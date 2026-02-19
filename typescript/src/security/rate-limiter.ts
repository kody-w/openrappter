/**
 * Rate Limiter — Token Bucket Implementation
 * Supports per-key, per-method, per-IP, and global rate limits.
 * Sliding window variant via token refill on interval.
 */

export interface RateLimiterOptions {
  /** Maximum tokens in the bucket (burst capacity) */
  maxTokens: number;
  /** Tokens added per refill interval */
  refillRate: number;
  /** Interval between refills, in milliseconds */
  refillInterval: number;
}

export interface CheckResult {
  allowed: boolean;
  /** Milliseconds until more tokens are available (only set when not allowed) */
  retryAfter?: number;
  /** Current token count after this check */
  remaining: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private options: RateLimiterOptions;

  constructor(options: RateLimiterOptions) {
    this.options = { ...options };
  }

  /**
   * Check whether `key` has tokens available without consuming.
   */
  check(key: string): CheckResult {
    const bucket = this.getOrCreate(key);
    this.refill(bucket);

    if (bucket.tokens >= 1) {
      return { allowed: true, remaining: Math.floor(bucket.tokens) };
    }

    const retryAfter = this.computeRetryAfter(bucket);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  /**
   * Consume `tokens` (default 1) from the bucket for `key`.
   * Returns whether the request was allowed.
   */
  consume(key: string, tokens = 1): CheckResult {
    const bucket = this.getOrCreate(key);
    this.refill(bucket);

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true, remaining: Math.floor(bucket.tokens) };
    }

    const retryAfter = this.computeRetryAfter(bucket);
    return { allowed: false, retryAfter, remaining: Math.floor(bucket.tokens) };
  }

  /**
   * Reset a specific key's bucket.
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Reset all buckets.
   */
  resetAll(): void {
    this.buckets.clear();
  }

  /**
   * Get the current token count for a key (without consuming).
   */
  getTokens(key: string): number {
    const bucket = this.getOrCreate(key);
    this.refill(bucket);
    return Math.floor(bucket.tokens);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private getOrCreate(key: string): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.options.maxTokens, lastRefill: Date.now() };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const intervals = elapsed / this.options.refillInterval;
    const newTokens = intervals * this.options.refillRate;

    if (newTokens >= 1) {
      bucket.tokens = Math.min(
        this.options.maxTokens,
        bucket.tokens + newTokens
      );
      bucket.lastRefill = now;
    }
  }

  private computeRetryAfter(bucket: Bucket): number {
    // Time until at least 1 token is available
    const tokensNeeded = 1 - bucket.tokens;
    const intervalsNeeded = tokensNeeded / this.options.refillRate;
    return Math.ceil(intervalsNeeded * this.options.refillInterval);
  }
}

// ── Multi-scope rate limiter ──────────────────────────────────────────────────

export interface MultiScopeOptions {
  /** Options for global rate limiter (across all keys) */
  global?: RateLimiterOptions;
  /** Options for per-IP rate limiter */
  perIp?: RateLimiterOptions;
  /** Per-method overrides: method name → options */
  perMethod?: Record<string, RateLimiterOptions>;
}

export interface MultiScopeResult {
  allowed: boolean;
  /** Which scope blocked this request */
  blockedBy?: 'global' | 'ip' | 'method';
  retryAfter?: number;
}

export class MultiScopeRateLimiter {
  private global?: RateLimiter;
  private perIp?: RateLimiter;
  private methodLimiters = new Map<string, RateLimiter>();

  constructor(options: MultiScopeOptions = {}) {
    if (options.global) this.global = new RateLimiter(options.global);
    if (options.perIp) this.perIp = new RateLimiter(options.perIp);

    if (options.perMethod) {
      for (const [method, opts] of Object.entries(options.perMethod)) {
        this.methodLimiters.set(method, new RateLimiter(opts));
      }
    }
  }

  /**
   * Check and consume across all configured scopes.
   * Returns false if any scope denies the request.
   */
  consume(params: { ip?: string; method?: string; tokens?: number }): MultiScopeResult {
    const tokens = params.tokens ?? 1;
    const GLOBAL_KEY = '__global__';

    // Global check
    if (this.global) {
      const result = this.global.consume(GLOBAL_KEY, tokens);
      if (!result.allowed) {
        return { allowed: false, blockedBy: 'global', retryAfter: result.retryAfter };
      }
    }

    // Per-IP check
    if (this.perIp && params.ip) {
      const result = this.perIp.consume(params.ip, tokens);
      if (!result.allowed) {
        return { allowed: false, blockedBy: 'ip', retryAfter: result.retryAfter };
      }
    }

    // Per-method check
    if (params.method) {
      const limiter = this.methodLimiters.get(params.method);
      if (limiter) {
        const key = params.ip ? `${params.method}:${params.ip}` : params.method;
        const result = limiter.consume(key, tokens);
        if (!result.allowed) {
          return { allowed: false, blockedBy: 'method', retryAfter: result.retryAfter };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Check without consuming.
   */
  check(params: { ip?: string; method?: string }): MultiScopeResult {
    const GLOBAL_KEY = '__global__';

    if (this.global) {
      const result = this.global.check(GLOBAL_KEY);
      if (!result.allowed) {
        return { allowed: false, blockedBy: 'global', retryAfter: result.retryAfter };
      }
    }

    if (this.perIp && params.ip) {
      const result = this.perIp.check(params.ip);
      if (!result.allowed) {
        return { allowed: false, blockedBy: 'ip', retryAfter: result.retryAfter };
      }
    }

    if (params.method) {
      const limiter = this.methodLimiters.get(params.method);
      if (limiter) {
        const key = params.ip ? `${params.method}:${params.ip}` : params.method;
        const result = limiter.check(key);
        if (!result.allowed) {
          return { allowed: false, blockedBy: 'method', retryAfter: result.retryAfter };
        }
      }
    }

    return { allowed: true };
  }

  resetAll(): void {
    this.global?.resetAll();
    this.perIp?.resetAll();
    for (const limiter of this.methodLimiters.values()) {
      limiter.resetAll();
    }
  }
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  return new RateLimiter(options);
}
