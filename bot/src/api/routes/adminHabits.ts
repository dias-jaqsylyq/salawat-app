import type { Request, Response } from "express";
import { createHabit, getHabitById, listHabits, updateHabit } from "../../db/repository.js";
import type { HabitType } from "../../types.js";

const NAME_MAX_LENGTH = 100;
const MAX_POINTS_WEIGHT = 1_000_000;

function habitResponse(habit: ReturnType<typeof getHabitById>) {
  if (!habit) return undefined;
  return {
    id: habit.id,
    name: habit.name,
    type: habit.type,
    pointsWeight: habit.points_weight,
    isActive: habit.is_active === 1,
    createdAt: habit.created_at,
    updatedAt: habit.updated_at,
  };
}

function parseHabitId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isValidPointsWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_POINTS_WEIGHT;
}

/** GET /api/admin/habits — all habits, including inactive ones. */
export function listAdminHabitsRoute(_req: Request, res: Response): void {
  res.json(listHabits({}).map((habit) => habitResponse(habit)));
}

/** POST /api/admin/habits — create a habit. Body: {name, type, pointsWeight}. */
export function createHabitRoute(req: Request, res: Response): void {
  const body = req.body ?? {};

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

  const habit = createHabit(body.name.trim(), type as HabitType, body.pointsWeight);
  res.status(201).json(habitResponse(habit));
}

/**
 * PATCH /api/admin/habits/:id — edit a habit. Body: {name?, pointsWeight?, isActive?}.
 * Non-destructive and reversible (unlike POST /api/admin/reset), so no YES-confirm needed.
 */
export function patchHabitRoute(req: Request, res: Response): void {
  const id = parseHabitId(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: "invalid_habit_id" });
    return;
  }

  if (!getHabitById(id)) {
    res.status(404).json({ success: false, error: "habit_not_found" });
    return;
  }

  const body = req.body ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasPointsWeight = Object.prototype.hasOwnProperty.call(body, "pointsWeight");
  const hasIsActive = Object.prototype.hasOwnProperty.call(body, "isActive");

  if (!hasName && !hasPointsWeight && !hasIsActive) {
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

  const habit = updateHabit(id, { name, pointsWeight, isActive });
  res.json(habitResponse(habit));
}
