import type { Request, Response } from "express";
import type { Bot } from "grammy";
import type { MyContext } from "../../context.js";
import {
  getParticipantCount,
  isRoomPasswordCollision,
  regenerateRoomPassword,
  setRoomCategoriesEnabled,
  updateRoomPassword,
} from "../../db/repository.js";
import { isValidRoomPassword, roomInviteLink } from "../../utils/roomPassword.js";
import { requireCallerRoom, roomResponse } from "../roomScope.js";
import type { Room } from "../../types.js";

/**
 * grammy only knows the bot's own username once it has started; before that
 * `bot.botInfo` throws. A missing username costs the share link, nothing more.
 */
function botUsername(bot: Bot<MyContext>): string | null {
  try {
    return bot.botInfo?.username ?? null;
  } catch {
    return null;
  }
}

/**
 * The admin's view of their own room: everything roomResponse carries, plus the
 * join password and the deep link that shares it (PRD §3, §3a). Admin-only —
 * the password is the room's invite code, and it is deliberately absent from
 * every participant-facing response.
 */
function adminRoomResponse(bot: Bot<MyContext>, room: Room) {
  const username = botUsername(bot);
  return {
    ...roomResponse(room),
    password: room.password,
    inviteLink: username ? roomInviteLink(username, room.password) : null,
    participantCount: getParticipantCount(room.id),
  };
}

export function createAdminRoomRoutes(bot: Bot<MyContext>) {
  /** GET /api/admin/room — the caller's own room, with its password. */
  function getAdminRoomRoute(req: Request, res: Response): void {
    const caller = requireCallerRoom(req, res);
    if (!caller) return;
    res.json(adminRoomResponse(bot, caller.room));
  }

  /**
   * PATCH /api/admin/room — body `{categoriesEnabled: boolean}`.
   *
   * Toggleable at any time, not only at room creation (PRD §0). Habit
   * categories already stored are deliberately left alone in both directions:
   * switching off preserves them, and switching back on does not silently
   * resurrect them — the admin re-confirms each habit through
   * PATCH /api/admin/habits/:id.
   */
  function patchAdminRoomRoute(req: Request, res: Response): void {
    const caller = requireCallerRoom(req, res);
    if (!caller) return;

    const body = req.body ?? {};
    if (typeof body.categoriesEnabled !== "boolean") {
      res.status(400).json({ success: false, error: "invalid_categories_enabled" });
      return;
    }

    const room = setRoomCategoriesEnabled(caller.roomId, body.categoriesEnabled);
    res.json(adminRoomResponse(bot, room));
  }

  /**
   * POST /api/admin/room/password — body `{password?}`.
   *
   * With a password: the admin's own choice (min 6 characters, case-sensitive,
   * Telegram deep-link charset — isValidRoomPassword). Without one: a generated
   * replacement. Either way this only blocks *future* joins; everyone already in
   * the room keeps their membership untouched, no re-verification (PRD §3a).
   */
  function regenerateRoomPasswordRoute(req: Request, res: Response): void {
    const caller = requireCallerRoom(req, res);
    if (!caller) return;

    const body = req.body ?? {};
    const wantsCustom =
      Object.prototype.hasOwnProperty.call(body, "password") &&
      body.password !== null &&
      body.password !== "";

    if (!wantsCustom) {
      res.json(adminRoomResponse(bot, regenerateRoomPassword(caller.roomId)));
      return;
    }

    if (typeof body.password !== "string" || !isValidRoomPassword(body.password)) {
      res.status(400).json({ success: false, error: "invalid_password" });
      return;
    }

    if (body.password === caller.room.password) {
      // Already this room's password: nothing to write, and re-writing it would
      // mean asking the UNIQUE index to tolerate the room's own row.
      res.json(adminRoomResponse(bot, caller.room));
      return;
    }

    try {
      res.json(adminRoomResponse(bot, updateRoomPassword(caller.roomId, body.password)));
    } catch (err) {
      if (isRoomPasswordCollision(err)) {
        // Another room already answers to it, and a password must resolve to
        // exactly one room. Which room is never revealed.
        res.status(409).json({ success: false, error: "password_taken" });
        return;
      }
      throw err;
    }
  }

  return { getAdminRoomRoute, patchAdminRoomRoute, regenerateRoomPasswordRoute };
}
