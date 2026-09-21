import type { Request, Response } from "express";
import {
  getHabitLogDatesInRange,
  getHabitPointsInRange,
  getPersonalHabitLogDatesInRange,
  listHabits,
  listPersonalHabits,
} from "../../db/repository.js";
import type { HabitCategory, HabitPeriod } from "../../types.js";
import {
  dayKeyFromSqliteUtc,
  getUserTimezone,
  getUserTodayKey,
  weekBoundsOfDateKey,
} from "../../utils/challenge.js";
import {
  addCalendarDays,
  formatDateParts,
  monthBounds,
  parseDateKey,
  parseMonthKey,
  startOfWeek,
  WEEK_START_DAY,
} from "../../utils/dates.js";
import { getOwnPersonalHabit, getRoomHabit, requireCallerRoom, resolveCallerRoom } from "../roomScope.js";

interface HistoryHabitRef {
  kind: "room" | "personal";
  habitId: number;
}

function parseHabitRef(req: Request): HistoryHabitRef | null {
  const kind = req.query?.kind;
  if (kind !== "room" && kind !== "personal") return null;
  const raw = req.query?.habitId;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const habitId = Number(raw);
  if (!Number.isSafeInteger(habitId) || habitId <= 0) return null;
  return { kind, habitId };
}

/**
 * GET /api/progress/history/habits — the History screen's habit switcher:
 * every room habit, active *and* inactive (a deactivated habit stays
 * visible here as historical data — HISTORY PRD; it just cannot be edited,
 * which is a backfill-route concern, not a read one), plus the caller's own
 * personal habits, separately flagged so the client can label them "My
 * Habits". Room-scoped, and empty for a caller between rooms — there is
 * nothing to have a history of.
 */
export function historyHabitsRoute(req: Request, res: Response): void {
  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json([]);
    return;
  }

  const roomHabits = listHabits({ roomId: caller.roomId }).map((habit) => ({
    id: habit.id,
    kind: "room" as const,
    name: habit.name,
    category: habit.category,
    period: habit.period,
    isActive: habit.is_active === 1,
  }));
  const personalHabits = listPersonalHabits(caller.user.id, caller.roomId).map((habit) => ({
    id: habit.id,
    kind: "personal" as const,
    name: habit.name,
    category: habit.category,
    period: "daily" as const,
    isActive: true,
  }));

  res.json([...roomHabits, ...personalHabits]);
}

/** Inclusive first/last day of the Monday-Sunday weeks a calendar month grid spans. */
function gridBounds(monthStart: string, monthEnd: string): { gridStart: string; gridEnd: string } {
  const start = startOfWeek(parseDateKey(monthStart), WEEK_START_DAY);
  const endWeekStart = startOfWeek(parseDateKey(monthEnd), WEEK_START_DAY);
  return {
    gridStart: formatDateParts(start),
    gridEnd: formatDateParts(addCalendarDays(endWeekStart, 6)),
  };
}

