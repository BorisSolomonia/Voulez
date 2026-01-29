import axios, { AxiosInstance } from 'axios';
import { FINA_API_URL, FINA_LOGIN, FINA_PASSWORD } from '../config/stores';
import { FinaInventoryItem, FinaProductDetail } from '../types';
import { logger } from '../utils/logger';
import { withFinaAuthRetry, withRetry } from '../utils/retry';
import { finaCircuitBreaker } from '../utils/circuitBreaker';

const tagFinaError = (error: any): void => {
  if (error && typeof error === 'object') {
    (error as any).isFinaError = true;
  }
};

export class FinaAdapter {
  private client: AxiosInstance;
  private token: string | null = null;

  constructor() {
    logger.info(`[FinaAdapter] Initializing with Base URL: '${FINA_API_URL}'`);
    this.client = axios.create({
      baseURL: FINA_API_URL,
      timeout: 30000,
    });
  }

  async authenticate(): Promise<{ durationMs: number }> {
    const startTime = Date.now();
    try {
      const response = await finaCircuitBreaker.execute(async () => {
        return await withFinaAuthRetry(async () => {
          return await this.client.post('/authentication/authenticate', {
            login: FINA_LOGIN,
            password: FINA_PASSWORD,
          });
        });
      });
      this.token = response.data.token;
      if (!this.token) {
        throw new Error('Fina authentication returned no token');
      }
      logger.info('Fina authentication successful');
      return { durationMs: Date.now() - startTime };
    } catch (error: any) {
      tagFinaError(error);
      logger.error(`Fina Auth Failed after retries: ${error.message} (URL: ${FINA_API_URL}/authentication/authenticate)`);
      this.token = null;
      throw error;
    }
  }

  async getInventory(storeId: number): Promise<{ items: FinaInventoryItem[]; durationMs: number }> {
    if (!this.token) await this.authenticate();

    const startTime = Date.now();
    const items = await finaCircuitBreaker.execute(async () => {
      return withRetry(async () => {
        try {
          const response = await this.client.get(`/operation/getProductsRestByStore/${storeId}`, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          return response.data.store_rest || [];
        } catch (error: any) {
          tagFinaError(error);
          logger.error(`Fina Inventory Fetch Failed (Store ${storeId}): ${error.message}`);
          if (error.response?.status === 401) {
            this.token = null; // Force re-auth next time
            await this.authenticate(); // Try to re-authenticate
            if (!this.token) {
              throw new Error('Fina re-authentication failed');
            }
          }
          throw error;
        }
      }, { maxAttempts: 3, initialDelay: 2000, backoffFactor: 2 });
    });

    return { items, durationMs: Date.now() - startTime };
  }

  async getProductDetails(ids: number[]): Promise<{ products: FinaProductDetail[]; durationMs: number; apiCalls: number }> {
    if (!this.token) await this.authenticate();

    const startTime = Date.now();
    const chunkSize = 1000;
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    const allDetails: FinaProductDetail[] = [];
    let apiCalls = 0;

    for (const chunk of chunks) {
      try {
        apiCalls++;
        // Retry logic for details fetch with circuit breaker
        const response = await finaCircuitBreaker.execute(async () => {
          return await withRetry(async () => {
               try {
                 return await this.client.post('/operation/getProductsArray', chunk, {
                   headers: { Authorization: `Bearer ${this.token}` },
                 });
               } catch (error: any) {
                 tagFinaError(error);
                 if (error.response?.status === 401) {
                   this.token = null; // Force re-auth next time
                   await this.authenticate(); // Try to re-authenticate
                   if (!this.token) {
                     throw new Error('Fina re-authentication failed');
                   }
                 }
                 throw error;
               }
          }, {
              maxAttempts: 3,
              initialDelay: 1000,
              retryIf: (err) =>
                !err.response ||
                err.response.status >= 500 ||
                err.response.status === 429 ||
                err.response.status === 401
          });
        });

        if (response.data.products) {
          allDetails.push(...response.data.products);
        }
      } catch (error: any) {
        logger.error(`Fina Details Fetch Failed (Chunk): ${error.message}`);
        // We continue to next chunk to get partial data at least.
      }
    }
    return { products: allDetails, durationMs: Date.now() - startTime, apiCalls };
  }

  // Helper to map Fina ID -> Wolt SKU (using usr_column_514 logic from Glovo project)
  mapToWoltSku(details: FinaProductDetail[]): Map<number, string> {
    const map = new Map<number, string>();
    for (const product of details) {
      // Safety check: ensure add_fields exists and is an array
      if (Array.isArray(product.add_fields)) {
          const woltField = product.add_fields.find(f => f && f.field === 'usr_column_514');
          if (woltField && woltField.value) {
            map.set(product.id, woltField.value);
          }
      }
    }
    return map;
  }
}
