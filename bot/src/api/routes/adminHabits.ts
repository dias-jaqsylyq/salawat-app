import type { Request, Response } from "express";
import { hasAmountColumns, hasExtendedLevelColumns } from "../../db/client.js";
import {
  createHabit,
  getHabitIdsWithLoggedAmounts,
  listHabits,
  updateHabit,
} from "../../db/repository.js";
import type { Habit, HabitAmounts, HabitPeriod } from "../../types.js";
import {
  categoryForCreate,
  checkCategory,
  checkDescription,
  checkUnitLabel,
  isValidAmount,
  isValidHabitName,
} from "../habitValidation.js";
import { parseIdParam } from "../params.js";
import { getRoomHabit, requireCallerRoom } from "../roomScope.js";

const MAX_POINTS_WEIGHT = 1_000_000;

/**
 * `hasLoggedAmounts` tells the Admin form that relabelling the unit would
 * relabel amounts already frozen into logs (they are not converted), so it
 * asks for confirmation first.
 */
function habitResponse(habit: Habit, hasLoggedAmounts = false) {
  return {
    id: habit.id,
    name: habit.name,
    description: habit.description,
    period: habit.period,
    pointsWeight: habit.points_weight,
    extendedPoints: habit.extended_points ?? null,
    extendedFrom: habit.extended_from ?? null,
    unitLabel: habit.unit_label ?? null,
    amountBasic: habit.amount_basic ?? null,
    amountExtended: habit.amount_extended ?? null,
    hasLoggedAmounts,
    category: habit.category,
    isActive: habit.is_active === 1,
    createdAt: habit.created_at,
    updatedAt: habit.updated_at,
  };
}

function isValidPointsWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_POINTS_WEIGHT;
}

/**
 * Validate a provided `extendedPoints` against the habit it would end up on.
 * null (switch off) is always fine; a number must be a valid weight, at least
 * the base, and on a daily habit. Writes the error itself and returns false.
 */
function checkExtendedPoints(
  extendedPoints: unknown,
  period: HabitPeriod,
  basePoints: number,
  res: Response
): extendedPoints is number | null {
  // First: without the columns even switching off cannot be written (see
  // runExtendedLevelMigration), and that is a server state, not a bad request.
  if (!hasExtendedLevelColumns()) {
    res.status(503).json({ success: false, error: "extended_level_unavailable" });
    return false;
  }
  if (extendedPoints === null) return true;
  if (!isValidPointsWeight(extendedPoints)) {
    res.status(400).json({ success: false, error: "invalid_extended_points" });
    return false;
  }
  if (period !== "daily") {
    res.status(400).json({ success: false, error: "extended_level_not_allowed" });
    return false;
  }
  if (extendedPoints < basePoints) {
    res.status(400).json({ success: false, error: "extended_points_below_base" });
    return false;
  }
  return true;
}

const AMOUNT_FIELDS = ["unitLabel", "amountBasic", "amountExtended"] as const;

/**
 * Validate the optional per-completion estimate of a create or PATCH body
 * against the habit it would end up on, and return the fields to write
 * (absent = leave alone). Writes the error itself and returns null.
 *
 * The rules, checked on the habit as it will be after the request: an amount
 * needs a unit, an Extended amount needs a Basic one and an Extended level,
 * and is at least the Basic one. A label alone is allowed — it just has no
 * estimate behind it yet.
 */
function checkAmounts(
  body: Record<string, unknown>,
  stored: HabitAmounts,
  hasExtendedLevel: boolean,
  res: Response
): Partial<HabitAmounts> | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  if (!AMOUNT_FIELDS.some(has)) return {};
  if (!hasAmountColumns()) {
    res.status(503).json({ success: false, error: "amounts_unavailable" });
    return null;
  }

  const patch: Partial<HabitAmounts> = {};
  const unit = checkUnitLabel(body.unitLabel, has("unitLabel"));
  if (!unit.ok) {
    res.status(400).json({ success: false, error: unit.error });
    return null;
  }
  if (unit.unitLabel !== undefined) patch.unitLabel = unit.unitLabel;
  for (const key of ["amountBasic", "amountExtended"] as const) {
    if (!has(key)) continue;
    const raw = body[key] ?? null;
    if (raw !== null && !isValidAmount(raw)) {
      res.status(400).json({ success: false, error: "invalid_amount" });
      return null;
    }
    patch[key] = raw as number | null;
  }

  const unitLabel = patch.unitLabel !== undefined ? patch.unitLabel : stored.unitLabel;
  const basic = patch.amountBasic !== undefined ? patch.amountBasic : stored.amountBasic;
  // A stored Extended amount on a habit losing its Extended level is cleared
  // with the level (updateHabit), so it is not held against this request.
  const extended =
    patch.amountExtended !== undefined
      ? patch.amountExtended
      : hasExtendedLevel
        ? stored.amountExtended
        : null;

  let error: string | null = null;
  if (basic !== null && unitLabel === null) error = "amount_requires_unit";
  else if (extended !== null && !hasExtendedLevel) error = "amount_extended_not_allowed";
  else if (extended !== null && basic === null) error = "amount_extended_requires_basic";
  else if (extended !== null && basic !== null && extended < basic) {
    error = "amount_extended_below_basic";
  }
  if (error !== null) {
    res.status(400).json({ success: false, error });
    return null;
  }
  return patch;
}

