import type { Request, Response } from "express";
import {
  HABIT_LOG_RATE_LIMIT_PER_MINUTE,
  MAX_PERSONAL_HABITS_PER_ROOM,
} from "../../config.js";
import {
  countPersonalHabits,
  createPersonalHabit,
  deletePersonalHabit,
  deletePersonalHabitLog,
  getUserPersonalHabitLogsForDate,
  listPersonalHabits,
  updatePersonalHabit,
  upsertPersonalHabitLog,
} from "../../db/repository.js";
import { LEVEL_VALUE, levelOfValue, type PersonalHabit, type User } from "../../types.js";
import { dailyLogWindow } from "../habitLogWindow.js";
import {
  categoryForCreate,
  checkCategory,
  isValidHabitName,
  parseLevel,
} from "../habitValidation.js";
import { hasExtendedLevelColumns } from "../../db/client.js";
import { parseDateParam, parseIdParam } from "../params.js";
import { allowRequest } from "../rateLimit.js";
import { getOwnPersonalHabit, requireCallerRoom, resolveCallerRoom } from "../roomScope.js";

/**
 * A member's own habits: create, edit, delete and log, all self-service.
 *
 * These routes take telegramAuth but deliberately NOT requireAdmin — the whole
 * point is that an ordinary participant owns this list. The mirror of that is
 * that there is no admin-facing counterpart anywhere: `/api/admin/habits` reads
 * `habits`, this reads `personal_habits`, and the two never meet. An admin
 * cannot see a member's personal habits through any endpoint.
 *
 * No points, anywhere: personal habits have no points_weight, personal logs
 * have no points_earned, and none of this reaches todayPoints, totalPoints, the
 * leaderboard or the CSV export.
 */
function personalHabitResponse(habit: PersonalHabit) {
  return {
    id: habit.id,
    name: habit.name,
    category: habit.category,
    hasExtended: habit.extended_enabled === 1,
    createdAt: habit.created_at,
    updatedAt: habit.updated_at,
  };
}

/**
 * GET /api/personal-habits — the caller's own list for the room they are in.
 * A member between rooms gets an empty list rather than an error, matching
 * GET /api/habits (PRD §3a).
 */
export function listPersonalHabitsRoute(req: Request, res: Response): void {
  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json([]);
    return;
  }
  res.json(
    listPersonalHabits(caller.user.id, caller.roomId).map((habit) =>
      personalHabitResponse(habit)
    )
  );
}

/**
 * POST /api/personal-habits — body `{name, category?, hasExtended?}`.
 * `hasExtended` (default false) offers a second "Extended" level on the Log
 * screen. It records the level only: there are no points, and unlike a room
 * habit no start date — any day in the window may be logged Extended.
 */
export function createPersonalHabitRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const body = req.body ?? {};

  if (!isValidHabitName(body.name)) {
    res.status(400).json({ success: false, error: "invalid_name" });
    return;
  }

  const categoriesEnabled = caller.room.categories_enabled === 1;
  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");
  const checked = checkCategory(body.category, hasCategory, categoriesEnabled);
  if (!checked.ok) {
    res.status(400).json({ success: false, error: checked.error });
    return;
  }
  const category = categoryForCreate(checked, categoriesEnabled);
  if (category === undefined) {
    res.status(400).json({ success: false, error: "category_required" });
    return;
  }

  const hasExtended = checkHasExtended(body, res);
  if (hasExtended === null) return;

  if (countPersonalHabits(caller.user.id, caller.roomId) >= MAX_PERSONAL_HABITS_PER_ROOM) {
    res.status(400).json({ success: false, error: "too_many_personal_habits" });
    return;
  }

  const habit = createPersonalHabit(
    caller.user.id,
    caller.roomId,
    body.name.trim(),
    category,
    hasExtended === true
  );
  res.status(201).json(personalHabitResponse(habit));
}

/**
 * Validate an optional `hasExtended`: a boolean, or absent (undefined). Writes
 * the error itself and returns null when the request cannot proceed —
 * including turning it on while the DB lacks the column (see
 * runExtendedLevelMigration).
 */
function checkHasExtended(
  body: Record<string, unknown>,
  res: Response
): boolean | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(body, "hasExtended")) return undefined;
  if (typeof body.hasExtended !== "boolean") {
    res.status(400).json({ success: false, error: "invalid_has_extended" });
    return null;
  }
  if (!hasExtendedLevelColumns()) {
    res.status(503).json({ success: false, error: "extended_level_unavailable" });
    return null;
  }
  return body.hasExtended;
}

/**
 * PATCH /api/personal-habits/:id — body `{name?, category?, hasExtended?}`.
 * Switching hasExtended off leaves days already logged Extended as they are.
 * Unlike room habits, the owner edits these themselves; an admin has no route
 * that reaches them at all.
 */
export function patchPersonalHabitRoute(req: Request, res: Response): void {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  if (!getOwnPersonalHabit(id, caller.user.id, caller.roomId)) {
    res.status(404).json({ success: false, error: "personal_habit_not_found" });
    return;
  }

  const body = req.body ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");
  const hasExtendedField = Object.prototype.hasOwnProperty.call(body, "hasExtended");

  if (!hasName && !hasCategory && !hasExtendedField) {
    res.status(400).json({ success: false, error: "invalid_body" });
    return;
  }

  let name: string | undefined;
  if (hasName) {
    if (!isValidHabitName(body.name)) {
      res.status(400).json({ success: false, error: "invalid_name" });
      return;
    }
    name = body.name.trim();
  }

  const checked = checkCategory(
    body.category,
    hasCategory,
    caller.room.categories_enabled === 1
  );
  if (!checked.ok) {
    res.status(400).json({ success: false, error: checked.error });
    return;
  }

  const extendedEnabled = checkHasExtended(body, res);
  if (extendedEnabled === null) return;

  const habit = updatePersonalHabit(id, {
    name,
    category: checked.category,
    extendedEnabled,
  });
  res.json(personalHabitResponse(habit));
}

