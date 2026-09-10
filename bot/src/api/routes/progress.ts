import type { Request, Response } from "express";
import { config } from "../../config.js";
import {
  getHabitStreak,
  getJamaatTotal,
  getUserByTelegramId,
  getUserHabitLogsForDate,
  getUserTotalPoints,
  listHabits,
} from "../../db/repository.js";
import { formatDateParts, getTodayInTimezone } from "../../utils/challenge.js";
import { userNeedsRealName } from "../realName.js";

export function progressRoute(req: Request, res: Response): void {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.json({ registered: false });
    return;
  }

  const todayKey = formatDateParts(getTodayInTimezone(config.timezone));
  const activeHabits = listHabits({ activeOnly: true });
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

  const streaks = activeHabits.map((habit) => ({
    habitId: habit.id,
    streak: getHabitStreak(user.id, habit.id, todayKey),
  }));

  res.json({
    registered: true,
    nickname: user.nickname,
    totalPoints: getUserTotalPoints(user.id),
    jamaatTotal: getJamaatTotal(),
    today,
    streaks,
    needsRealName: userNeedsRealName(user.real_name),
  });
}
