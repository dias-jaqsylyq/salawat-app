import { Brain, Dumbbell, Heart, Sparkles, type LucideIcon } from "lucide-react";
import type { Habit, HabitCategory } from "../api/types.ts";

/**
 * Display order for the four fixed categories (MULTI ROOM PRD §3): SQ → IQ →
 * EQ → PQ. Not alphabetical and not the order the backend lists them in — the
 * spiritual habits come first deliberately.
 */
export const CATEGORY_ORDER: readonly HabitCategory[] = ["SQ", "IQ", "EQ", "PQ"] as const;

interface CategoryMeta {
  /** Full name shown next to the code. */
  label: string;
  icon: LucideIcon;
}

/** The icons are a fixed global set — identical in every room (PRD §3a). */
export const CATEGORY_META: Record<HabitCategory, CategoryMeta> = {
  SQ: { label: "Spiritual", icon: Sparkles },
  IQ: { label: "Intellectual", icon: Brain },
  EQ: { label: "Emotional", icon: Heart },
  PQ: { label: "Physical", icon: Dumbbell },
};

export interface HabitGroup<T extends Habit> {
  /** Null for the trailing uncategorized group. */
  category: HabitCategory | null;
  habits: T[];
}

/**
 * Habits split into the four categories in display order, empty groups dropped.
 *
 * Habits with no category still appear, in a trailing group of their own: a
 * room that turns categories back on keeps its old habits at `category: null`
 * until an admin re-confirms each one (PRD §0), and those habits must stay
 * loggable in the meantime.
 */
export function groupHabitsByCategory<T extends Habit>(habits: T[]): HabitGroup<T>[] {
  const groups: HabitGroup<T>[] = [];

  for (const category of CATEGORY_ORDER) {
    const matching = habits.filter((habit) => habit.category === category);
    if (matching.length > 0) groups.push({ category, habits: matching });
  }

  const uncategorized = habits.filter(
    (habit) => habit.category === null || !CATEGORY_ORDER.includes(habit.category)
  );
  if (uncategorized.length > 0) groups.push({ category: null, habits: uncategorized });

  return groups;
}
