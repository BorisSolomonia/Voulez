import { FinaAdapter } from '../adapters/fina';
import { WoltAdapter } from '../adapters/wolt';
import { StateManager } from './state';
import { StoreConfig, SyncState, WoltInventoryItem, WoltItemUpdate } from '../types';
import { createStoreLogger } from '../utils/logger';
import { metricsCollector } from '../utils/metrics';
import { CircuitBreakerError } from '../utils/circuitBreaker';

export interface SyncOptions {
  dryRun?: boolean;
  limit?: number;
  forceFullSync?: boolean;  // Force sending all items (for first sync or recovery)
  bootstrapState?: boolean; // Create state without sending to Wolt (for initial setup)
}

export class SyncEngine {
  private fina: FinaAdapter;
  private wolt: WoltAdapter;
  private stateManager: StateManager;
  private readonly defaultBatchSize: number;
  private readonly defaultBatchDelayMs: number;
  private readonly defaultFirstSyncBatchSize: number;
  private readonly defaultFirstSyncBatchDelayMs: number;

  constructor() {
    this.fina = new FinaAdapter();
    this.wolt = new WoltAdapter();
    this.stateManager = new StateManager();

    // Global defaults (can be overridden per-store via env vars).
    const envBatchSize = parseInt(process.env.WOLT_BATCH_SIZE || '', 10);
    const envBatchDelay = parseInt(process.env.WOLT_BATCH_DELAY_MS || '', 10);
    this.defaultBatchSize = Number.isFinite(envBatchSize) && envBatchSize > 0 ? envBatchSize : 50;
    this.defaultBatchDelayMs = Number.isFinite(envBatchDelay) && envBatchDelay > 0 ? envBatchDelay : 2000;

    const envFirstBatchSize = parseInt(process.env.WOLT_FIRST_SYNC_BATCH_SIZE || '', 10);
    const envFirstBatchDelay = parseInt(process.env.WOLT_FIRST_SYNC_BATCH_DELAY_MS || '', 10);
    this.defaultFirstSyncBatchSize = Number.isFinite(envFirstBatchSize) && envFirstBatchSize > 0 ? envFirstBatchSize : 1;
    this.defaultFirstSyncBatchDelayMs = Number.isFinite(envFirstBatchDelay) && envFirstBatchDelay > 0 ? envFirstBatchDelay : 10000;
  }

