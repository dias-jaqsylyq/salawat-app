import type { Request, Response } from "express";
import {
  getHabitLogDatesInRange,
  getPersonalHabitLogDatesInRange,
  getUserByTelegramId,
  getWeeklyHabitStreak,
  listHabits,
  listPersonalHabits,
} from "../../db/repository.js";
import {
  dayKeyFromSqliteUtc,
  formatDateParts,
  getCurrentWeekBounds,
  getUserTimezone,
  getUserToday,
  parseDateKey,
  WEEK_START_DAY,
} from "../../utils/challenge.js";
import { addCalendarDays } from "../../utils/dates.js";
import { resolveCallerRoom } from "../roomScope.js";

const DAYS_IN_WEEK = 7;

/**
 * GET /api/progress/week — this week, per active habit, for the weekly streak view.
 *
 * The week is the room's week: Monday-Sunday in TIMEZONE, the same window a
 * weekly habit scores in and the weekly leaderboard resets on. It used to be
 * each viewer's own week from users.week_start_day; that preference no longer
 * moves any boundary, because a grid on a different week from the weekly habits
 * drawn beneath it is a grid that lies. `weekStartDay` is still in the response,
 * now as the constant it has become, so an older client keeps parsing it.
 *
 * Daily habits get a seven-cell row. Cells carry presence only, never a count:
 * the view draws a lit or unlit flame and deliberately has no "X of 7". Two
 * kinds of cell are neither lit nor missed and say so explicitly, so the UI can
 * grey them out instead of scoring them against the member:
 *   - `locked` — the day precedes their room_joined_at (they joined mid-week).
 *   - `future` — the day has not happened yet in their own timezone.
 *
 * Weekly habits are **not** given a row of seven: a week is one unit for them,
 * so seven cells would invite reading six unlit days as six misses. They come
 * back in `weeklyHabits` instead, one entry each, carrying how many days of the
 * week are marked (`count`, normally 0 or 1 — more when the member marked it on
 * several days, of which only the first was worth anything), whether the week is
 * done at all (`met`), and the run of consecutive weeks behind it
 * (`streakWeeks`).
 *
 * Read-only by construction: there is no matching write endpoint, because the
 * weekly view is not tappable and logging still happens only for today, through
 * POST /api/habits/:id/log (day-override stays out of scope, PIVOT_PLAN §7).
 *
 * The caller's personal habits are appended to the same `habits` array rather
 * than given one of their own: on the Progress screen a streak is a streak, and
 * the two kinds are deliberately not separated visually. `personal` says which
 * table a row came from — the two id spaces overlap, so the client needs it to
 * key rows apart, not to style them differently. Personal habits are daily-only,
 * so they never appear in `weeklyHabits`.
 */
export function progressWeekRoute(req: Request, res: Response): void {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  // "Today" stays the viewer's own day — it is the day their logs land on, and
  // what the grid rings — while the week around it is the room's.
  const todayKey = formatDateParts(getUserToday(user));
  const { weekStart, weekEnd } = getCurrentWeekBounds();
  const days = Array.from({ length: DAYS_IN_WEEK }, (_, i) =>
    formatDateParts(addCalendarDays(parseDateKey(weekStart), i))
  );

  const caller = resolveCallerRoom(req);
  if (!caller) {
    // Between rooms: the week itself is still well-defined, there is just
    // nothing in it — same empty-view convention as every other read (PRD §3a).
    res.json({
      weekStart,
      weekEnd,
      weekStartDay: WEEK_START_DAY,
      today: todayKey,
      days,
      habits: [],
      weeklyHabits: [],
    });
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
    ...activeHabits
      .filter((habit) => habit.period !== "weekly")
      .map((habit) => buildRow(habit.id, habit.name, loggedDates.get(habit.id), false)),
    ...personalHabits.map((habit) =>
      buildRow(habit.id, habit.name, personalLoggedDates.get(habit.id), true)
    ),
  ];

  const weeklyHabits = activeHabits
    .filter((habit) => habit.period === "weekly")
    .map((habit) => {
      const count = loggedDates.get(habit.id)?.size ?? 0;
      return {
        habitId: habit.id,
        name: habit.name,
        description: habit.description,
        count,
        met: count > 0,
        streakWeeks: getWeeklyHabitStreak(user.id, habit.id, weekStart),
      };
    });

  res.json({
    weekStart,
    weekEnd,
    weekStartDay: WEEK_START_DAY,
    today: todayKey,
    days,
    habits,
    weeklyHabits,
  });
}
