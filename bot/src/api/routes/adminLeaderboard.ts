import type { Request, Response } from "express";
import { getLeaderboard, listRoomAdminUserIds } from "../../db/repository.js";
import { requireCallerRoom } from "../roomScope.js";

/**
 * All-time, perpetual leaderboard of the caller's own room. No period filter —
 * the tracker has no periodic resets (PIVOT_PLAN §0), so the old
 * all-time-vs-Mawlid-window `?period=` distinction no longer applies.
 *
 * Adds realName/telegramId per row for moderation, beyond the public
 * leaderboard, plus `isRoomAdmin` — the Leaderboard screen is also where
 * co-admins are promoted, demoted and kicked from (PRD §3, §3a), so it needs to
 * know who already holds admin status here.
 */
export function adminLeaderboardRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  const rows = getLeaderboard(caller.roomId);
  const adminUserIds = new Set(listRoomAdminUserIds(caller.roomId));
  let rank = 1;
  const leaderboard = rows.map((row, index) => {
    if (index > 0 && row.total < rows[index - 1]!.total) {
      rank = index + 1;
    }
    return {
      rank,
      nickname: row.nickname,
      realName: row.real_name ?? null,
      telegramId: row.telegram_id,
      totalPoints: row.total,
      isRoomAdmin: adminUserIds.has(row.user_id),
      isYou: row.telegram_id === req.telegramId,
    };
  });

  res.json({ leaderboard });
}
