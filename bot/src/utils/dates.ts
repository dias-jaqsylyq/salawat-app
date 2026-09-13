import type { DateParts } from "../types.js";

/** Format DateParts as YYYY-MM-DD for API clients. */
export function formatDateParts(parts: DateParts): string {
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

/** Parse DateParts from a YYYY-MM-DD key. */
export function parseDateKey(date: string): DateParts {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

export function addOneCalendarDay(parts: DateParts): DateParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function subtractOneCalendarDay(parts: DateParts): DateParts {
  const prev = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return { year: prev.getUTCFullYear(), month: prev.getUTCMonth() + 1, day: prev.getUTCDate() };
}

/** Shift a civil date by whole days (negative shifts backward). */
export function addCalendarDays(parts: DateParts, days: number): DateParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Day of the week for a civil date: 0 = Sunday … 6 = Saturday. */
export function weekdayOfDate(parts: DateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/**
 * The first day of the calendar week containing `parts`, for a week that starts
 * on `weekStartDay` (0 = Sunday … 6 = Saturday). A date that already falls on
 * the start day is its own week start.
 */
export function startOfWeek(parts: DateParts, weekStartDay: number): DateParts {
  const daysIntoWeek = (weekdayOfDate(parts) - weekStartDay + 7) % 7;
  return addCalendarDays(parts, -daysIntoWeek);
}

/**
 * The day every calendar week in this app starts on: Monday. One constant, not
 * a per-user preference — a weekly habit scores once per week and the weekly
 * leaderboard resets once per week, so two members of the same room have to
 * agree on where that week begins even when they live in different countries.
 *
 * (users.week_start_day predates this and no longer moves any week boundary.)
 */
export const WEEK_START_DAY = 1;

/** Inclusive first and last day of the Monday-Sunday week containing `parts`. */
export function weekBounds(parts: DateParts): { weekStart: string; weekEnd: string } {
  const start = startOfWeek(parts, WEEK_START_DAY);
  return { weekStart: formatDateParts(start), weekEnd: formatDateParts(addCalendarDays(start, 6)) };
}

/**
 * weekBounds for a stored YYYY-MM-DD key — which bucket a habit_logs.log_date
 * falls in. Pure calendar arithmetic on the string: a log's week never depends
 * on a timezone, only on the date it was written under. Timezones enter exactly
 * once, in getCurrentWeekBounds, to decide which week is *now*.
 */
export function weekBoundsOfDateKey(dateKey: string): { weekStart: string; weekEnd: string } {
  return weekBounds(parseDateKey(dateKey));
}

/** The Monday of the week `weeks` weeks before the one starting at `weekStart`. */
export function shiftWeekStart(weekStart: string, weeks: number): string {
  return formatDateParts(addCalendarDays(parseDateKey(weekStart), weeks * 7));
}
