/**
 * The Log screen's optimistic state, kept free of React so it can be tested on
 * its own. A toggle shows up at once as an override on top of the last server
 * response; the override goes away once a fresh response already agrees.
 */

export type LogKind = "room" | "personal";

/** One habit on one day. Room and personal ids overlap, hence the kind. */
export function logKey(date: string, kind: LogKind, id: number): string {
  return `${date}:${kind}:${id}`;
}

/**
 * A habit's state on one day. "off" is unlogged; a single-level habit only
 * ever moves between "off" and "basic".
 */
export type LogLevel = "off" | "basic" | "extended";

/** The server's state for a day, as a LogLevel. A missing `level` (older server) is Basic. */
export function serverLevel(entry: { logged: boolean; level?: "basic" | "extended" | null }): LogLevel {
  return entry.logged ? (entry.level ?? "basic") : "off";
}

/** Desired level per logKey, for changes the server hasn't confirmed yet. */
export type Overrides = Readonly<Record<string, LogLevel>>;

export function effectiveLevel(overrides: Overrides, key: string, server: LogLevel): LogLevel {
  return overrides[key] ?? server;
}

export function withOverride(overrides: Overrides, key: string, level: LogLevel): Overrides {
  return { ...overrides, [key]: level };
}

/**
 * The level a tap on a level segment asks for: tapping the one already
 * selected clears the day (back to Off), anything else selects it.
 */
export function levelAfterTap(current: LogLevel, tapped: LogLevel): LogLevel {
  return tapped === current ? "off" : tapped;
}

export function withoutOverrides(overrides: Overrides, keys: Iterable<string>): Overrides {
  const next = { ...overrides };
  for (const key of keys) delete next[key];
  return next;
}

export interface ProgressItem {
  logged: boolean;
  /** False for a habit that is retired or didn't exist yet on this day — not counted. */
  editable: boolean;
  /** Weekly habits: another day of the week already carries it. */
  countedThisWeek?: boolean;
}

export interface DayProgress {
  done: number;
  total: number;
  /** Every countable habit is done — and there was at least one. */
  complete: boolean;
}

/**
 * "3 of 5 done" for the room's habits on one day. A weekly habit already
 * banked on another day of its week counts as done here too: there is nothing
 * left for the member to do about it this week.
 */
export function dayProgress(items: readonly ProgressItem[]): DayProgress {
  const countable = items.filter((item) => item.editable);
  const done = countable.filter((item) => item.logged || item.countedThisWeek === true).length;
  const total = countable.length;
  return { done, total, complete: total > 0 && done === total };
}

/** The server's marked days, with `date` itself re-derived from what is on screen now. */
export function markedDatesWith(
  serverDates: readonly string[],
  date: string,
  dayHasMark: boolean
): Set<string> {
  const dates = new Set(serverDates);
  if (dayHasMark) dates.add(date);
  else dates.delete(date);
  return dates;
}

export interface DaySnapshot {
  /** Habits marked on the day — room and personal. */
  marks: number;
  progress: DayProgress;
}

/**
 * Which haptic a toggle earns: `complete` when it finishes the day, `first`
 * for the day's first mark, `tap` otherwise (including every unmark).
 */
export function toggleFeedback(before: DaySnapshot, after: DaySnapshot): "complete" | "first" | "tap" {
  if (after.progress.complete && !before.progress.complete) return "complete";
  if (before.marks === 0 && after.marks > 0) return "first";
  return "tap";
}
