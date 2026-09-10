import type { NextFunction, Request, Response } from "express";
import { isRoomAdminByTelegramId } from "../db/repository.js";

/**
 * True when this Telegram user is an admin (owner or co-admin) of the room they
 * are currently in. There is no global admin any more: status is room-scoped and
 * is dropped the moment someone leaves for another room (MULTI ROOM PRD §3a).
 */
export function isAdminTelegramId(telegramId: number): boolean {
  return isRoomAdminByTelegramId(telegramId);
}

/** Must run after telegramAuth has populated req.telegramId. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminTelegramId(req.telegramId)) {
    res.status(403).json({ success: false, error: "not_admin" });
    return;
  }
  next();
}
