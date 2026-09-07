import type { Request, Response } from "express";
import { config } from "../../config.js";
import { getParticipantCount } from "../../db/repository.js";
import { formatDateParts } from "../../utils/challenge.js";
import { isAdminTelegramId } from "../adminAuth.js";

export function isAdminRoute(req: Request, res: Response): void {
  res.json({ isAdmin: isAdminTelegramId(req.telegramId) });
}

export function adminStatsRoute(_req: Request, res: Response): void {
  res.json({
    participantCount: getParticipantCount(),
    mawlidStartDate: formatDateParts(config.challengeStartDate),
    mawlidEndDate: formatDateParts(config.challengeEndDate),
  });
}