  private static readPositiveInt(envKey: string): number | undefined {
    const raw = process.env[envKey];
    if (typeof raw !== 'string' || raw.trim() === '') {
      return undefined;
    }
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private resolveBatchConfig(storeId: number, isFirstSync: boolean): { batchSize: number; batchDelayMs: number } {
    const storePrefix = `STORE_${storeId}_`;

    if (isFirstSync) {
      const batchSize =
        SyncEngine.readPositiveInt(`${storePrefix}WOLT_FIRST_SYNC_BATCH_SIZE`) ??
        this.defaultFirstSyncBatchSize;
      const batchDelayMs =
        SyncEngine.readPositiveInt(`${storePrefix}WOLT_FIRST_SYNC_BATCH_DELAY_MS`) ??
        this.defaultFirstSyncBatchDelayMs;
      return { batchSize, batchDelayMs };
    }

    const batchSize = SyncEngine.readPositiveInt(`${storePrefix}WOLT_BATCH_SIZE`) ?? this.defaultBatchSize;
    const batchDelayMs = SyncEngine.readPositiveInt(`${storePrefix}WOLT_BATCH_DELAY_MS`) ?? this.defaultBatchDelayMs;
    return { batchSize, batchDelayMs };
  }

  async run(store: StoreConfig, dryRun: boolean = false, limit?: number): Promise<void> {
    return this.runWithOptions(store, { dryRun, limit });
  }

  async runWithOptions(store: StoreConfig, options: SyncOptions = {}): Promise<void> {
    let { dryRun = false, limit, forceFullSync = false, bootstrapState = false } = options;
    const log = createStoreLogger(store.id);

    // Start metrics collection
    metricsCollector.startSync(store.id, store.name);

    if (!store.enabled) {
      log.info('Store disabled, skipping.');
      metricsCollector.endSync(store.id, 'success');
      return;
    }

    let newItemCount = 0;
    let missingItemCount = 0;

    try {
      // 1. Load State
      const previousState = await this.stateManager.loadState(store.id);
      const previousStateCount = Object.keys(previousState).length;
      const isFirstSync = previousStateCount === 0;

      if (isFirstSync && !forceFullSync && !bootstrapState) {
        forceFullSync = true;
        log.warn('No previous state found. Running FULL SYNC with throttled pacing. This may take several hours.');
      }

      const modeDesc = bootstrapState ? 'Bootstrap State' : (forceFullSync ? 'Full Sync' : 'Delta Sync');
      log.info(`Starting ${modeDesc}... (Dry Run: ${dryRun}, Limit: ${limit || 'Unlimited'})`);

      // 2. Fetch Fina Data
      log.info('Fetching Fina inventory...');
      const inventoryResult = await this.fina.getInventory(store.id);
      metricsCollector.recordFinaInventory(store.id, inventoryResult.items.length, inventoryResult.durationMs);

      if (inventoryResult.items.length === 0) {
        log.warn('No inventory found in Fina. Aborting sync to prevent zeroing out everything.');
        metricsCollector.recordFinaError(store.id, 'No inventory returned');
        metricsCollector.endSync(store.id, 'error');
        return;
      }

      const inventory = inventoryResult.items;
      const productIds = inventory.map(i => i.id);
      log.info(`Fetching details for ${productIds.length} products...`);

      const detailsResult = await this.fina.getProductDetails(productIds);

      const details = detailsResult.products;
      if (details.length < productIds.length) {
        log.error(`Only received ${details.length}/${productIds.length} product details. Aborting to avoid disabling valid items.`);
        metricsCollector.recordFinaError(store.id, `Partial data: ${details.length}/${productIds.length}`);
        metricsCollector.endSync(store.id, 'error');
        const partialError = new Error('Partial product details received from Fina');
        (partialError as any).isFinaError = true;
        (partialError as any).metricsRecorded = true;
        throw partialError;
      }

      // 3. Map Data
      const stockMap = new Map<number, number>();
      inventory.forEach(i => stockMap.set(i.id, i.rest));

      const woltData = new Map<string, { quantity: number, price: number, enabled: boolean }>();

      const finaIdToWoltSku = this.fina.mapToWoltSku(details);
      metricsCollector.recordFinaDetails(store.id, finaIdToWoltSku.size, detailsResult.durationMs, detailsResult.apiCalls);
      log.info(`Found ${finaIdToWoltSku.size} products with Wolt SKU mapping (out of ${details.length} total).`);

      for (const product of details) {
        const woltSku = finaIdToWoltSku.get(product.id);
        if (!woltSku) continue;

        const quantity = stockMap.get(product.id) || 0;
        const enabled = quantity > 0;

        if (!woltData.has(woltSku)) {
          woltData.set(woltSku, {
            quantity,
            price: product.price,
            enabled
          });
        } else {
          const existing = woltData.get(woltSku)!;
          existing.quantity += quantity;
          existing.price = product.price;
          existing.enabled = existing.quantity > 0;
        }
      }

      // 4. Detect Changes (DELTA SYNC LOGIC)
      let inventoryUpdates: WoltInventoryItem[] = [];
      let itemUpdates: WoltItemUpdate[] = [];
      const newState: SyncState = {};
      const now = Date.now();

      for (const [sku, data] of woltData.entries()) {
        // Add to new state
        newState[sku] = { quantity: data.quantity, enabled: data.enabled, price: data.price, lastSeen: now };

        const prev = previousState[sku];

        if (forceFullSync && !bootstrapState) {
          if (!prev) {
            newItemCount++;
          }
          inventoryUpdates.push({ sku, inventory: data.quantity });
          itemUpdates.push({ sku, enabled: data.enabled, price: data.price });
          continue;
        }

        // Track new items (delta mode)
        if (!prev) {
          newItemCount++;
          if (!bootstrapState) {
            inventoryUpdates.push({ sku, inventory: data.quantity });
            itemUpdates.push({ sku, enabled: data.enabled, price: data.price });
          }
          continue;
        }

        // DELTA: Only send if actually changed
        if (prev.quantity !== data.quantity) {
          inventoryUpdates.push({ sku, inventory: data.quantity });
        }

        if (prev.enabled !== data.enabled || prev.price !== data.price) {
          itemUpdates.push({ sku, enabled: data.enabled, price: data.price });
        }
      }

      // 5. Detect Missing Items (items in state but not in Fina)
      for (const [sku, prev] of Object.entries(previousState)) {
        if (!woltData.has(sku)) {
          log.warn(`Item ${sku} missing from Fina feed. Disabling and setting inventory to 0.`);
          if (!bootstrapState) {
            inventoryUpdates.push({ sku, inventory: 0 });
            itemUpdates.push({ sku, enabled: false });
          }
          newState[sku] = { quantity: 0, enabled: false, price: prev.price, lastSeen: now };
          missingItemCount++;
        }
      }

      // Record change metrics
      metricsCollector.recordChanges(store.id, itemUpdates.length, inventoryUpdates.length, newItemCount, missingItemCount);

      // Log delta summary
      const updatedSkus = new Set<string>();
      itemUpdates.forEach(update => updatedSkus.add(update.sku));
      inventoryUpdates.forEach(update => updatedSkus.add(update.sku));

      const totalProducts = woltData.size;
      let changedCount = 0;
      for (const sku of woltData.keys()) {
        if (updatedSkus.has(sku)) {
          changedCount++;
        }
      }
      const unchangedCount = totalProducts - changedCount;
      const cacheHit = totalProducts > 0
        ? ((unchangedCount / totalProducts) * 100).toFixed(1)
        : '0.0';
      log.info(`Delta Analysis: ${totalProducts} total products, ${changedCount} changed, ${unchangedCount} unchanged (${cacheHit}% cache hit)`);

      // Bootstrap mode - just save state, don't send to Wolt
      if (bootstrapState) {
        log.info(`BOOTSTRAP MODE: Saving state for ${Object.keys(newState).length} products without sending to Wolt.`);
        if (!dryRun) {
          await this.stateManager.saveState(store.id, newState);
          log.info('Bootstrap state saved. Next sync will only send changes.');
        }
        metricsCollector.endSync(store.id, 'success');
        return;
      }

      // Apply Limit
      if (limit && limit > 0) {
        if (itemUpdates.length > limit) {
          log.info(`Limiting availability updates from ${itemUpdates.length} to ${limit}.`);
          itemUpdates = itemUpdates.slice(0, limit);
        }
        if (inventoryUpdates.length > limit) {
          log.info(`Limiting inventory updates from ${inventoryUpdates.length} to ${limit}.`);
          inventoryUpdates = inventoryUpdates.slice(0, limit);
        }
      }

      // 6. Execute Sync (Two-Phase) - Only if there are actual changes
      let woltItemsApiCalls = 0;
      let woltInventoryApiCalls = 0;
      const useFirstSyncBatch = isFirstSync || forceFullSync;
      const { batchSize: effectiveBatchSize, batchDelayMs: effectiveBatchDelay } = this.resolveBatchConfig(store.id, useFirstSyncBatch);
      const itemsStartTime = Date.now();

      // Helper to update state partially
      const updateSyncedState = async (syncedSkus: string[]) => {
        if (dryRun || limit) return;
        for (const sku of syncedSkus) {
          const current = newState[sku];
          if (current) {
            // Persist only what we know is confirmed on Wolt.
            previousState[sku] = { ...current };
          }
        }
        await this.stateManager.saveState(store.id, { ...previousState });
      };

      // Phase 1: Availability (Items API)
      if (itemUpdates.length > 0) {
        log.info(`Sending ${itemUpdates.length} availability updates in batches of ${effectiveBatchSize}...`);
        if (!dryRun) {
          const totalBatches = Math.ceil(itemUpdates.length / effectiveBatchSize);
          for (let i = 0; i < itemUpdates.length; i += effectiveBatchSize) {
            const batchNum = Math.floor(i / effectiveBatchSize) + 1;
            const batch = itemUpdates.slice(i, i + effectiveBatchSize);
            log.info(`Items batch ${batchNum}/${totalBatches} (${batch.length} items)...`);

            const result = await this.wolt.updateItems(store.woltVenueId, { data: batch }, store.woltUsername, store.woltPassword, store.woltApiUrl);
            woltItemsApiCalls++;
            
            // Success! Update local state so we don't retry these if we crash later
            await updateSyncedState(batch.map(item => item.sku));

            if (result.rateLimitHit) {
              metricsCollector.recordWoltRateLimit(store.id);
            }
            // Delay between batches
            if (i + effectiveBatchSize < itemUpdates.length) {
              await new Promise(r => setTimeout(r, effectiveBatchDelay));
            }
          }
        }
      } else {
        log.info('No availability changes to send.');
      }

      metricsCollector.recordWoltItemsUpdate(store.id, itemUpdates.length, Date.now() - itemsStartTime, woltItemsApiCalls);

      if (!dryRun && itemUpdates.length > 0 && inventoryUpdates.length > 0) {
        log.info('Waiting 3s before inventory updates...');
        await new Promise(r => setTimeout(r, 3000));
      }

      const inventoryStartTime = Date.now();

      // Phase 2: Inventory (Inventory API)
      if (inventoryUpdates.length > 0) {
        log.info(`Sending ${inventoryUpdates.length} inventory updates in batches of ${effectiveBatchSize}...`);
        if (!dryRun) {
          const totalBatches = Math.ceil(inventoryUpdates.length / effectiveBatchSize);
          for (let i = 0; i < inventoryUpdates.length; i += effectiveBatchSize) {
            const batchNum = Math.floor(i / effectiveBatchSize) + 1;
            const batch = inventoryUpdates.slice(i, i + effectiveBatchSize);
            log.info(`Inventory batch ${batchNum}/${totalBatches} (${batch.length} items)...`);

            const result = await this.wolt.updateInventory(store.woltVenueId, { data: batch }, store.woltUsername, store.woltPassword, store.woltApiUrl);
            woltInventoryApiCalls++;

            // Success! Update local state
            await updateSyncedState(batch.map(item => item.sku));

            if (result.rateLimitHit) {
              metricsCollector.recordWoltRateLimit(store.id);
            }
            // Delay between batches
            if (i + effectiveBatchSize < inventoryUpdates.length) {
              await new Promise(r => setTimeout(r, effectiveBatchDelay));
            }
          }
        }
      } else {
        log.info('No inventory changes to send.');
      }

      metricsCollector.recordWoltInventoryUpdate(store.id, inventoryUpdates.length, Date.now() - inventoryStartTime, woltInventoryApiCalls);

      // 7. Save Final State
      if (!dryRun) {
        if (!limit) {
          await this.stateManager.saveState(store.id, newState);
          log.info('Final state saved.');
        } else {
          log.warn('State NOT saved because sync was limited (partial sync).');
        }
      }

      // End metrics - success
      metricsCollector.endSync(store.id, 'success');

    } catch (error: any) {
      const message = error?.message || String(error);
      if (!error?.metricsRecorded) {
        if (error instanceof CircuitBreakerError) {
          const circuitName = error.circuitName.toLowerCase();
          if (circuitName.includes('fina')) {
            metricsCollector.recordFinaError(store.id, message);
          } else if (circuitName.includes('wolt')) {
            metricsCollector.recordWoltError(store.id, message);
          } else {
            metricsCollector.recordWoltError(store.id, message);
          }
        } else if (error?.isFinaError) {
          metricsCollector.recordFinaError(store.id, message);
        } else if (error?.isWoltError) {
          metricsCollector.recordWoltError(store.id, message);
        } else {
          metricsCollector.recordWoltError(store.id, message);
        }
      }
      metricsCollector.endSync(store.id, 'error');
      throw error;
    }
  }

  // Bootstrap state for a store without sending to Wolt
  async bootstrapState(store: StoreConfig): Promise<void> {
    return this.runWithOptions(store, { bootstrapState: true });
  }

  // Force full sync (for initial setup or recovery)
  async forceFullSync(store: StoreConfig, limit?: number): Promise<void> {
    return this.runWithOptions(store, { forceFullSync: true, limit });
  }
}