/**
 * DELETE /api/personal-habits/:id — a real delete, logs and all. Nobody else's
 * view of the room depends on this history, so there is nothing to preserve the
 * way habits.is_active preserves a room habit an admin retires.
 */
export function deletePersonalHabitRoute(req: Request, res: Response): void {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  if (!getOwnPersonalHabit(id, caller.user.id, caller.roomId)) {
    res.status(404).json({ success: false, error: "personal_habit_not_found" });
    return;
  }

  deletePersonalHabit(id);
  res.json({ success: true, personalHabitId: id, deleted: true });
}

/**
 * Shared by GET /api/personal-habits/log and POST/DELETE .../:id/log:
 * resolves and validates the `?date=` query param against this caller and
 * (when given) this specific personal habit, using the same window
 * dailyLogWindow already gives room habits (BACKFILL PRD) — a personal habit
 * has no is_active/period to narrow it further, only room_joined_at and its
 * own created_at. Writes the error response itself and returns null when the
 * request cannot proceed. Omitted `date` resolves to the caller's own today.
 */
function resolvePersonalLogDate(
  req: Request,
  res: Response,
  user: User,
  habit?: PersonalHabit
): string | null {
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
 * GET /api/personal-habits/log?date=YYYY-MM-DD — the day picker's own bounds
 * (`today`, `minDate`, `maxDate`) plus every personal habit's state on
 * whichever day is requested (today when `date` is omitted). Mirrors
 * GET /api/habits/log; the two are separate endpoints because personal
 * habits carry no points and live in their own table.
 */
export function personalHabitLogWindowRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const screenWindow = dailyLogWindow(caller.user);
  const date = resolvePersonalLogDate(req, res, caller.user);
  if (date === null) return;

  const habits = listPersonalHabits(caller.user.id, caller.roomId);
  const logs = getUserPersonalHabitLogsForDate(caller.user.id, date);

  const entries = habits.map((habit) => {
    const log = logs.get(habit.id);
    return {
      personalHabitId: habit.id,
      hasExtended: habit.extended_enabled === 1,
      logged: log !== undefined,
      level: log ? levelOfValue(log.value) : null,
      value: log?.value ?? 0,
      editable: date >= dailyLogWindow(caller.user, habit).minDate,
    };
  });

  res.json({
    date,
    today: screenWindow.today,
    minDate: screenWindow.minDate,
    maxDate: screenWindow.maxDate,
    habits: entries,
  });
}

/**
 * POST /api/personal-habits/:id/log?date=YYYY-MM-DD — upsert one day's value,
 * in the caller's own timezone-local day, exactly like POST
 * /api/habits/:id/log. `date` is optional (defaults to today) and, like the
 * room-habit route, may target any earlier day within the backfill window —
 * back to whichever is later of the window's start, the day the caller
 * joined the room, or the day this personal habit was created (BACKFILL PRD).
 * The response has no `points` field because there are none to report.
 *
 * Body `level` is "basic" (default) or "extended"; Extended is refused with
 * no_extended_level unless the habit has hasExtended on.
 */
export function logPersonalHabitRoute(req: Request, res: Response): void {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const habit = getOwnPersonalHabit(id, caller.user.id, caller.roomId);
  if (!habit) {
    res.status(404).json({ success: false, error: "personal_habit_not_found" });
    return;
  }

  // `value` is the pre-levels field, still accepted (only as 1) so an older
  // Mini App build posting `{value: 1}` keeps working; the level is `level`.
  const body = req.body ?? {};
  if (body.value !== undefined && body.value !== null && body.value !== 1) {
    res.status(400).json({ success: false, error: "invalid_value" });
    return;
  }
  const level = parseLevel(body.level);
  if (level === null) {
    res.status(400).json({ success: false, error: "invalid_level" });
    return;
  }
  if (level === "extended" && habit.extended_enabled !== 1) {
    res.status(400).json({ success: false, error: "no_extended_level" });
    return;
  }

  const date = resolvePersonalLogDate(req, res, caller.user, habit);
  if (date === null) return;

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  const log = upsertPersonalHabitLog(habit.id, LEVEL_VALUE[level], date);
  res.json({
    success: true,
    personalHabitId: habit.id,
    value: log.value,
    level: levelOfValue(log.value),
    date: log.log_date,
    logged: true,
  });
}

/**
 * DELETE /api/personal-habits/:id/log?date=YYYY-MM-DD — idempotent, like its
 * room-habit twin. `date` follows the same rules as POST.
 */
export function deletePersonalHabitLogRoute(req: Request, res: Response): void {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const habit = getOwnPersonalHabit(id, caller.user.id, caller.roomId);
  if (!habit) {
    res.status(404).json({ success: false, error: "personal_habit_not_found" });
    return;
  }

  const date = resolvePersonalLogDate(req, res, caller.user, habit);
  if (date === null) return;

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  deletePersonalHabitLog(caller.user.id, habit.id, date);
  res.json({ success: true, personalHabitId: habit.id, date, logged: false });
}