function datesFromTo(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = parseDateKey(from);
  const end = parseDateKey(to);
  while (formatDateParts(cursor) <= formatDateParts(end)) {
    dates.push(formatDateParts(cursor));
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

/**
 * GET /api/progress/history?kind=room|personal&habitId=&month=YYYY-MM — one
 * habit's read-only history for one calendar month (HISTORY PRD): a day grid
 * for a daily habit, a list of week badges for a weekly one. Always the
 * caller's *own* history — there is no target-user parameter, so an admin has
 * no path to another member's data through this route.
 *
 * The month's own boundary is resolved in the room's shared TIMEZONE
 * (config.timezone via monthBounds' caller), not the viewer's personal zone —
 * every member of a room must agree on where a given month starts, the same
 * reasoning getCurrentWeekBounds already applies to weeks. `locked`/`future`
 * and "today" stay in the caller's own timezone, exactly like
 * GET /api/progress/week, since those describe what the viewer personally
 * could have done.
 */
export function historyMonthRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const ref = parseHabitRef(req);
  if (ref === null) {
    res.status(400).json({ success: false, error: "invalid_habit_ref" });
    return;
  }

  const monthRaw = req.query?.month;
  const monthKey = typeof monthRaw === "string" ? parseMonthKey(monthRaw) : null;
  if (monthKey === null) {
    res.status(400).json({ success: false, error: "invalid_month" });
    return;
  }

  let name: string;
  let category: HabitCategory | null;
  let period: HabitPeriod;
  let isActive: boolean;
  let createdAt: string;

  if (ref.kind === "room") {
    const habit = getRoomHabit(ref.habitId, caller.roomId);
    if (!habit) {
      res.status(404).json({ success: false, error: "habit_not_found" });
      return;
    }
    name = habit.name;
    category = habit.category;
    period = habit.period;
    isActive = habit.is_active === 1;
    createdAt = habit.created_at;
  } else {
    const habit = getOwnPersonalHabit(ref.habitId, caller.user.id, caller.roomId);
    if (!habit) {
      res.status(404).json({ success: false, error: "personal_habit_not_found" });
      return;
    }
    name = habit.name;
    category = habit.category;
    period = "daily";
    isActive = true;
    createdAt = habit.created_at;
  }

  const timeZone = getUserTimezone(caller.user);
  const todayKey = getUserTodayKey(caller.user);
  const joinedDay =
    caller.user.room_joined_at === null ? null : dayKeyFromSqliteUtc(caller.user.room_joined_at, timeZone);
  const createdDay = dayKeyFromSqliteUtc(createdAt, timeZone);
  // The earliest day this habit could possibly have been tracked by this
  // caller — whichever is later of when they joined the room and when the
  // habit itself was created. Same combination dailyLogWindow narrows the
  // backfill window by, read here rather than written.
  const lowerBound = joinedDay !== null && joinedDay > createdDay ? joinedDay : createdDay;

  const { monthStart, monthEnd } = monthBounds(monthKey.year, monthKey.month);
  const habitResponse = {
    id: ref.habitId,
    kind: ref.kind,
    name,
    category,
    period,
    isActive,
  };
  const base = {
    habit: habitResponse,
    month: monthRaw as string,
    monthStart,
    monthEnd,
    today: todayKey,
    // The earliest calendar month the caller can navigate to (HISTORY PRD:
    // never before room_joined_at) — bound to the caller's own room
    // membership, not to this particular habit, so switching habits mid-
    // browse never moves the floor. Room-scoped by construction: a caller
    // this route ever reaches always has a current room, so room_joined_at
    // is always set (setUserCurrentRoom writes both together).
    earliestMonth: (joinedDay ?? createdDay).slice(0, 7),
  };

  const totalPoints =
    ref.kind === "room" ? getHabitPointsInRange(caller.user.id, ref.habitId, monthStart, monthEnd) : undefined;

  if (period === "weekly") {
    const { gridStart, gridEnd } = gridBounds(monthStart, monthEnd);
    const loggedDates =
      getHabitLogDatesInRange(caller.user.id, caller.roomId, gridStart, gridEnd).get(ref.habitId) ??
      new Set<string>();

    const weekStarts = new Set<string>();
    for (const date of datesFromTo(gridStart, gridEnd)) {
      weekStarts.add(weekBoundsOfDateKey(date).weekStart);
    }

    const weeks = [...weekStarts]
      .sort()
      // A week that began before the caller could have tracked this habit at
      // all is omitted entirely, not shown partial or disabled (HISTORY PRD).
      .filter((weekStart) => weekStart >= lowerBound)
      .map((weekStart) => {
        const { weekEnd } = weekBoundsOfDateKey(weekStart);
        const daysInWeek = datesFromTo(weekStart, weekEnd);
        const markedDates = daysInWeek.filter((date) => loggedDates.has(date));
        return {
          weekStart,
          weekEnd,
          count: markedDates.length,
          met: markedDates.length > 0,
        };
      });

    res.json({
      ...base,
      period: "weekly" as const,
      hasData: loggedDates.size > 0,
      ...(totalPoints !== undefined ? { totalPoints } : {}),
      weeks,
    });
    return;
  }

  const { gridStart, gridEnd } = gridBounds(monthStart, monthEnd);
  const loggedDates =
    ref.kind === "room"
      ? (getHabitLogDatesInRange(caller.user.id, caller.roomId, monthStart, monthEnd).get(ref.habitId) ??
        new Set<string>())
      : (getPersonalHabitLogDatesInRange(caller.user.id, caller.roomId, monthStart, monthEnd).get(
          ref.habitId
        ) ?? new Set<string>());

  let completedCount = 0;
  let applicableDays = 0;
  const days = datesFromTo(gridStart, gridEnd).map((date) => {
    const outOfMonth = date < monthStart || date > monthEnd;
    const logged = !outOfMonth && loggedDates.has(date);
    const locked = !outOfMonth && date < lowerBound;
    const future = !outOfMonth && date > todayKey;
    if (!outOfMonth && !locked && !future) {
      applicableDays += 1;
      if (logged) completedCount += 1;
    }
    return { date, logged, locked, future, outOfMonth };
  });

  res.json({
    ...base,
    period: "daily" as const,
    hasData: loggedDates.size > 0,
    ...(totalPoints !== undefined ? { totalPoints } : {}),
    days,
    completedCount,
    applicableDays,
  });
}
