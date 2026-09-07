import type { RegisteredProgress } from "../api/types.ts";

export const TOTAL_MILESTONES = [
  1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
] as const;

export const STREAK_MILESTONES = [7, 14, 30] as const;

const CHALLENGE_TIMEZONE = "Asia/Hong_Kong";

export type CelebrationKind = "total" | "daily" | "streak";

export interface CelebrationEvent {
  id: string;
  kind: CelebrationKind;
  /** Count-up start value. */
  from: number;
  /** Count-up end / displayed milestone. */
  to: number;
  subtitle: string;
}

function storageKey(telegramId: number): string {
  return `salawat:celebrated:${telegramId}`;
}

export function todayKeyInChallengeTz(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CHALLENGE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function getCelebrated(telegramId: number | null): Set<string> {
  if (telegramId === null) return new Set();
  try {
    const raw = localStorage.getItem(storageKey(telegramId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function markCelebrated(telegramId: number | null, ids: string[]): void {
  if (telegramId === null || ids.length === 0) return;
  const set = getCelebrated(telegramId);
  for (const id of ids) set.add(id);
  try {
    localStorage.setItem(storageKey(telegramId), JSON.stringify([...set]));
  } catch {
    // Quota / private mode — in-session Set in App still dedupes.
  }
}

/** Milestones already achieved by current progress (for first-load seeding). */
export function achievedMilestoneIds(progress: RegisteredProgress, now: Date = new Date()): string[] {
  const ids: string[] = [];
  for (const m of TOTAL_MILESTONES) {
    if (progress.total >= m) ids.push(`total:${m}`);
  }
  for (const s of STREAK_MILESTONES) {
    if (progress.streak >= s) ids.push(`streak:${s}`);
  }
  if (progress.dailyGoal > 0 && progress.todayTotal >= progress.dailyGoal) {
    ids.push(`daily:${todayKeyInChallengeTz(now)}`);
  }
  return ids;
}

/** Seed storage so historical milestones do not animate on first open. */
export function seedAchieved(telegramId: number | null, progress: RegisteredProgress): void {
  markCelebrated(telegramId, achievedMilestoneIds(progress));
}

/**
 * Newly crossed milestones since prev → next.
 * At most one highest total, one highest streak, and one daily — in that enqueue order.
 */
export function diffMilestones(
  prev: RegisteredProgress,
  next: RegisteredProgress,
  alreadyCelebrated: Set<string>,
  now: Date = new Date()
): CelebrationEvent[] {
  const events: CelebrationEvent[] = [];

  let highestTotal: number | null = null;
  for (const m of TOTAL_MILESTONES) {
    if (prev.total < m && next.total >= m) {
      highestTotal = m;
    }
  }
  if (highestTotal !== null) {
    const id = `total:${highestTotal}`;
    if (!alreadyCelebrated.has(id)) {
      events.push({
        id,
        kind: "total",
        from: prev.total,
        to: highestTotal,
        subtitle: `You've reached ${highestTotal.toLocaleString()} salawat`,
      });
    }
  }

  let highestStreak: number | null = null;
  for (const s of STREAK_MILESTONES) {
    if (prev.streak < s && next.streak >= s) {
      highestStreak = s;
    }
  }
  if (highestStreak !== null) {
    const id = `streak:${highestStreak}`;
    if (!alreadyCelebrated.has(id)) {
      events.push({
        id,
        kind: "streak",
        from: 0,
        to: highestStreak,
        subtitle: `${highestStreak}-day streak`,
      });
    }
  }

  const day = todayKeyInChallengeTz(now);
  const dailyId = `daily:${day}`;
  if (
    next.dailyGoal > 0 &&
    prev.todayTotal < next.dailyGoal &&
    next.todayTotal >= next.dailyGoal &&
    !alreadyCelebrated.has(dailyId)
  ) {
    events.push({
      id: dailyId,
      kind: "daily",
      from: 0,
      to: next.todayTotal,
      subtitle: "Daily goal complete",
    });
  }

  return events;
}
