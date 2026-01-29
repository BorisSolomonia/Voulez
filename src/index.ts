import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { stores, validateEnvironment } from './config/stores';
import { SyncEngine } from './core/sync';
import { logger } from './utils/logger';
import { metricsCollector } from './utils/metrics';
import { getAllCircuitBreakerStats, finaCircuitBreaker, woltCircuitBreaker } from './utils/circuitBreaker';
import dotenv from 'dotenv';

dotenv.config();

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
fs.ensureDirSync(logsDir);

// Validate required environment variables
const envValidation = validateEnvironment();
if (!envValidation.valid) {
  logger.error(`Missing required environment variables: ${envValidation.missing.join(', ')}`);
  logger.error('Please copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

const app = express();
// Sync interval - configurable via env (default 15 minutes)
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '15', 10);
const SYNC_INTERVAL = SYNC_INTERVAL_MINUTES * 60 * 1000;

// Determine if running in single-store mode (PM2) or multi-store mode
const STORE_ID = process.env.STORE_ID ? parseInt(process.env.STORE_ID) : null;
const PORT = process.env.HEALTH_PORT || process.env.PORT || 3000;

const engine = new SyncEngine();
let isSyncing = false;
let lastSyncStatus = 'idle';
let lastSyncTime: Date | null = null;
let syncCount = 0;
let errorCount = 0;

// Global Error Handlers
process.on('uncaughtException', (error: Error) => {
  logger.error({
    message: 'Uncaught exception',
    store: STORE_ID || 'all',
    error: error.message,
    stack: error.stack
  });
  errorCount++;
  lastSyncStatus = 'error';
  // DO NOT EXIT - keep process running
});

process.on('unhandledRejection', (reason: any) => {
  logger.error({
    message: 'Unhandled rejection',
    store: STORE_ID || 'all',
    reason: reason?.message || reason
  });
  errorCount++;
  lastSyncStatus = 'error';
  // DO NOT EXIT - keep process running
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, gracefully shutting down...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, gracefully shutting down...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Validate Stores on Startup
stores.forEach(store => {
  if (store.enabled) {
    if (!store.woltVenueId || !store.woltUsername || !store.woltPassword) {
       logger.error(`[Config] Store ${store.id} is ENABLED but missing Wolt credentials. Disabling to prevent errors.`);
       store.enabled = false;
    }
  }
});
const enabledStoresOnStart = stores.filter(s => s.enabled);
if (enabledStoresOnStart.length === 0) {
  lastSyncStatus = 'disabled';
  logger.error('No stores enabled after configuration validation. Health will report DISABLED and scheduler will not run.');
}

// Health Check Endpoint (Simple)
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const uptimeFormatted = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  const status = lastSyncStatus === 'error' ? 'ERROR' : lastSyncStatus === 'disabled' ? 'DISABLED' : 'UP';

  res.json({
    status,
    store: STORE_ID || 'all',
    timestamp: new Date().toISOString(),
    syncing: isSyncing,
    lastSync: lastSyncTime?.toISOString() || null,
    lastSyncStatus,
    syncCount,
    errorCount,
    uptime: uptimeFormatted,
    memory: {
      heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2),
      rssMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2)
    }
  });
});

// Detailed Metrics Endpoint
app.get('/metrics', (req, res) => {
  res.json(metricsCollector.getHealthReport());
});

// Store-specific Metrics
app.get('/metrics/store/:storeId', (req, res) => {
  const storeId = parseInt(req.params.storeId, 10);
  const storeMetrics = metricsCollector.getStoreMetrics(storeId);
  if (!storeMetrics) {
    return res.status(404).json({ error: `Store ${storeId} not found or no metrics available` });
  }
  res.json({
    store: storeMetrics,
    history: metricsCollector.getSyncHistory(storeId, 10)
  });
});

// Sync History Endpoint
app.get('/metrics/history', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 20;
  const storeId = req.query.store ? parseInt(req.query.store as string, 10) : undefined;
  res.json(metricsCollector.getSyncHistory(storeId, limit));
});

// Circuit Breaker Status
app.get('/circuit-breakers', (req, res) => {
  res.json({
    circuitBreakers: getAllCircuitBreakerStats(),
    available: {
      fina: finaCircuitBreaker.isAvailable(),
      wolt: woltCircuitBreaker.isAvailable()
    }
  });
});

