import type { Request, Response } from "express";
import {
  getParticipantCount,
  getRoomHabitTotals,
  getRoomHabitWeeklyCompletions,
  getRoomTotalPoints,
  listHabits,
} from "../../db/repository.js";
import {
  dayKeyFromSqliteUtc,
  getCurrentWeekBounds,
  shiftWeekStart,
  weekBoundsOfDateKey,
} from "../../utils/challenge.js";
import { resolveCallerRoom } from "../roomScope.js";

/** How many Monday-Sunday weeks each habit's bar chart covers, the current one last. */
export const STATS_WEEKS = 8;

/** The current week's position in `weekly` — always the last, it is unfinished. */
const CURRENT_WEEK_INDEX = STATS_WEEKS - 1;

/**
 * The closed week with the most completions, ties going to the most recent;
 * null when no closed week has any. The current week never qualifies: it is
 * still running, and a half-week "best" would be a moving target.
 */
export function bestClosedWeekIndex(weekly: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < CURRENT_WEEK_INDEX; i++) {
    const value = weekly[i];
    if (value === null || value === undefined || value <= 0) continue;
    if (best === null || value >= weekly[best]!) best = i;
  }
  return best;
}

/**
 * GET /api/stats — what the caller's whole room has done together, all time,
 * per habit. Readable by every member, and anonymous by construction: every
 * figure is an aggregate over the room, so there is no per-member number, no
 * name and no ranking anywhere in the payload.
 *
 * Counted by habit_logs.room_id, so members who left still count; personal
 * habits are never read. See the "Room stats" block in repository.ts for the
 * exact counting rules (one completion per day, or per week for a weekly
 * habit).
 *
 * `weekly` covers the last STATS_WEEKS Monday-Sunday weeks (config.timezone),
 * oldest first, the current unfinished week last (`currentWeekIndex`). A week
 * before the habit existed is null rather than 0, so a young habit draws only
 * the weeks it has had. `estimatedAmount` is the sum of the amounts frozen
 * into its logs — a lower bound — and null for a habit with no unit.
 *
 * A member between rooms gets an empty payload, like the leaderboard.
 */
export function statsRoute(req: Request, res: Response): void {
  const { weekStart: currentWeekStart } = getCurrentWeekBounds();
  const weeks = Array.from({ length: STATS_WEEKS }, (_, i) =>
    weekBoundsOfDateKey(shiftWeekStart(currentWeekStart, i - CURRENT_WEEK_INDEX))
  );
  const weekStarts = weeks.map((week) => week.weekStart);

  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json({ room: null, categoriesEnabled: false, weekStarts, habits: [] });
    return;
  }

  const categoriesEnabled = caller.room.categories_enabled === 1;
  const totals = getRoomHabitTotals(caller.roomId);
  const weeklyCounts = getRoomHabitWeeklyCompletions(caller.roomId, weeks);

  // Creation order, paused habits included; grouping by category is the
  // client's, with the same helper the Log screen uses.
  const habits = listHabits({ roomId: caller.roomId }).map((habit) => {
    const total = totals.get(habit.id);
    const counts = weeklyCounts.get(habit.id);

    // The habit's first week: the week it was created in, or the week of its
    // first log if that is earlier (a member behind config.timezone can log
    // the day before the creation day here).
    let firstWeekStart = weekBoundsOfDateKey(dayKeyFromSqliteUtc(habit.created_at)).weekStart;
    if (total !== undefined) {
      const firstLogWeek = weekBoundsOfDateKey(total.firstLogDate).weekStart;
      if (firstLogWeek < firstWeekStart) firstWeekStart = firstLogWeek;
    }
    const weekly = weeks.map((week, i) =>
      week.weekEnd < firstWeekStart ? null : (counts?.[i] ?? 0)
    );

    const unit = habit.unit_label ?? null;
    return {
      id: habit.id,
      name: habit.name,
      category: categoriesEnabled ? habit.category : null,
      active: habit.is_active === 1,
      completions: total?.completions ?? 0,
      estimatedAmount: unit === null ? null : (total?.amount ?? null),
      unit,
      weekly,
      currentWeekIndex: CURRENT_WEEK_INDEX,
      bestWeekIndex: bestClosedWeekIndex(weekly),
    };
  });

  res.json({
    room: {
      memberCount: getParticipantCount(caller.roomId),
      totalPoints: getRoomTotalPoints(caller.roomId),
      since: dayKeyFromSqliteUtc(caller.room.created_at),
    },
    categoriesEnabled,
    weekStarts,
    habits,
  });
}
