import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEngine } from '../../src/core/sync';
import { StoreConfig } from '../../src/types';

// Mock timers to speed up tests
vi.useFakeTimers();

// Mock metrics collector
vi.mock('../../src/utils/metrics', () => {
  return {
    metricsCollector: {
      startSync: vi.fn(),
      endSync: vi.fn(),
      recordFinaInventory: vi.fn(),
      recordFinaDetails: vi.fn(),
      recordFinaError: vi.fn(),
      recordWoltItemsUpdate: vi.fn(),
      recordWoltInventoryUpdate: vi.fn(),
      recordWoltError: vi.fn(),
      recordWoltRateLimit: vi.fn(),
      recordChanges: vi.fn()
    }
  };
});

// Mock Adapters - updated to return new structure
vi.mock('../../src/adapters/fina', () => {
  return {
    FinaAdapter: vi.fn().mockImplementation(() => ({
      getInventory: vi.fn().mockResolvedValue({
        items: [
          { id: 101, rest: 5, store_id: 1 },
          { id: 102, rest: 0, store_id: 1 }
        ],
        durationMs: 100
      }),
      getProductDetails: vi.fn().mockResolvedValue({
        products: [
          { id: 101, price: 100, add_fields: [{ field: 'usr_column_514', value: 'WOLT-101' }] },
          { id: 102, price: 200, add_fields: [{ field: 'usr_column_514', value: 'WOLT-102' }] }
        ],
        durationMs: 500,
        apiCalls: 1
      }),
      mapToWoltSku: vi.fn().mockReturnValue(new Map([
        [101, 'WOLT-101'],
        [102, 'WOLT-102']
      ]))
    }))
  };
});

vi.mock('../../src/adapters/wolt', () => {
  return {
    WoltAdapter: vi.fn().mockImplementation(() => ({
      updateInventory: vi.fn().mockResolvedValue({ success: true, itemCount: 2, rateLimitHit: false }),
      updateItems: vi.fn().mockResolvedValue({ success: true, itemCount: 2, rateLimitHit: false })
    }))
  };
});

vi.mock('../../src/core/state', () => {
  return {
    StateManager: vi.fn().mockImplementation(() => ({
      loadState: vi.fn().mockResolvedValue({
        'WOLT-101': { quantity: 10, lastSeen: 0 } // Was 10, now 5 -> Change!
      }),
      saveState: vi.fn().mockResolvedValue(undefined)
    }))
  };
});

describe('SyncEngine', () => {
  let engine: SyncEngine;
  const mockStore: StoreConfig = {
    id: 1,
    name: 'Test Store',
    woltVenueId: 'test-venue',
    woltUsername: 'user',
    woltPassword: 'pass',
    enabled: true
  };

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new SyncEngine();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  it('should detect inventory changes and call Wolt API', async () => {
    // We mocked Fina to return quantity 5 for WOLT-101.
    // We mocked State to say previous quantity was 10.
    // So it SHOULD call updateInventory.

    // Run sync with fake timers - advance timers as needed
    const syncPromise = engine.run(mockStore);

    // Advance timers to complete all the delays in sync
    await vi.runAllTimersAsync();

    await syncPromise;

    // Access the mocked instance
    const woltAdapter = (engine as any).wolt;
    expect(woltAdapter.updateInventory).toHaveBeenCalled();

    // Check payload
    const payload = woltAdapter.updateInventory.mock.calls[0][1];
    expect(payload.data).toEqual(expect.arrayContaining([
      { sku: 'WOLT-101', inventory: 5 },
      { sku: 'WOLT-102', inventory: 0 } // New item? Or just changed? State didn't have it, so it's a change.
    ]));
  }, 30000); // Increase timeout to 30s

  it('should call updateItems for availability changes', async () => {
    const syncPromise = engine.run(mockStore);
    await vi.runAllTimersAsync();
    await syncPromise;

    const woltAdapter = (engine as any).wolt;
    expect(woltAdapter.updateItems).toHaveBeenCalled();
  }, 30000);

  it('should not sync if store is disabled', async () => {
    const disabledStore = { ...mockStore, enabled: false };

    await engine.run(disabledStore);

    const woltAdapter = (engine as any).wolt;
    expect(woltAdapter.updateInventory).not.toHaveBeenCalled();
    expect(woltAdapter.updateItems).not.toHaveBeenCalled();
  });
});
