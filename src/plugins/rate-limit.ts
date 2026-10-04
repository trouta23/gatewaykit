import type { RateLimitConfig } from '../config/types.ts';
import type { Plugin } from '../pipeline.ts';
import { GatewayError } from '../pipeline.ts';

export type RateDecision = { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number };

/** Per-key request counting for one route. Pure data: time is passed in, no timers inside. */
export interface RateLimiter {
  /** Admits and records one request for `key` at `now`, or rejects it without recording anything. */
  take(key: string, now: number): RateDecision;
  /** Drops buckets that can no longer affect a decision, so memory stays bounded as client IPs churn. */
  sweep(now: number): void;
  /** Number of buckets currently held. */
  readonly size: number;
}

// Every `per: global` request on a route shares this one bucket.
const GLOBAL_KEY = '*';

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  return config.strategy === 'fixed_window' ? fixedWindow(config) : slidingWindow(config);
}

/**
 * Counts requests per window aligned to the clock (floor(now / window)), not to
 * a client's first request. O(1) per key, but allows up to 2x the limit across
 * a window boundary.
 */
function fixedWindow({ requests, windowMs }: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, { windowStart: number; count: number }>();
  const windowStartOf = (now: number) => Math.floor(now / windowMs) * windowMs;

  return {
    take(key, now) {
      const windowStart = windowStartOf(now);
      let bucket = buckets.get(key);
      if (bucket?.windowStart !== windowStart) {
        bucket = { windowStart, count: 0 };
        buckets.set(key, bucket);
      }
      if (bucket.count >= requests) return { allowed: false, retryAfterMs: windowStart + windowMs - now };
      bucket.count += 1;
      return { allowed: true, remaining: requests - bucket.count };
    },
    sweep(now) {
      const current = windowStartOf(now);
      for (const [key, bucket] of buckets) {
        if (bucket.windowStart < current) buckets.delete(key);
      }
    },
    get size() {
      return buckets.size;
    },
  };
}

/**
 * Exact sliding log: keeps the timestamps of admitted requests from the last
 * window. No boundary burst, and a log never holds more than `requests` entries
 * because rejected requests are not recorded.
 */
function slidingWindow({ requests, windowMs }: RateLimitConfig): RateLimiter {
  const logs = new Map<string, number[]>();

  return {
    take(key, now) {
      const log = logs.get(key) ?? [];
      // Timestamps are appended in order, so expired entries are always at the front.
      const expired = log.findIndex((at) => at > now - windowMs);
      log.splice(0, expired === -1 ? log.length : expired);
      if (log.length >= requests) return { allowed: false, retryAfterMs: log[0]! + windowMs - now };
      log.push(now);
      logs.set(key, log);
      return { allowed: true, remaining: requests - log.length };
    },
    sweep(now) {
      for (const [key, log] of logs) {
        if (log.at(-1)! <= now - windowMs) logs.delete(key);
      }
    },
    get size() {
      return logs.size;
    },
  };
}

export const rateLimitPlugin: Plugin = {
  feature: 'rate_limit',
  build(route, ctx) {
    const config = route.features.rate_limit;
    if (!config) return undefined;
    const limiter = createRateLimiter(config);
    const limit = String(config.requests);

    // A bucket idle for a whole window holds nothing that affects a decision.
    const sweeper = setInterval(() => limiter.sweep(ctx.now()), config.windowMs);
    sweeper.unref();
    ctx.onClose(() => clearInterval(sweeper));

    return (next) => async (req) => {
      const key = config.per === 'ip' ? req.clientIp : GLOBAL_KEY;
      // take() checks and records in one synchronous call with no await in between.
      // Node runs one event loop per process, so no other request can interleave:
      // 50 simultaneous requests against a limit of 10 admit exactly 10. Several
      // gateway instances would need a shared store (e.g. Redis) to keep that guarantee.
      const decision = limiter.take(key, ctx.now());
      if (!decision.allowed) {
        const retryAfter = Math.ceil(decision.retryAfterMs / 1000);
        throw new GatewayError(429, 'rate_limited', {
          details: { retry_after: retryAfter },
          headers: { 'retry-after': String(retryAfter), 'x-ratelimit-limit': limit, 'x-ratelimit-remaining': '0' },
        });
      }

      const response = await next(req);
      return {
        ...response,
        headers: { ...response.headers, 'x-ratelimit-limit': limit, 'x-ratelimit-remaining': String(decision.remaining) },
      };
    };
  },
};
