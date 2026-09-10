import type { Request, Response } from "express";
import { HABIT_LOG_RATE_LIMIT_PER_MINUTE, MAX_HABIT_VALUE, config } from "../../config.js";
import {
  deleteHabitLog,
  getHabitById,
  getUserByTelegramId,
  listHabits,
  upsertHabitLog,
} from "../../db/repository.js";
import { formatDateParts, getTodayInTimezone } from "../../utils/challenge.js";
import { allowRequest } from "../rateLimit.js";

/** GET /api/habits — active habits for the logging screen. */
export function listHabitsRoute(_req: Request, res: Response): void {
  const habits = listHabits({ activeOnly: true }).map((habit) => ({
    id: habit.id,
    name: habit.name,
    type: habit.type,
    pointsWeight: habit.points_weight,
  }));
  res.json(habits);
}

function parseHabitId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * POST /api/habits/:id/log — upsert today's value for a habit.
 * Always writes today's TIMEZONE-local log_date, so a log is only ever
 * editable the same day it was made (PIVOT_PLAN §3) — there is no way to
 * target a past day through this endpoint.
 */
export function logHabitRoute(req: Request, res: Response): void {
  const habitId = parseHabitId(req.params.id);
  if (habitId === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const habit = getHabitById(habitId);
  if (!habit) {
    res.status(404).json({ success: false, error: "habit_not_found" });
    return;
  }
  if (habit.is_active !== 1) {
    res.status(400).json({ success: false, error: "habit_inactive" });
    return;
  }

  const body = req.body ?? {};
  let value: number;
  if (habit.type === "binary") {
    if (body.value === undefined || body.value === null) {
      value = 1;
    } else if (body.value === 1) {
      value = 1;
    } else {
      res.status(400).json({ success: false, error: "invalid_value" });
      return;
    }
  } else {
    if (
      typeof body.value !== "number" ||
      !Number.isInteger(body.value) ||
      body.value < 0 ||
      body.value > MAX_HABIT_VALUE
    ) {
      res.status(400).json({ success: false, error: "invalid_value" });
      return;
    }
    value = body.value;
  }

  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  const today = formatDateParts(getTodayInTimezone(config.timezone));
  const log = upsertHabitLog(user.id, habit.id, value, today);

  res.json({
    success: true,
    habitId: habit.id,
    value: log.value,
    points: log.points_earned,
    logged: true,
  });
}

/**
 * DELETE /api/habits/:id/log — remove today's log for a habit, if any.
 * Idempotent (no log today is still a 200), and allowed even against a
 * deactivated habit — this corrects an existing entry rather than logging
 * new engagement, so it isn't gated by habit_inactive like POST is.
 */
export function deleteHabitLogRoute(req: Request, res: Response): void {
  const habitId = parseHabitId(req.params.id);
  if (habitId === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const habit = getHabitById(habitId);
  if (!habit) {
    res.status(404).json({ success: false, error: "habit_not_found" });
    return;
  }

  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  if (!allowRequest(req.telegramId, HABIT_LOG_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  const today = formatDateParts(getTodayInTimezone(config.timezone));
  deleteHabitLog(user.id, habit.id, today);

  res.json({ success: true, habitId: habit.id, logged: false });
}
