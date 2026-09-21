/**
 * Remembers the History screen's last-viewed habit and month across opens.
 * Client-only (localStorage, per device) rather than a server preference —
 * Part 1 of the HISTORY PRD deliberately makes no database schema change, so
 * this can't follow streak_display's pattern of a `users` column.
 *
 * Every access is wrapped: a private window, cleared site data or a blocked
 * storage API must never break the screen, just leave it un-remembered.
 */

export interface HistorySelection {
  kind: "room" | "personal";
  habitId: number;
}

const HABIT_KEY = "history:lastHabit";
const MONTH_KEY = "history:lastMonth";

export function loadLastHabit(): HistorySelection | null {
  try {
    const raw = localStorage.getItem(HABIT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      "habitId" in parsed &&
      (parsed.kind === "room" || parsed.kind === "personal") &&
      typeof parsed.habitId === "number"
    ) {
      return { kind: parsed.kind, habitId: parsed.habitId };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLastHabit(selection: HistorySelection): void {
  try {
    localStorage.setItem(HABIT_KEY, JSON.stringify(selection));
  } catch {
    // Best-effort — the screen just opens to the first habit next time.
  }
}

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

/** The month kept on a habit switch, per HISTORY PRD — only habit selection is per-key. */
export function loadLastMonth(): string | null {
  try {
    const raw = localStorage.getItem(MONTH_KEY);
    return raw && MONTH_KEY_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveLastMonth(month: string): void {
  try {
    localStorage.setItem(MONTH_KEY, month);
  } catch {
    // Best-effort — the screen just re-defaults to the current month next time.
  }
}
