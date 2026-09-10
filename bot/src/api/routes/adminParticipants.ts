import type { Request, Response } from "express";
import type { Bot } from "grammy";
import type { MyContext } from "../../context.js";
import {
  addRoomAdmin,
  demoteRoomAdmin,
  isRoomAdmin,
  kickUserFromRoom,
} from "../../db/repository.js";
import { parseIdParam } from "../params.js";
import { getRoomMemberByTelegramId, requireCallerRoom } from "../roomScope.js";
import type { CallerRoom } from "../roomScope.js";
import type { User } from "../../types.js";

/**
 * Room governance from the admin Leaderboard screen (PRD §3, §3a): promote and
 * demote co-admins, and kick members.
 *
 * Co-admins are flat and equal — any of them may promote or demote any other,
 * the room's original owner included; `owner_user_id` is historical record, not
 * power (PRD §3a). What is *not* flat is the room boundary: a target who is not
 * a current member of the caller's own room 404s, exactly like a Telegram id
 * that was never registered, so admin status in one room is never authority in
 * another.
 */
function resolveTarget(
  req: Request,
  res: Response
): { caller: CallerRoom; target: User } | null {
  const caller = requireCallerRoom(req, res);
  if (!caller) return null;

  const telegramId = parseIdParam(req.params.telegramId);
  if (telegramId === null) {
    res.status(400).json({ success: false, error: "invalid_telegram_id" });
    return null;
  }

  const target = getRoomMemberByTelegramId(telegramId, caller.roomId);
  if (!target) {
    res.status(404).json({ success: false, error: "participant_not_found" });
    return null;
  }

  return { caller, target };
}

function participantResponse(target: User, roomId: number) {
  return {
    success: true,
    telegramId: target.telegram_id,
    nickname: target.nickname,
    isRoomAdmin: isRoomAdmin(target.id, roomId),
  };
}

/**
 * POST /api/admin/participants/:telegramId/admin — promote a member of the
 * caller's room to co-admin. Idempotent: promoting an existing admin is a
 * no-op 200.
 */
export function promoteParticipantRoute(req: Request, res: Response): void {
  const resolved = resolveTarget(req, res);
  if (!resolved) return;
  const { caller, target } = resolved;

  addRoomAdmin(caller.roomId, target.id);
  res.json(participantResponse(target, caller.roomId));
}

/**
 * DELETE /api/admin/participants/:telegramId/admin — demote a co-admin (or the
 * owner) back to plain participant. Demoting yourself is allowed; demoting the
 * room's last admin is not — promote someone else first (PRD §3a).
 */
export function demoteParticipantRoute(req: Request, res: Response): void {
  const resolved = resolveTarget(req, res);
  if (!resolved) return;
  const { caller, target } = resolved;

  const result = demoteRoomAdmin(caller.roomId, target.id);
  if (result.lastAdmin) {
    res.status(409).json({ success: false, error: "last_admin" });
    return;
  }

  res.json(participantResponse(target, caller.roomId));
}

/** The DM a kicked member gets (PRD §3a) — plain text, so a room name never needs escaping. */
export function kickNotificationText(roomName: string): string {
  return (
    `You've been removed from ${roomName}.\n\n` +
    "Your habit history for that room is gone. If you're given the room password again, " +
    "you can rejoin and start fresh."
  );
}

/**
 * DELETE /api/admin/participants/:telegramId — kick a member out of the room.
 *
 * Destructive by design, unlike a voluntary leave: every log they earned in
 * this room is deleted, so a later rejoin starts from zero (PRD §3a). They are
 * told by DM, and nothing stops them rejoining with the password — a kick is
 * not a ban.
 *
 * You cannot kick yourself (leaving is POST /api/room/leave), and you cannot
 * kick the room's last admin.
 */
export function createKickParticipantRoute(bot: Bot<MyContext>) {
  return async (req: Request, res: Response): Promise<void> => {
    const resolved = resolveTarget(req, res);
    if (!resolved) return;
    const { caller, target } = resolved;

    if (target.id === caller.user.id) {
      res.status(400).json({ success: false, error: "cannot_kick_self" });
      return;
    }

    const result = kickUserFromRoom(target.id, caller.roomId);
    if (result.lastAdmin) {
      res.status(409).json({ success: false, error: "last_admin" });
      return;
    }
    if (!result.kicked) {
      // They left the room between resolveTarget and here.
      res.status(404).json({ success: false, error: "participant_not_found" });
      return;
    }

    // The kick itself is already committed — a failed DM must not undo it or
    // fail the request.
    try {
      await bot.api.sendMessage(target.telegram_id, kickNotificationText(caller.room.name));
    } catch (err) {
      console.error(`Failed to notify kicked user ${target.telegram_id}:`, err);
    }

    res.json({
      success: true,
      telegramId: target.telegram_id,
      nickname: target.nickname,
      habitLogsDeleted: result.habitLogsDeleted,
    });
  };
}
