import axios, { AxiosInstance } from 'axios';
import { WOLT_API_BASE } from '../config/stores';
import { WoltInventoryUpdatePayload, WoltItemUpdatePayload } from '../types';
import { logger } from '../utils/logger';
import { withWoltApiRetry } from '../utils/retry';
import { woltCircuitBreaker } from '../utils/circuitBreaker';
import { WoltRateLimiter } from '../utils/woltRateLimiter';

type PQueueType = import('p-queue').default;

const tagWoltError = (error: any): void => {
  if (error && typeof error === 'object') {
    (error as any).isWoltError = true;
  }
};

export interface WoltApiResult {
  success: boolean;
  itemCount: number;
  rateLimitHit: boolean;
}

export interface WoltExistingItem {
  sku: string;
  enabled: boolean;
  price?: number;
  inventory?: number;
}

export class WoltAdapter {
  private queuePromise: Promise<PQueueType> | null = null;
  private readonly rateLimiters = new Map<string, WoltRateLimiter>();

  // Lazy-load p-queue so CommonJS builds don't crash on ESM-only dependency.
  private async getQueue(): Promise<PQueueType> {
    if (!this.queuePromise) {
      // Dynamic import for ESM-only p-queue module
      this.queuePromise = (async () => {
        const mod = await (Function('return import("p-queue")')() as Promise<typeof import('p-queue')>);
        return new mod.default({
          concurrency: 1
        });
      })();
    }
    return this.queuePromise;
  }

  private getRateLimiterKey(venueId: string, username?: string, baseUrl?: string): string {
    const base = baseUrl || WOLT_API_BASE;
    return `${base}::${venueId}::${username || 'unknown-user'}`;
  }

  private getRateLimiter(venueId: string, username?: string, baseUrl?: string): WoltRateLimiter {
    const key = this.getRateLimiterKey(venueId, username, baseUrl);
    const existing = this.rateLimiters.get(key);
    if (existing) {
      return existing;
    }
    const limiter = WoltRateLimiter.fromEnv(key);
    this.rateLimiters.set(key, limiter);
    return limiter;
  }