/** GET /api/admin/habits — every habit of the caller's room, including inactive ones. */
export function listAdminHabitsRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const withAmounts = getHabitIdsWithLoggedAmounts(caller.roomId);
  res.json(
    listHabits({ roomId: caller.roomId }).map((habit) =>
      habitResponse(habit, withAmounts.has(habit.id))
    )
  );
}

/**
 * POST /api/admin/habits — create a habit in the caller's own room.
 * Body: `{name, pointsWeight, category?, period?, description?, extendedPoints?,
 * unitLabel?, amountBasic?, amountExtended?}`,
 * where `category` is required when the room has categories enabled and
 * rejected when it does not, and `period` defaults to "daily".
 *
 * `extendedPoints` (omitted or null = single-level) is the TOTAL an Extended
 * log scores, >= pointsWeight, daily habits only. Extended becomes loggable
 * from today (config.timezone) on — see habits.extended_from.
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

  // Omitted/null is a plain single-level habit and never touches the new
  // columns, so it is not checked (and keeps working without them).
  const extendedPoints: unknown = body.extendedPoints ?? null;
  if (
    extendedPoints !== null &&
    !checkExtendedPoints(extendedPoints, rawPeriod as HabitPeriod, body.pointsWeight, res)
  ) {
    return;
  }

  const amounts = checkAmounts(
    body,
    { unitLabel: null, amountBasic: null, amountExtended: null },
    extendedPoints !== null,
    res
  );
  if (amounts === null) return;

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
    describedCheck.description ?? null,
    extendedPoints,
    amounts.unitLabel === undefined && amounts.amountBasic === undefined
      ? null
      : {
          unitLabel: amounts.unitLabel ?? null,
          amountBasic: amounts.amountBasic ?? null,
          amountExtended: amounts.amountExtended ?? null,
        }
  );
  res.status(201).json(habitResponse(habit));
}

/**
 * PATCH /api/admin/habits/:id — edit a habit of the caller's own room. Body:
 * `{name?, description?, pointsWeight?, isActive?, category?, extendedPoints?,
 * unitLabel?, amountBasic?, amountExtended?}`. A habit
 * belonging to another room 404s: being an admin of your room is never
 * authority over someone else's (PRD §3a).
 *
 * `period` is deliberately not editable. Points are frozen into each log row
 * under whichever rule was in force when it was written, so turning a daily
 * habit weekly halfway through would leave past weeks holding seven awards the
 * new rule says should have been one. Changing cadence means deactivating the
 * habit and creating its replacement — the same rule the retired `type` had.
 *
 * `extendedPoints`: a number switches the Extended level on (or edits its
 * points), null switches it off. Days already logged keep their frozen points
 * and level either way. The extended >= base rule is checked against the
 * habit as it will be after this PATCH, so raising only pointsWeight above the
 * stored extendedPoints is refused too.
 *
 * `unitLabel` / `amountBasic` / `amountExtended`: the per-completion estimate
 * the Stats tab sums. Like points, an edit only reaches logs written after it
 * — except the very first time an amount is set, when the habit's existing
 * logs are given one once (backfillHabitAmounts). A unit rename relabels the
 * whole history; the old amounts are not converted.
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

  const current = getRoomHabit(id, caller.roomId);
  if (!current) {
    res.status(404).json({ success: false, error: "habit_not_found" });
    return;
  }

  const body = req.body ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const hasPointsWeight = Object.prototype.hasOwnProperty.call(body, "pointsWeight");
  const hasIsActive = Object.prototype.hasOwnProperty.call(body, "isActive");
  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");
  const hasExtendedPoints = Object.prototype.hasOwnProperty.call(body, "extendedPoints");
  const hasAmountField = AMOUNT_FIELDS.some((key) =>
    Object.prototype.hasOwnProperty.call(body, key)
  );

  if (
    !hasName &&
    !hasDescription &&
    !hasPointsWeight &&
    !hasIsActive &&
    !hasCategory &&
    !hasExtendedPoints &&
    !hasAmountField
  ) {
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

  let extendedPoints: number | null | undefined;
  if (hasExtendedPoints) {
    const raw: unknown = body.extendedPoints ?? null;
    if (!checkExtendedPoints(raw, current.period, pointsWeight ?? current.points_weight, res)) {
      return;
    }
    extendedPoints = raw;
  } else if (pointsWeight !== undefined) {
    const stored = current.extended_points ?? null;
    if (stored !== null && stored < pointsWeight) {
      res.status(400).json({ success: false, error: "extended_points_below_base" });
      return;
    }
  }

  const amounts = checkAmounts(
    body,
    {
      unitLabel: current.unit_label ?? null,
      amountBasic: current.amount_basic ?? null,
      amountExtended: current.amount_extended ?? null,
    },
    extendedPoints !== undefined
      ? extendedPoints !== null
      : (current.extended_points ?? null) !== null,
    res
  );
  if (amounts === null) return;

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
    extendedPoints,
    ...amounts,
  });
  res.json(habitResponse(habit, getHabitIdsWithLoggedAmounts(caller.roomId).has(habit.id)));
}
