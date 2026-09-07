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
