import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, withFinaAuthRetry, withWoltApiRetry } from '../../src/utils/retry';

// Mock logger
vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Retry Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await withRetry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');

      const resultPromise = withRetry(fn, { maxAttempts: 3, initialDelay: 100 });

      // Advance through retries
      await vi.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max attempts exceeded', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('always fail'));

      const resultPromise = withRetry(fn, { maxAttempts: 3, initialDelay: 100 });

      // Catch the rejection to avoid unhandled rejection warning
      resultPromise.catch(() => {});

      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow('always fail');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should respect retryIf predicate', async () => {
      const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });

      const resultPromise = withRetry(fn, {
        maxAttempts: 3,
        initialDelay: 100,
        retryIf: (error) => error.response?.status >= 500,
      });

      // Should throw immediately without retrying (400 doesn't match predicate)
      await expect(resultPromise).rejects.toEqual({ response: { status: 400 } });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should use exponential backoff', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');

      const resultPromise = withRetry(fn, {
        maxAttempts: 3,
        initialDelay: 1000,
        backoffFactor: 2,
      });

      // First attempt fails immediately
      await vi.advanceTimersByTimeAsync(0);

      // Wait for first delay (1000ms)
      await vi.advanceTimersByTimeAsync(1000);

      // Wait for second delay (2000ms with backoff)
      await vi.advanceTimersByTimeAsync(2000);

      const result = await resultPromise;
      expect(result).toBe('success');
    });

    it('should respect Retry-After header', async () => {
      const errorWithRetryAfter = {
        message: 'Rate limited',
        response: {
          status: 429,
          headers: { 'retry-after': '5' },
        },
      };

      const fn = vi.fn()
        .mockRejectedValueOnce(errorWithRetryAfter)
        .mockResolvedValue('success');

      const resultPromise = withRetry(fn, {
        maxAttempts: 2,
        initialDelay: 1000,
      });

      await vi.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toBe('success');
    });
  });

  describe('withFinaAuthRetry', () => {
    it('should use fixed delay intervals', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('auth fail'))
        .mockResolvedValue('token');

      const resultPromise = withFinaAuthRetry(fn);

      await vi.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toBe('token');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('withWoltApiRetry', () => {
    it('should retry on 5xx errors', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce({ response: { status: 500 } })
        .mockResolvedValue('success');

      const resultPromise = withWoltApiRetry(fn);

      await vi.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toBe('success');
    });

    it('should retry on 429 rate limit', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce({ response: { status: 429 } })
        .mockResolvedValue('success');

      const resultPromise = withWoltApiRetry(fn);

      await vi.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toBe('success');
    });

    it('should NOT retry on 4xx client errors (except 429)', async () => {
      const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });

      await expect(withWoltApiRetry(fn)).rejects.toEqual({ response: { status: 400 } });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on network errors (no response)', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const resultPromise = withWoltApiRetry(fn);

      await vi.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toBe('success');
    });
  });
});
