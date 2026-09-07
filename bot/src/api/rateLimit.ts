/**
 * Simple in-memory rate limits keyed by telegram user id.
 * Fine for a single Railway process; resets on restart.
 */

type Bucket = { timestamps: number[]; dailyKey: string; dailyCount: number };

const buckets = new Map<number, Bucket>();

function getBucket(telegramId: number): Bucket {
  let bucket = buckets.get(telegramId);
  if (!bucket) {
    bucket = { timestamps: [], dailyKey: "", dailyCount: 0 };
    buckets.set(telegramId, bucket);
  }
  return bucket;
}

/** Returns true if under the per-minute request limit (and records this attempt). */
export function allowRequest(telegramId: number, maxPerMinute: number, now = Date.now()): boolean {
  const bucket = getBucket(telegramId);
  const windowStart = now - 60_000;
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);
  if (bucket.timestamps.length >= maxPerMinute) {
    return false;
  }
  bucket.timestamps.push(now);
  return true;
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
  const bucket = getBucket(telegramId);
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
