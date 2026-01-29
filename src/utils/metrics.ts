import { logger } from './logger';

export interface SyncMetrics {
  storeId: number;
  storeName: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'running' | 'success' | 'error' | 'partial';

  // Fina metrics
  finaProductsLoaded: number;
  finaProductsWithWoltSku: number;
  finaApiCalls: number;
  finaApiErrors: number;
  finaAuthTime?: number;
  finaInventoryFetchTime?: number;
  finaDetailsFetchTime?: number;

  // Wolt metrics
  woltItemsUpdated: number;
  woltInventoryUpdated: number;
  woltApiCalls: number;
  woltApiErrors: number;
  woltRateLimitHits: number;
  woltItemsUpdateTime?: number;
  woltInventoryUpdateTime?: number;

  // Change metrics
  availabilityChanges: number;
  inventoryChanges: number;
  newItems: number;
  missingItems: number;

  // Error details
  errors: string[];
}

export interface SystemMetrics {
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  partialSyncs: number;
  lastSyncTime?: number;
  averageSyncDuration: number;
  storeMetrics: Map<number, StoreCumulativeMetrics>;
}

export interface StoreCumulativeMetrics {
  storeId: number;
  storeName: string;
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  totalItemsUpdated: number;
  totalInventoryUpdated: number;
  totalApiCalls: number;
  totalApiErrors: number;
  totalRateLimitHits: number;
  averageDurationMs: number;
  lastSyncTime?: number;
  lastSyncStatus?: string;
  consecutiveFailures: number;
}

class MetricsCollector {
  private systemMetrics: SystemMetrics;
  private readonly startTimeMs: number;
  private currentSyncs: Map<number, SyncMetrics> = new Map();
  private syncHistory: SyncMetrics[] = [];
  private readonly maxHistorySize = 100;

  constructor() {
    this.startTimeMs = Date.now();
    this.systemMetrics = {
      uptime: 0,
      memoryUsage: process.memoryUsage(),
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      partialSyncs: 0,
      averageSyncDuration: 0,
      storeMetrics: new Map()
    };
  }

  startSync(storeId: number, storeName: string): SyncMetrics {
    const metrics: SyncMetrics = {
      storeId,
      storeName,
      startTime: Date.now(),
      status: 'running',
      finaProductsLoaded: 0,
      finaProductsWithWoltSku: 0,
      finaApiCalls: 0,
      finaApiErrors: 0,
      woltItemsUpdated: 0,
      woltInventoryUpdated: 0,
      woltApiCalls: 0,
      woltApiErrors: 0,
      woltRateLimitHits: 0,
      availabilityChanges: 0,
      inventoryChanges: 0,
      newItems: 0,
      missingItems: 0,
      errors: []
    };

    this.currentSyncs.set(storeId, metrics);
    return metrics;
  }

  getCurrentSync(storeId: number): SyncMetrics | undefined {
    return this.currentSyncs.get(storeId);
  }

