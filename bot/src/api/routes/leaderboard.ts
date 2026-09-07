import type { Request, Response } from "express";
import { getJamaatTotal, getLeaderboard } from "../../db/repository.js";

export function leaderboardRoute(req: Request, res: Response) {
  const rows = getLeaderboard();
  // Competition ranking: equal totals share a rank (1, 1, 3 — not 1, 2, 3).
  let rank = 1;
  const leaderboard = rows.map((row, i) => {
    if (i > 0 && row.total < rows[i - 1]!.total) {
      rank = i + 1;
    }
    return {
      nickname: row.nickname,
      total: row.total,
      rank,
      isYou: row.telegram_id === req.telegramId,
    };
  });
  res.json({
    jamaatTotal: getJamaatTotal(),
    leaderboard,
  });
}
