import type { Request, Response } from "express";
import { HABIT_LOG_RATE_LIMIT_PER_MINUTE } from "../../config.js";
import {
  deleteHabitLog,
  getUserHabitLogsForDate,
  listHabits,
  upsertHabitLog,
} from "../../db/repository.js";
import type { Habit, User } from "../../types.js";
import { dailyLogWindow } from "../habitLogWindow.js";
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
 * `minDate`, `maxDate`) plus every DAILY habit's state on whichever day is
 * requested (today when `date` is omitted).
 *
 * Weekly habits are left out entirely: they are not backfillable (BACKFILL PRD),
 * so the client keeps reading their state from GET /api/progress, which is
 * always "today" regardless of what is selected here.
 *
 * `editable` is false when `date` precedes that particular habit's own
 * creation day, even though the day itself is inside the screen's window —
 * the picker is one control for the whole screen, but a habit created
 * mid-week cannot be backfilled into days before it existed.
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

  const dailyHabits = listHabits({ activeOnly: true, roomId: caller.roomId }).filter(
    (habit) => habit.period === "daily"
  );
  const logs = getUserHabitLogsForDate(caller.user.id, date);

  const habits = dailyHabits.map((habit) => {
    const log = logs.get(habit.id);
    return {
      habitId: habit.id,
      logged: log !== undefined,
      value: log?.value ?? 0,
      points: log?.points_earned ?? 0,
      editable: date >= dailyLogWindow(caller.user, habit).minDate,
    };
  });

  res.json({
    date,
    today: screenWindow.today,
    minDate: screenWindow.minDate,
    maxDate: screenWindow.maxDate,
    habits,
  });
}

/**
 * Shared by POST and DELETE /api/habits/:id/log: resolves and validates the
 * `?date=` query param against this caller and this specific habit, writing
 * the error response itself and returning null when the request cannot
 * proceed. Omitted `date` always resolves to the caller's own today, exactly
 * the previous (pre-backfill) behavior of both routes.
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
  // Weekly habits score once for the whole week (upsertHabitLog's carrier
  // logic), which only makes sense pinned to the day the member actually
  // marked it on — backfill is daily-only by design (BACKFILL PRD).
  if (habit.period === "weekly" && parsed !== window.today) {
    res.status(400).json({ success: false, error: "habit_not_backfillable" });
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
 * For a DAILY habit it may also target any earlier day of the room's current
 * week, back to whichever is later of that week's Monday, the day the caller
 * joined the room, or the day the habit itself was created (BACKFILL PRD) —
 * see dailyLogWindow. A WEEKLY habit accepts no date but today's.
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
 * still a 200), and allowed even against a deactivated habit — this corrects
 * an existing entry rather than logging new engagement, so it isn't gated by
 * habit_inactive like POST is.
 *
 * `date` follows the same rules as POST: optional (defaults to today), and
 * for a DAILY habit reaches back to dailyLogWindow's minDate. Un-marking a
 * backfilled day is exactly as allowed as marking one, within the same window
 * — a week that has since closed is no more editable for a delete than for a
 * write.
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

  const date = resolveLogDate(req, res, caller.user, habit);
  if (date === null) return;

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  deleteHabitLog(caller.user.id, habit.id, date);

  res.json({ success: true, habitId: habit.id, date, logged: false });
}
