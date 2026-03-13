import { describe, it, expect, beforeEach } from 'vitest';

// Standalone copy of RateLimiter for unit testing (mirrors src/dashboard.ts)
class RateLimiter {
  private requests = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(jid: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const timestamps = (this.requests.get(jid) || []).filter(t => t > cutoff);

    if (timestamps.length >= this.limit) {
      const oldestTs = timestamps[0];
      return {
        allowed: false,
        remaining: 0,
        resetMs: oldestTs + this.windowMs - now,
      };
    }

    timestamps.push(now);
    this.requests.set(jid, timestamps);

    return {
      allowed: true,
      remaining: this.limit - timestamps.length,
      resetMs: this.windowMs,
    };
  }

  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [jid, timestamps] of this.requests.entries()) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) {
        this.requests.delete(jid);
      } else {
        this.requests.set(jid, filtered);
      }
    }
  }
}

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(5, 60_000);
  });

  it('allows requests under the limit', () => {
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('test-jid');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - (i + 1));
    }
  });

  it('blocks requests over the limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('test-jid');
    }

    const result = limiter.check('test-jid');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetMs).toBeGreaterThan(0);
  });

  it('isolates rate limits per JID', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('jid1');
    }

    const result = limiter.check('jid2');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('cleans up expired timestamps', () => {
    limiter.check('test-jid');

    const oldTimestamp = Date.now() - 61_000;
    limiter['requests'].set('old-jid', [oldTimestamp]);

    limiter.cleanup();

    expect(limiter['requests'].has('old-jid')).toBe(false);
    // Current entry should remain
    expect(limiter['requests'].has('test-jid')).toBe(true);
  });
});
