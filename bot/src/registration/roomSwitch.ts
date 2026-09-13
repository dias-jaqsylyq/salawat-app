import { config } from "../config.js";
import { escapeHtml } from "../api/broadcastFormatting.js";
import {
  enqueueMessageDeletion,
  getRoomById,
  getUserByTelegramId,
  isLastAdminWithMembers,
  isNicknameTaken,
  switchRoomWithKick,
  updateUserProfile,
} from "../db/repository.js";
import {
  REMOVE_KEYBOARD,
  YES_NO_KEYBOARD,
  parseYesNo,
  resolveJoinPassword,
  roomWelcomeHtml,
  roomWelcomePlain,
  sendConfirmation,
} from "./flow.js";
import type { MyContext } from "../context.js";
import type { Room, User } from "../types.js";

/**
 * What an *already-registered* user gets when they follow a room invite link.
 *
 * Three outcomes, decided by the room they are in right now:
 *   • no room at all (they left one)  → joined straight away, nothing to ask
 *   • the room the link points at     → told so, nothing changes
 *   • some other room                 → one Yes/No question, then a switch
 *
 * The question is *ephemeral* in the strict sense: it lives in memory, it is
 * dropped the moment the user does anything else, and it is never repeated.
 * That is the whole reason it is not a pending_registrations-style row — an
 * unanswered question is meant to evaporate, and a redeploy losing one costs
 * the user nothing more than tapping the link again.
 */

/** Nicknames are 1–50 characters, same as at signup (flow.ts). */
const MAX_NICKNAME_LENGTH = 50;

/**
 * How long an unanswered question stays answerable. Deliberately the same
 * window the message itself lives for: by the time the cleanup cron deletes the
 * question from the chat, answering it is no longer a thing the user can see to
 * do, so the state must not outlive it either.
 */
export const ROOM_SWITCH_TTL_MS = config.reminderDeleteAfterMinutes * 60_000;

export type RoomSwitchState =
  | { kind: "confirm"; fromRoomId: number; toRoomId: number; askedAt: number }
  | { kind: "nickname"; roomId: number; askedAt: number };

const openQuestions = new Map<number, RoomSwitchState>();

/** The open question for this user, if there is one and it hasn't gone stale. */
export function getRoomSwitchState(telegramId: number): RoomSwitchState | undefined {
  const state = openQuestions.get(telegramId);
  if (!state) return undefined;
  if (Date.now() - state.askedAt > ROOM_SWITCH_TTL_MS) {
    openQuestions.delete(telegramId);
    return undefined;
  }
  return state;
}

export function clearRoomSwitchState(telegramId: number): void {
  openQuestions.delete(telegramId);
}

function ask(telegramId: number, state: RoomSwitchState): void {
  openQuestions.set(telegramId, state);
}

/* --------------------------------------------------------------- messages */

/**
 * Queue one message for deletion an hour out, reusing the same cron-drained
 * queue the reminders use. Never throws: losing one message to the queue costs
 * a leftover line in the chat, which must not cost the switch itself.
 *
 * Silently does nothing without a message id — Telegram always sends one, but
 * the reply stubs in the tests do not, and a dialog that only works against a
 * fully-furnished context is a dialog that is never tested.
 */
function queueForDeletion(ctx: MyContext, messageId: number | undefined): void {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId === undefined || messageId === undefined) return;
  try {
    enqueueMessageDeletion(chatId, messageId, config.reminderDeleteAfterMinutes);
  } catch (err) {
    console.error(`Could not queue message ${messageId} in chat ${chatId} for deletion:`, err);
  }
}

/** The user's own message, when it is part of this dialog. */
function queueIncoming(ctx: MyContext): void {
  queueForDeletion(ctx, ctx.message?.message_id);
}

/** Reply, and queue what we just said for deletion along with the rest. */
async function replyEphemeral(
  ctx: MyContext,
  html: string,
  replyMarkup?: unknown
): Promise<void> {
  const sent = await ctx.reply(html, {
    parse_mode: "HTML",
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup as never }),
  });
  queueForDeletion(ctx, sent.message_id);
}

function roomNameOf(roomId: number | null): string {
  return (roomId === null ? undefined : getRoomById(roomId)?.name) ?? "your room";
}

/**
 * Both room names go in the text and never on the buttons: a name can be long,
 * or emoji, or look exactly like the other room's, and a button that reads
 * "🌙🌙🌙" answers nothing. The buttons stay a plain Yes and No, and the text
 * says which is which.
 */
