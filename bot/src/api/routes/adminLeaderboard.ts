import type { Request, Response } from "express";
import { getJamaatTotal, getLeaderboard } from "../../db/repository.js";
import {
  logWindowForPeriod,
  parseLeaderboardPeriod,
  periodMetadata,
} from "../adminPeriod.js";

export function adminLeaderboardRoute(req: Request, res: Response): void {
  const period = parseLeaderboardPeriod(req.query.period);
  if (!period) {
    res.status(400).json({ success: false, error: "invalid_period" });
    return;
  }

  const window = logWindowForPeriod(period);
  const rows = getLeaderboard(window);
  let rank = 1;
  const leaderboard = rows.map((row, index) => {
    if (index > 0 && row.total < rows[index - 1]!.total) {
      rank = index + 1;
    }
    return { rank, nickname: row.nickname, realName: row.real_name ?? null, total: row.total };
  });

  res.json({
    ...periodMetadata(period),
    jamaatTotal: getJamaatTotal(window),
    leaderboard,
  });
}
