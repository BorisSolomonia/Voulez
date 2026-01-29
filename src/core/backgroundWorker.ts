import { FinaAdapter } from '../adapters/fina';
import { WoltAdapter } from '../adapters/wolt';
import { StateManager } from './state';
import { StoreConfig, SyncState, WoltInventoryItem, WoltItemUpdate } from '../types';
import { createStoreLogger } from '../utils/logger';
import { AdaptiveBatcher } from '../utils/adaptiveBatcher';
import fs from 'fs-extra';
import path from 'path';

export interface BackgroundWorkerConfig {
  dailyLimit: number;
  batchInterval: number; // milliseconds between batches
  skipIfInState: boolean;
  enabled: boolean;
}

export interface BackgroundWorkerProgress {
  totalItems: number;
  syncedItems: number;
  remainingItems: number;
  percentComplete: number;
  estimatedDaysRemaining: number;
  lastSyncAt: number;
  startedAt: number;
}

export class BackgroundWorker {
  private fina: FinaAdapter;
  private wolt: WoltAdapter;
  private stateManager: StateManager;
  private adaptiveBatcher: AdaptiveBatcher;
  private config: BackgroundWorkerConfig;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;
  private readonly progressFile: string;

  constructor(private store: StoreConfig) {
    this.fina = new FinaAdapter();
    this.wolt = new WoltAdapter();
    this.stateManager = new StateManager();
    this.adaptiveBatcher = new AdaptiveBatcher();
    this.progressFile = path.join(process.cwd(), 'state', `.bg-worker-progress-${store.id}.json`);

    this.config = {
      dailyLimit: parseInt(process.env.BACKGROUND_DAILY_LIMIT || '500', 10),
      batchInterval: 24 * 60 * 60 * 1000, // 24 hours by default
      skipIfInState: true,
      enabled: (process.env.BACKGROUND_SYNC_ENABLED || 'true').toLowerCase() !== 'false'
    };
  }

  /**
   * Load progress from disk
   */
  private async loadProgress(): Promise<BackgroundWorkerProgress | null> {
    try {
      if (await fs.pathExists(this.progressFile)) {
        return await fs.readJson(this.progressFile);
      }
    } catch (error) {
      // Ignore errors, start fresh
    }
    return null;
  }