export function switchQuestionText(fromName: string, toName: string): string {
  return (
    `You're in <b>${escapeHtml(fromName)}</b>. This link is for <b>${escapeHtml(toName)}</b>.\n\n` +
    `Switch to <b>${escapeHtml(toName)}</b>? Your logs, points and personal habits in ` +
    `<b>${escapeHtml(fromName)}</b> will be deleted.\n\n` +
    `Reply <b>Yes</b> to switch, or <b>No</b> to stay where you are.`
  );
}

function lastAdminRefusalText(roomName: string): string {
  return (
    `You're the only admin of <b>${escapeHtml(roomName)}</b>, and other people are still in it.\n\n` +
    `Make someone else an admin in the Mini App first, then tap the same invite link again.`
  );
}

function nicknamePromptText(nickname: string, roomName: string): string {
  return (
    `Your nickname <b>${escapeHtml(nickname)}</b> is already taken in ` +
    `<b>${escapeHtml(roomName)}</b>.\n\n` +
    `Send a different one (1–${MAX_NICKNAME_LENGTH} characters) and I'll move you over.`
  );
}

const ROOM_GONE_TEXT =
  "That room doesn't exist any more — ask its admin for a current invite link.";

/* ----------------------------------------------------------- the deep link */

/**
 * A `/start <payload>` from someone who already has an account. Always answers.
 *
 * This is the only place a room-join rate-limit token is spent: the click is
 * the join attempt, and answering the question that follows must never cost a
 * second one.
 */
export async function handleRegisteredDeepLink(
  ctx: MyContext,
  user: User,
  payload: string
): Promise<void> {
  queueIncoming(ctx);

  const resolution = resolveJoinPassword(user.telegram_id, payload);
  if (!resolution.room) {
    await replyEphemeral(ctx, `That invite link didn't work — ${escapeHtml(resolution.error)}`);
    return;
  }
  const room = resolution.room;

  if (user.current_room_id === room.id) {
    await replyEphemeral(ctx, `You're already in <b>${escapeHtml(room.name)}</b>.`);
    return;
  }

  const from = user.current_room_id === null ? undefined : getRoomById(user.current_room_id);
  if (!from) {
    // Nothing to stay in, so nothing to ask: a user between rooms joins the
    // linked room the same way a brand-new one would.
    await joinLinkedRoom(ctx, user, room);
    return;
  }

  ask(user.telegram_id, {
    kind: "confirm",
    fromRoomId: from.id,
    toRoomId: room.id,
    askedAt: Date.now(),
  });
  await replyEphemeral(ctx, switchQuestionText(from.name, room.name), YES_NO_KEYBOARD);
}

/**
 * Everything between "this room, yes" and actually being in it: the two things
 * that can still stop the move, then the move.
 */
async function joinLinkedRoom(ctx: MyContext, user: User, room: Room): Promise<void> {
  // Refused first, before any other question, so nobody is walked through
  // picking a new nickname and only then turned away.
  if (user.current_room_id !== null && isLastAdminWithMembers(user.id, user.current_room_id)) {
    clearRoomSwitchState(user.telegram_id);
    await replyEphemeral(
      ctx,
      lastAdminRefusalText(roomNameOf(user.current_room_id)),
      REMOVE_KEYBOARD
    );
    return;
  }

  // Nicknames are unique per room, so the one they have may already be spoken
  // for over there. Nothing is written until they have a free one — walking
  // away from this question leaves them exactly where they were.
  if (isNicknameTaken(user.nickname, { roomId: room.id, excludeTelegramId: user.telegram_id })) {
    ask(user.telegram_id, { kind: "nickname", roomId: room.id, askedAt: Date.now() });
    await replyEphemeral(ctx, nicknamePromptText(user.nickname, room.name), REMOVE_KEYBOARD);
    return;
  }

  await completeJoin(ctx, user, room);
}

/** The move itself, plus the one message that survives it. */
async function completeJoin(ctx: MyContext, user: User, room: Room): Promise<void> {
  const telegramId = user.telegram_id;
  const result = switchRoomWithKick(user.id, room.id);
  clearRoomSwitchState(telegramId);

  if (result.targetMissing) {
    await replyEphemeral(ctx, ROOM_GONE_TEXT, REMOVE_KEYBOARD);
    return;
  }
  if (result.lastAdmin) {
    await replyEphemeral(ctx, lastAdminRefusalText(roomNameOf(result.oldRoomId)), REMOVE_KEYBOARD);
    return;
  }
  if (result.alreadyThere) {
    await replyEphemeral(ctx, `You're already in <b>${escapeHtml(room.name)}</b>.`, REMOVE_KEYBOARD);
    return;
  }

  // The nickname may have been changed a moment ago, on the way in.
  const nickname = getUserByTelegramId(telegramId)?.nickname ?? user.nickname;
  // The plain new-room welcome and nothing else: no summary of what became of
  // the old room. They were told what they were giving up before they said yes.
  const messageId = await sendConfirmation(
    ctx,
    telegramId,
    roomWelcomeHtml(room.name, nickname),
    roomWelcomePlain(room.name, nickname)
  );
  queueForDeletion(ctx, messageId);
}

