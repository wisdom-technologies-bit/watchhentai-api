/**
 * Fixed-window limiter, in memory.
 *
 * One process, one container, so a Map is the honest tool: it stops a single
 * caller from turning the service into a scraper-of-scrapers, and it costs
 * nothing. Multi-instance deployments get one budget per instance, which is
 * fine for a politeness limit.
 */

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number; remaining: number };

const hits = new Map<string, { count: number; resetsAt: number }>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const entry = hits.get(key);
  if (!entry || entry.resetsAt <= now) {
    hits.set(key, { count: 1, resetsAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, limit - 1) };
  }
  entry.count += 1;
  const allowed = entry.count <= limit;
  return {
    allowed,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)),
    remaining: Math.max(0, limit - entry.count),
  };
}

/** Test seam. */
export function resetRateLimits() {
  hits.clear();
}
