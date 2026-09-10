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
