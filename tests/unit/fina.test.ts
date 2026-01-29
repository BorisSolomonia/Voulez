import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinaAdapter } from '../../src/adapters/fina';
import { FinaProductDetail } from '../../src/types';

// Mock logger
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('FinaAdapter', () => {
  let adapter: FinaAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new FinaAdapter();
  });

  describe('mapToWoltSku', () => {
    it('should map Fina IDs to Wolt SKUs', () => {
      const details: FinaProductDetail[] = [
        { id: 101, title: 'P1', price: 100, add_fields: [{ field: 'usr_column_514', value: 'WOLT-001' }] },
        { id: 102, title: 'P2', price: 200, add_fields: [{ field: 'usr_column_514', value: 'WOLT-002' }] },
      ];

      const mapping = adapter.mapToWoltSku(details);

      expect(mapping.get(101)).toBe('WOLT-001');
      expect(mapping.get(102)).toBe('WOLT-002');
      expect(mapping.size).toBe(2);
    });

    it('should skip products without Wolt SKU field', () => {
      const details: FinaProductDetail[] = [
        { id: 101, title: 'P1', price: 100, add_fields: [{ field: 'other_field', value: 'other' }] },
        { id: 102, title: 'P2', price: 200, add_fields: [{ field: 'usr_column_514', value: 'WOLT-002' }] },
      ];

      const mapping = adapter.mapToWoltSku(details);

      expect(mapping.has(101)).toBe(false);
      expect(mapping.get(102)).toBe('WOLT-002');
      expect(mapping.size).toBe(1);
    });

    it('should handle products with empty add_fields', () => {
      const details: FinaProductDetail[] = [
        { id: 101, title: 'P1', price: 100, add_fields: [] },
      ];

      const mapping = adapter.mapToWoltSku(details);

      expect(mapping.size).toBe(0);
    });

    it('should handle products with null add_fields gracefully', () => {
      const details = [
        { id: 101, title: 'P1', price: 100, add_fields: null as any },
        { id: 102, title: 'P2', price: 200, add_fields: undefined as any },
      ];

      const mapping = adapter.mapToWoltSku(details);

      expect(mapping.size).toBe(0);
    });

    it('should skip add_fields entries with empty values', () => {
      const details: FinaProductDetail[] = [
        { id: 101, title: 'P1', price: 100, add_fields: [{ field: 'usr_column_514', value: '' }] },
        { id: 102, title: 'P2', price: 200, add_fields: [{ field: 'usr_column_514', value: 'WOLT-002' }] },
      ];

      const mapping = adapter.mapToWoltSku(details);

      expect(mapping.has(101)).toBe(false);
      expect(mapping.get(102)).toBe('WOLT-002');
    });

    it('should handle large datasets', () => {
      const details: FinaProductDetail[] = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        title: `Product ${i + 1}`,
        price: 100,
        add_fields: [{ field: 'usr_column_514', value: `WOLT-${i + 1}` }],
      }));

      const mapping = adapter.mapToWoltSku(details);

      expect(mapping.size).toBe(1000);
      expect(mapping.get(500)).toBe('WOLT-500');
    });
  });
});