  private getClient(venueId: string, username?: string, password?: string, baseUrl?: string): AxiosInstance {
    if (!username || !password) {
      throw new Error(`Missing credentials for venue ${venueId}`);
    }

    // Base64 encode credentials for Basic Auth
    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    // Use provided baseUrl or default to constant, ensuring no trailing slash issues
    const base = baseUrl || WOLT_API_BASE;

    return axios.create({
      baseURL: `${base}/${venueId}`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json;charset=utf-8'
      },
      timeout: 30000
    });
  }

  async updateInventory(venueId: string, payload: WoltInventoryUpdatePayload, username?: string, password?: string, baseUrl?: string): Promise<WoltApiResult> {
    const queue = await this.getQueue();
    let rateLimitHit = false;
    const limiter = this.getRateLimiter(venueId, username, baseUrl);

    return queue.add(async () => {
      return woltCircuitBreaker.execute(async () => {
        return withWoltApiRetry(async () => {
          try {
            const client = this.getClient(venueId, username, password, baseUrl);
            await limiter.waitForTurn();
            await client.patch('/items/inventory', payload);
            limiter.onSuccess();
            logger.info(`[Wolt] Updated inventory for venue ${venueId} (${payload.data.length} items)`);
            return { success: true, itemCount: payload.data.length, rateLimitHit };
          } catch (error: any) {
            tagWoltError(error);
            const status = error.response?.status;
            if (status === 429) {
              rateLimitHit = true;
              limiter.onRateLimited(error.response?.headers?.['retry-after']);
              throw error;
            }

            if (status === 409) {
              logger.warn(`[Wolt] Inventory update ignored (409 Conflict - Duplicate). Treating as success.`);
              return { success: true, itemCount: payload.data.length, rateLimitHit };
            }

            // Avoid noisy error logs for retriable failures - the retry wrapper logs attempts.
            const isServerError = typeof status === 'number' && status >= 500 && status < 600;
            const isNetworkError = !error?.response;
            if (!isServerError && !isNetworkError) {
              logger.error({
                message: `[Wolt] Inventory Update Failed for ${venueId}`,
                error: error.message,
                status,
                responseData: error.response?.data
              });
            }
            throw error;
          }
        });
      });
    }) as Promise<WoltApiResult>;
  }

  // For full product updates (price, enabled status)
  async updateItems(venueId: string, payload: WoltItemUpdatePayload, username?: string, password?: string, baseUrl?: string): Promise<WoltApiResult> {
    const queue = await this.getQueue();
    let rateLimitHit = false;
    const limiter = this.getRateLimiter(venueId, username, baseUrl);

    return queue.add(async () => {
      return woltCircuitBreaker.execute(async () => {
        return withWoltApiRetry(async () => {
          try {
            const client = this.getClient(venueId, username, password, baseUrl);
            await limiter.waitForTurn();
            await client.patch('/items', payload);
            limiter.onSuccess();
            logger.info(`[Wolt] Updated items for venue ${venueId} (${payload.data.length} items)`);
            return { success: true, itemCount: payload.data.length, rateLimitHit };
          } catch (error: any) {
            tagWoltError(error);
            const status = error.response?.status;
            if (status === 429) {
              rateLimitHit = true;
              limiter.onRateLimited(error.response?.headers?.['retry-after']);
              throw error;
            }

            if (status === 409) {
              logger.warn(`[Wolt] Items update ignored (409 Conflict - Duplicate). Treating as success.`);
              return { success: true, itemCount: payload.data.length, rateLimitHit };
            }

            // Avoid noisy error logs for retriable failures - the retry wrapper logs attempts.
            const isServerError = typeof status === 'number' && status >= 500 && status < 600;
            const isNetworkError = !error?.response;
            if (!isServerError && !isNetworkError) {
              logger.error({
                message: `[Wolt] Items Update Failed for ${venueId}`,
                error: error.message,
                status,
                responseData: error.response?.data
              });
            }
            throw error;
          }
        });
      });
    }) as Promise<WoltApiResult>;
  }

  /**
   * Introspect Wolt to get existing items (Solution 3 - Smart Caching)
   * This allows us to bootstrap state from Wolt instead of doing full sync
   *
   * NOTE: This method attempts to query Wolt for existing items.
   * If the API doesn't support this endpoint, it will fail gracefully.
   */
  async introspectExistingItems(venueId: string, username?: string, password?: string, baseUrl?: string): Promise<WoltExistingItem[]> {
    const queue = await this.getQueue();
    const enableIntrospection = (process.env.ENABLE_WOLT_INTROSPECTION || 'true').toLowerCase() !== 'false';

    if (!enableIntrospection) {
      logger.info('[Wolt] Introspection disabled via config');
      return [];
    }

    return queue.add(async () => {
      try {
        const client = this.getClient(venueId, username, password, baseUrl);

        logger.info(`[Wolt] Attempting to introspect existing items for venue ${venueId}...`);

        // Try GET /items endpoint (may not be supported by all Wolt environments)
        const timeout = parseInt(process.env.WOLT_INTROSPECTION_TIMEOUT_MS || '120000', 10);
        const response = await client.get('/items', { timeout });

        const items: WoltExistingItem[] = [];

        // Handle different response formats
        if (Array.isArray(response.data)) {
          items.push(...response.data);
        } else if (response.data.items && Array.isArray(response.data.items)) {
          items.push(...response.data.items);
        } else if (response.data.data && Array.isArray(response.data.data)) {
          items.push(...response.data.data);
        }

        logger.info(`[Wolt] Successfully introspected ${items.length} existing items`);
        return items;

      } catch (error: any) {
        const status = error.response?.status;

        // 404 or 405 means endpoint not supported - this is OK
        if (status === 404 || status === 405) {
          logger.info('[Wolt] Introspection endpoint not supported by this Wolt environment (404/405)');
          return [];
        }

        // 403 might mean insufficient permissions
        if (status === 403) {
          logger.warn('[Wolt] Introspection forbidden (403) - may need different permissions');
          return [];
        }

        // Other errors - log but don't fail
        logger.warn(`[Wolt] Introspection failed: ${error.message} (will fall back to normal sync)`);
        return [];
      }
    }) as Promise<WoltExistingItem[]>;
  }
}
