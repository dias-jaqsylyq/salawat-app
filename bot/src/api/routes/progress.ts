import type { Request, Response } from "express";
import { config } from "../../config.js";
import {
  getHabitStreak,
  getUserByTelegramId,
  getUserHabitLogsForDate,
  getUserTotalPoints,
  listHabits,
} from "../../db/repository.js";
import { formatDateParts, getTodayInTimezone } from "../../utils/challenge.js";
import { userNeedsRealName } from "../realName.js";
import { resolveCallerRoom, roomResponse } from "../roomScope.js";

/**
 * GET /api/progress — today's state and all-time total, scoped to the caller's
 * room (PRD §3): habits, points and streaks all come from that one room, so a
 * member who moved here from another room keeps their old logs without carrying
 * their old points in (PRD §1).
 *
 * `room` carries the name the Mini App shows in its header and the room's
 * category mode (PRD §3a); it is null for a registered user who is between
 * rooms, and everything else then reads as an empty day.
 */
export function progressRoute(req: Request, res: Response): void {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.json({ registered: false });
    return;
  }

  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json({
      registered: true,
      nickname: user.nickname,
      room: null,
      totalPoints: 0,
      today: [],
      streaks: [],
      needsRealName: userNeedsRealName(user.real_name),
    });
    return;
  }

  const todayKey = formatDateParts(getTodayInTimezone(config.timezone));
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

  res.json({
    registered: true,
    nickname: user.nickname,
    room: roomResponse(caller.room),
    totalPoints: getUserTotalPoints(user.id, caller.roomId),
    today,
    streaks,
    needsRealName: userNeedsRealName(user.real_name),
  });
}
