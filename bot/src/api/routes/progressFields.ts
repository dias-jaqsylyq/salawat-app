import { config } from "../../config.js";
import {
  getDayOverrides,
  getUserLogsSince,
  getUserTodayTotal,
  getUserTotal,
} from "../../db/repository.js";
import type { User } from "../../types.js";
import {
  dayKeyFromSqliteUtc,
  formatDateParts,
  getDaysLeft,
  getTodayInTimezone,
  getTodayUtcRange,
  getUtcRangeForDate,
  parseDateKey,
  subtractOneCalendarDay,
} from "../../utils/challenge.js";
import { bucketLogsByDay, buildLast7Days, computeStreak } from "../../utils/streak.js";

/** Shared streak + last7Days (+ totals) for progress and day-override responses. */
export function computeUserProgressFields(user: User) {
  const total = getUserTotal(user.id);
  const { startUtc, endUtc } = getTodayUtcRange();
  const todayTotal = getUserTodayTotal(user.id, startUtc, endUtc);

  const todayParts = getTodayInTimezone(config.timezone);
  let windowStart = todayParts;
  for (let i = 0; i < 6; i++) {
    windowStart = subtractOneCalendarDay(windowStart);
  }
  const windowStartKey = formatDateParts(windowStart);
  const todayKey = formatDateParts(todayParts);

  // Personal progress starts at registration, or at the latest reset epoch.
  const progressStart = user.progress_started_at ?? user.created_at;
  const progressStartKey = dayKeyFromSqliteUtc(progressStart, config.timezone);
  const progressStartParts = parseDateKey(progressStartKey);
  const earliestEligibleKey = progressStartKey;

  // Fetch enough history for the complete streak as well as the visible week.
  const logsFromKey =
    windowStartKey < progressStartKey ? windowStartKey : progressStartKey;
  const logsFromParts = parseDateKey(logsFromKey);
  const logsStartUtc = getUtcRangeForDate(logsFromParts).startUtc;

  const logs = getUserLogsSince(user.id, logsStartUtc);
  const totalsByDate = bucketLogsByDay(logs, (loggedAt) =>
    dayKeyFromSqliteUtc(loggedAt, config.timezone)
  );

  const overrides = getDayOverrides(user.id, progressStartKey, todayKey);
  const dailyGoal = user.goal;
  const streak = computeStreak(
    dailyGoal,
    totalsByDate,
    todayParts,
    progressStartParts,
    overrides
  );
  const last7Days = buildLast7Days(
    dailyGoal,
    totalsByDate,
    todayParts,
    progressStartParts,
    overrides
  );

  return {
    total,
    todayTotal,
    dailyGoal,
    streak,
    last7Days,
    daysLeft: getDaysLeft(),
    todayParts,
    windowStartKey,
    todayKey,
    earliestEligibleKey,
  };
}
