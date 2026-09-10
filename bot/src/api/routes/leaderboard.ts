import type { Request, Response } from "express";
import { getLeaderboard } from "../../db/repository.js";
import { resolveCallerRoom } from "../roomScope.js";

/**
 * GET /api/leaderboard — the caller's room only: its current members, ranked by
 * the points they earned in it (PRD §3). A user between rooms has no
 * leaderboard to be on, so they get an empty one.
 */
export function leaderboardRoute(req: Request, res: Response): void {
  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json({ leaderboard: [] });
    return;
  }

  const rows = getLeaderboard(caller.roomId);
  // Competition ranking: equal totals share a rank (1, 1, 3 — not 1, 2, 3).
  let rank = 1;
  const leaderboard = rows.map((row, i) => {
    if (i > 0 && row.total < rows[i - 1]!.total) {
      rank = i + 1;
    }
    return {
      nickname: row.nickname,
      totalPoints: row.total,
      rank,
      isYou: row.telegram_id === req.telegramId,
    };
  });
  res.json({ leaderboard });
}
