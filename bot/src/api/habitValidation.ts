import { HABIT_CATEGORIES, type HabitCategory } from "../types.js";

/**
 * Validation shared by the admin habit routes and the personal habit routes.
 * Both surfaces answer to the same room setting, so the rule lives here once
 * rather than being restated (and drifting) in each.
 */

export const NAME_MAX_LENGTH = 100;

export function isValidHabitName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= NAME_MAX_LENGTH
  );
}

export function isHabitCategory(value: unknown): value is HabitCategory {
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
export type CategoryCheck =
  | { ok: true; category: HabitCategory | null | undefined }
  | { ok: false; error: string };

export function checkCategory(
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

/**
 * On create there is nothing to leave unchanged: a categories-enabled room
 * needs the value now, a categories-disabled one stores null.
 */
export function categoryForCreate(
  checked: Extract<CategoryCheck, { ok: true }>,
  categoriesEnabled: boolean
): HabitCategory | null | undefined {
  if (!categoriesEnabled) return null;
  if (checked.category === undefined || checked.category === null) return undefined;
  return checked.category;
}
