import type { Request, Response } from "express";
import { getParticipantCount } from "../../db/repository.js";
import { isAdminTelegramId } from "../adminAuth.js";
import { resolveCallerRoom } from "../roomScope.js";

export function isAdminRoute(req: Request, res: Response): void {
  res.json({ isAdmin: isAdminTelegramId(req.telegramId) });
}

/** Members of the caller's own room — never a count across rooms (PRD §3). */
export function adminStatsRoute(req: Request, res: Response): void {
  const caller = resolveCallerRoom(req);
  res.json({
    participantCount: caller ? getParticipantCount(caller.roomId) : 0,
  });
}
