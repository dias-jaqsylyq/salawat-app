import type { DateParts } from "../types.js";
import {
  addOneCalendarDay,
  formatDateParts,
  subtractOneCalendarDay,
} from "./dates.js";

export interface DayBreakdown {
  date: string;
  total: number;
  metGoal: boolean;
  /** True for days before the user registered. */
  locked: boolean;
}

/** Override wins when present; otherwise total >= dailyGoal. */
export function effectiveMet(
  date: string,
  total: number,
  dailyGoal: number,
  overrides?: Map<string, boolean>
): boolean {
  if (overrides?.has(date)) return overrides.get(date)!;
  return total >= dailyGoal;
}

function isBefore(day: DateParts, earliest: DateParts): boolean {
  const dayEpoch = Date.UTC(day.year, day.month - 1, day.day);
  const earliestEpoch = Date.UTC(earliest.year, earliest.month - 1, earliest.day);
  return dayEpoch < earliestEpoch;
}

/**
 * Consecutive met days walking backward from today.
 * - Today counts only from real logs (overrides ignored — today is locked).
 * - If today is unmet, walking starts at yesterday (today still in progress).
 * - Past days use effectiveMet (override authoritative when present).
 * - Days before `earliestParts` (the user's registration day) stop the walk.
 */
export function computeStreak(
  dailyGoal: number,
  totalsByDate: Map<string, number>,
  todayParts: DateParts,
  earliestParts?: DateParts,
  overrides?: Map<string, boolean>
): number {
  if (dailyGoal <= 0) return 0;

  let day = todayParts;
  const todayKey = formatDateParts(day);
  const todayTotal = totalsByDate.get(todayKey) ?? 0;
  // Today is locked to live logs — never apply overrides.
  if (todayTotal < dailyGoal) {
    day = subtractOneCalendarDay(day);
  }

  let streak = 0;
  while (true) {
    if (earliestParts && isBefore(day, earliestParts)) break;

    const date = formatDateParts(day);
    const total = totalsByDate.get(date) ?? 0;
    const isToday = date === todayKey;
    const met = isToday
      ? total >= dailyGoal
      : effectiveMet(date, total, dailyGoal, overrides);
    if (!met) break;
    streak += 1;
    day = subtractOneCalendarDay(day);
  }
  return streak;
}

/** Exactly 7 days ending with today, oldest → newest. */
export function buildLast7Days(
  dailyGoal: number,
  totalsByDate: Map<string, number>,
  todayParts: DateParts,
  earliestParts?: DateParts,
  overrides?: Map<string, boolean>
): DayBreakdown[] {
  let day = todayParts;
  for (let i = 0; i < 6; i++) {
    day = subtractOneCalendarDay(day);
  }

  const todayKey = formatDateParts(todayParts);
  const days: DayBreakdown[] = [];
  for (let i = 0; i < 7; i++) {
    const date = formatDateParts(day);
    const total = totalsByDate.get(date) ?? 0;
    const locked = earliestParts ? isBefore(day, earliestParts) : false;
    if (locked) {
      // Pre-eligibility: not missed, not makeup-eligible, ignore overrides.
      days.push({ date, total, metGoal: false, locked: true });
    } else {
      const metGoal =
        date === todayKey
          ? total >= dailyGoal
          : effectiveMet(date, total, dailyGoal, overrides);
      days.push({ date, total, metGoal, locked: false });
    }
    day = addOneCalendarDay(day);
  }
  return days;
}

/** Aggregate log rows into TIMEZONE day totals. */
export function bucketLogsByDay(
  rows: { logged_at: string; count: number }[],
  dayKeyFn: (loggedAt: string) => string
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = dayKeyFn(row.logged_at);
    totals.set(key, (totals.get(key) ?? 0) + row.count);
  }
  return totals;
}
