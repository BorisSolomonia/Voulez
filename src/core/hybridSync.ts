import { FinaAdapter } from '../adapters/fina';
import { WoltAdapter } from '../adapters/wolt';
import { StateManager } from './state';
import { PriorityScorer } from './priorityScorer';
import { BackgroundWorker } from './backgroundWorker';
import { StoreConfig, SyncState, WoltInventoryItem, WoltItemUpdate } from '../types';
import { createStoreLogger } from '../utils/logger';
import { AdaptiveBatcher } from '../utils/adaptiveBatcher';
import { metricsCollector } from '../utils/metrics';

export interface HybridSyncStatus {
  phase: 'bootstrap' | 'introspection' | 'priority' | 'background' | 'delta' | 'complete';
  bootstrapComplete: boolean;
  introspectionComplete: boolean;
  introspectionItemsFound: number;
  prioritySyncComplete: boolean;
  priorityItemsSynced: number;
  backgroundWorkerRunning: boolean;
  backgroundWorkerProgress: number;
  message: string;
}

/**
 * HybridSyncOrchestrator - Solution 5 Implementation
 *
 * Combines:
 * - Bootstrap (state creation without Wolt calls)
 * - Wolt introspection (smart caching)
 * - Priority sync (critical items first)
 * - Adaptive batching (learns optimal batch size)
 * - Background worker (incremental full sync)
 * - Delta sync (real-time changes)
 */
export class HybridSyncOrchestrator {
  private fina: FinaAdapter;
  private wolt: WoltAdapter;
  private stateManager: StateManager;
  private priorityScorer: PriorityScorer;
  private adaptiveBatcher: AdaptiveBatcher;
  private backgroundWorker: BackgroundWorker | null = null;

  constructor() {
    this.fina = new FinaAdapter();
    this.wolt = new WoltAdapter();
    this.stateManager = new StateManager();
    this.priorityScorer = new PriorityScorer();
    this.adaptiveBatcher = new AdaptiveBatcher();
  }

  /**
   * Initialize hybrid sync for a store
   * This is the main entry point for first-time setup
   */
  async initialize(store: StoreConfig): Promise<HybridSyncStatus> {
    const log = createStoreLogger(store.id);
    const status: HybridSyncStatus = {
      phase: 'bootstrap',
      bootstrapComplete: false,
      introspectionComplete: false,
      introspectionItemsFound: 0,
      prioritySyncComplete: false,
      priorityItemsSynced: 0,
      backgroundWorkerRunning: false,
      backgroundWorkerProgress: 0,
      message: 'Starting hybrid sync initialization'
    };

    log.info('='.repeat(60));
    log.info('[HybridSync] SOLUTION 5: HYBRID SYNC INITIALIZATION');
    log.info('='.repeat(60));

    // Check if already initialized
    const existingState = await this.stateManager.loadState(store.id);
    if (Object.keys(existingState).length > 0) {
      log.info('[HybridSync] Store already initialized (state exists)');
      status.phase = 'complete';
      status.bootstrapComplete = true;
      status.message = 'Store already initialized';
      return status;
    }

    // Phase 1: Bootstrap State
    log.info('[HybridSync] Phase 1: Bootstrap state from Fina (no Wolt calls)');
    status.phase = 'bootstrap';
    await this.bootstrapState(store);
    status.bootstrapComplete = true;
    log.info('[HybridSync] ✓ Bootstrap complete');

    // Phase 2: Wolt Introspection (if available)
    log.info('[HybridSync] Phase 2: Introspect Wolt for existing items');
    status.phase = 'introspection';
    try {
      const woltItems = await this.introspectWolt(store);
      if (woltItems.length > 0) {
        await this.mergeWoltState(store, woltItems);
        status.introspectionItemsFound = woltItems.length;
        log.info(`[HybridSync] ✓ Introspection complete: ${woltItems.length} items found in Wolt`);
      } else {
        log.info('[HybridSync] ✓ Introspection complete: No items found (or API not supported)');
      }
    } catch (error: any) {
      log.warn(`[HybridSync] Introspection failed: ${error.message} (continuing anyway)`);
    }
    status.introspectionComplete = true;

    // Phase 3: Priority Sync
    log.info('[HybridSync] Phase 3: Priority sync (critical items first)');
    status.phase = 'priority';
    const priorityLimit = parseInt(process.env.PRIORITY_SYNC_LIMIT || '500', 10);
    const prioritySynced = await this.prioritySync(store, priorityLimit);
    status.priorityItemsSynced = prioritySynced;
    status.prioritySyncComplete = true;
    log.info(`[HybridSync] ✓ Priority sync complete: ${prioritySynced} items synced`);

    // Phase 4: Start Background Worker
    log.info('[HybridSync] Phase 4: Starting background worker for incremental sync');
    status.phase = 'background';
    this.backgroundWorker = new BackgroundWorker(store);
    // Start in background (non-blocking)
    this.startBackgroundWorker();
    status.backgroundWorkerRunning = true;
    log.info('[HybridSync] ✓ Background worker started');

    // Phase 5: System Ready
    log.info('='.repeat(60));
    log.info('[HybridSync] INITIALIZATION COMPLETE - SYSTEM OPERATIONAL');
    log.info(`[HybridSync] - State created: ${Object.keys(await this.stateManager.loadState(store.id)).length} products`);
    log.info(`[HybridSync] - Existing items: ${status.introspectionItemsFound} items`);
    log.info(`[HybridSync] - Priority items: ${prioritySynced} items synced`);
    log.info('[HybridSync] - Delta sync: Ready for 15-minute intervals');
    log.info('[HybridSync] - Background worker: Running (incremental sync)');
    log.info('='.repeat(60));

    status.phase = 'complete';
    status.message = 'Hybrid sync initialized successfully';

    return status;
  }

