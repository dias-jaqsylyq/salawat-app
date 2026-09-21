import type { User } from "../types.js";
import {
  dayKeyFromSqliteUtc,
  getCurrentWeekBounds,
  getUserTimezone,
  getUserTodayKey,
  shiftWeekStart,
} from "../utils/challenge.js";

/**
 * How many weeks back of the room's current week the backfill window opens:
 * this week plus this many previous ones (BACKFILL PRD). One constant so the
 * window, the day-picker UI and any test fixture agree on the same span.
 */
export const BACKFILL_WEEKS_BACK = 2;

export interface DailyLogWindow {
  /** The caller's own today (their timezone) — also the window's upper bound. */
  today: string;
  /** Inclusive lower bound: the later of the Monday BACKFILL_WEEKS_BACK weeks
   *  before the room's current week, the day the caller joined the room, and
   *  (when `habit` was given) the day the habit itself was created. */
  minDate: string;
  maxDate: string;
}

/**
 * The inclusive range of days a habit's log may target (backfill PRD): the
 * room's current Monday-Sunday week plus the BACKFILL_WEEKS_BACK weeks before
 * it (the same weeks weekly habits and the leaderboard use for each of those
 * weeks), capped below by whichever is later — that Monday or the day the
 * caller joined the room — and above by the caller's own today. A week older
 * than the window is not reachable through this window, even for a day that
 * was legitimately logged while it was still current.
 *
 * Passing `habit` narrows the lower bound further to the day the habit itself
 * was created, so a member cannot backfill a habit into days before it
 * existed. Omitted for the day-picker itself, which is one control for the
 * whole screen rather than one per habit.
 *
 * All three boundary dates (week start, room join, habit creation) are read
 * as calendar days in the caller's *own* timezone — the same zone their
 * log_date is written in — so the window never disagrees with the day the
 * caller sees as "today".
 *
 * `now` defaults to the real current instant, exactly like getCurrentWeekBounds
 * and getUserToday underneath it — routes never pass it, only tests, to pin
 * "today" instead of a suite's behavior depending on which real weekday it runs
 * on.
 *
 * `habit` only needs a `created_at` — both `Habit` and `PersonalHabit` satisfy
 * that structurally, so this one function serves the personal-habit log
 * routes too (personal habits have no `is_active`/`period` concerns for this
 * window to care about; those are checked separately by their own route, the
 * same way habit_inactive is checked outside dailyLogWindow for room habits).
 */
export function dailyLogWindow(
  user: User,
  habit?: { created_at: string },
  now: Date = new Date()
): DailyLogWindow {
  const timeZone = getUserTimezone(user);
  const today = getUserTodayKey(user, now);
  const { weekStart } = getCurrentWeekBounds(now);

  let minDate = shiftWeekStart(weekStart, -BACKFILL_WEEKS_BACK);
  if (user.room_joined_at !== null) {
    const joinedDay = dayKeyFromSqliteUtc(user.room_joined_at, timeZone);
    if (joinedDay > minDate) minDate = joinedDay;
  }
  if (habit !== undefined) {
    const createdDay = dayKeyFromSqliteUtc(habit.created_at, timeZone);
    if (createdDay > minDate) minDate = createdDay;
  }
  // weekStart is the room's week (TIMEZONE), but today is the caller's own —
  // a member in a zone well behind TIMEZONE can still be living the outgoing
  // week's Sunday after TIMEZONE has already rolled to the new Monday, which
  // would make minDate > today. Rather than an inverted, always-empty window,
  // collapse it to just today: still loggable, never backfillable until the
  // caller's own calendar catches up.
  if (minDate > today) minDate = today;

  return { today, minDate, maxDate: today };
}
