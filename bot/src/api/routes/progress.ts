import type { Request, Response } from "express";
import {
  getHabitStreak,
  getPersonalHabitStreak,
  getUserByTelegramId,
  getUserHabitLogsForDate,
  getUserPersonalHabitLogsForDate,
  getUserPointsForDate,
  getUserTotalPoints,
  listHabits,
  listPersonalHabits,
} from "../../db/repository.js";
import { getUserTodayKey } from "../../utils/challenge.js";
import { userNeedsRealName } from "../realName.js";
import { resolveCallerRoom, roomResponse } from "../roomScope.js";

/**
 * GET /api/progress — today's state and all-time total, scoped to the caller's
 * room (PRD §3): habits, points and streaks all come from that one room, so a
 * member who moved here from another room keeps their old logs without carrying
 * their old points in (PRD §1).
 *
 * "Today" is the caller's *own* calendar day (users.timezone, falling back to
 * TIMEZONE) — the same day key their logs are written under, so todayPoints and
 * the Log screen can never disagree, and both move the moment the user's
 * timezone changes.
 *
 * `room` carries the name the Mini App shows in its header and the room's
 * category mode (PRD §3a); it is null for a registered user who is between
 * rooms, and everything else then reads as an empty day.
 *
 * `streakDisplay`/`weekStartDay` are display preferences the Progress screen
 * reads to decide which streak shape to draw. They are echoed here rather than
 * fetched separately so the screen never renders one shape and then flips.
 *
 * `personalToday`/`personalStreaks` cover the caller's own private habits. They
 * are separate arrays because they key off a different id space, and they carry
 * no points field at all — a personal habit is tracking, never scoring, so it
 * contributes to neither todayPoints nor totalPoints.
 */
export function progressRoute(req: Request, res: Response): void {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.json({ registered: false });
    return;
  }

  const todayKey = getUserTodayKey(user);
  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json({
      registered: true,
      nickname: user.nickname,
      room: null,
      totalPoints: 0,
      todayPoints: 0,
      today: [],
      todayDate: todayKey,
      streaks: [],
      personalToday: [],
      personalStreaks: [],
      streakDisplay: user.streak_display,
      weekStartDay: user.week_start_day,
      needsRealName: userNeedsRealName(user.real_name),
    });
    return;
  }

  const activeHabits = listHabits({ activeOnly: true, roomId: caller.roomId });
  const todayLogs = getUserHabitLogsForDate(user.id, todayKey);

  const today = activeHabits.map((habit) => {
    const log = todayLogs.get(habit.id);
    return {
      habitId: habit.id,
      logged: log !== undefined,
      value: log?.value ?? 0,
      points: log?.points_earned ?? 0,
    };
  });

  // Streaks need no room filter of their own: a habit belongs to exactly one
  // room, so walking one habit's logs never crosses a room boundary.
  const streaks = activeHabits.map((habit) => ({
    habitId: habit.id,
    streak: getHabitStreak(user.id, habit.id, todayKey),
  }));

  const personalHabits = listPersonalHabits(user.id, caller.roomId);
  const personalLogs = getUserPersonalHabitLogsForDate(user.id, todayKey);
  const personalToday = personalHabits.map((habit) => {
    const log = personalLogs.get(habit.id);
    return {
      personalHabitId: habit.id,
      logged: log !== undefined,
      value: log?.value ?? 0,
    };
  });
  const personalStreaks = personalHabits.map((habit) => ({
    personalHabitId: habit.id,
    streak: getPersonalHabitStreak(user.id, habit.id, todayKey),
  }));

  res.json({
    registered: true,
    nickname: user.nickname,
    room: roomResponse(caller.room),
    totalPoints: getUserTotalPoints(user.id, caller.roomId),
    // Summed from the stored points_earned of today's rows, not recomputed from
    // habit weights — a weight change is never retroactive (PIVOT_PLAN §2).
    // Deactivated habits still count: the points were earned while they were
    // active, and today's total is a record of the day, not of the habit list.
    todayPoints: getUserPointsForDate(user.id, caller.roomId, todayKey),
    today,
    todayDate: todayKey,
    streaks,
    personalToday,
    personalStreaks,
    streakDisplay: user.streak_display,
    weekStartDay: user.week_start_day,
    needsRealName: userNeedsRealName(user.real_name),
  });
}