  /**
   * Save progress to disk
   */
  private async saveProgress(progress: BackgroundWorkerProgress): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(this.progressFile));
      await fs.writeJson(this.progressFile, progress, { spaces: 2 });
    } catch (error) {
      // Non-critical error, log and continue
    }
  }

  /**
   * Get current progress
   */
  async getProgress(): Promise<BackgroundWorkerProgress | null> {
    return this.loadProgress();
  }

  /**
   * Check if background worker has completed
   */
  async isComplete(): Promise<boolean> {
    const progress = await this.loadProgress();
    return progress ? progress.remainingItems === 0 : false;
  }

  /**
   * Start the background worker
   */
  async start(): Promise<void> {
    const log = createStoreLogger(this.store.id);

    if (!this.config.enabled) {
      log.info('[BackgroundWorker] Disabled via configuration');
      return;
    }

    if (this.isRunning) {
      log.warn('[BackgroundWorker] Already running');
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;
    log.info('[BackgroundWorker] Starting background sync worker...');

    try {
      await this.runLoop();
    } catch (error: any) {
      log.error(`[BackgroundWorker] Fatal error: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Stop the background worker gracefully
   */
  stop(): void {
    const log = createStoreLogger(this.store.id);
    log.info('[BackgroundWorker] Stop requested, will finish current batch...');
    this.shouldStop = true;
  }

  /**
   * Main worker loop
   */
  private async runLoop(): Promise<void> {
    const log = createStoreLogger(this.store.id);
    const startDelay = parseInt(process.env.BACKGROUND_START_DELAY_HOURS || '1', 10) * 60 * 60 * 1000;

    // Wait before starting (let priority sync complete first)
    log.info(`[BackgroundWorker] Waiting ${startDelay / 1000 / 60} minutes before starting...`);
    await new Promise(resolve => setTimeout(resolve, startDelay));

    if (this.shouldStop) return;

    let iteration = 0;

    while (!this.shouldStop) {
      iteration++;
      log.info(`[BackgroundWorker] Starting iteration ${iteration}...`);

      try {
        const progress = await this.syncNextBatch();

        if (progress.remainingItems === 0) {
          log.info('[BackgroundWorker] All items synced! Worker complete.');
          break;
        }

        log.info(
          `[BackgroundWorker] Progress: ${progress.percentComplete.toFixed(1)}% complete ` +
          `(${progress.syncedItems}/${progress.totalItems} items, ` +
          `est. ${progress.estimatedDaysRemaining.toFixed(1)} days remaining)`
        );

        // Wait for next batch interval
        if (!this.shouldStop) {
          log.info(`[BackgroundWorker] Waiting ${this.config.batchInterval / 1000 / 60 / 60} hours until next batch...`);
          await new Promise(resolve => setTimeout(resolve, this.config.batchInterval));
        }

      } catch (error: any) {
        log.error(`[BackgroundWorker] Iteration ${iteration} failed: ${error.message}`);
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000)); // 1 hour
      }
    }

    log.info('[BackgroundWorker] Stopped');
  }

  /**
   * Sync the next batch of items
   */
  private async syncNextBatch(): Promise<BackgroundWorkerProgress> {
    const log = createStoreLogger(this.store.id);

    // Load state to see what's already synced
    const state = await this.stateManager.loadState(this.store.id);

    // Fetch all current inventory
    const inventoryResult = await this.fina.getInventory(this.store.id);
    const inventory = inventoryResult.items;

    // Fetch all product details
    const productIds = inventory.map(i => i.id);
    const detailsResult = await this.fina.getProductDetails(productIds);
    const details = detailsResult.products;

    // Build SKU map
    const finaIdToWoltSku = this.fina.mapToWoltSku(details);

    // Find items not yet synced to Wolt
    const unsyncedItems: Array<{ finaId: number; woltSku: string }> = [];

    for (const product of details) {
      const woltSku = finaIdToWoltSku.get(product.id);
      if (!woltSku) continue;

      // Check if already synced
      if (this.config.skipIfInState && state[woltSku]) {
        const stateEntry = state[woltSku] as any;
        if (stateEntry.syncedToWolt) {
          continue; // Already synced
        }
      }

      unsyncedItems.push({ finaId: product.id, woltSku });
    }

    const totalItems = finaIdToWoltSku.size;
    const remainingItems = unsyncedItems.length;
    const syncedItems = totalItems - remainingItems;

    log.info(`[BackgroundWorker] Found ${remainingItems} unsynced items (${syncedItems}/${totalItems} already synced)`);

    if (remainingItems === 0) {
      return {
        totalItems,
        syncedItems,
        remainingItems: 0,
        percentComplete: 100,
        estimatedDaysRemaining: 0,
        lastSyncAt: Date.now(),
        startedAt: await this.getStartTime()
      };
    }

    // Take next batch
    const batchToSync = unsyncedItems.slice(0, this.config.dailyLimit);
    log.info(`[BackgroundWorker] Syncing batch of ${batchToSync.length} items...`);

    // Build update payloads
    const itemUpdates: WoltItemUpdate[] = [];
    const inventoryUpdates: WoltInventoryItem[] = [];

    const stockMap = new Map(inventory.map(i => [i.id, i.rest]));
    const detailMap = new Map(details.map(d => [d.id, d]));

    for (const { finaId, woltSku } of batchToSync) {
      const detail = detailMap.get(finaId);
      const quantity = stockMap.get(finaId) || 0;

      if (!detail) continue;

      itemUpdates.push({
        sku: woltSku,
        enabled: quantity > 0,
        price: detail.price
      });

      inventoryUpdates.push({
        sku: woltSku,
        inventory: quantity
      });
    }

    // Send to Wolt with adaptive batching
    const batchSize = this.adaptiveBatcher.getCurrentBatchSize(this.store.woltVenueId);
    const batchDelay = this.adaptiveBatcher.getRecommendedDelay(this.store.woltVenueId);

    // Phase 1: Items
    if (itemUpdates.length > 0) {
      log.info(`[BackgroundWorker] Sending ${itemUpdates.length} availability updates (batch size: ${batchSize})...`);

      for (let i = 0; i < itemUpdates.length; i += batchSize) {
        if (this.shouldStop) break;

        const batch = itemUpdates.slice(i, i + batchSize);
        try {
          const result = await this.wolt.updateItems(
            this.store.woltVenueId,
            { data: batch },
            this.store.woltUsername,
            this.store.woltPassword,
            this.store.woltApiUrl
          );

          if (result.rateLimitHit) {
            this.adaptiveBatcher.onRateLimit(this.store.woltVenueId, 60000);
          } else {
            this.adaptiveBatcher.onSuccess(this.store.woltVenueId);
          }
        } catch (error) {
          log.error(`[BackgroundWorker] Batch failed: ${(error as Error).message}`);
          throw error;
        }

        if (i + batchSize < itemUpdates.length) {
          await new Promise(r => setTimeout(r, batchDelay));
        }
      }
    }

    // Phase 2: Inventory
    if (inventoryUpdates.length > 0 && !this.shouldStop) {
      log.info(`[BackgroundWorker] Sending ${inventoryUpdates.length} inventory updates...`);

      for (let i = 0; i < inventoryUpdates.length; i += batchSize) {
        if (this.shouldStop) break;

        const batch = inventoryUpdates.slice(i, i + batchSize);
        try {
          await this.wolt.updateInventory(
            this.store.woltVenueId,
            { data: batch },
            this.store.woltUsername,
            this.store.woltPassword,
            this.store.woltApiUrl
          );
        } catch (error) {
          log.error(`[BackgroundWorker] Batch failed: ${(error as Error).message}`);
          throw error;
        }

        if (i + batchSize < inventoryUpdates.length) {
          await new Promise(r => setTimeout(r, batchDelay));
        }
      }
    }

    // Mark items as synced in state
    for (const { woltSku } of batchToSync) {
      if (!state[woltSku]) {
        state[woltSku] = {
          quantity: 0,
          enabled: false,
          price: 0,
          lastSeen: Date.now()
        };
      }
      (state[woltSku] as any).syncedToWolt = true;
    }

    await this.stateManager.saveState(this.store.id, state);

    // Calculate and save progress
    const newSyncedItems = syncedItems + batchToSync.length;
    const newRemainingItems = totalItems - newSyncedItems;
    const percentComplete = (newSyncedItems / totalItems) * 100;
    const estimatedDaysRemaining = newRemainingItems / this.config.dailyLimit;

    const progress: BackgroundWorkerProgress = {
      totalItems,
      syncedItems: newSyncedItems,
      remainingItems: newRemainingItems,
      percentComplete,
      estimatedDaysRemaining,
      lastSyncAt: Date.now(),
      startedAt: await this.getStartTime()
    };

    await this.saveProgress(progress);

    return progress;
  }

  private async getStartTime(): Promise<number> {
    const progress = await this.loadProgress();
    return progress?.startedAt || Date.now();
  }
}
