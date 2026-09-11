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
import { STREAK_DISPLAYS, type Room, type StreakDisplay, type User } from "../../types.js";

/** Fallback when a stored fasting time is missing or corrupt — the schema default. */
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

function isStreakDisplay(value: unknown): value is StreakDisplay {
  return typeof value === "string" && STREAK_DISPLAYS.includes(value as StreakDisplay);
}

function isWeekStartDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
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
    // Opt-in and identical for every room and every member, admins included:
    // the fasting nudge is a bot-wide function, not a room setting.
    fastingReminderEnabled: user.fasting_reminder_enabled === 1,
    fastingReminderTime: effectiveFastingReminderTime(user),
    timezone: user.timezone ?? null,
    // Display-only preferences for the Progress screen's streak section.
    streakDisplay: user.streak_display,
    weekStartDay: user.week_start_day,
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
  const hasFastingReminderEnabled = Object.prototype.hasOwnProperty.call(
    body,
    "fastingReminderEnabled"
  );
  const hasFastingReminderTime = Object.prototype.hasOwnProperty.call(body, "fastingReminderTime");
  const hasRealName = Object.prototype.hasOwnProperty.call(body, "realName");
  const hasTimezone = Object.prototype.hasOwnProperty.call(body, "timezone");
  const hasStreakDisplay = Object.prototype.hasOwnProperty.call(body, "streakDisplay");
  const hasWeekStartDay = Object.prototype.hasOwnProperty.call(body, "weekStartDay");

  if (
    !hasNickname &&
    !hasReminderEnabled &&
    !hasReminderTime &&
    !hasFastingReminderEnabled &&
    !hasFastingReminderTime &&
    !hasRealName &&
    !hasTimezone &&
    !hasStreakDisplay &&
    !hasWeekStartDay
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

  let fastingReminderEnabled: boolean | undefined;
  if (hasFastingReminderEnabled) {
    if (typeof body.fastingReminderEnabled !== "boolean") {
      res.status(400).json({ success: false, error: "invalid_fasting_reminder_enabled" });
      return;
    }
    fastingReminderEnabled = body.fastingReminderEnabled;
  }

  // No null here, unlike reminderTime: there is no global default fasting time
  // to fall back to, so the column always holds a concrete HH:mm.
  let fastingReminderTime: string | undefined;
  if (hasFastingReminderTime) {
    if (
      typeof body.fastingReminderTime === "string" &&
      isValidReminderTime(body.fastingReminderTime)
    ) {
      fastingReminderTime = formatReminderHhMm(parseReminderTime(body.fastingReminderTime));
    } else {
      res.status(400).json({ success: false, error: "invalid_fasting_reminder_time" });
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

  // Validated here rather than left to the column's CHECK: a database migrated
  // from an earlier deploy got these columns through ALTER TABLE ADD COLUMN,
  // which cannot carry a CHECK (see db/client.ts) — this is the only guard there.
  let streakDisplay: StreakDisplay | undefined;
  if (hasStreakDisplay) {
    if (!isStreakDisplay(body.streakDisplay)) {
      res.status(400).json({ success: false, error: "invalid_streak_display" });
      return;
    }
    streakDisplay = body.streakDisplay;
  }

  let weekStartDay: number | undefined;
  if (hasWeekStartDay) {
    if (!isWeekStartDay(body.weekStartDay)) {
      res.status(400).json({ success: false, error: "invalid_week_start_day" });
      return;
    }
    weekStartDay = body.weekStartDay;
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
    fastingReminderEnabled,
    fastingReminderTime,
    realName,
    timezone,
    streakDisplay,
    weekStartDay,
  });

  res.json(profileResponse(updated, room));
}
