import { config } from "../config.js";
import type { DateParts } from "../types.js";
import {
  addOneCalendarDay,
  formatDateParts,
  parseDateKey,
  subtractOneCalendarDay,
} from "./dates.js";

export {
  addOneCalendarDay,
  formatDateParts,
  parseDateKey,
  subtractOneCalendarDay,
} from "./dates.js";

/** Returns today's calendar date (Y/M/D) as observed in the given IANA timezone. */
export function getTodayInTimezone(timeZone: string, now: Date = new Date()): DateParts {
  // en-CA locale formats as YYYY-MM-DD, which is convenient to split.
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = formatted.split("-").map(Number);
  return { year, month, day };
}

function toEpochDay(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

/**
 * Days remaining until (and including) the challenge end date.
 * 0 means today is the last day; negative values are clamped to 0.
 */
export function getDaysLeft(now: Date = new Date()): number {
  const today = getTodayInTimezone(config.timezone, now);
  const daysLeft = toEpochDay(config.challengeEndDate) - toEpochDay(today);
  return Math.max(0, daysLeft);
}

/** True once today's date in TIMEZONE is on or after CHALLENGE_START_DATE. */
export function hasChallengeStarted(now: Date = new Date()): boolean {
  const today = getTodayInTimezone(config.timezone, now);
  return toEpochDay(today) >= toEpochDay(config.challengeStartDate);
}

export function hasChallengeEnded(now: Date = new Date()): boolean {
  const today = getTodayInTimezone(config.timezone, now);
  return toEpochDay(today) > toEpochDay(config.challengeEndDate);
}

export type ChallengeStatus = "not_started" | "active" | "ended";

export function getChallengeStatus(now: Date = new Date()): ChallengeStatus {
  if (!hasChallengeStarted(now)) return "not_started";
  if (hasChallengeEnded(now)) return "ended";
  return "active";
}

/** Calendar day key (YYYY-MM-DD) in the challenge timezone — for daily caps. */
export function getDayKeyInTimezone(now: Date = new Date()): string {
  return formatDateParts(getTodayInTimezone(config.timezone, now));
}

/** Convert a wall-clock time in `timeZone` to the corresponding UTC Date. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const read = (date: Date) => {
    const parts = dtf.formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === type)?.value);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
      second: get("second"),
    };
  };

  // Guess: treat the wall time as UTC, then correct using the zone's offset.
  let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 2; i++) {
    const got = read(new Date(utcMillis));
    const asUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, second);
    utcMillis += want - asUtc;
  }
  return new Date(utcMillis);
}

/** Format a Date as UTC `YYYY-MM-DD HH:MM:SS` to match SQLite `datetime('now')`. */
function formatSqliteUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/**
 * UTC half-open [start, end) for a calendar day in `timeZone`.
 * String format matches `logs.logged_at` (`datetime('now')` UTC text).
 */
export function getUtcRangeForDate(
  parts: DateParts,
  timeZone: string = config.timezone
): { startUtc: string; endUtc: string } {
  const tomorrow = addOneCalendarDay(parts);
  const start = zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
  const end = zonedTimeToUtc(
    tomorrow.year,
    tomorrow.month,
    tomorrow.day,
    0,
    0,
    0,
    timeZone
  );
  return { startUtc: formatSqliteUtc(start), endUtc: formatSqliteUtc(end) };
}

/**
 * UTC half-open [start, end) for the calendar day containing `now` in `TIMEZONE`.
 * String format matches `logs.logged_at` (`datetime('now')` UTC text).
 */
export function getTodayUtcRange(now: Date = new Date()): { startUtc: string; endUtc: string } {
  return getUtcRangeForDate(getTodayInTimezone(config.timezone, now), config.timezone);
}

/**
 * Informational Mawlid period as a UTC half-open range. The configured end
 * calendar date is inclusive in TIMEZONE.
 */
export function getChallengeWindowUtc(): { startUtc: string; endUtc: string } {
  return {
    startUtc: getUtcRangeForDate(config.challengeStartDate, config.timezone).startUtc,
    endUtc: getUtcRangeForDate(config.challengeEndDate, config.timezone).endUtc,
  };
}

/**
 * Map a SQLite UTC `logged_at` (`YYYY-MM-DD HH:MM:SS`) to a calendar day key in `timeZone`.
 */
export function dayKeyFromSqliteUtc(loggedAt: string, timeZone: string = config.timezone): string {
  const iso = loggedAt.includes("T") ? loggedAt : `${loggedAt.replace(" ", "T")}Z`;
  return formatDateParts(getTodayInTimezone(timeZone, new Date(iso)));
}

export function getPercentComplete(total: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(100, Math.round((total / goal) * 1000) / 10); // one decimal place, capped at 100
}
