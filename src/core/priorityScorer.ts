import { FinaInventoryItem, FinaProductDetail } from '../types';
import { logger } from '../utils/logger';

export interface PriorityScoredItem {
  id: number;
  rest: number;
  price: number;
  woltSku: string;
  priority: number;
  reason: string;
}

export interface PriorityConfig {
  inStockWeight: number;
  highStockWeight: number;
  highStockThreshold: number;
  highValueWeight: number;
  highValueThreshold: number;
  lowStockWeight: number;
  lowStockThreshold: number;
}

export class PriorityScorer {
  private config: PriorityConfig;

  constructor(config?: Partial<PriorityConfig>) {
    this.config = {
      inStockWeight: parseInt(process.env.PRIORITY_IN_STOCK_WEIGHT || '100', 10),
      highStockWeight: parseInt(process.env.PRIORITY_HIGH_STOCK_WEIGHT || '20', 10),
      highStockThreshold: parseInt(process.env.PRIORITY_HIGH_STOCK_THRESHOLD || '50', 10),
      highValueWeight: parseInt(process.env.PRIORITY_HIGH_VALUE_WEIGHT || '15', 10),
      highValueThreshold: parseFloat(process.env.PRIORITY_HIGH_VALUE_THRESHOLD || '50'),
      lowStockWeight: parseInt(process.env.PRIORITY_LOW_STOCK_WEIGHT || '10', 10),
      lowStockThreshold: parseInt(process.env.PRIORITY_LOW_STOCK_THRESHOLD || '5', 10),
      ...config
    };
  }

  /**
   * Calculate priority score for an item
   */
  calculatePriority(inventory: FinaInventoryItem, detail: FinaProductDetail): { score: number; reason: string } {
    let score = 0;
    const reasons: string[] = [];

    // CRITICAL: Items without valid prices cannot be synced to Wolt
    // Skip them entirely (they can't be listed for sale)
    if (typeof detail.price !== 'number' || detail.price < 0) {
      return { score: 0, reason: 'invalid-price' };
    }

    // Critical: In-stock items get highest priority
    if (inventory.rest > 0) {
      score += this.config.inStockWeight;
      reasons.push('in-stock');
    } else {
      // Out of stock items get lowest priority (but still tracked)
      return { score: 0, reason: 'out-of-stock' };
    }

    // High stock = popular/fast-moving item
    if (inventory.rest >= this.config.highStockThreshold) {
      score += this.config.highStockWeight;
      reasons.push('high-stock');
    }

    // Low stock = urgent (may sell out soon)
    if (inventory.rest > 0 && inventory.rest <= this.config.lowStockThreshold) {
      score += this.config.lowStockWeight;
      reasons.push('low-stock');
    }

    // High-value items (better margins, important for revenue)
    if (detail.price >= this.config.highValueThreshold) {
      score += this.config.highValueWeight;
      reasons.push('high-value');
    }

    return { score, reason: reasons.join(', ') };
  }

  /**
   * Score and sort all items by priority
   */
  scoreAndSort(
    inventory: FinaInventoryItem[],
    details: FinaProductDetail[],
    finaIdToWoltSku: Map<number, string>
  ): PriorityScoredItem[] {
    const detailMap = new Map(details.map(d => [d.id, d]));
    const scored: PriorityScoredItem[] = [];

    for (const item of inventory) {
      const detail = detailMap.get(item.id);
      if (!detail) continue;

      const woltSku = finaIdToWoltSku.get(item.id);
      if (!woltSku) continue;

      const { score, reason } = this.calculatePriority(item, detail);

      scored.push({
        id: item.id,
        rest: item.rest,
        price: detail.price,
        woltSku,
        priority: score,
        reason
      });
    }

    // Sort by priority descending (highest priority first)
    scored.sort((a, b) => b.priority - a.priority);

    // Log priority distribution
    const inStock = scored.filter(i => i.rest > 0).length;
    const highPriority = scored.filter(i => i.priority >= 100).length;
    const mediumPriority = scored.filter(i => i.priority >= 50 && i.priority < 100).length;
    const lowPriority = scored.filter(i => i.priority > 0 && i.priority < 50).length;

    logger.info(`[Priority] Scored ${scored.length} items: ${inStock} in-stock, ${highPriority} high-priority, ${mediumPriority} medium, ${lowPriority} low`);

    return scored;
  }

  /**
   * Get top N priority items
   */
  getTopPriority(scoredItems: PriorityScoredItem[], limit: number): PriorityScoredItem[] {
    // Filter out items with score 0 (out of stock, invalid price, etc.)
    const validItems = scoredItems.filter(item => item.priority > 0);

    if (validItems.length === 0) {
      logger.warn(`[Priority] No items with valid priority scores found (all items have score 0)`);
      return [];
    }

    const top = validItems.slice(0, limit);

    if (top.length > 0) {
      logger.info(`[Priority] Selected top ${top.length} items (priority range: ${top[0].priority} - ${top[top.length - 1].priority})`);
    }

    return top;
  }
}
