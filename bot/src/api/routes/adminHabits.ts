import type { Request, Response } from "express";
import { createHabit, listHabits, updateHabit } from "../../db/repository.js";
import type { Habit, HabitPeriod } from "../../types.js";
import {
  categoryForCreate,
  checkCategory,
  checkDescription,
  isValidHabitName,
} from "../habitValidation.js";
import { parseIdParam } from "../params.js";
import { getRoomHabit, requireCallerRoom } from "../roomScope.js";

const MAX_POINTS_WEIGHT = 1_000_000;

function habitResponse(habit: Habit) {
  return {
    id: habit.id,
    name: habit.name,
    // Retired field, echoed as a constant so a Mini App build that predates the
    // binary-only change keeps rendering. Dropped once the client stops reading it.
    type: "binary" as const,
    description: habit.description,
    period: habit.period,
    pointsWeight: habit.points_weight,
    category: habit.category,
    isActive: habit.is_active === 1,
    createdAt: habit.created_at,
    updatedAt: habit.updated_at,
  };
}

function isValidPointsWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_POINTS_WEIGHT;
}

/** GET /api/admin/habits — every habit of the caller's room, including inactive ones. */
export function listAdminHabitsRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  res.json(listHabits({ roomId: caller.roomId }).map((habit) => habitResponse(habit)));
}

/**
 * POST /api/admin/habits — create a habit in the caller's own room.
 * Body: `{name, pointsWeight, category?, period?, description?}`, where
 * `category` is required when the room has categories enabled and rejected when
 * it does not, and `period` defaults to "daily".
 */
export function createHabitRoute(req: Request, res: Response): void {
  const body = req.body ?? {};

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  if (!isValidHabitName(body.name)) {
    res.status(400).json({ success: false, error: "invalid_name" });
    return;
  }

  if (!isValidPointsWeight(body.pointsWeight)) {
    res.status(400).json({ success: false, error: "invalid_points_weight" });
    return;
  }

  // Omitted means daily: a room that never thinks about cadence keeps the
  // behaviour it already had.
  const rawPeriod: unknown = body.period ?? "daily";
  if (rawPeriod !== "daily" && rawPeriod !== "weekly") {
    res.status(400).json({ success: false, error: "invalid_period" });
    return;
  }

  const describedCheck = checkDescription(
    body.description,
    Object.prototype.hasOwnProperty.call(body, "description")
  );
  if (!describedCheck.ok) {
    res.status(400).json({ success: false, error: describedCheck.error });
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

  const habit = createHabit(
    caller.roomId,
    body.name.trim(),
    body.pointsWeight,
    category,
    rawPeriod as HabitPeriod,
    describedCheck.description ?? null
  );
  res.status(201).json(habitResponse(habit));
}

/**
 * PATCH /api/admin/habits/:id — edit a habit of the caller's own room. Body:
 * `{name?, description?, pointsWeight?, isActive?, category?}`. A habit
 * belonging to another room 404s: being an admin of your room is never
 * authority over someone else's (PRD §3a).
 *
 * `period` is deliberately not editable. Points are frozen into each log row
 * under whichever rule was in force when it was written, so turning a daily
 * habit weekly halfway through would leave past weeks holding seven awards the
 * new rule says should have been one. Changing cadence means deactivating the
 * habit and creating its replacement — the same rule the retired `type` had.
 *
 * Non-destructive and reversible (unlike POST /api/admin/reset), so no
 * YES-confirm needed.
 */
export function patchHabitRoute(req: Request, res: Response): void {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  if (!getRoomHabit(id, caller.roomId)) {
    res.status(404).json({ success: false, error: "habit_not_found" });
    return;
  }

  const body = req.body ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const hasPointsWeight = Object.prototype.hasOwnProperty.call(body, "pointsWeight");
  const hasIsActive = Object.prototype.hasOwnProperty.call(body, "isActive");
  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");

  if (!hasName && !hasDescription && !hasPointsWeight && !hasIsActive && !hasCategory) {
    res.status(400).json({ success: false, error: "invalid_body" });
    return;
  }

  const describedCheck = checkDescription(body.description, hasDescription);
  if (!describedCheck.ok) {
    res.status(400).json({ success: false, error: describedCheck.error });
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

  let pointsWeight: number | undefined;
  if (hasPointsWeight) {
    if (!isValidPointsWeight(body.pointsWeight)) {
      res.status(400).json({ success: false, error: "invalid_points_weight" });
      return;
    }
    pointsWeight = body.pointsWeight;
  }

  let isActive: boolean | undefined;
  if (hasIsActive) {
    if (typeof body.isActive !== "boolean") {
      res.status(400).json({ success: false, error: "invalid_is_active" });
      return;
    }
    isActive = body.isActive;
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

  const habit = updateHabit(id, {
    name,
    description: describedCheck.description,
    pointsWeight,
    isActive,
    category: checked.category,
  });
  res.json(habitResponse(habit));
}
