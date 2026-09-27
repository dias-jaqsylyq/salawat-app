import type { Request, Response } from "express";
import { HABIT_LOG_RATE_LIMIT_PER_MINUTE } from "../../config.js";
import {
  deleteHabitLog,
  getLoggedDatesInRange,
  getUserHabitLogsForDate,
  listHabits,
  upsertHabitLog,
  weekCarrierRow,
} from "../../db/repository.js";
import type { Habit, User } from "../../types.js";
import { dailyLogWindow } from "../habitLogWindow.js";
import { dayKeyFromSqliteUtc, getUserTimezone } from "../../utils/challenge.js";
import { weekBoundsOfDateKey } from "../../utils/dates.js";
import { parseDateParam, parseIdParam } from "../params.js";
import { allowRequest } from "../rateLimit.js";
import { getRoomHabit, requireCallerRoom, resolveCallerRoom } from "../roomScope.js";

/**
 * GET /api/habits — active habits of the caller's room, for the logging screen.
 * A user between rooms sees an empty list rather than an error: there is simply
 * nothing to log against right now (PRD §3a).
 *
 * `category` is echoed as stored — the client decides whether to group by it,
 * from the room's own categoriesEnabled (GET /api/progress). `period` says
 * whether a habit scores once a day or once a week; weekly habits are listed
 * among the daily ones, in the same categories, and are not a separate section.
 */
export function listHabitsRoute(req: Request, res: Response): void {
  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json([]);
    return;
  }

  const habits = listHabits({ activeOnly: true, roomId: caller.roomId }).map((habit) => ({
    id: habit.id,
    name: habit.name,
    description: habit.description,
    period: habit.period,
    pointsWeight: habit.points_weight,
    category: habit.category,
  }));
  res.json(habits);
}

/**
 * GET /api/habits/log?date=YYYY-MM-DD — the Log screen's day picker (`today`,
 * `minDate`, `maxDate`) plus every active habit's state on whichever day is
 * requested (today when `date` is omitted) — daily and weekly alike, both now
 * backfillable within the same window (BACKFILL PRD).
 *
 * A weekly habit's entry describes *this exact day*, not "this week's status":
 * `logged` mirrors row presence on `date` the same way a daily habit's does,
 * and `countedThisWeek` says whether some *other* day of `date`'s week already
 * carries the points — the write side's weekCarrierRow, read rather than
 * decided. A day can be logged (marked) without being the carrier.
 *
 * `editable` is false when `date` precedes that particular habit's own
 * creation day, even though the day itself is inside the screen's window —
 * the picker is one control for the whole screen, but a habit created
 * mid-window cannot be backfilled into days before it existed. Such a habit is
 * still listed (locked), never hidden.
 *
 * A deactivated habit is listed too, always locked (`isActive: false`,
 * `editable: false`), but only for a `date` in a *past* week during which it
 * was still active — created on or before that week's Sunday and deactivated
 * on or after its Monday. The same read-only treatment the History screen
 * gives retired habits; the current week never shows one.
 *
 * Every entry carries the habit's own display fields, so the Log screen can
 * render a retired habit that GET /api/habits (active only) no longer lists.
 *
 * `markedDates` lists every day of the whole window (not just `date`) that
 * carries any mark — room habit or personal, this room only — so the day
 * picker can dot them without one request per day.
 */
export function habitLogWindowRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const screenWindow = dailyLogWindow(caller.user);

  const requestedRaw = req.query?.date;
  let date: string;
  if (requestedRaw === undefined) {
    date = screenWindow.today;
  } else {
    const parsed = parseDateParam(requestedRaw);
    if (parsed === null) {
      res.status(400).json({ success: false, error: "invalid_date" });
      return;
    }
    date = parsed;
  }

  if (date < screenWindow.minDate || date > screenWindow.maxDate) {
    res.status(400).json({ success: false, error: "date_out_of_window" });
    return;
  }

  const timeZone = getUserTimezone(caller.user);
  const { weekStart, weekEnd } = weekBoundsOfDateKey(date);
  const isPastWeek = weekStart < weekBoundsOfDateKey(screenWindow.today).weekStart;
  const wasActiveDuringWeek = (habit: Habit): boolean => {
    if (!isPastWeek) return false;
    if (dayKeyFromSqliteUtc(habit.created_at, timeZone) > weekEnd) return false;
    const deactivatedAt = habit.deactivated_at ?? habit.updated_at;
    return dayKeyFromSqliteUtc(deactivatedAt, timeZone) >= weekStart;
  };

  const shownHabits = listHabits({ roomId: caller.roomId }).filter(
    (habit) => habit.is_active === 1 || wasActiveDuringWeek(habit)
  );
  const logs = getUserHabitLogsForDate(caller.user.id, date);

  const habits = shownHabits.map((habit) => {
    const log = logs.get(habit.id);
    const isActive = habit.is_active === 1;
    const entry = {
      habitId: habit.id,
      name: habit.name,
      description: habit.description,
      period: habit.period,
      pointsWeight: habit.points_weight,
      category: habit.category,
      isActive,
      logged: log !== undefined,
      value: log?.value ?? 0,
      points: log?.points_earned ?? 0,
      editable: isActive && date >= dailyLogWindow(caller.user, habit).minDate,
    };
    if (habit.period !== "weekly") return entry;
    const carrier = weekCarrierRow(caller.user.id, habit.id, date);
    return {
      ...entry,
      countedThisWeek: carrier !== undefined && carrier.log_date !== date,
    };
  });

  res.json({
    date,
    today: screenWindow.today,
    minDate: screenWindow.minDate,
    maxDate: screenWindow.maxDate,
    habits,
    markedDates: getLoggedDatesInRange(
      caller.user.id,
      caller.roomId,
      screenWindow.minDate,
      screenWindow.maxDate
    ),
  });
}

