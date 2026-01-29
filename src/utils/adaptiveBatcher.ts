import fs from 'fs-extra';
import path from 'path';
import { logger } from './logger';

export interface AdaptiveBatchConfig {
  currentBatchSize: number;
  minBatchSize: number;
  maxBatchSize: number;
  successStreak: number;
  failureStreak: number;
  lastRateLimitAt: number;
  optimalBatchSize: number;
  totalRequests: number;
  totalRateLimits: number;
}

interface AdaptiveBatchState {
  [venueId: string]: AdaptiveBatchConfig;
}

export class AdaptiveBatcher {
  private static readonly STATE_FILE = path.join(process.cwd(), 'state', 'adaptive-batch.json');
  private config: Map<string, AdaptiveBatchConfig> = new Map();
  private readonly increaseThreshold: number;
  private readonly increaseRate: number;
  private readonly decreaseRate: number;

  constructor() {
    this.increaseThreshold = parseInt(process.env.ADAPTIVE_INCREASE_THRESHOLD || '10', 10);
    this.increaseRate = parseFloat(process.env.ADAPTIVE_INCREASE_RATE || '1.1');
    this.decreaseRate = parseFloat(process.env.ADAPTIVE_DECREASE_RATE || '0.5');
    this.loadState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(AdaptiveBatcher.STATE_FILE)) {
        const state: AdaptiveBatchState = fs.readJsonSync(AdaptiveBatcher.STATE_FILE);
        for (const [venueId, config] of Object.entries(state)) {
          this.config.set(venueId, config);
        }
        logger.debug('[AdaptiveBatcher] Loaded state for ${Object.keys(state).length} venues');
      }
    } catch (error) {
      logger.warn('[AdaptiveBatcher] Failed to load state, starting fresh');
    }
  }

  private saveState(): void {
    try {
      fs.ensureDirSync(path.dirname(AdaptiveBatcher.STATE_FILE));
      const state: AdaptiveBatchState = {};
      for (const [venueId, config] of this.config.entries()) {
        state[venueId] = config;
      }
      fs.writeJsonSync(AdaptiveBatcher.STATE_FILE, state, { spaces: 2 });
    } catch (error) {
      logger.warn(`[AdaptiveBatcher] Failed to save state: ${(error as Error).message}`);
    }
  }

  private initConfig(venueId: string): AdaptiveBatchConfig {
    const initialBatchSize = parseInt(process.env.ADAPTIVE_INITIAL_BATCH_SIZE || '1000', 10);
    const minBatchSize = parseInt(process.env.ADAPTIVE_MIN_BATCH_SIZE || '10', 10);
    const maxBatchSize = parseInt(process.env.ADAPTIVE_MAX_BATCH_SIZE || '5000', 10);

    const config: AdaptiveBatchConfig = {
      currentBatchSize: initialBatchSize,
      minBatchSize,
      maxBatchSize,
      successStreak: 0,
      failureStreak: 0,
      lastRateLimitAt: 0,
      optimalBatchSize: initialBatchSize,
      totalRequests: 0,
      totalRateLimits: 0
    };

    this.config.set(venueId, config);
    this.saveState();
    return config;
  }

  /**
   * Get current batch size for a venue
   */
  getCurrentBatchSize(venueId: string): number {
    let config = this.config.get(venueId);
    if (!config) {
      config = this.initConfig(venueId);
    }
    return config.currentBatchSize;
  }

  /**
   * Adjust batch size after successful request
   */
  onSuccess(venueId: string): number {
    let config = this.config.get(venueId);
    if (!config) {
      config = this.initConfig(venueId);
    }

    config.successStreak++;
    config.failureStreak = 0;
    config.totalRequests++;

    // After N consecutive successes, try increasing batch size
    if (config.successStreak >= this.increaseThreshold) {
      const oldSize = config.currentBatchSize;
      config.currentBatchSize = Math.min(
        Math.floor(config.currentBatchSize * this.increaseRate),
        config.maxBatchSize
      );

      if (config.currentBatchSize > oldSize) {
        logger.info(`[AdaptiveBatcher] ${venueId}: Increased batch size ${oldSize} → ${config.currentBatchSize} (${config.successStreak} successes)`);
      }

      config.successStreak = 0;
    }

    // Track optimal (most successful size)
    if (config.successStreak > 5) {
      config.optimalBatchSize = config.currentBatchSize;
    }

    this.saveState();
    return config.currentBatchSize;
  }

  /**
   * Adjust batch size after rate limit hit
   */
  onRateLimit(venueId: string, retryAfterMs: number): number {
    let config = this.config.get(venueId);
    if (!config) {
      config = this.initConfig(venueId);
    }

    config.failureStreak++;
    config.successStreak = 0;
    config.lastRateLimitAt = Date.now();
    config.totalRequests++;
    config.totalRateLimits++;

    const oldSize = config.currentBatchSize;
    config.currentBatchSize = Math.max(
      Math.floor(config.currentBatchSize * this.decreaseRate),
      config.minBatchSize
    );

    logger.warn(
      `[AdaptiveBatcher] ${venueId}: Rate limited! Reduced batch size ${oldSize} → ${config.currentBatchSize} ` +
      `(retry after ${Math.ceil(retryAfterMs / 1000)}s, total rate limits: ${config.totalRateLimits})`
    );

    this.saveState();
    return config.currentBatchSize;
  }

  /**
   * Get recommended delay between batches based on recent history
   */
  getRecommendedDelay(venueId: string): number {
    const config = this.config.get(venueId);
    if (!config) {
      return parseInt(process.env.WOLT_BATCH_DELAY_MS || '2000', 10);
    }

    const timeSinceRateLimit = Date.now() - config.lastRateLimitAt;
    const fiveMinutes = 5 * 60 * 1000;

    // If rate limited recently, be more conservative
    if (timeSinceRateLimit < fiveMinutes) {
      return 5000; // 5 second delay
    }

    // Normal operation
    return parseInt(process.env.WOLT_BATCH_DELAY_MS || '2000', 10);
  }

  /**
   * Get statistics for a venue
   */
  getStats(venueId: string): AdaptiveBatchConfig | null {
    return this.config.get(venueId) || null;
  }

  /**
   * Reset configuration for a venue (useful for testing)
   */
  reset(venueId: string): void {
    this.config.delete(venueId);
    this.saveState();
    logger.info(`[AdaptiveBatcher] ${venueId}: Reset configuration`);
  }

  /**
   * Get all venue statistics
   */
  getAllStats(): Map<string, AdaptiveBatchConfig> {
    return new Map(this.config);
  }
}
