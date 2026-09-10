import type { Request, Response } from "express";
import { getLeaderboard } from "../../db/repository.js";

/**
 * All-time, perpetual leaderboard for the admin view. No period filter —
 * the tracker has no periodic resets (PIVOT_PLAN §0), so the old
 * all-time-vs-Mawlid-window `?period=` distinction no longer applies.
 * Adds realName/telegramId per row for moderation, beyond the public leaderboard.
 */
export function adminLeaderboardRoute(_req: Request, res: Response): void {
  const rows = getLeaderboard();
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
    };
  });

  res.json({ leaderboard });
}
