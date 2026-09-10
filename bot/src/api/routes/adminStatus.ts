import type { Request, Response } from "express";
import { getParticipantCount } from "../../db/repository.js";
import { isAdminTelegramId } from "../adminAuth.js";

export function isAdminRoute(req: Request, res: Response): void {
  res.json({ isAdmin: isAdminTelegramId(req.telegramId) });
}

export function adminStatsRoute(_req: Request, res: Response): void {
  res.json({
    participantCount: getParticipantCount(),
  });
}
