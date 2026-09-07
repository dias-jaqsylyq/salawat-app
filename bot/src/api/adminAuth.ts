import type { NextFunction, Request, Response } from "express";
import { isAdmin } from "../db/repository.js";

/** True when telegramId is in the admins table (seeded from ADMIN_TELEGRAM_ID). */
export function isAdminTelegramId(telegramId: number): boolean {
  return isAdmin(telegramId);
}

/** Must run after telegramAuth has populated req.telegramId. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminTelegramId(req.telegramId)) {
    res.status(403).json({ success: false, error: "not_admin" });
    return;
  }
  next();
}
