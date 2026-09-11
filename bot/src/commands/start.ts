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
  trackRegistrationMessage,
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
      // The /start message is part of the signup conversation and goes with the
      // rest of it at the end. Recorded after the pending row exists, so a
      // /start from someone already registered leaves nothing behind.
      trackRegistrationMessage(telegramId, ctx.message?.message_id);
      await promptCurrentStep(
        ctx,
        pending,
        `Assalamu alaikum! You've been invited to <b>${escapeHtml(resolution.room.name)}</b>.`
      );
      return;
    }

    const pending = ensurePendingRegistration(telegramId);
    trackRegistrationMessage(telegramId, ctx.message?.message_id);
    await promptCurrentStep(ctx, pending, `That invite link didn't work — ${resolution.error}`);
    return;
  }

  const pending = ensurePendingRegistration(telegramId);
  trackRegistrationMessage(telegramId, ctx.message?.message_id);
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
    trackRegistrationMessage(telegramId, ctx.message?.message_id);
    await promptCurrentStep(
      ctx,
      pending,
      "Registration isn't finished yet — continuing where you left off."
    );
    return;
  }

  await ctx.reply(HELP_UNREGISTERED_TEXT, { parse_mode: "HTML" });
}

/**
 * Shown when someone sends something the bot cannot act on. Both prefaces are
 * followed by whatever that user actually needs next — the current signup
 * question, or the menu nudge — so a dead end always comes with a way forward.
 */
export const UNSUPPORTED_MESSAGE_PREFACE =
  "I can only read text messages here — photos, files, voice notes and stickers " +
  "aren't something I can read.";

export const UNKNOWN_COMMAND_PREFACE = "I don't know that command.";

/**
 * Reply with whatever this user's next step is, optionally prefaced by why we
 * couldn't use what they just sent.
 *
 * Three audiences, and every one of them gets an answer: someone mid-signup is
 * re-asked the current question, a registered user is pointed at the menu
 * button, and someone who has never started gets the help text.
 */
async function replyWithNextStep(
  ctx: MyContext,
  telegramId: number,
  preface?: string
): Promise<void> {
  if (getUserByTelegramId(telegramId)) {
    const menu = registeredMenuText(currentRoomName(telegramId));
    await ctx.reply(preface ? `${preface}\n\n${menu}` : menu, { parse_mode: "HTML" });
    return;
  }

  const pending = getPendingRegistration(telegramId);
  if (pending) {
    // promptCurrentStep records the question it sends; the message that
    // provoked it was recorded by whichever handler called us.
    await promptCurrentStep(ctx, pending, preface);
    return;
  }

  await ctx.reply(
    preface ? `${preface}\n\n${HELP_UNREGISTERED_TEXT}` : HELP_UNREGISTERED_TEXT,
    { parse_mode: "HTML" }
  );
}

/** Text answers while a pending registration exists. */
export async function registrationTextHandler(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Anything sent mid-signup belongs to the signup conversation — a real answer,
  // a mistyped command, a second guess — and is swept away with it. Recorded
  // before the handlers below so an unknown command is covered too.
  if (!getUserByTelegramId(telegramId) && getPendingRegistration(telegramId)) {
    trackRegistrationMessage(telegramId, ctx.message?.message_id);
  }

  // Only reachable for a command no bot.command() claimed: grammy stops the
  // middleware chain at a matched command, so /start and /help never land here.
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) {
    await replyWithNextStep(ctx, telegramId, UNKNOWN_COMMAND_PREFACE);
    return;
  }

  const pending = getUserByTelegramId(telegramId) ? undefined : getPendingRegistration(telegramId);
  if (!pending) {
    // Registered, or never started: either way there is no answer to record,
    // but staying silent leaves them typing into a void.
    await replyWithNextStep(ctx, telegramId);
    return;
  }

  await handleRegistrationAnswer(ctx, pending, text);
}

/**
 * Every message that is not text: photos, documents, stickers, voice and video
 * notes, locations, contacts, polls.
 *
 * Registered only as a catch-all *after* the text handler, so it never competes
 * with it. Before this existed these updates matched no handler at all, and
 * someone who answered a signup question with a photo got complete silence with
 * their registration still waiting on that same question.
 */
export async function unsupportedMessageHandler(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // A sticker sent at the nickname question is as much part of the signup mess
  // as a typed answer, so it is swept away with the rest.
  if (!getUserByTelegramId(telegramId) && getPendingRegistration(telegramId)) {
    trackRegistrationMessage(telegramId, ctx.message?.message_id);
  }

  await replyWithNextStep(ctx, telegramId, UNSUPPORTED_MESSAGE_PREFACE);
}
