import type { Request, Response } from "express";
import { getWeeklyLeaderboard } from "../../db/repository.js";
import { getCurrentWeekBounds } from "../../utils/challenge.js";
import { rankRows } from "../rank.js";
import { resolveCallerRoom } from "../roomScope.js";

/**
 * GET /api/leaderboard — what an ordinary member of the room may see.
 *
 * Two deliberate restrictions, both of them privacy rather than plumbing:
 *
 *  - **This week only.** The perpetual all-time board is gone from this
 *    endpoint. A member sees the current Monday-Sunday week, which resets on its
 *    own by being a different window — there is nothing stored to clear.
 *  - **Everyone's name and place, nobody else's points.** The full roster in
 *    rank order is the whole point of a leaderboard; the exact figures behind it
 *    are not anyone else's business. The caller's own row carries `points`, and
 *    every other row simply has no such key — not a zero, not a null, so a
 *    client cannot accidentally render a number that was never sent.
 *
 * Equal weeks share a place and the next distinct score skips the places they
 * used up (both #2, then #4) — see rankRows.
 *
 * A member between rooms has no leaderboard to be on, so they get an empty one.
 */
export function leaderboardRoute(req: Request, res: Response): void {
  const { weekStart, weekEnd } = getCurrentWeekBounds();

  const caller = resolveCallerRoom(req);
  if (!caller) {
    res.json({ leaderboard: [], weekStart, weekEnd });
    return;
  }

  const rows = getWeeklyLeaderboard(caller.roomId, weekStart, weekEnd);
  const leaderboard = rankRows(rows, (row) => row.total).map(({ row, rank }) => {
    const isYou = row.telegram_id === req.telegramId;
    return {
      nickname: row.nickname,
      rank,
      isYou,
      // Spread rather than a `points: isYou ? … : null` so somebody else's row
      // genuinely has no points field on the wire.
      ...(isYou ? { points: row.total } : {}),
    };
  });

  res.json({ leaderboard, weekStart, weekEnd });
}
