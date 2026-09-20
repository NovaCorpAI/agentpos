/**
 * Rate limiting for the endpoints that reach out to the network. Published, those three
 * endpoints are the expensive ones: each call makes this server open connections to an address
 * somebody else chose. The SSRF guard says WHERE we may go; this says HOW OFTEN.
 *
 * The bucket itself is `TokenBucketLimiter` from `@agentpos/site` (the limiter the store library
 * already uses for cart and checkout), so there is one implementation of this in the repo. Only
 * the middleware and the client-IP rule live here, because they differ: this app always runs
 * behind our own Caddy.
 */
import type { Context, MiddlewareHandler } from "hono";
import { TokenBucketLimiter } from "@agentpos/site";

/** Wizard calls are typed by a human: a handful per minute is generous, a flood is not. */
export const WOO_RULE = { perMinute: 20, burst: 10 } as const;
export const VERIFY_RULE = { perMinute: 10, burst: 5 } as const;

/**
 * The caller's address.
 *
 * `x-forwarded-for` is a list the proxies APPEND to, so the LAST entry is the one our own Caddy
 * wrote (the address it saw), and the earlier ones are whatever the client claimed. Reading the
 * first entry, as a public-internet app, would let anyone reset their own limit by sending a
 * made-up header, so we read the last.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined && forwarded.trim() !== "") {
    const hops = forwarded.split(",");
    const last = hops[hops.length - 1]?.trim();
    if (last) return last;
  }
  return c.req.header("x-real-ip") ?? c.req.header("cf-connecting-ip") ?? "unknown";
}

/**
 * 429 with `Retry-After` and a typed body, like every other refusal in AgentPOS. Idle buckets
 * are swept periodically so a long-running process does not keep a row per address forever.
 */
export function rateLimit(limiter: TokenBucketLimiter, scope: string): MiddlewareHandler {
  let sinceSweep = 0;
  return async (c, next) => {
    if (++sinceSweep >= 512) {
      sinceSweep = 0;
      limiter.sweep();
    }
    const wait = limiter.take(clientIp(c));
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: `Demasiadas consultas seguidas (${scope})`,
            hint: `Espera ${wait} segundos y vuelve a intentarlo.`,
            retryable: true,
            details: { retryAfterSeconds: wait, scope },
          },
        },
        429,
      );
    }
    await next();
    return undefined;
  };
}

export { TokenBucketLimiter };