  /**
   * Phase 1: Bootstrap state from Fina (no Wolt calls)
   */
  private async bootstrapState(store: StoreConfig): Promise<void> {
    const log = createStoreLogger(store.id);

    // Fetch Fina data
    log.info('[Bootstrap] Fetching Fina inventory...');
    const inventoryResult = await this.fina.getInventory(store.id);
    const inventory = inventoryResult.items;

    log.info('[Bootstrap] Fetching Fina product details...');
    const productIds = inventory.map(i => i.id);
    const detailsResult = await this.fina.getProductDetails(productIds);
    const details = detailsResult.products;

    // Build SKU map
    const finaIdToWoltSku = this.fina.mapToWoltSku(details);
    const stockMap = new Map(inventory.map(i => [i.id, i.rest]));

    // Create state
    const state: SyncState = {};
    const now = Date.now();

    for (const product of details) {
      const woltSku = finaIdToWoltSku.get(product.id);
      if (!woltSku) continue;

      const quantity = stockMap.get(product.id) || 0;

      state[woltSku] = {
        quantity,
        enabled: quantity > 0,
        price: product.price,
        lastSeen: now
      };
    }

    // Save state
    await this.stateManager.saveState(store.id, state);
    log.info(`[Bootstrap] State created: ${Object.keys(state).length} products`);
  }

  /**
   * Phase 2: Introspect Wolt for existing items
   */
  private async introspectWolt(store: StoreConfig): Promise<any[]> {
    try {
      return await this.wolt.introspectExistingItems(
        store.woltVenueId,
        store.woltUsername,
        store.woltPassword,
        store.woltApiUrl
      );
    } catch (error) {
      // Non-critical error
      return [];
    }
  }

  /**
   * Merge Wolt items into state
   */
  private async mergeWoltState(store: StoreConfig, woltItems: any[]): Promise<void> {
    const log = createStoreLogger(store.id);
    const state = await this.stateManager.loadState(store.id);
    let mergedCount = 0;

    for (const item of woltItems) {
      if (item.sku && state[item.sku]) {
        // Mark as already synced to Wolt
        (state[item.sku] as any).syncedToWolt = true;
        mergedCount++;
      }
    }

    await this.stateManager.saveState(store.id, state);
    log.info(`[Introspection] Merged ${mergedCount} items from Wolt into state`);
  }

