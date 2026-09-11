import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
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

/**
 * Constant-time string comparison for the ADMIN_EXPORT_SECRET.
 *
 * Both sides are hashed first so timingSafeEqual always gets two equal-length
 * buffers: it throws on a length mismatch, and guarding that with a plain
 * `length !==` check would leak the secret's length through the fast path.
 * SHA-256 of an unequal string differs in the first bytes with overwhelming
 * probability, so this compares the secrets themselves, not their digests'
 * usefulness.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Shared auth for the two owner-only endpoints gated by ADMIN_EXPORT_SECRET
 * (GET /api/admin/export, POST /api/admin/reset) rather than by initData.
 *
 * Answers the response itself and returns false when the caller may not
 * proceed. These are the only endpoints with no Telegram identity behind them,
 * so they carry no per-user rate limit — the per-IP limiter in server.ts is
 * what keeps the secret from being brute-forced.
 */
export function requireAdminSecret(req: Request, res: Response): boolean {
  const secret = config.adminExportSecret;
  if (!secret) {
    res.status(503).json({ success: false, error: "export_disabled" });
    return false;
  }

  const provided =
    (typeof req.query.key === "string" ? req.query.key : undefined) ??
    req.header("X-Admin-Key") ??
    "";
  if (!secretsMatch(provided, secret)) {
    res.status(401).json({ success: false, error: "unauthorized" });
    return false;
  }

  return true;
}
