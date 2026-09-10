import type { Request, Response } from "express";
import {
  PROFILE_RATE_LIMIT_PER_MINUTE,
  config,
  formatReminderHhMm,
  isValidReminderTime,
  parseReminderTime,
} from "../../config.js";
import { allowRequest } from "../rateLimit.js";
import { getUserByTelegramId, isNicknameTaken, updateUserProfile } from "../../db/repository.js";
import { nicknameMatchesRealName, parseRealName } from "../realName.js";
import { resolveCallerRoom, roomResponse } from "../roomScope.js";
import type { Room, User } from "../../types.js";

function effectiveReminderTime(user: User): string {
  if (user.reminder_time && isValidReminderTime(user.reminder_time)) {
    return formatReminderHhMm(parseReminderTime(user.reminder_time));
  }
  return formatReminderHhMm(config.reminderTime);
}

function profileResponse(user: User, room: Room | null) {
  // real_name is safe to echo here because GET/PATCH /api/profile are always
  // self-scoped (looked up by req.telegramId) — this never exposes another
  // user's name. Public/other-user surfaces (leaderboard, export) must keep
  // hiding or admin-gating it separately — see the doc comment on
  // User.real_name.
  return {
    nickname: user.nickname,
    realName: user.real_name ?? null,
    reminderEnabled: user.reminder_enabled === 1,
    reminderTime: effectiveReminderTime(user),
    timezone: user.timezone ?? null,
    // The room name Settings shows (PRD §3a); null while between rooms.
    room: room ? roomResponse(room) : null,
  };
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function getProfileRoute(req: Request, res: Response) {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }
  res.json(profileResponse(user, resolveCallerRoom(req)?.room ?? null));
}

export function patchProfileRoute(req: Request, res: Response) {
  const body = req.body ?? {};
  const hasNickname = Object.prototype.hasOwnProperty.call(body, "nickname");
  const hasReminderEnabled = Object.prototype.hasOwnProperty.call(body, "reminderEnabled");
  const hasReminderTime = Object.prototype.hasOwnProperty.call(body, "reminderTime");
  const hasRealName = Object.prototype.hasOwnProperty.call(body, "realName");
  const hasTimezone = Object.prototype.hasOwnProperty.call(body, "timezone");

  if (!hasNickname && !hasReminderEnabled && !hasReminderTime && !hasRealName && !hasTimezone) {
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

  // Nickname uniqueness is per-room, not global — the same nickname may exist
  // in two rooms at once (PRD §3a). A user between rooms is checked globally:
  // there is no room to collide within yet.
  const room = resolveCallerRoom(req)?.room ?? null;

  let nickname: string | undefined;
  if (hasNickname) {
    if (typeof body.nickname !== "string" || body.nickname.trim().length === 0 || body.nickname.trim().length > 50) {
      res.status(400).json({ success: false, error: "invalid_nickname" });
      return;
    }
    const trimmedNickname = body.nickname.trim();
    nickname = trimmedNickname;
    if (
      isNicknameTaken(trimmedNickname, {
        excludeTelegramId: req.telegramId,
        roomId: room?.id,
      })
    ) {
      res.status(409).json({ success: false, error: "nickname_taken" });
      return;
    }
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

  let timezone: string | null | undefined;
  if (hasTimezone) {
    if (body.timezone === null) {
      timezone = null;
    } else if (typeof body.timezone === "string" && isValidTimezone(body.timezone)) {
      timezone = body.timezone;
    } else {
      res.status(400).json({ success: false, error: "invalid_timezone" });
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
    reminderEnabled,
    reminderTime: reminderTime ?? undefined,
    realName,
    timezone,
  });

  res.json(profileResponse(updated, room));
}