  /**
   * Phase 3: Priority sync (critical items first)
   */
  private async prioritySync(store: StoreConfig, limit: number): Promise<number> {
    const log = createStoreLogger(store.id);

    if ((process.env.PRIORITY_SYNC_ENABLED || 'true').toLowerCase() === 'false') {
      log.info('[PrioritySync] Disabled via configuration');
      return 0;
    }

    // Fetch current data
    const inventoryResult = await this.fina.getInventory(store.id);
    const inventory = inventoryResult.items;

    const productIds = inventory.map(i => i.id);
    const detailsResult = await this.fina.getProductDetails(productIds);
    const details = detailsResult.products;

    const finaIdToWoltSku = this.fina.mapToWoltSku(details);

    // Score and sort
    const scoredItems = this.priorityScorer.scoreAndSort(inventory, details, finaIdToWoltSku);
    const topItems = this.priorityScorer.getTopPriority(scoredItems, limit);

    if (topItems.length === 0) {
      log.warn('[PrioritySync] No priority items found');
      return 0;
    }

    log.info(`[PrioritySync] Syncing ${topItems.length} priority items...`);

    // Build update payloads
    const itemUpdates: WoltItemUpdate[] = [];
    const inventoryUpdates: WoltInventoryItem[] = [];
    const syncedSkus: string[] = [];
    let invalidPriceCount = 0;

    for (const item of topItems) {
      // Validate SKU exists
      if (!item.woltSku) {
        log.warn(`[PrioritySync] Skipping item without SKU`);
        continue;
      }

      syncedSkus.push(item.woltSku);

      // CRITICAL: Items with invalid prices cannot be sold
      // Sync them with inventory=0 to make them unavailable in Wolt
      const hasValidPrice = typeof item.price === 'number' && item.price >= 0;

      if (!hasValidPrice) {
        log.warn(`[PrioritySync] Item ${item.woltSku} has invalid price (${item.price}). Setting inventory=0 in Wolt.`);
        invalidPriceCount++;

        itemUpdates.push({
          sku: item.woltSku,
          enabled: false,  // Disabled because no valid price
          price: 0  // Set price to 0 for invalid items
        });

        inventoryUpdates.push({
          sku: item.woltSku,
          inventory: 0  // Set inventory to 0 for invalid prices
        });
      } else {
        // Valid price - sync normally
        itemUpdates.push({
          sku: item.woltSku,
          enabled: item.rest > 0,
          price: item.price
        });

        inventoryUpdates.push({
          sku: item.woltSku,
          inventory: item.rest
        });
      }
    }

    // Log summary
    if (itemUpdates.length === 0) {
      log.warn(`[PrioritySync] No items to sync`);
      return 0;
    }

    if (invalidPriceCount > 0) {
      log.info(`[PrioritySync] Syncing ${itemUpdates.length} items (${invalidPriceCount} with invalid prices set to inventory=0)`);
    } else {
      log.info(`[PrioritySync] Syncing ${itemUpdates.length} items`);
    }

    // Sync with adaptive batching
    await this.adaptiveSync(store, itemUpdates, inventoryUpdates);

    // Mark successfully synced items in state
    const state = await this.stateManager.loadState(store.id);
    for (const sku of syncedSkus) {
      if (state[sku]) {
        (state[sku] as any).syncedToWolt = true;
      }
    }
    await this.stateManager.saveState(store.id, state);

    return itemUpdates.length;
  }

