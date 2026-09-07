import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { updateTelegramProfileIfRegistered } from "../db/repository.js";
import type { TelegramProfile } from "../types.js";
import { InitDataError, validateInitData } from "./initData.js";

declare global {
  namespace Express {
    interface Request {
      telegramId: number;
      telegramProfile: TelegramProfile;
    }
  }
}

const AUTH_HEADER_PREFIX = "tma ";

export function telegramAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("Authorization");
  if (!header || !header.startsWith(AUTH_HEADER_PREFIX)) {
    res.status(401).json({ success: false, error: "missing_init_data" });
    return;
  }

  const initDataRaw = header.slice(AUTH_HEADER_PREFIX.length);
  try {
    const validated = validateInitData(initDataRaw, config.botToken, config.initDataMaxAgeSeconds);
    req.telegramId = validated.telegramId;
    req.telegramProfile = {
      telegramUsername: validated.telegramUsername,
      telegramFirstName: validated.telegramFirstName,
      telegramLastName: validated.telegramLastName,
    };
    // Keep stored Telegram names fresh for registered users (also backfills pre-migration nulls).
    updateTelegramProfileIfRegistered(req.telegramId, req.telegramProfile);
    next();
  } catch (err) {
    if (err instanceof InitDataError) {
      res.status(401).json({ success: false, error: "invalid_init_data" });
      return;
    }
    throw err;
  }
}
