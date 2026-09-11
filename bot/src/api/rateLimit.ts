/**
 * Simple in-memory rate limits keyed by telegram user id (or, for the two
 * endpoints with no Telegram identity behind them, by client IP).
 * Fine for a single Railway process; resets on restart.
 */

import type { NextFunction, Request, Response } from "express";

type Bucket = { timestamps: number[]; dailyKey: string; dailyCount: number };

/**
 * Buckets are keyed by a namespaced string so the per-user and per-IP limiters
 * can share one store (and one sweep) without a user id ever colliding with an
 * IP address.
 */
const buckets = new Map<string, Bucket>();

function userKey(telegramId: number): string {
  return `user:${telegramId}`;
}

function getBucket(key: string): Bucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [], dailyKey: "", dailyCount: 0 };
    buckets.set(key, bucket);
  }
  return bucket;
}

/** How often the idle-bucket sweep runs, and how long a bucket may sit idle. */
const SWEEP_INTERVAL_MS = 5 * 60_000;
const BUCKET_TTL_MS = 5 * 60_000;

let lastSweep = 0;

/**
 * Drop buckets nothing has touched for a while.
 *
 * The per-user map is naturally bounded by the number of real users, but the
 * per-IP one is not: a brute-forcer rotating source addresses would otherwise
 * grow it without limit for as long as the process lives. A bucket carrying a
 * daily salawat count for today is kept regardless of idleness — evicting that
 * would hand back the daily cap (allowDailyCount) for free.
 */
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const cutoff = now - BUCKET_TTL_MS;
  for (const [key, bucket] of buckets) {
    const recent = bucket.timestamps.some((t) => t > cutoff);
    if (!recent && bucket.dailyCount === 0) {
      buckets.delete(key);
    }
  }
}

/** Test seam: forget every bucket (and the sweep clock). */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

/** Returns true if `key` is under the per-minute request limit (and records this attempt). */
function allowKey(key: string, maxPerMinute: number, now: number): boolean {
  sweep(now);
  const bucket = getBucket(key);
  const windowStart = now - 60_000;
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);
  if (bucket.timestamps.length >= maxPerMinute) {
    return false;
  }
  bucket.timestamps.push(now);
  return true;
}

/** Returns true if under the per-minute request limit (and records this attempt). */
export function allowRequest(telegramId: number, maxPerMinute: number, now = Date.now()): boolean {
  return allowKey(userKey(telegramId), maxPerMinute, now);
}

/**
 * The per-IP equivalent, for endpoints authenticated by a shared secret rather
 * than by initData. `ip` is whatever Express resolved from the socket and the
 * trusted proxy hop — see the `trust proxy` setting in server.ts.
 */
export function allowRequestFromIp(ip: string, maxPerMinute: number, now = Date.now()): boolean {
  return allowKey(`ip:${ip}`, maxPerMinute, now);
}

/**
 * Returns true if adding `count` stays under the daily salawat cap for `dayKey` (YYYY-MM-DD in challenge TZ).
 * Records the count only when allowed.
 */
export function allowDailyCount(
  telegramId: number,
  dayKey: string,
  count: number,
  dailyCap: number
): boolean {
  const bucket = getBucket(userKey(telegramId));
  if (bucket.dailyKey !== dayKey) {
    bucket.dailyKey = dayKey;
    bucket.dailyCount = 0;
  }
  if (bucket.dailyCount + count > dailyCap) {
    return false;
  }
  bucket.dailyCount += count;
  return true;
}

/**
 * Per-user rate limiting as middleware, so a route is covered by how it is
 * mounted in server.ts rather than by each handler remembering to call
 * allowRequest itself — which is what left most of the admin write paths
 * unlimited.
 *
 * Must be mounted after telegramAuth: it reads req.telegramId.
 */
export function rateLimited(maxPerMinute: number) {
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!allowRequest(req.telegramId, maxPerMinute)) {
      res.status(429).json({ success: false, error: "rate_limited" });
      return;
    }
    next();
  };
}

/**
 * Per-IP rate limiting as middleware, for the ADMIN_EXPORT_SECRET-gated
 * endpoints. A request Express cannot attribute to any address falls into one
 * shared bucket rather than going unlimited.
 */
export function rateLimitedByIp(maxPerMinute: number) {
  return function ipRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!allowRequestFromIp(req.ip ?? "unknown", maxPerMinute)) {
      res.status(429).json({ success: false, error: "rate_limited" });
      return;
    }
    next();
  };
}