  recordFinaAuth(storeId: number, durationMs: number): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.finaAuthTime = durationMs;
      metrics.finaApiCalls++;
    }
  }

  recordFinaInventory(storeId: number, productCount: number, durationMs: number): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.finaProductsLoaded = productCount;
      metrics.finaInventoryFetchTime = durationMs;
      metrics.finaApiCalls++;
    }
  }

  recordFinaDetails(storeId: number, skuMappedCount: number, durationMs: number, apiCalls: number): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.finaProductsWithWoltSku = skuMappedCount;
      metrics.finaDetailsFetchTime = durationMs;
      metrics.finaApiCalls += apiCalls;
    }
  }

  recordFinaError(storeId: number, error: string): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.finaApiErrors++;
      metrics.errors.push(`Fina: ${error}`);
    }
  }

  recordWoltItemsUpdate(storeId: number, itemCount: number, durationMs: number, apiCalls: number): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.woltItemsUpdated = itemCount;
      metrics.woltItemsUpdateTime = durationMs;
      metrics.woltApiCalls += apiCalls;
    }
  }

  recordWoltInventoryUpdate(storeId: number, itemCount: number, durationMs: number, apiCalls: number): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.woltInventoryUpdated = itemCount;
      metrics.woltInventoryUpdateTime = durationMs;
      metrics.woltApiCalls += apiCalls;
    }
  }

  recordWoltError(storeId: number, error: string): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.woltApiErrors++;
      metrics.errors.push(`Wolt: ${error}`);
    }
  }

  recordWoltRateLimit(storeId: number): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.woltRateLimitHits++;
    }
  }

  recordChanges(storeId: number, availability: number, inventory: number, newItems: number, missingItems: number): void {
    const metrics = this.currentSyncs.get(storeId);
    if (metrics) {
      metrics.availabilityChanges = availability;
      metrics.inventoryChanges = inventory;
      metrics.newItems = newItems;
      metrics.missingItems = missingItems;
    }
  }

  endSync(storeId: number, status: 'success' | 'error' | 'partial'): SyncMetrics | undefined {
    const metrics = this.currentSyncs.get(storeId);
    if (!metrics) return undefined;

    metrics.endTime = Date.now();
    metrics.durationMs = metrics.endTime - metrics.startTime;
    metrics.status = status;

    // Update system metrics
    this.systemMetrics.totalSyncs++;
    if (status === 'success') this.systemMetrics.successfulSyncs++;
    else if (status === 'error') this.systemMetrics.failedSyncs++;
    else if (status === 'partial') this.systemMetrics.partialSyncs++;

    this.systemMetrics.lastSyncTime = metrics.endTime;

    // Update average duration
    const totalDuration = this.syncHistory.reduce((sum, m) => sum + (m.durationMs || 0), 0) + metrics.durationMs;
    this.systemMetrics.averageSyncDuration = totalDuration / (this.syncHistory.length + 1);

    // Update store-specific cumulative metrics
    this.updateStoreCumulativeMetrics(metrics);

    // Add to history
    this.syncHistory.push({ ...metrics });
    if (this.syncHistory.length > this.maxHistorySize) {
      this.syncHistory.shift();
    }

    // Remove from current syncs
    this.currentSyncs.delete(storeId);

    // Log metrics summary
    this.logSyncSummary(metrics);

    return metrics;
  }

  private updateStoreCumulativeMetrics(metrics: SyncMetrics): void {
    let storeMetrics = this.systemMetrics.storeMetrics.get(metrics.storeId);

    if (!storeMetrics) {
      storeMetrics = {
        storeId: metrics.storeId,
        storeName: metrics.storeName,
        totalSyncs: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
        totalItemsUpdated: 0,
        totalInventoryUpdated: 0,
        totalApiCalls: 0,
        totalApiErrors: 0,
        totalRateLimitHits: 0,
        averageDurationMs: 0,
        consecutiveFailures: 0
      };
      this.systemMetrics.storeMetrics.set(metrics.storeId, storeMetrics);
    }

    storeMetrics.totalSyncs++;
    if (metrics.status === 'success') {
      storeMetrics.successfulSyncs++;
      storeMetrics.consecutiveFailures = 0;
    } else if (metrics.status === 'error') {
      storeMetrics.failedSyncs++;
      storeMetrics.consecutiveFailures++;
    }

    storeMetrics.totalItemsUpdated += metrics.woltItemsUpdated;
    storeMetrics.totalInventoryUpdated += metrics.woltInventoryUpdated;
    storeMetrics.totalApiCalls += metrics.finaApiCalls + metrics.woltApiCalls;
    storeMetrics.totalApiErrors += metrics.finaApiErrors + metrics.woltApiErrors;
    storeMetrics.totalRateLimitHits += metrics.woltRateLimitHits;
    storeMetrics.lastSyncTime = metrics.endTime;
    storeMetrics.lastSyncStatus = metrics.status;

    // Update average duration
    const storeHistory = this.syncHistory.filter(m => m.storeId === metrics.storeId);
    const totalDuration = storeHistory.reduce((sum, m) => sum + (m.durationMs || 0), 0) + (metrics.durationMs || 0);
    storeMetrics.averageDurationMs = totalDuration / (storeHistory.length + 1);
  }

  private logSyncSummary(metrics: SyncMetrics): void {
    const summary = {
      store: `${metrics.storeName} (ID: ${metrics.storeId})`,
      status: metrics.status,
      duration: `${((metrics.durationMs || 0) / 1000).toFixed(1)}s`,
      fina: {
        products: metrics.finaProductsLoaded,
        withWoltSku: metrics.finaProductsWithWoltSku,
        apiCalls: metrics.finaApiCalls,
        errors: metrics.finaApiErrors
      },
      wolt: {
        itemsUpdated: metrics.woltItemsUpdated,
        inventoryUpdated: metrics.woltInventoryUpdated,
        apiCalls: metrics.woltApiCalls,
        errors: metrics.woltApiErrors,
        rateLimits: metrics.woltRateLimitHits
      },
      changes: {
        availability: metrics.availabilityChanges,
        inventory: metrics.inventoryChanges,
        new: metrics.newItems,
        missing: metrics.missingItems
      }
    };

    logger.info({ message: 'Sync completed', metrics: summary });
  }

  getSystemMetrics(): SystemMetrics {
    const uptime = Date.now() - this.startTimeMs;
    return { ...this.systemMetrics, uptime, memoryUsage: process.memoryUsage() };
  }

  getStoreMetrics(storeId: number): StoreCumulativeMetrics | undefined {
    return this.systemMetrics.storeMetrics.get(storeId);
  }

  getAllStoreMetrics(): StoreCumulativeMetrics[] {
    return Array.from(this.systemMetrics.storeMetrics.values());
  }

  getSyncHistory(storeId?: number, limit: number = 10): SyncMetrics[] {
    let history = this.syncHistory;
    if (storeId !== undefined) {
      history = history.filter(m => m.storeId === storeId);
    }
    return history.slice(-limit);
  }

  getHealthReport(): object {
    const now = Date.now();
    const uptimeMs = now - this.startTimeMs;
    const memory = process.memoryUsage();

    return {
      status: this.getOverallStatus(),
      uptime: this.formatDuration(uptimeMs),
      memory: {
        heapUsedMB: (memory.heapUsed / 1024 / 1024).toFixed(2),
        heapTotalMB: (memory.heapTotal / 1024 / 1024).toFixed(2),
        rssMB: (memory.rss / 1024 / 1024).toFixed(2)
      },
      syncs: {
        total: this.systemMetrics.totalSyncs,
        successful: this.systemMetrics.successfulSyncs,
        failed: this.systemMetrics.failedSyncs,
        partial: this.systemMetrics.partialSyncs,
        successRate: this.systemMetrics.totalSyncs > 0
          ? `${((this.systemMetrics.successfulSyncs / this.systemMetrics.totalSyncs) * 100).toFixed(1)}%`
          : 'N/A',
        averageDuration: `${(this.systemMetrics.averageSyncDuration / 1000).toFixed(1)}s`
      },
      lastSync: this.systemMetrics.lastSyncTime
        ? new Date(this.systemMetrics.lastSyncTime).toISOString()
        : null,
      currentlySyncing: Array.from(this.currentSyncs.keys()),
      stores: this.getAllStoreMetrics().map(s => ({
        id: s.storeId,
        name: s.storeName,
        syncs: s.totalSyncs,
        successRate: s.totalSyncs > 0
          ? `${((s.successfulSyncs / s.totalSyncs) * 100).toFixed(1)}%`
          : 'N/A',
        avgDuration: `${(s.averageDurationMs / 1000).toFixed(1)}s`,
        lastStatus: s.lastSyncStatus || 'never',
        consecutiveFailures: s.consecutiveFailures
      }))
    };
  }

  private getOverallStatus(): 'healthy' | 'degraded' | 'unhealthy' {
    const stores = this.getAllStoreMetrics();

    // Check for stores with consecutive failures
    const storesWithFailures = stores.filter(s => s.consecutiveFailures >= 3);
    if (storesWithFailures.length > stores.length / 2) {
      return 'unhealthy';
    }
    if (storesWithFailures.length > 0) {
      return 'degraded';
    }

    // Check overall success rate
    if (this.systemMetrics.totalSyncs > 0) {
      const successRate = this.systemMetrics.successfulSyncs / this.systemMetrics.totalSyncs;
      if (successRate < 0.5) return 'unhealthy';
      if (successRate < 0.9) return 'degraded';
    }

    return 'healthy';
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}

// Singleton instance
export const metricsCollector = new MetricsCollector();
