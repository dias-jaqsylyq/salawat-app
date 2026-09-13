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
  listPersonalHabits,
  updatePersonalHabit,
  upsertPersonalHabitLog,
} from "../../db/repository.js";
import type { PersonalHabit } from "../../types.js";
import { getUserTodayKey } from "../../utils/challenge.js";
import { categoryForCreate, checkCategory, isValidHabitName } from "../habitValidation.js";
import { parseIdParam } from "../params.js";
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

/** POST /api/personal-habits — body `{name, category?}`. */
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

  if (countPersonalHabits(caller.user.id, caller.roomId) >= MAX_PERSONAL_HABITS_PER_ROOM) {
    res.status(400).json({ success: false, error: "too_many_personal_habits" });
    return;
  }

  const habit = createPersonalHabit(
    caller.user.id,
    caller.roomId,
    body.name.trim(),
    category
  );
  res.status(201).json(personalHabitResponse(habit));
}

/**
 * PATCH /api/personal-habits/:id — body `{name?, category?}`.
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

  if (!hasName && !hasCategory) {
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

  const habit = updatePersonalHabit(id, { name, category: checked.category });
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
 * POST /api/personal-habits/:id/log — upsert today's value, in the caller's own
 * timezone-local day, exactly like POST /api/habits/:id/log. The response has no
 * `points` field because there are none to report.
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

  // Done-or-not: the only value a log can carry is 1. `value` is still accepted
  // so an older Mini App build posting `{value: 1}` keeps working.
  const body = req.body ?? {};
  if (body.value !== undefined && body.value !== null && body.value !== 1) {
    res.status(400).json({ success: false, error: "invalid_value" });
    return;
  }
  const value = 1;

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  const log = upsertPersonalHabitLog(habit.id, value, getUserTodayKey(caller.user));
  res.json({ success: true, personalHabitId: habit.id, value: log.value, logged: true });
}

/** DELETE /api/personal-habits/:id/log — idempotent, like its room-habit twin. */
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

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  deletePersonalHabitLog(caller.user.id, habit.id, getUserTodayKey(caller.user));
  res.json({ success: true, personalHabitId: habit.id, logged: false });
}
