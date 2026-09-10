import type { MyContext } from "../context.js";
import { escapeHtml } from "../api/broadcastFormatting.js";
import {
  ensurePendingRegistration,
  getPendingRegistration,
  getRoomById,
  getUserByTelegramId,
  startPendingRegistrationForRoom,
} from "../db/repository.js";
import {
  handleRegistrationAnswer,
  promptCurrentStep,
  resolveJoinPassword,
} from "../registration/flow.js";

export const HELP_UNREGISTERED_TEXT =
  "🌙 <b>Habit Tracker</b>\n\n" +
  "Send /start to begin registration in this chat.\n" +
  "After that, use the menu button (☰) to open the Mini App.";

/**
 * The already-registered nudge, naming the user's room (PRD §3a) so "which room
 * am I in" never needs its own command. Falls back to a room-less wording for
 * the window between leaving one room and joining the next.
 */
export function registeredMenuText(roomName: string | null): string {
  const where = roomName
    ? `You're registered in <b>${escapeHtml(roomName)}</b> — logging, progress, and the leaderboard are in the app.`
    : "You're registered, but you're not in a room right now.";
  return `🌙 <b>Habit Tracker</b>\n\n${where}\n\nTap the menu button (☰ next to the message box) to open it.`;
}

/**
 * The payload of a `/start <payload>` deep link, or null for a bare /start.
 * Read from the message text rather than ctx.match so the parsing is the same
 * everywhere and testable on its own.
 */
export function parseStartPayload(text: string | undefined): string | null {
  if (!text) return null;
  const match = /^\/start(?:@\S+)?\s+(\S+)/.exec(text.trim());
  return match?.[1] ?? null;
}

/** The room the user is currently in, if any. */
function currentRoomName(telegramId: number): string | null {
  const user = getUserByTelegramId(telegramId);
  if (!user?.current_room_id) return null;
  return getRoomById(user.current_room_id)?.name ?? null;
}

/** Registered users get the menu nudge; everyone else resumes or starts signup. */
export async function startCommand(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (getUserByTelegramId(telegramId)) {
    // A room invite link followed by someone who is already registered is
    // ignored entirely, payload and all (PRD §3a): switching rooms stays a
    // deliberate action, never a side effect of tapping a link.
    await ctx.reply(registeredMenuText(currentRoomName(telegramId)), { parse_mode: "HTML" });
    return;
  }

  const payload = parseStartPayload(ctx.message?.text);
  if (payload) {
    const resolution = resolveJoinPassword(telegramId, payload);
    if (resolution.room) {
      // The link answered both the role and the password question — open the
      // conversation at the first thing we still need.
      const pending = startPendingRegistrationForRoom(telegramId, resolution.room.id);
      await promptCurrentStep(
        ctx,
        pending,
        `Assalamu alaikum! You've been invited to <b>${escapeHtml(resolution.room.name)}</b>.`
      );
      return;
    }

    const pending = ensurePendingRegistration(telegramId);
    await promptCurrentStep(ctx, pending, `That invite link didn't work — ${resolution.error}`);
    return;
  }

  const pending = ensurePendingRegistration(telegramId);
  await promptCurrentStep(ctx, pending);
}

export async function helpCommand(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (getUserByTelegramId(telegramId)) {
    await ctx.reply(registeredMenuText(currentRoomName(telegramId)), { parse_mode: "HTML" });
    return;
  }

  const pending = getPendingRegistration(telegramId);
  if (pending) {
    await promptCurrentStep(
      ctx,
      pending,
      "Registration isn't finished yet — continuing where you left off."
    );
    return;
  }

  await ctx.reply(HELP_UNREGISTERED_TEXT, { parse_mode: "HTML" });
}

/** Text answers while a pending registration exists. */
export async function registrationTextHandler(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (getUserByTelegramId(telegramId)) return;

  const pending = getPendingRegistration(telegramId);
  if (!pending) return;

  const text = ctx.message?.text;
  if (!text) {
    await promptCurrentStep(ctx, pending, "Please reply with text.");
    return;
  }

  // Ignore slash commands here — command handlers own those.
  if (text.startsWith("/")) return;

  await handleRegistrationAnswer(ctx, pending, text);
}
