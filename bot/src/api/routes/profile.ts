import type { Request, Response } from "express";
import {
  PROFILE_RATE_LIMIT_PER_MINUTE,
  MAX_GOAL,
  config,
  formatReminderHhMm,
  isValidReminderTime,
  parseReminderTime,
} from "../../config.js";
import { allowRequest } from "../rateLimit.js";
import { getUserByTelegramId, isNicknameTaken, updateUserProfile } from "../../db/repository.js";
import { nicknameMatchesRealName, parseRealName } from "../realName.js";
import type { User } from "../../types.js";

const DEFAULT_FASTING_REMINDER_TIME = "20:00";

function effectiveReminderTime(user: User): string {
  if (user.reminder_time && isValidReminderTime(user.reminder_time)) {
    return formatReminderHhMm(parseReminderTime(user.reminder_time));
  }
  return formatReminderHhMm(config.reminderTime);
}

function effectiveFastingReminderTime(user: User): string {
  if (user.fasting_reminder_time && isValidReminderTime(user.fasting_reminder_time)) {
    return formatReminderHhMm(parseReminderTime(user.fasting_reminder_time));
  }
  return DEFAULT_FASTING_REMINDER_TIME;
}

function profileResponse(user: User) {
  return {
    nickname: user.nickname,
    dailyGoal: user.goal,
    reminderEnabled: user.reminder_enabled === 1,
    reminderTime: effectiveReminderTime(user),
    fastingReminderEnabled: user.fasting_reminder_enabled === 1,
    fastingReminderTime: effectiveFastingReminderTime(user),
  };
}

export function getProfileRoute(req: Request, res: Response) {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }
  res.json(profileResponse(user));
}

export function patchProfileRoute(req: Request, res: Response) {
  const body = req.body ?? {};
  const hasNickname = Object.prototype.hasOwnProperty.call(body, "nickname");
  const hasDailyGoal = Object.prototype.hasOwnProperty.call(body, "dailyGoal");
  const hasReminderEnabled = Object.prototype.hasOwnProperty.call(body, "reminderEnabled");
  const hasReminderTime = Object.prototype.hasOwnProperty.call(body, "reminderTime");
  const hasRealName = Object.prototype.hasOwnProperty.call(body, "realName");
  const hasFastingReminderEnabled = Object.prototype.hasOwnProperty.call(body, "fastingReminderEnabled");
  const hasFastingReminderTime = Object.prototype.hasOwnProperty.call(body, "fastingReminderTime");

  if (
    !hasNickname &&
    !hasDailyGoal &&
    !hasReminderEnabled &&
    !hasReminderTime &&
    !hasRealName &&
    !hasFastingReminderEnabled &&
    !hasFastingReminderTime
  ) {
    res.status(400).json({ success: false, error: "invalid_body" });
    return;
  }

  if (!allowRequest(req.telegramId, PROFILE_RATE_LIMIT_PER_MINUTE)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }

  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  let nickname: string | undefined;
  if (hasNickname) {
    if (typeof body.nickname !== "string" || body.nickname.trim().length === 0 || body.nickname.trim().length > 50) {
      res.status(400).json({ success: false, error: "invalid_nickname" });
      return;
    }
    const trimmedNickname = body.nickname.trim();
    nickname = trimmedNickname;
    if (isNicknameTaken(trimmedNickname, req.telegramId)) {
      res.status(409).json({ success: false, error: "nickname_taken" });
      return;
    }
  }

  let dailyGoal: number | undefined;
  if (hasDailyGoal) {
    if (typeof body.dailyGoal !== "number" || !Number.isInteger(body.dailyGoal) || body.dailyGoal <= 0 || body.dailyGoal > MAX_GOAL) {
      res.status(400).json({ success: false, error: "invalid_goal" });
      return;
    }
    dailyGoal = body.dailyGoal;
  }

  let reminderEnabled: boolean | undefined;
  if (hasReminderEnabled) {
    if (typeof body.reminderEnabled !== "boolean") {
      res.status(400).json({ success: false, error: "invalid_reminder_enabled" });
      return;
    }
    reminderEnabled = body.reminderEnabled;
  }

  let reminderTime: string | null | undefined;
  if (hasReminderTime) {
    if (body.reminderTime === null) {
      reminderTime = null;
    } else if (typeof body.reminderTime === "string" && isValidReminderTime(body.reminderTime)) {
      reminderTime = formatReminderHhMm(parseReminderTime(body.reminderTime));
    } else {
      res.status(400).json({ success: false, error: "invalid_reminder_time" });
      return;
    }
  }

  let realName: string | undefined;
  if (hasRealName) {
    const parsedRealName = parseRealName(body.realName);
    if (!parsedRealName) {
      res.status(400).json({ success: false, error: "invalid_real_name" });
      return;
    }
    realName = parsedRealName;
  }

  let fastingReminderEnabled: boolean | undefined;
  if (hasFastingReminderEnabled) {
    if (typeof body.fastingReminderEnabled !== "boolean") {
      res.status(400).json({ success: false, error: "invalid_fasting_reminder_enabled" });
      return;
    }
    fastingReminderEnabled = body.fastingReminderEnabled;
  }

  let fastingReminderTime: string | undefined;
  if (hasFastingReminderTime) {
    if (typeof body.fastingReminderTime === "string" && isValidReminderTime(body.fastingReminderTime)) {
      fastingReminderTime = formatReminderHhMm(parseReminderTime(body.fastingReminderTime));
    } else {
      res.status(400).json({ success: false, error: "invalid_fasting_reminder_time" });
      return;
    }
  }

  const effectiveNickname = nickname ?? user.nickname;
  const effectiveRealName = realName ?? user.real_name;
  if (effectiveRealName && nicknameMatchesRealName(effectiveNickname, effectiveRealName)) {
    res.status(400).json({ success: false, error: "nickname_matches_real_name" });
    return;
  }

  const updated = updateUserProfile(req.telegramId, {
    nickname,
    goal: dailyGoal,
    reminderEnabled,
    reminderTime,
    realName,
    fastingReminderEnabled,
    fastingReminderTime,
  });

  res.json(profileResponse(updated));
}
