/**
 * "YYYY-MM" calendar-month keys for the History screen's month nav — mirrors
 * the bot's monthBounds/shiftMonth in bot/src/utils/dates.ts, but purely for
 * display and picking which month to request; the server is the actual
 * authority on a month's boundary (config.timezone, not the viewer's own).
 */

/** The device's own current month — only ever the History screen's very
 *  first default before anything has been saved; every load after that
 *  restores the last-viewed month instead (HISTORY PRD). */
export function currentMonthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Shift a "YYYY-MM" key by whole months, wrapping across a year boundary. */
export function shiftMonthKey(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const zeroIndexed = m! - 1 + delta;
  const newYear = year! + Math.floor(zeroIndexed / 12);
  const newMonth = (((zeroIndexed % 12) + 12) % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, "0")}`;
}

/** "September 2026", parsed as UTC so a local read can never shift a month. */
export function formatMonthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, m! - 1, 1));
  return date.toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
}