/* -------------------------------------------------------------- the answer */

/**
 * A text message from a registered user, offered to whichever question is open.
 *
 * Returns true when it was an answer and has been dealt with. False means the
 * caller should carry on handling the message normally — and any question that
 * was open has been dropped on the way out, because an ignored question is
 * dropped rather than repeated.
 */
export async function handleRoomSwitchText(
  ctx: MyContext,
  telegramId: number,
  text: string
): Promise<boolean> {
  const state = getRoomSwitchState(telegramId);
  if (!state) return false;

  const trimmed = text.trim();
  // A command is never an answer to either question.
  if (trimmed.startsWith("/")) {
    clearRoomSwitchState(telegramId);
    return false;
  }

  const user = getUserByTelegramId(telegramId);
  if (!user) {
    clearRoomSwitchState(telegramId);
    return false;
  }

  if (state.kind === "nickname") {
    queueIncoming(ctx);
    await answerNickname(ctx, user, state.roomId, trimmed);
    return true;
  }

  const answer = parseYesNo(trimmed);
  if (answer === null) {
    // They said something else entirely: the question goes away and this
    // message is ordinary traffic from here on — which is also why it is not
    // queued for deletion, it was never part of the dialog.
    clearRoomSwitchState(telegramId);
    return false;
  }

  // Cleared before the first await: nothing here is serialised per user, so two
  // taps arriving together must not both find an open question.
  clearRoomSwitchState(telegramId);
  queueIncoming(ctx);

  if (!answer) {
    await replyEphemeral(
      ctx,
      `Alright — you're staying in <b>${escapeHtml(roomNameOf(state.fromRoomId))}</b>.`,
      REMOVE_KEYBOARD
    );
    return true;
  }

  await performSwitch(ctx, user, state.fromRoomId, state.toRoomId);
  return true;
}

/**
 * Yes, they want to switch. The question may be an hour old by now, so where
 * they are is re-read rather than assumed.
 */
async function performSwitch(
  ctx: MyContext,
  user: User,
  fromRoomId: number,
  toRoomId: number
): Promise<void> {
  const room = getRoomById(toRoomId);
  if (!room) {
    await replyEphemeral(ctx, ROOM_GONE_TEXT, REMOVE_KEYBOARD);
    return;
  }
  if (user.current_room_id === room.id) {
    await replyEphemeral(ctx, `You're already in <b>${escapeHtml(room.name)}</b>.`, REMOVE_KEYBOARD);
    return;
  }
  if (user.current_room_id !== null && user.current_room_id !== fromRoomId) {
    // They moved since the question was asked. Never take someone out of a room
    // they never agreed to leave.
    await replyEphemeral(
      ctx,
      "Your room has changed since that link was sent — tap it again if you still want to switch.",
      REMOVE_KEYBOARD
    );
    return;
  }

  await joinLinkedRoom(ctx, user, room);
}

/** A replacement nickname, checked only for length and for being free there. */
async function answerNickname(
  ctx: MyContext,
  user: User,
  roomId: number,
  trimmed: string
): Promise<void> {
  const room = getRoomById(roomId);
  if (!room) {
    clearRoomSwitchState(user.telegram_id);
    await replyEphemeral(ctx, ROOM_GONE_TEXT, REMOVE_KEYBOARD);
    return;
  }

  if (trimmed.length === 0 || trimmed.length > MAX_NICKNAME_LENGTH) {
    await replyEphemeral(ctx, `Nickname must be 1–${MAX_NICKNAME_LENGTH} characters.`);
    return;
  }
  if (isNicknameTaken(trimmed, { roomId: room.id, excludeTelegramId: user.telegram_id })) {
    await replyEphemeral(
      ctx,
      `That one is taken in <b>${escapeHtml(room.name)}</b> too — please choose another.`
    );
    return;
  }

  // Being free in the new room is the only test here. Signup also refuses a
  // nickname equal to the real name, but that pair was settled at registration
  // and a room change is not the moment to re-open it.
  const updated = updateUserProfile(user.telegram_id, { nickname: trimmed });
  clearRoomSwitchState(user.telegram_id);
  await completeJoin(ctx, updated, room);
}
