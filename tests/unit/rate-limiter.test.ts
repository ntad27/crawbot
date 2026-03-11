/**
 * Unit tests for the token bucket rate limiter
 * Source: electron/automation/rate-limiter.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '@electron/automation/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic allow / deny', () => {
    it('allows first request for a key', () => {
      expect(limiter.tryConsume('wh-1')).toBe(true);
    });

    it('allows up to perKeyLimit requests', () => {
      const limit = 5;
      for (let i = 0; i < limit; i++) {
        expect(limiter.tryConsume('wh-1', limit)).toBe(true);
      }
    });

    it('rejects request once per-key limit is exhausted', () => {
      const limit = 3;
      for (let i = 0; i < limit; i++) {
        limiter.tryConsume('wh-1', limit);
      }
      expect(limiter.tryConsume('wh-1', limit)).toBe(false);
    });
  });

  describe('token replenishment', () => {
    it('replenishes tokens after 60 seconds (full refill)', () => {
      const limit = 2;
      // Drain the bucket
      limiter.tryConsume('wh-1', limit);
      limiter.tryConsume('wh-1', limit);
      expect(limiter.tryConsume('wh-1', limit)).toBe(false);

      // Advance 60 seconds → full refill
      vi.advanceTimersByTime(60_000);

      expect(limiter.tryConsume('wh-1', limit)).toBe(true);
    });

    it('replenishes proportionally after partial time', () => {
      const limit = 60;
      // Drain all tokens
      for (let i = 0; i < limit; i++) {
        limiter.tryConsume('wh-1', limit);
      }
      expect(limiter.tryConsume('wh-1', limit)).toBe(false);

      // Advance 1 second → should replenish ~1 token
      vi.advanceTimersByTime(1_000);

      expect(limiter.tryConsume('wh-1', limit)).toBe(true);
    });
  });

  describe('per-key isolation', () => {
    it('exhausting key A does not affect key B', () => {
      const limit = 2;
      limiter.tryConsume('key-a', limit);
      limiter.tryConsume('key-a', limit);
      expect(limiter.tryConsume('key-a', limit)).toBe(false);

      // Key B should still work
      expect(limiter.tryConsume('key-b', limit)).toBe(true);
    });

    it('each key has independent bucket tracking', () => {
      const limit = 1;
      expect(limiter.tryConsume('key-x', limit)).toBe(true);
      expect(limiter.tryConsume('key-x', limit)).toBe(false);
      expect(limiter.tryConsume('key-y', limit)).toBe(true);
      expect(limiter.tryConsume('key-y', limit)).toBe(false);
    });
  });

  describe('reset', () => {
    it('reset allows requests again after bucket is exhausted', () => {
      const limit = 1;
      limiter.tryConsume('wh-reset', limit);
      expect(limiter.tryConsume('wh-reset', limit)).toBe(false);

      limiter.reset('wh-reset');

      expect(limiter.tryConsume('wh-reset', limit)).toBe(true);
    });

    it('reset on unknown key does not throw', () => {
      expect(() => limiter.reset('nonexistent-key')).not.toThrow();
    });
  });

  describe('global limit', () => {
    it('large volume of different keys stays within global budget', () => {
      // 300 requests with different keys should all be allowed (global limit = 300)
      let allowed = 0;
      for (let i = 0; i < 300; i++) {
        if (limiter.tryConsume(`key-${i}`, 10)) allowed++;
      }
      expect(allowed).toBe(300);
    });

    it('exceeding 300 total requests triggers global limit', () => {
      // Exhaust global bucket (300 tokens)
      for (let i = 0; i < 300; i++) {
        limiter.tryConsume(`key-${i}`, 10);
      }
      // 301st request should be rejected regardless of key
      expect(limiter.tryConsume('fresh-key', 10)).toBe(false);
    });
  });
});
