import type { MyContext } from "../context.js";
import { escapeHtml } from "../api/broadcastFormatting.js";
import {
  clearRegistrationMessages,
  deletePendingRegistration,
  enqueueMessageDeletion,
  ensurePendingRegistration,
  getPendingRegistration,
  getRoomById,
  getUserByTelegramId,
  listRegistrationMessageIds,
  startPendingRegistrationForRoom,
} from "../db/repository.js";
import { config } from "../config.js";
import type { User } from "../types.js";
import {
  handleRegistrationAnswer,
  promptCurrentStep,
  resolveJoinPassword,
  trackRegistrationMessage,
} from "../registration/flow.js";
import {
  clearRoomSwitchState,
  handleRegisteredDeepLink,
  handleRoomSwitchText,
} from "../registration/roomSwitch.js";

export const HELP_UNREGISTERED_TEXT =
  "🌙 <b>Habit Tracker</b>\n\n" +
  "Send /start to begin registration in this chat.\n" +
  "After that, use the menu button (☰) to open the Mini App.";

/**
 * The already-registered nudge, naming the user's room (PRD §3a) so "which room
 * am I in" never needs its own command.
 *
 * Someone between rooms is sent to /start instead of to the menu button: the
 * app has nothing to show them without a room, and /start is where they join
 * or create one. Pointing them at the menu button was a loop — the Mini App
 * answered it by telling them to /start.
 */
export function registeredMenuText(roomName: string | null): string {
  if (!roomName) {
    return (
      `🌙 <b>Habit Tracker</b>\n\n` +
      `You're registered, but you're not in a room right now.\n\n` +
      `Send /start to join one with its password, or to create a room of your own.`
    );
  }
  return (
    `🌙 <b>Habit Tracker</b>\n\n` +
    `You're registered in <b>${escapeHtml(roomName)}</b> — logging, progress, and the leaderboard are in the app.\n\n` +
    `Tap the menu button (☰ next to the message box) to open it.`
  );
}

/**
 * True for a registered user with no room. They may run the whole signup
 * conversation again from a bare /start — a fresh role question and every
 * answer asked from scratch — which for everyone else is closed off.
 */
function isBetweenRooms(user: User | undefined): boolean {
  return user !== undefined && user.current_room_id === null;
}

/**
 * Who is allowed to be answering signup questions right now: someone who has
 * never registered, and someone who has but is between rooms and going through
 * it again. A user with a room is neither, and their answers are ordinary chat.
 */
function mayAnswerSignup(telegramId: number): boolean {
  const user = getUserByTelegramId(telegramId);
  return user === undefined || isBetweenRooms(user);
}

/**
 * Throw away a signup that is no longer going anywhere, queueing whatever of it
 * is still on screen for deletion an hour out (the same queue roomSwitch.ts and
 * the reminders use) rather than leaving the questions hanging in the chat.
 *
 * Two callers, both cases where the pending row can only mislead: an invite
 * link superseding a half-finished re-registration, and a user who has a room
 * again and so can never finish one.
 */
function abandonPendingRegistration(telegramId: number): void {
  if (!getPendingRegistration(telegramId)) return;
  try {
    for (const messageId of listRegistrationMessageIds(telegramId)) {
      enqueueMessageDeletion(telegramId, messageId, config.reminderDeleteAfterMinutes);
    }
  } catch (err) {
    console.error(`Could not queue the abandoned signup of ${telegramId} for deletion:`, err);
  }
  clearRegistrationMessages(telegramId);
  deletePendingRegistration(telegramId);
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

/**
 * Registered users follow the link they tapped, or get the menu nudge for a
 * bare /start; everyone else resumes or starts signup.
 */
export async function startCommand(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = getUserByTelegramId(telegramId);
  if (user) {
    // A fresh /start always supersedes a room-switch question left hanging.
    clearRoomSwitchState(telegramId);
    const linked = parseStartPayload(ctx.message?.text);
    if (linked) {
      // An invite link used to be dropped on the floor here, payload and all,
      // which left anyone who had left their room with no way back into one.
      // The payload is honoured now — but a switch out of a room they are
      // actually in still takes an explicit yes (roomSwitch.ts).
      //
      // A link that opens a real room is the newer intent, so it supersedes a
      // re-registration half-typed into the chat: left behind, that row would
      // wait to be resumed by some later /start and finish into a room change
      // nobody asked for. A link that opens nothing supersedes nothing — a
      // mistyped or expired one must not cost them the answers they gave.
      if (await handleRegisteredDeepLink(ctx, user, linked)) {
        abandonPendingRegistration(telegramId);
      }
      return;
    }
    if (isBetweenRooms(user)) {
      // The whole signup conversation, from the role question down: they are
      // choosing a room all over again, and everything it asks is asked afresh.
      const pending = ensurePendingRegistration(telegramId);
      trackRegistrationMessage(telegramId, ctx.message?.message_id);
      await promptCurrentStep(ctx, pending);
      return;
    }
    // Registered and in a room: a pending row here can never be finished, and
    // would only be resumed into confusion.
    abandonPendingRegistration(telegramId);
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

  // Asking for help is not an answer to a room-switch question; drop it.
  clearRoomSwitchState(telegramId);

  const user = getUserByTelegramId(telegramId);
  if (user && !isBetweenRooms(user)) {
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
  // Someone between rooms is mid-signup like anyone else, so their question
  // comes before the menu nudge — which for them says "send /start" anyway.
  if (!mayAnswerSignup(telegramId)) {
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

  // First, before anything else can answer them: a registered user may have an
  // open room-switch question, and their Yes or No belongs to it. Anything that
  // is not an answer drops the question in there and falls through to the
  // normal handling below, so it is never asked twice.
  if (await handleRoomSwitchText(ctx, telegramId, ctx.message?.text ?? "")) return;

  // Anything sent mid-signup belongs to the signup conversation — a real answer,
  // a mistyped command, a second guess — and is swept away with it. Recorded
  // before the handlers below so an unknown command is covered too.
  if (mayAnswerSignup(telegramId) && getPendingRegistration(telegramId)) {
    trackRegistrationMessage(telegramId, ctx.message?.message_id);
  }

  // Only reachable for a command no bot.command() claimed: grammy stops the
  // middleware chain at a matched command, so /start and /help never land here.
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) {
    await replyWithNextStep(ctx, telegramId, UNKNOWN_COMMAND_PREFACE);
    return;
  }

  const pending = mayAnswerSignup(telegramId) ? getPendingRegistration(telegramId) : undefined;
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

  // A sticker is "something else" too: it drops an open room-switch question
  // rather than leaving it waiting for a Yes that is no longer coming.
  clearRoomSwitchState(telegramId);

  // A sticker sent at the nickname question is as much part of the signup mess
  // as a typed answer, so it is swept away with the rest.
  if (mayAnswerSignup(telegramId) && getPendingRegistration(telegramId)) {
    trackRegistrationMessage(telegramId, ctx.message?.message_id);
  }

  await replyWithNextStep(ctx, telegramId, UNSUPPORTED_MESSAGE_PREFACE);
}
