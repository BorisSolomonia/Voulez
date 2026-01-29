import fs from 'fs-extra';
import path from 'path';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface WoltRateLimiterOptions {
  minIntervalMs: number;
  retryAfterBufferMs: number;
  retryAfterJitterMs: number;
  learnMinIntervalFromRetryAfter: boolean;
  enforceLearnedMinIntervalAfterSuccess: boolean;
  maxLearnedMinIntervalMs: number;
  key?: string; // Unique key for persistence
}

interface RateLimiterState {
  nextAllowedAtMs: number;
  learnedMinIntervalMs: number;
}

export function parseRetryAfterMs(value: unknown, nowMs: number = Date.now()): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value * 1000;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  // Header can be either:
  // - seconds (e.g. "890")
  // - HTTP date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Math.max(0, seconds * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - nowMs);
  }

  return undefined;
}

export class WoltRateLimiter {
  private readonly options: WoltRateLimiterOptions;
  private nextAllowedAtMs = 0;
  private lastRequestAtMs = 0;
  private learnedMinIntervalMs = 0;
  private static readonly STATE_FILE = path.join(process.cwd(), 'state', 'rate-limits.json');

  // Simple mutex to keep internal state consistent even if called concurrently.
  private serial: Promise<void> = Promise.resolve();

  constructor(options: WoltRateLimiterOptions) {
    this.options = options;
    if (this.options.key) {
      this.loadState();
    }
  }

  static fromEnv(key?: string): WoltRateLimiter {
    const minIntervalMs = parseInt(process.env.WOLT_RATE_LIMIT_MIN_INTERVAL_MS || '', 10);
    const retryAfterBufferMs = parseInt(process.env.WOLT_RETRY_AFTER_BUFFER_MS || '', 10);
    const retryAfterJitterMs = parseInt(process.env.WOLT_RETRY_AFTER_JITTER_MS || '', 10);
    const maxLearnedMinIntervalMs = parseInt(process.env.WOLT_MAX_LEARNED_MIN_INTERVAL_MS || '', 10);

    const learnMinIntervalFromRetryAfter = (process.env.WOLT_LEARN_MIN_INTERVAL_FROM_RETRY_AFTER || 'true')
      .trim()
      .toLowerCase() !== 'false';

    const enforceLearnedMinIntervalAfterSuccess = (process.env.WOLT_ENFORCE_LEARNED_MIN_INTERVAL_AFTER_SUCCESS || 'true')
      .trim()
      .toLowerCase() !== 'false';

    return new WoltRateLimiter({
      minIntervalMs: Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : 1100,
      retryAfterBufferMs: Number.isFinite(retryAfterBufferMs) && retryAfterBufferMs >= 0 ? retryAfterBufferMs : 1000,
      retryAfterJitterMs: Number.isFinite(retryAfterJitterMs) && retryAfterJitterMs >= 0 ? retryAfterJitterMs : 250,
      learnMinIntervalFromRetryAfter,
      enforceLearnedMinIntervalAfterSuccess,
      maxLearnedMinIntervalMs: Number.isFinite(maxLearnedMinIntervalMs) && maxLearnedMinIntervalMs > 0 ? maxLearnedMinIntervalMs : 60 * 60 * 1000,
      key
    });
  }

  private loadState() {
    try {
      if (!fs.existsSync(WoltRateLimiter.STATE_FILE)) return;
      const allStates = fs.readJsonSync(WoltRateLimiter.STATE_FILE);
      const myState = allStates[this.options.key!] as RateLimiterState;
      if (myState) {
        this.nextAllowedAtMs = myState.nextAllowedAtMs || 0;
        this.learnedMinIntervalMs = myState.learnedMinIntervalMs || 0;
      }
    } catch (error) {
      // Ignore read errors (file might be corrupt or locked), start fresh
    }
  }

  private saveState() {
    if (!this.options.key) return;
    try {
      fs.ensureDirSync(path.dirname(WoltRateLimiter.STATE_FILE));
      let allStates: Record<string, RateLimiterState> = {};
      try {
        if (fs.existsSync(WoltRateLimiter.STATE_FILE)) {
          allStates = fs.readJsonSync(WoltRateLimiter.STATE_FILE);
        }
      } catch (e) { /* ignore */ }

      allStates[this.options.key] = {
        nextAllowedAtMs: this.nextAllowedAtMs,
        learnedMinIntervalMs: this.learnedMinIntervalMs
      };

      fs.writeJsonSync(WoltRateLimiter.STATE_FILE, allStates, { spaces: 2 });
    } catch (error) {
      // Ignore write errors
    }
  }

  private withLock(fn: () => Promise<void>): Promise<void> {
    const run = async () => fn();
    const next = this.serial.then(run, run);
    this.serial = next;
    return next;
  }

  async waitForTurn(): Promise<void> {
    return this.withLock(async () => {
      // Reload state in case another process updated it
      if (this.options.key) this.loadState();
      
      const now = Date.now();

      const minIntervalGate = this.lastRequestAtMs > 0
        ? this.lastRequestAtMs + Math.max(this.options.minIntervalMs, this.learnedMinIntervalMs)
        : 0;

      const gateAt = Math.max(this.nextAllowedAtMs, minIntervalGate);
      
      if (gateAt > now) {
        const waitMs = gateAt - now;
        // Only log long waits
        if (waitMs > 2000) {
             console.log(`[RateLimiter] Waiting ${Math.ceil(waitMs / 1000)}s for quota...`);
        }
        await sleep(waitMs);
      }

      this.lastRequestAtMs = Date.now();
    });
  }

  onRateLimited(retryAfterHeaderValue: unknown): void {
    const now = Date.now();
    const retryAfterMs = parseRetryAfterMs(retryAfterHeaderValue, now);

    if (this.options.learnMinIntervalFromRetryAfter && typeof retryAfterMs === 'number' && retryAfterMs > 0) {
      this.learnedMinIntervalMs = Math.min(
        Math.max(this.learnedMinIntervalMs, retryAfterMs),
        this.options.maxLearnedMinIntervalMs
      );
    }

    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
      const jitter = this.options.retryAfterJitterMs > 0 ? Math.floor(Math.random() * this.options.retryAfterJitterMs) : 0;
      const nextAllowed = now + retryAfterMs + this.options.retryAfterBufferMs + jitter;
      this.nextAllowedAtMs = Math.max(this.nextAllowedAtMs, nextAllowed);
      this.saveState();
    }
  }

  onSuccess(): void {
    if (!this.options.enforceLearnedMinIntervalAfterSuccess) {
      return;
    }

    const now = Date.now();
    const postSuccessDelay = Math.max(this.options.minIntervalMs, this.learnedMinIntervalMs);
    if (postSuccessDelay <= 0) {
      return;
    }

    this.nextAllowedAtMs = Math.max(this.nextAllowedAtMs, now + postSuccessDelay);
    // Don't save on every success to avoid IO thrashing, only significant blocks (rate limits) need persistence
  }
}
