/**
 * Rate limiting (G1): token buckets per key (IP, cart) kept in memory. Agents transact in bursts,
 * so limits are per minute with a small burst allowance; rejected calls get 429 + Retry-After.
 */
import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitRule {
  /** Sustained requests per minute. */
  perMinute: number;
  /** Extra requests allowed instantly on top of the sustained rate. */
  burst?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(private readonly rule: RateLimitRule) {
    this.capacity = rule.perMinute + (rule.burst ?? 0);
    this.refillPerMs = rule.perMinute / 60_000;
  }

  /** Returns 0 when allowed, otherwise the number of seconds to wait. */
  take(key: string, now = Date.now()): number {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updatedAt) * this.refillPerMs);
    b.updatedAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerMs / 1000));
  }

  /** Drops idle buckets (call periodically). */
  sweep(now = Date.now(), idleMs = 10 * 60_000): void {
    for (const [k, b] of this.buckets) if (now - b.updatedAt > idleMs) this.buckets.delete(k);
  }
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return c.req.header("x-real-ip") ?? c.req.header("cf-connecting-ip") ?? "unknown";
}

export function rateLimit(
  limiter: TokenBucketLimiter,
  keyOf: (c: Context) => string,
  scope: string,
): MiddlewareHandler {
  return async (c, next) => {
    const wait = limiter.take(keyOf(c));
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: `Too many ${scope} requests`,
            hint: `Wait ${wait}s and retry. Agents should back off exponentially.`,
            retryable: true,
            details: { retryAfterSeconds: wait, scope },
          },
        },
        429,
      );
    }
    await next();
  };
}
