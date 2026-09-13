import type { Bot } from "grammy";
import type { Request, Response } from "express";
import { getUserByTelegramId, leaveCurrentRoom } from "../../db/repository.js";
import { hideAppMenuButton } from "../../utils/menuButton.js";
import type { MyContext } from "../../context.js";

/**
 * POST /api/room/leave — leave the room you are currently in (PRD §0, §3).
 *
 * Non-destructive, unlike a kick: habit logs stay in the database, membership
 * and co-admin status are simply dropped (PRD §1, §3a). Afterwards the user has
 * no room — reminders pause, and the Mini App shows an empty day — until they
 * send /start in the bot or follow another room's invite link.
 *
 * Refused for a room's last admin: promote someone else first (PRD §3a).
 *
 * Takes the bot for the one thing leaving does outside the database: dropping
 * the "Open App" chat menu button, which from here on would only open a screen
 * telling them to come back to the bot.
 */
export function createLeaveRoomRoute(bot: Bot<MyContext>) {
  return async (req: Request, res: Response): Promise<void> => {
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

    // The leave is already committed, so a Telegram hiccup here must not turn a
    // successful leave into an error — hideAppMenuButton never throws.
    await hideAppMenuButton(bot.api, user.telegram_id);

    res.json({ success: true, leftRoomId: result.roomId });
  };
}
