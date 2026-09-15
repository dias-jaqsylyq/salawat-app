import { parseDateKey } from "../utils/dates.js";

/**
 * Route parameter parsing shared by every `/api/**\/:id` handler.
 */

/**
 * A positive integer path parameter (habit id, Telegram id), or null when the
 * raw value is anything else. Deliberately strict about the string form —
 * `"12abc"`, `"1.5"` and `" 3"` are rejected rather than coerced, so a
 * malformed id can never silently become a real row's id.
 */
export function parseIdParam(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `?date=YYYY-MM-DD` query param as the same key habit_logs.log_date stores,
 * or null when it isn't one — including a calendar date that doesn't exist
 * (`2024-02-30`), which the regex alone lets through since it only checks
 * shape. `Date.UTC` normalizes those (Feb 30 becomes Mar 1); reading the parts
 * back out and comparing catches the normalization instead of silently
 * accepting it.
 */
export function parseDateParam(raw: unknown): string | null {
  if (typeof raw !== "string" || !DATE_KEY_PATTERN.test(raw)) return null;
  const { year, month, day } = parseDateKey(raw);
  const check = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  return roundTrips ? raw : null;
}
