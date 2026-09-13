import type { Request, Response } from "express";
import { getLeaderboard, getWeeklyLeaderboard, listRoomAdminUserIds } from "../../db/repository.js";
import { getCurrentWeekBounds } from "../../utils/challenge.js";
import { rankRows } from "../rank.js";
import { requireCallerRoom } from "../roomScope.js";

/**
 * GET /api/admin/leaderboard?period=weekly|all-time — the caller's own room,
 * with none of the restrictions the member-facing board carries: every row has
 * its real points, in both periods.
 *
 *   all-time  (the default) perpetual, every log since the room began
 *   weekly    the current Monday-Sunday week, the same window members see
 *
 * The default is all-time rather than weekly so a Mini App build that predates
 * the switch keeps getting exactly what it got before.
 *
 * Adds realName/telegramId per row for moderation, plus `isRoomAdmin` — the
 * Leaderboard screen is also where co-admins are promoted, demoted and kicked
 * from (PRD §3, §3a), so it needs to know who already holds admin status here.
 *
 * The CSV export deliberately stays all-time-only: it exists for prizes and
 * moderation, which are about the whole run, not one week.
 */
export function adminLeaderboardRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  // `req.query` is always present under Express; the optional chain is for the
  // handler being called directly, which is how the route tests drive it.
  const requested = req.query?.period;
  if (requested !== undefined && requested !== "weekly" && requested !== "all-time") {
    res.status(400).json({ success: false, error: "invalid_period" });
    return;
  }
  const period = requested === "weekly" ? "weekly" : "all-time";

  const week = getCurrentWeekBounds();
  const rows =
    period === "weekly"
      ? getWeeklyLeaderboard(caller.roomId, week.weekStart, week.weekEnd)
      : getLeaderboard(caller.roomId);

  const adminUserIds = new Set(listRoomAdminUserIds(caller.roomId));
  const leaderboard = rankRows(rows, (row) => row.total).map(({ row, rank }) => ({
    rank,
    nickname: row.nickname,
    realName: row.real_name ?? null,
    telegramId: row.telegram_id,
    totalPoints: row.total,
    isRoomAdmin: adminUserIds.has(row.user_id),
    isYou: row.telegram_id === req.telegramId,
  }));

  res.json({
    leaderboard,
    period,
    // Echoed in both periods so the screen can label the weekly view without a
    // second request, and so an admin flipping the toggle never has to guess
    // which week they are looking at.
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
  });
}
