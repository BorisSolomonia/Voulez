import { logger } from './logger';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  retryIf?: (error: any) => boolean;
  onRetry?: (error: any, attempt: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryIf' | 'onRetry'>> = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;
  let delay = opts.initialDelay;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if should retry
      if (opts.retryIf && !opts.retryIf(error)) {
        throw error;
      }

      // Last attempt, throw
      if (attempt === opts.maxAttempts) {
        throw error;
      }

      // Check for Retry-After header
      let currentDelay = delay;
      const retryAfterHeader = error?.response?.headers ? error.response.headers['retry-after'] : null;
      if (retryAfterHeader) {
          const retrySeconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(retrySeconds)) {
              currentDelay = (retrySeconds * 1000) + 1000; // Wait requested time + 1s buffer
          }
      }

      // Call retry callback if provided
      if (opts.onRetry) {
        opts.onRetry(error, attempt);
      }

      // Log retry attempt
      logger.warn({
        message: 'Retrying after error',
        attempt,
        maxAttempts: opts.maxAttempts,
        delay: currentDelay,
        error: (error as any)?.message || String(error)
      });

      // Wait before retry
      await sleep(currentDelay);
      
      // Calculate next delay for standard backoff (if Retry-After wasn't used, or for next loop)
      // If Retry-After was used, we might want to reset backoff or continue?
      // Standard approach: continue exponential backoff for unknown errors, but respect header if present.
      delay = Math.min(delay * opts.backoffFactor, opts.maxDelay);
    }
  }

  throw lastError;
}

// Specific retry function for Fina auth (3 attempts, fixed 2s intervals)
export async function withFinaAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    maxAttempts: 3,
    initialDelay: 2000,
    backoffFactor: 1, // Fixed delay (2s, 2s, 2s)
    onRetry: (error, attempt) => {
      logger.warn(`Fina auth failed (attempt ${attempt}/3), retrying...`);
    }
  });
}

// Specific retry function for Wolt API
export async function withWoltApiRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    maxAttempts: 8, // Increased from 3 to 8
    initialDelay: 2000, // Start with 2s delay
    backoffFactor: 2, // Exponential (2s, 4s, 8s, 16s...)
    retryIf: (error) => {
      const status = error?.response?.status;
      // Retry on:
      // 1. Server errors (500-599)
      // 2. Rate limiting (429)
      // 3. Network errors (no response object - ECONNRESET, ETIMEDOUT, etc.)
      // Note: 409 (Conflict) is explicitly NOT retried as it often means "Duplicate Request - Already Processed"
      const isServerError = typeof status === 'number' && status >= 500 && status < 600;
      const isRateLimited = status === 429;
      const isNetworkError = !error?.response; // No response = network level failure
      return isServerError || isRateLimited || isNetworkError;
    },
    onRetry: (error, attempt) => {
      const status = error?.response?.status || 'Network Error';
      const data = error?.response?.data ? JSON.stringify(error.response.data) : '';
      const retryAfter = error?.response?.headers ? error.response.headers['retry-after'] : null;
      
      let msg = `Wolt API error ${status} (attempt ${attempt}/8)`;
      if (retryAfter) {
          msg += ` [Rate Limited! Waiting ${retryAfter}s]`;
      }
      logger.warn(`${msg} Details: ${data}`);
    }
  });
}
