import type { Request, Response } from "express";
import { getUserByTelegramId, leaveCurrentRoom } from "../../db/repository.js";

/**
 * POST /api/room/leave — leave the room you are currently in (PRD §0, §3).
 *
 * Non-destructive, unlike a kick: habit logs stay in the database, membership
 * and co-admin status are simply dropped (PRD §1, §3a). Afterwards the user has
 * no room — reminders pause, and the Mini App shows an empty day — until they
 * join another one with its password, which happens in the bot.
 *
 * Refused for a room's last admin: promote someone else first (PRD §3a).
 */
export function leaveRoomRoute(req: Request, res: Response): void {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  const result = leaveCurrentRoom(user.id);
  if (result.lastAdmin) {
    res.status(409).json({ success: false, error: "last_admin" });
    return;
  }
  if (!result.left) {
    res.status(400).json({ success: false, error: "no_room" });
    return;
  }

  res.json({ success: true, leftRoomId: result.roomId });
}