  /**
   * Adaptive sync with automatic batch size adjustment
   */
  private async adaptiveSync(
    store: StoreConfig,
    itemUpdates: WoltItemUpdate[],
    inventoryUpdates: WoltInventoryItem[]
  ): Promise<void> {
    const log = createStoreLogger(store.id);
    let currentBatchSize = this.adaptiveBatcher.getCurrentBatchSize(store.woltVenueId);

    // Phase 1: Items
    if (itemUpdates.length > 0) {
      log.info(`[AdaptiveSync] Sending ${itemUpdates.length} availability updates (initial batch: ${currentBatchSize})...`);

      for (let i = 0; i < itemUpdates.length; i += currentBatchSize) {
        const batch = itemUpdates.slice(i, i + currentBatchSize);
        const batchNum = Math.floor(i / currentBatchSize) + 1;
        const totalBatches = Math.ceil(itemUpdates.length / currentBatchSize);

        log.info(`[AdaptiveSync] Items batch ${batchNum}/${totalBatches} (${batch.length} items, batch size: ${currentBatchSize})...`);

        try {
          const result = await this.wolt.updateItems(
            store.woltVenueId,
            { data: batch },
            store.woltUsername,
            store.woltPassword,
            store.woltApiUrl
          );

          if (result.rateLimitHit) {
            currentBatchSize = this.adaptiveBatcher.onRateLimit(store.woltVenueId, 60000);
          } else {
            currentBatchSize = this.adaptiveBatcher.onSuccess(store.woltVenueId);
          }

        } catch (error: any) {
          // Handle rate limit in error
          if (error.response?.status === 429) {
            const retryAfter = error.response?.headers?.['retry-after'];
            currentBatchSize = this.adaptiveBatcher.onRateLimit(store.woltVenueId, parseInt(retryAfter || '60', 10) * 1000);
            // Retry this batch
            i -= currentBatchSize;
            continue;
          }
          throw error;
        }

        // Delay between batches
        if (i + currentBatchSize < itemUpdates.length) {
          const delay = this.adaptiveBatcher.getRecommendedDelay(store.woltVenueId);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // Phase 2: Inventory
    if (inventoryUpdates.length > 0) {
      log.info(`[AdaptiveSync] Sending ${inventoryUpdates.length} inventory updates...`);
      currentBatchSize = this.adaptiveBatcher.getCurrentBatchSize(store.woltVenueId);

      for (let i = 0; i < inventoryUpdates.length; i += currentBatchSize) {
        const batch = inventoryUpdates.slice(i, i + currentBatchSize);
        const batchNum = Math.floor(i / currentBatchSize) + 1;
        const totalBatches = Math.ceil(inventoryUpdates.length / currentBatchSize);

        log.info(`[AdaptiveSync] Inventory batch ${batchNum}/${totalBatches} (${batch.length} items, batch size: ${currentBatchSize})...`);

        try {
          await this.wolt.updateInventory(
            store.woltVenueId,
            { data: batch },
            store.woltUsername,
            store.woltPassword,
            store.woltApiUrl
          );

          currentBatchSize = this.adaptiveBatcher.onSuccess(store.woltVenueId);

        } catch (error: any) {
          if (error.response?.status === 429) {
            const retryAfter = error.response?.headers?.['retry-after'];
            currentBatchSize = this.adaptiveBatcher.onRateLimit(store.woltVenueId, parseInt(retryAfter || '60', 10) * 1000);
            i -= currentBatchSize;
            continue;
          }
          throw error;
        }

        if (i + currentBatchSize < inventoryUpdates.length) {
          const delay = this.adaptiveBatcher.getRecommendedDelay(store.woltVenueId);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
  }

  /**
   * Start background worker (non-blocking)
   */
  private startBackgroundWorker(): void {
    if (this.backgroundWorker) {
      // Run in background (don't await)
      this.backgroundWorker.start().catch(error => {
        const log = createStoreLogger(0);
        log.error(`[BackgroundWorker] Error: ${error.message}`);
      });
    }
  }

  /**
   * Get background worker progress
   */
  async getBackgroundWorkerProgress(store: StoreConfig): Promise<any> {
    if (!this.backgroundWorker) {
      this.backgroundWorker = new BackgroundWorker(store);
    }
    return this.backgroundWorker.getProgress();
  }

  /**
   * Stop background worker
   */
  stopBackgroundWorker(): void {
    if (this.backgroundWorker) {
      this.backgroundWorker.stop();
    }
  }
}
