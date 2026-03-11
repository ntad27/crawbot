/**
 * Token Bucket Rate Limiter
 * Per-key rate limiting with a global cap across all keys.
 * No external dependencies — pure Node.js.
 */

const GLOBAL_LIMIT = 300; // requests per minute across all webhooks

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private globalBucket: Bucket;

  constructor() {
    this.globalBucket = { tokens: GLOBAL_LIMIT, lastRefillMs: Date.now() };
  }

  /**
   * Try to consume one token for the given key.
   * @param key         Unique key (e.g. webhook id)
   * @param perKeyLimit Max requests per minute for this key (default 60)
   * @returns true if allowed, false if rate-limited
   */
  tryConsume(key: string, perKeyLimit = 60): boolean {
    const now = Date.now();

    // Refill global bucket
    this._refill(this.globalBucket, GLOBAL_LIMIT, now);

    // Refill per-key bucket
    if (!this.buckets.has(key)) {
      this.buckets.set(key, { tokens: perKeyLimit, lastRefillMs: now });
    }
    const keyBucket = this.buckets.get(key)!;
    this._refill(keyBucket, perKeyLimit, now);

    // Check both limits
    if (this.globalBucket.tokens < 1 || keyBucket.tokens < 1) {
      return false;
    }

    // Consume one token from each
    this.globalBucket.tokens -= 1;
    keyBucket.tokens -= 1;
    return true;
  }

  /**
   * Reset the bucket for a given key (e.g. after secret regeneration)
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private _refill(bucket: Bucket, maxTokens: number, nowMs: number): void {
    const elapsedMs = nowMs - bucket.lastRefillMs;
    if (elapsedMs <= 0) return;

    // Token refill rate: maxTokens per 60 000 ms
    const refill = (elapsedMs / 60_000) * maxTokens;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refill);
    bucket.lastRefillMs = nowMs;
  }
}

export const rateLimiter = new RateLimiter();
