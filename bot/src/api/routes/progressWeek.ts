import type { Request, Response } from "express";
import {
  getHabitLogDatesInRange,
  getPersonalHabitLogDatesInRange,
  getUserByTelegramId,
  listHabits,
  listPersonalHabits,
} from "../../db/repository.js";
import {
  dayKeyFromSqliteUtc,
  formatDateParts,
  getUserTimezone,
  getUserToday,
} from "../../utils/challenge.js";
import { addCalendarDays, startOfWeek } from "../../utils/dates.js";
import { resolveCallerRoom } from "../roomScope.js";

const DAYS_IN_WEEK = 7;

/**
 * GET /api/progress/week — the seven days of the caller's current calendar week,
 * per active habit, for the weekly streak view.
 *
 * A *calendar* week from the user's own start day (users.week_start_day,
 * default Monday), not a rolling last-7-days window — so the row a member sees
 * on Wednesday covers the same dates it covered on Monday, with the rest of the
 * week still ahead of them.
 *
 * Cells carry presence only, never a count: the view draws a lit or unlit flame
 * and deliberately has no "X of 7". Two kinds of cell are neither lit nor
 * missed and say so explicitly, so the UI can grey them out instead of scoring
 * them against the member:
 *   - `locked` — the day precedes their room_joined_at (they joined mid-week).
 *   - `future`  — the day has not happened yet in their own timezone.
 *
 * Read-only by construction: there is no matching write endpoint, because the
 * weekly view is not tappable and logging still happens only for today, through
 * POST /api/habits/:id/log (day-override stays out of scope, PIVOT_PLAN §7).
 *
 * The caller's personal habits are appended to the same `habits` array rather
 * than given one of their own: on the Progress screen a streak is a streak, and
 * the two kinds are deliberately not separated visually. `personal` says which
 * table a row came from — the two id spaces overlap, so the client needs it to
 * key rows apart, not to style them differently.
 */
export function progressWeekRoute(req: Request, res: Response): void {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  const todayParts = getUserToday(user);
  const todayKey = formatDateParts(todayParts);
  const weekStartDay = user.week_start_day;
  const weekStartParts = startOfWeek(todayParts, weekStartDay);
  const days = Array.from({ length: DAYS_IN_WEEK }, (_, i) =>
    formatDateParts(addCalendarDays(weekStartParts, i))
  );
  const weekStart = days[0]!;
  const weekEnd = days[DAYS_IN_WEEK - 1]!;

  const caller = resolveCallerRoom(req);
  if (!caller) {
    // Between rooms: the week itself is still well-defined, there is just
    // nothing in it — same empty-view convention as every other read (PRD §3a).
    res.json({ weekStart, weekStartDay, today: todayKey, days, habits: [] });
    return;
  }

  // room_joined_at is UTC text; the grid is in the user's local days, so it has
  // to be read as the local day they joined on — that whole day counts as
  // joined, however late in it the join happened.
  const joinedDay =
    user.room_joined_at === null
      ? null
      : dayKeyFromSqliteUtc(user.room_joined_at, getUserTimezone(user));

  const activeHabits = listHabits({ activeOnly: true, roomId: caller.roomId });
  const loggedDates = getHabitLogDatesInRange(user.id, caller.roomId, weekStart, weekEnd);

  const personalHabits = listPersonalHabits(user.id, caller.roomId);
  const personalLoggedDates = getPersonalHabitLogDatesInRange(
    user.id,
    caller.roomId,
    weekStart,
    weekEnd
  );

  const buildRow = (
    habitId: number,
    name: string,
    logged: Set<string> | undefined,
    personal: boolean
  ) => ({
    habitId,
    name,
    personal,
    days: days.map((date) => ({
      date,
      logged: logged?.has(date) ?? false,
      locked: joinedDay !== null && date < joinedDay,
      future: date > todayKey,
    })),
  });

  const habits = [
    ...activeHabits.map((habit) =>
      buildRow(habit.id, habit.name, loggedDates.get(habit.id), false)
    ),
    ...personalHabits.map((habit) =>
      buildRow(habit.id, habit.name, personalLoggedDates.get(habit.id), true)
    ),
  ];

  res.json({ weekStart, weekStartDay, today: todayKey, days, habits });
}
