import { logger } from './logger';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;      // Number of failures before opening circuit
  successThreshold: number;      // Number of successes in half-open before closing
  timeout: number;               // Time in ms before attempting to close circuit (half-open)
  resetTimeout?: number;         // Time in ms to reset failure count if no failures occur
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure?: Date;
  lastSuccess?: Date;
  lastStateChange: Date;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private lastStateChangeTime: number = Date.now();
  private nextAttemptTime?: number;
  private totalRequests: number = 0;
  private totalFailures: number = 0;
  private totalSuccesses: number = 0;

  constructor(private options: CircuitBreakerOptions) {
    logger.info(`Circuit breaker "${options.name}" initialized (threshold: ${options.failureThreshold} failures)`);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === 'open') {
      if (Date.now() < (this.nextAttemptTime || 0)) {
        const waitTime = Math.ceil(((this.nextAttemptTime || 0) - Date.now()) / 1000);
        throw new CircuitBreakerError(
          `Circuit breaker "${this.options.name}" is OPEN. Retry in ${waitTime}s.`,
          this.options.name,
          this.state
        );
      }
      // Time to try again - move to half-open
      this.transitionTo('half-open');
    }

    this.totalRequests++;

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.totalSuccesses++;

    if (this.state === 'half-open') {
      this.successes++;
      logger.info(`Circuit breaker "${this.options.name}" success in half-open state (${this.successes}/${this.options.successThreshold})`);

      if (this.successes >= this.options.successThreshold) {
        this.transitionTo('closed');
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success if resetTimeout has passed
      if (this.options.resetTimeout && this.lastFailureTime) {
        if (Date.now() - this.lastFailureTime > this.options.resetTimeout) {
          this.failures = 0;
        }
      }
    }
  }

  private onFailure(error: any): void {
    this.lastFailureTime = Date.now();
    this.totalFailures++;

    if (this.state === 'half-open') {
      // Any failure in half-open goes back to open
      logger.warn(`Circuit breaker "${this.options.name}" failed in half-open state, reopening`);
      this.transitionTo('open');
    } else if (this.state === 'closed') {
      this.failures++;
      logger.warn(`Circuit breaker "${this.options.name}" failure ${this.failures}/${this.options.failureThreshold}`);

      if (this.failures >= this.options.failureThreshold) {
        this.transitionTo('open');
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChangeTime = Date.now();

    logger.info(`Circuit breaker "${this.options.name}" state: ${oldState} -> ${newState}`);

    if (newState === 'open') {
      this.nextAttemptTime = Date.now() + this.options.timeout;
      const retryIn = Math.ceil(this.options.timeout / 1000);
      logger.warn(`Circuit breaker "${this.options.name}" OPEN - will retry in ${retryIn}s`);
    } else if (newState === 'half-open') {
      this.successes = 0;
      logger.info(`Circuit breaker "${this.options.name}" entering HALF-OPEN state`);
    } else if (newState === 'closed') {
      this.failures = 0;
      this.successes = 0;
      this.nextAttemptTime = undefined;
      logger.info(`Circuit breaker "${this.options.name}" CLOSED - normal operation resumed`);
    }
  }

  getState(): CircuitState {
    // Check if we should auto-transition from open to half-open
    if (this.state === 'open' && Date.now() >= (this.nextAttemptTime || 0)) {
      return 'half-open';
    }
    return this.state;
  }

  getStats(): CircuitBreakerStats {
    return {
      name: this.options.name,
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime) : undefined,
      lastSuccess: this.lastSuccessTime ? new Date(this.lastSuccessTime) : undefined,
      lastStateChange: new Date(this.lastStateChangeTime),
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses
    };
  }

  isAvailable(): boolean {
    const state = this.getState();
    return state === 'closed' || state === 'half-open';
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.nextAttemptTime = undefined;
    this.lastStateChangeTime = Date.now();
    logger.info(`Circuit breaker "${this.options.name}" manually reset`);
  }
}

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly circuitName: string,
    public readonly circuitState: CircuitState
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

// Pre-configured circuit breakers for Fina and Wolt
export const finaCircuitBreaker = new CircuitBreaker({
  name: 'Fina API',
  failureThreshold: 5,           // Open after 5 consecutive failures
  successThreshold: 2,           // Close after 2 successes in half-open
  timeout: 60000,                // Try again after 1 minute
  resetTimeout: 300000           // Reset failure count after 5 minutes of no failures
});

export const woltCircuitBreaker = new CircuitBreaker({
  name: 'Wolt API',
  failureThreshold: 10,          // Higher threshold for Wolt (rate limits are expected)
  successThreshold: 3,           // Need 3 successes to close
  timeout: 120000,               // Try again after 2 minutes
  resetTimeout: 600000           // Reset failure count after 10 minutes
});

// Helper to get all circuit breaker stats
export function getAllCircuitBreakerStats(): CircuitBreakerStats[] {
  return [
    finaCircuitBreaker.getStats(),
    woltCircuitBreaker.getStats()
  ];
}
