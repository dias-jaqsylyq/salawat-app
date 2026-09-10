import type { Request, Response } from "express";
import { createHabit, listHabits, updateHabit } from "../../db/repository.js";
import { HABIT_CATEGORIES, type Habit, type HabitCategory, type HabitType } from "../../types.js";
import { parseIdParam } from "../params.js";
import { getRoomHabit, requireCallerRoom } from "../roomScope.js";

const NAME_MAX_LENGTH = 100;
const MAX_POINTS_WEIGHT = 1_000_000;

function habitResponse(habit: Habit) {
  return {
    id: habit.id,
    name: habit.name,
    type: habit.type,
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

function isHabitCategory(value: unknown): value is HabitCategory {
  return typeof value === "string" && (HABIT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The application-layer half of the category invariant (PRD §1): a habit in a
 * categories-enabled room always carries one of IQ/SQ/PQ/EQ, and a habit in a
 * categories-disabled room never carries one. The column itself only checks the
 * value is one of the four.
 *
 * `raw` is the request's category value; `provided` distinguishes "field
 * omitted" from "explicit null", which only PATCH cares about.
 */
type CategoryCheck =
  | { ok: true; category: HabitCategory | null | undefined }
  | { ok: false; error: string };

function checkCategory(
  raw: unknown,
  provided: boolean,
  categoriesEnabled: boolean
): CategoryCheck {
  if (!categoriesEnabled) {
    // Omitted, or explicitly cleared, are both fine; anything else is not.
    if (!provided || raw === null || raw === undefined) {
      return { ok: true, category: provided ? null : undefined };
    }
    return { ok: false, error: "category_not_allowed" };
  }
  if (!provided || raw === undefined) {
    return { ok: true, category: undefined };
  }
  if (raw === null) {
    return { ok: false, error: "category_required" };
  }
  if (!isHabitCategory(raw)) {
    return { ok: false, error: "invalid_category" };
  }
  return { ok: true, category: raw };
}

/** GET /api/admin/habits — every habit of the caller's room, including inactive ones. */
export function listAdminHabitsRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  res.json(listHabits({ roomId: caller.roomId }).map((habit) => habitResponse(habit)));
}

/**
 * POST /api/admin/habits — create a habit in the caller's own room.
 * Body: `{name, type, pointsWeight, category?}`, where `category` is required
 * when the room has categories enabled and rejected when it does not.
 */
export function createHabitRoute(req: Request, res: Response): void {
  const body = req.body ?? {};

  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.trim().length > NAME_MAX_LENGTH) {
    res.status(400).json({ success: false, error: "invalid_name" });
    return;
  }

  const type: unknown = body.type;
  if (type !== "quantity" && type !== "binary") {
    res.status(400).json({ success: false, error: "invalid_type" });
    return;
  }

  if (!isValidPointsWeight(body.pointsWeight)) {
    res.status(400).json({ success: false, error: "invalid_points_weight" });
    return;
  }

  const categoriesEnabled = caller.room.categories_enabled === 1;
  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");
  const checked = checkCategory(body.category, hasCategory, categoriesEnabled);
  if (!checked.ok) {
    res.status(400).json({ success: false, error: checked.error });
    return;
  }
  // On create there is nothing to leave unchanged: a categories-enabled room
  // needs the value now, a categories-disabled one stores null.
  if (categoriesEnabled && (checked.category === undefined || checked.category === null)) {
    res.status(400).json({ success: false, error: "category_required" });
    return;
  }

  const habit = createHabit(
    caller.roomId,
    body.name.trim(),
    type as HabitType,
    body.pointsWeight,
    categoriesEnabled ? (checked.category as HabitCategory) : null
  );
  res.status(201).json(habitResponse(habit));
}

/**
 * PATCH /api/admin/habits/:id — edit a habit of the caller's own room. Body:
 * `{name?, pointsWeight?, isActive?, category?}`. A habit belonging to another
 * room 404s: being an admin of your room is never authority over someone
 * else's (PRD §3a).
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
  const hasPointsWeight = Object.prototype.hasOwnProperty.call(body, "pointsWeight");
  const hasIsActive = Object.prototype.hasOwnProperty.call(body, "isActive");
  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");

  if (!hasName && !hasPointsWeight && !hasIsActive && !hasCategory) {
    res.status(400).json({ success: false, error: "invalid_body" });
    return;
  }

  let name: string | undefined;
  if (hasName) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.trim().length > NAME_MAX_LENGTH) {
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

  const habit = updateHabit(id, { name, pointsWeight, isActive, category: checked.category });
  res.json(habitResponse(habit));
}