// Reset Circuit Breaker (admin endpoint)
app.post('/circuit-breakers/reset/:name', (req, res) => {
  const remoteAddress = req.ip || req.socket.remoteAddress;
  if (remoteAddress !== '::1' && remoteAddress !== '127.0.0.1' && remoteAddress !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const name = req.params.name.toLowerCase();
  if (name === 'fina') {
    finaCircuitBreaker.reset();
    res.json({ message: 'Fina circuit breaker reset' });
  } else if (name === 'wolt') {
    woltCircuitBreaker.reset();
    res.json({ message: 'Wolt circuit breaker reset' });
  } else {
    res.status(400).json({ error: 'Unknown circuit breaker. Use "fina" or "wolt".' });
  }
});

// Manual Trigger Endpoint
app.post('/trigger-sync', async (req, res) => {
  // Security: Only allow localhost
  const remoteAddress = req.ip || req.socket.remoteAddress;
  if (remoteAddress !== '::1' && remoteAddress !== '127.0.0.1' && remoteAddress !== '::ffff:127.0.0.1') {
     logger.warn(`Unauthorized sync attempt from ${remoteAddress}`);
     return res.status(403).json({ error: 'Forbidden' });
  }

  if (isSyncing) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }
  res.json({ message: 'Sync triggered' });

  if (STORE_ID) {
    runSingleStoreSync();
  } else {
    runAllSyncs();
  }
});

async function runSingleStoreSync() {
  if (isSyncing) {
    logger.warn(`[Store ${STORE_ID}] Sync skipped: Already in progress`);
    return;
  }

  const store = stores.find(s => s.id === STORE_ID);
  if (!store) {
    logger.error(`[Store ${STORE_ID}] Configuration not found`);
    lastSyncStatus = 'disabled';
    return;
  }

  if (!store.enabled) {
    logger.warn(`[Store ${STORE_ID}] Store disabled in configuration`);
    lastSyncStatus = 'disabled';
    return;
  }

  isSyncing = true;
  syncCount++;

  try {
    logger.info(`[Store ${STORE_ID}] Starting sync #${syncCount}...`);
    await engine.run(store);
    lastSyncStatus = 'success';
    lastSyncTime = new Date();
    logger.info(`[Store ${STORE_ID}] Sync #${syncCount} completed successfully`);
  } catch (error: any) {
    errorCount++;
    lastSyncStatus = 'error';
    lastSyncTime = new Date();
    logger.error({
      message: `[Store ${STORE_ID}] Sync #${syncCount} failed`,
      error: error.message,
      stack: error.stack
    });
  } finally {
    isSyncing = false;
  }
}

async function runAllSyncs() {
  if (isSyncing) {
    logger.warn('Sync skipped: Already in progress');
    return;
  }

  isSyncing = true;
  syncCount++;
  logger.info(`Starting scheduled sync #${syncCount} for all stores...`);

  const enabledStores = stores.filter(s => s.enabled);
  if (enabledStores.length === 0) {
    logger.warn('No enabled stores; skipping sync run.');
    lastSyncStatus = 'disabled';
    isSyncing = false;
    return;
  }

  // Sequential sync to avoid overwhelming Fina/Wolt APIs and reduce memory usage
  // Each store loads ~70k products into memory; parallel would multiply this
  const syncResults: Array<{ store: number; status: string; error?: string }> = [];

  for (const store of enabledStores) {
    try {
      logger.info(`Starting sync for Store ${store.id} (${store.name})...`);
      await engine.run(store);
      syncResults.push({ store: store.id, status: 'success' });
      logger.info(`Sync completed for Store ${store.id}`);
    } catch (error: any) {
      logger.error(`Sync failed for Store ${store.id}: ${error.message}`);
      syncResults.push({ store: store.id, status: 'error', error: error.message });
    }
  }

  const successCount = syncResults.filter(r => r.status === 'success').length;
  const failureCount = syncResults.filter(r => r.status === 'error').length;

  if (failureCount > 0) {
    lastSyncStatus = 'partial';
    errorCount += failureCount;
  } else {
    lastSyncStatus = 'success';
  }

  lastSyncTime = new Date();
  isSyncing = false;
  logger.info(`Scheduled sync #${syncCount} complete: ${successCount} succeeded, ${failureCount} failed`);
}

// Start Server
const server = app.listen(PORT, () => {
  if (STORE_ID) {
    const store = stores.find(s => s.id === STORE_ID);
    if (!store || !store.enabled) {
      logger.error(`Wolt Sync Service (Store ${STORE_ID}) not scheduled because store is disabled or missing.`);
      lastSyncStatus = 'disabled';
      return;
    }

    logger.info(`Wolt Sync Service (Store ${STORE_ID}) running on port ${PORT}`);
    logger.info(`Health endpoint: http://localhost:${PORT}/health`);
    logger.info(`Sync interval: ${SYNC_INTERVAL_MINUTES} minutes`);

    // Initial Sync
    setTimeout(runSingleStoreSync, 5000);

    // Schedule
    setInterval(runSingleStoreSync, SYNC_INTERVAL);
  } else {
    logger.info(`Wolt Sync Service (All Stores) running on port ${PORT}`);
    logger.info(`Health endpoint: http://localhost:${PORT}/health`);
    logger.info(`Sync interval: ${SYNC_INTERVAL_MINUTES} minutes`);

    if (enabledStoresOnStart.length === 0) {
      logger.warn('No stores enabled; sync schedule will not start until configuration is updated.');
      return;
    }

    // Initial Sync
    setTimeout(runAllSyncs, 5000);

    // Schedule
    setInterval(runAllSyncs, SYNC_INTERVAL);
  }
});
