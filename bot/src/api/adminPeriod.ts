import { config } from "../config.js";
import type { LogWindow } from "../db/repository.js";
import {
  formatDateParts,
  getChallengeWindowUtc,
  getTodayInTimezone,
} from "../utils/challenge.js";

export type LeaderboardPeriod = "all" | "mawlid";

export function parseLeaderboardPeriod(value: unknown): LeaderboardPeriod | null {
  if (value === undefined || value === "all") return "all";
  if (value === "mawlid") return "mawlid";
  return null;
}

export function logWindowForPeriod(period: LeaderboardPeriod): LogWindow | undefined {
  return period === "mawlid" ? getChallengeWindowUtc() : undefined;
}

export function periodMetadata(period: LeaderboardPeriod): {
  period: LeaderboardPeriod;
  periodStart?: string;
  periodEnd?: string;
} {
  if (period === "all") return { period };
  return {
    period,
    periodStart: formatDateParts(config.challengeStartDate),
    periodEnd: formatDateParts(config.challengeEndDate),
  };
}

export function exportFilename(period: LeaderboardPeriod): string {
  if (period === "mawlid") {
    return `salawat-leaderboard-mawlid-${formatDateParts(
      config.challengeStartDate
    )}-to-${formatDateParts(config.challengeEndDate)}.csv`;
  }
  const today = formatDateParts(getTodayInTimezone(config.timezone));
  return `salawat-leaderboard-all-time-${today}.csv`;
}