/**
 * Shared by POST and DELETE /api/habits/:id/log: resolves and validates the
 * `?date=` query param against this caller and this specific habit, writing
 * the error response itself and returning null when the request cannot
 * proceed. Omitted `date` always resolves to the caller's own today, exactly
 * the previous (pre-backfill) behavior of both routes.
 *
 * Weekly habits accept any date inside the window, exactly like daily ones
 * (BACKFILL PRD) — the carrier-row logic in upsertHabitLog/deleteHabitLog
 * already keys off whichever logDate it is given, not "today", so a marked
 * day earlier in the window banks or releases the week's points correctly
 * without any special-casing here.
 */
function resolveLogDate(req: Request, res: Response, user: User, habit: Habit): string | null {
  const window = dailyLogWindow(user, habit);

  const requestedRaw = req.query?.date;
  if (requestedRaw === undefined) return window.today;

  const parsed = parseDateParam(requestedRaw);
  if (parsed === null) {
    res.status(400).json({ success: false, error: "invalid_date" });
    return null;
  }
  if (parsed < window.minDate || parsed > window.maxDate) {
    res.status(400).json({ success: false, error: "date_out_of_window" });
    return null;
  }
  return parsed;
}

/**
 * POST /api/habits/:id/log?date=YYYY-MM-DD — upsert one day's value for a
 * habit of the caller's own room. A habit of any other room 404s exactly like
 * a non-existent one.
 *
 * `date` is optional and defaults to the caller's own today (their personal
 * timezone, falling back to TIMEZONE until the Mini App has detected one).
 * It may also target any earlier day within the backfill window — the room's
 * current week plus the BACKFILL_WEEKS_BACK weeks before it — back to
 * whichever is later of that window's start, the day the caller joined the
 * room, or the day the habit itself was created (BACKFILL PRD); see
 * dailyLogWindow. DAILY and WEEKLY habits share the same window: a WEEKLY
 * habit's carrier-row bookkeeping (upsertHabitLog) already keys off whichever
 * date it is given, not "today".
 */
export function logHabitRoute(req: Request, res: Response): void {
  const habitId = parseIdParam(req.params.id);
  if (habitId === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const habit = getRoomHabit(habitId, caller.roomId);
  if (!habit) {
    res.status(404).json({ success: false, error: "habit_not_found" });
    return;
  }
  if (habit.is_active !== 1) {
    res.status(400).json({ success: false, error: "habit_inactive" });
    return;
  }

  // Every habit is done-or-not, so the only value a log can carry is 1. The
  // field is still accepted (and still validated) so a Mini App build that
  // predates the change keeps working by posting `{value: 1}`.
  const body = req.body ?? {};
  if (body.value !== undefined && body.value !== null && body.value !== 1) {
    res.status(400).json({ success: false, error: "invalid_value" });
    return;
  }
  const value = 1;

  const date = resolveLogDate(req, res, caller.user, habit);
  if (date === null) return;

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  const log = upsertHabitLog(caller.user.id, habit.id, value, date);

  res.json({
    success: true,
    habitId: habit.id,
    value: log.value,
    points: log.points_earned,
    date: log.log_date,
    logged: true,
  });
}

/**
 * DELETE /api/habits/:id/log?date=YYYY-MM-DD — remove one day's log for a
 * habit of the caller's own room, if any. Idempotent (no log on that day is
 * still a 200).
 *
 * Blocked against a deactivated habit, same as POST — once a habit is
 * deactivated, editing it is closed entirely, including correcting a mistaken
 * past entry. (This used to be allowed, on the theory that a delete only
 * corrects existing engagement rather than logging new engagement; that
 * carve-out is gone now that backfill reaches three weeks back, wide enough
 * that "editing" and "logging new engagement" against a retired habit are no
 * longer practically distinguishable.)
 *
 * `date` follows the same rules as POST: optional (defaults to today), and
 * reaches back to dailyLogWindow's minDate for daily and weekly habits alike.
 * Un-marking a backfilled day is exactly as allowed as marking one, within
 * the same window — a week older than the window is no more editable for a
 * delete than for a write.
 */
export function deleteHabitLogRoute(req: Request, res: Response): void {
  const habitId = parseIdParam(req.params.id);
  if (habitId === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const habit = getRoomHabit(habitId, caller.roomId);
  if (!habit) {
    res.status(404).json({ success: false, error: "habit_not_found" });
    return;
  }
  if (habit.is_active !== 1) {
    res.status(400).json({ success: false, error: "habit_inactive" });
    return;
  }

  const date = resolveLogDate(req, res, caller.user, habit);
  if (date === null) return;

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  deleteHabitLog(caller.user.id, habit.id, date);

  res.json({ success: true, habitId: habit.id, date, logged: false });
}
