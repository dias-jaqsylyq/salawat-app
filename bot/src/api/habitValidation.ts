import { HABIT_CATEGORIES, type HabitCategory } from "../types.js";

/**
 * Validation shared by the admin habit routes and the personal habit routes.
 * Both surfaces answer to the same room setting, so the rule lives here once
 * rather than being restated (and drifting) in each.
 */

export const NAME_MAX_LENGTH = 100;

/**
 * The admin's free-text goal line ("min 30 min", "2 pages"). Long enough for a
 * sentence, short enough to sit under a habit name on a phone without becoming
 * a second description field nobody reads.
 */
export const DESCRIPTION_MAX_LENGTH = 200;

/**
 * Normalise a `description` from a request body.
 *
 * An omitted field means "leave it alone" (undefined); null, an empty string
 * and whitespace all mean "there is no goal line" and land as null, so an admin
 * clearing the box gets the same stored value as one who never filled it in.
 */
export type DescriptionCheck =
  | { ok: true; description: string | null | undefined }
  | { ok: false; error: string };

export function checkDescription(raw: unknown, provided: boolean): DescriptionCheck {
  if (!provided || raw === undefined) return { ok: true, description: undefined };
  if (raw === null) return { ok: true, description: null };
  if (typeof raw !== "string") return { ok: false, error: "invalid_description" };
  const trimmed = raw.trim();
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: "invalid_description" };
  }
  return { ok: true, description: trimmed.length === 0 ? null : trimmed };
}

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
