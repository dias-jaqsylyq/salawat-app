import { InlineKeyboard, Keyboard } from "grammy";
import {
  ROOM_JOIN_RATE_LIMIT_PER_MINUTE,
  config,
  formatReminderHhMm,
  isValidReminderTime,
  parseReminderTime,
} from "../config.js";
import { allowRequest } from "../api/rateLimit.js";
import { nicknameMatchesRealName, parseRealName } from "../api/realName.js";
import { escapeHtml } from "../api/broadcastFormatting.js";
import {
  createAdminWithRoom,
  createUser,
  deletePendingRegistration,
  getRoomById,
  getRoomByPassword,
  getUserByTelegramId,
  isNicknameTaken,
  updatePendingRegistration,
} from "../db/repository.js";
import { isValidRoomPassword } from "../utils/roomPassword.js";
import type { MyContext } from "../context.js";
import type {
  PendingRegistration,
  RegistrationStep,
  Room,
  TelegramProfile,
  UserRole,
} from "../types.js";

const YES_NO_KEYBOARD = new Keyboard()
  .text("Yes")
  .text("No")
  .resized()
  .oneTime();

export const ADMIN_CHOICE_LABEL = "Admin — create a room";
export const PARTICIPANT_CHOICE_LABEL = "Participant — join with a password";

/** One choice per row: both labels are too long to share one comfortably. */
const ROLE_KEYBOARD = new Keyboard()
  .text(ADMIN_CHOICE_LABEL)
  .row()
  .text(PARTICIPANT_CHOICE_LABEL)
  .resized()
  .oneTime();

const REMOVE_KEYBOARD = { remove_keyboard: true as const };

/** Room names are free text shown back to everyone in the room — keep them sane. */
const MAX_ROOM_NAME_LENGTH = 100;

export function parseYesNo(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (["yes", "y", "yeah", "yep"].includes(normalized)) return true;
  if (["no", "n", "nope"].includes(normalized)) return false;
  return null;
}

/**
 * The admin-or-participant answer (PRD §2). Accepts the two keyboard labels
 * plus the obvious typed shorthands, since the reply keyboard is a suggestion —
 * nothing stops someone typing the answer instead of tapping.
 */
export function parseRole(text: string): UserRole | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === ADMIN_CHOICE_LABEL.toLowerCase()) return "admin";
  if (normalized === PARTICIPANT_CHOICE_LABEL.toLowerCase()) return "participant";
  if (["admin", "a", "1", "create", "create a room"].includes(normalized)) return "admin";
  if (["participant", "p", "2", "join", "join a room"].includes(normalized)) {
    return "participant";
  }
  return null;
}

export function promptTextForStep(step: RegistrationStep): string {
  switch (step) {
    case "role":
      return (
        "Assalamu alaikum! Let's get you set up.\n\n" +
        "Are you setting up a new competition, or joining one?\n\n" +
        `• <b>${escapeHtml(ADMIN_CHOICE_LABEL)}</b> — you create the room and share its password.\n` +
        `• <b>${escapeHtml(PARTICIPANT_CHOICE_LABEL)}</b> — you need the password from your room's admin.\n\n` +
        "This can't be changed later, so pick carefully."
      );
    case "room_password":
      return "Enter your room's password (ask the room's admin for it — it's case-sensitive).";
    case "real_name":
      return "What's your full name? (private — only admins see this for prizes)";
    case "room_name":
      return `What should your room be called? (1–${MAX_ROOM_NAME_LENGTH} characters — your participants will see this.)`;
    case "categories":
      return (
        "Do you want habit categories in this room?\n\n" +
        "With categories on, every habit belongs to one of <b>IQ</b>, <b>SQ</b>, " +
        "<b>PQ</b> or <b>EQ</b>, and they're grouped by category in the app. " +
        "With them off, habits are one flat list.\n\n" +
        "You can change this later."
      );
    case "nickname":
      return "Choose a nickname for the leaderboard (1–50 characters).\nIt must be different from your full name.";
    case "reminder_opt_in":
      return "Want a daily reminder to log your habits?";
    case "reminder_time":
      return "What time should we remind you? Reply with HH:mm (24h), e.g. 20:00";
    case "fasting_opt_in":
      return (
        "Want a separate fasting reminder?\n\n" +
        "It's a nudge on Sundays and Wednesdays about the fast the next day. " +
        "Independent of the daily reminder above."
      );
    case "fasting_time":
      return "What time should the fasting reminder arrive? Reply with HH:mm (24h), e.g. 20:00";
  }
}

function usesYesNoKeyboard(step: RegistrationStep): boolean {
  return step === "reminder_opt_in" || step === "categories" || step === "fasting_opt_in";
}

export async function promptCurrentStep(
  ctx: MyContext,
  pending: PendingRegistration,
  preface?: string
): Promise<void> {
  const text = preface
    ? `${preface}\n\n${promptTextForStep(pending.step)}`
    : promptTextForStep(pending.step);

  // HTML throughout: prompts carry bold markup, and prefaces interpolate free
  // text (room names) that must not be parsed as markup — see escapeHtml calls
  // at every call site that builds one.
  if (pending.step === "role") {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: ROLE_KEYBOARD });
    return;
  }

  if (usesYesNoKeyboard(pending.step)) {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: YES_NO_KEYBOARD });
    return;
  }

  await ctx.reply(text, { parse_mode: "HTML", reply_markup: REMOVE_KEYBOARD });
}

function profileFromContext(ctx: MyContext): TelegramProfile {
  const from = ctx.from;
  return {
    telegramUsername: from?.username ?? null,
    telegramFirstName: from?.first_name ?? null,
    telegramLastName: from?.last_name ?? null,
  };
}

/**
 * The bot's own @username, for building room invite links. Read from the
 * running bot's info rather than configuration so it can never drift from the
 * token in use; null in contexts where it isn't available (bot.init() not run),
 * where the caller falls back to showing the bare password.
 */
function botUsername(ctx: MyContext): string | null {
  try {
    return ctx.me?.username ?? null;
  } catch {
    return null;
  }
}

/**
 * A room's Telegram deep link (PRD §3a): following it pre-fills the password
 * and drops a brand-new user straight into this room's signup. Room passwords
 * are restricted to Telegram's start-payload charset (see roomPassword.ts), so
 * no escaping is needed here.
 */
export function roomInviteLink(botUsername: string, password: string): string {
  return `https://t.me/${botUsername}?start=${password}`;
}

/** Reminder answers as stored on a finished pending row. */
function remindersFromPending(pending: PendingRegistration) {
  const reminderEnabled = pending.reminder_enabled === 1;
  const fastingReminderEnabled = pending.fasting_reminder_enabled === 1;
  return {
    reminderEnabled,
    // reminder_time is a non-nullable column (default '20:00'); these
    // placeholders are inert whenever the matching opt-in is false.
    reminderTime: reminderEnabled ? (pending.reminder_time ?? "20:00") : "20:00",
    fastingReminderEnabled,
    fastingReminderTime: fastingReminderEnabled
      ? (pending.fasting_reminder_time ?? "20:00")
      : "20:00",
  };
}

function openAppKeyboard(): InlineKeyboard {
  return new InlineKeyboard().url("Open App", config.miniAppDeepLink);
}

/**
 * Reply, and if the fancy HTML version fails, fall back to a plain one — the
 * account is already saved by the time these run, so a failed confirmation must
 * never leave the user thinking signup itself failed.
 */
async function sendConfirmation(
  ctx: MyContext,
  telegramId: number,
  html: string,
  plainFallback: string
): Promise<void> {
  try {
    await ctx.reply(html, { parse_mode: "HTML", reply_markup: openAppKeyboard() });
  } catch (err) {
    console.error(
      `finalizeRegistration: user ${telegramId} was saved but the confirmation reply failed:`,
      err
    );
    try {
      await ctx.reply(plainFallback);
    } catch (fallbackErr) {
      console.error(
        `finalizeRegistration: fallback confirmation also failed for ${telegramId}:`,
        fallbackErr
      );
    }
  }
}

/**
 * Shared failure handling for both finalize branches. Returns true when it
 * handled the error (and already replied), false when the caller should rethrow.
 */
async function handleFinalizeFailure(
  ctx: MyContext,
  pending: PendingRegistration,
  err: unknown
): Promise<void> {
  const telegramId = pending.telegram_id;
  // Never let a DB failure here vanish silently into bot.catch() — log the
  // concrete SQL error plus a diagnostic snapshot of what's colliding, so a
  // future occurrence is diagnosable from Railway logs alone.
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;
  console.error(
    `finalizeRegistration: failed to save user ${telegramId} (nickname "${pending.nickname}"): ` +
      `${message}${code ? ` [${code}]` : ""}\n` +
      `  diagnostic: users row already exists for this telegram_id? ` +
      `${getUserByTelegramId(telegramId) !== undefined}; ` +
      `nickname "${pending.nickname}" taken by someone else? ` +
      `${isNicknameTaken(pending.nickname ?? "", { roomId: pending.room_id ?? undefined })}`,
    err
  );

  // The only UNIQUE constraint the users INSERT can hit is users.telegram_id
  // — so if a row for this id exists now, the account was already created
  // (by an earlier attempt, or some other path) and this "failure" just means
  // we're out of sync with our own pending row. Reconcile instead of scaring
  // an already-registered person with a generic error.
  if (getUserByTelegramId(telegramId) !== undefined) {
    deletePendingRegistration(telegramId);
    await ctx.reply(
      "Looks like you're already registered! Open the Mini App from the menu button (☰) to get started."
    );
    return;
  }

  // Pending row is deliberately left in place (not deleted) so the user can
  // simply retry once whatever this was is resolved.
  await ctx.reply(
    "Something went wrong finishing your signup. Please try again — resend your last answer, " +
      "or contact an admin if this keeps happening."
  );
}

/** Admin path: create the account, the room, and the room's first password. */
async function finalizeAdminRegistration(
  ctx: MyContext,
  pending: PendingRegistration
): Promise<void> {
  const telegramId = pending.telegram_id;
  if (!pending.room_name || pending.categories_enabled === null) {
    throw new Error(`Incomplete room answers for ${telegramId}`);
  }

  let room: Room;
  try {
    const created = createAdminWithRoom(
      telegramId,
      pending.nickname!,
      profileFromContext(ctx),
      pending.real_name,
      remindersFromPending(pending),
      {
        name: pending.room_name,
        categoriesEnabled: pending.categories_enabled === 1,
      }
    );
    room = created.room;
    deletePendingRegistration(telegramId);
  } catch (err) {
    await handleFinalizeFailure(ctx, pending, err);
    return;
  }

  const username = botUsername(ctx);
  const inviteLine = username
    ? `\n\nOr share this invite link — it opens the bot with the password filled in:\n` +
      `${roomInviteLink(username, room.password)}`
    : "";

  const html =
    `Your room <b>${escapeHtml(room.name)}</b> is ready, ` +
    `<b>${escapeHtml(pending.nickname!)}</b>! 🌙\n\n` +
    `Room password: <code>${escapeHtml(room.password)}</code>\n` +
    `<b>Share this with your participants</b> — anyone with it can join your room. ` +
    `It's case-sensitive.` +
    inviteLine +
    `\n\nCategories are <b>${room.categories_enabled === 1 ? "on" : "off"}</b> for this room.\n\n` +
    `You're a participant of your own room too. Open the app to add habits and start logging.`;

  const plain =
    `Your room "${room.name}" is ready! Password: ${room.password}\n` +
    `Share it with your participants. Open the Mini App from the menu button (☰) to add habits.`;

  await sendConfirmation(ctx, telegramId, html, plain);
}

/** Participant path: join the room their password already resolved to. */
async function finalizeParticipantRegistration(
  ctx: MyContext,
  pending: PendingRegistration
): Promise<void> {
  const telegramId = pending.telegram_id;
  if (pending.room_id === null) {
    throw new Error(`Incomplete room answer for ${telegramId}`);
  }

  // The room is resolved at the password step, but this signup may have sat
  // half-finished for a while since — re-check rather than trusting a stale id.
  const room = getRoomById(pending.room_id);
  if (!room) {
    const next = updatePendingRegistration(telegramId, {
      room_id: null,
      step: "room_password",
    });
    await promptCurrentStep(
      ctx,
      next,
      "That room doesn't exist any more. Ask your admin for a current password."
    );
    return;
  }

  try {
    createUser(
      telegramId,
      pending.nickname!,
      profileFromContext(ctx),
      pending.real_name,
      remindersFromPending(pending),
      { role: "participant", currentRoomId: room.id }
    );
    deletePendingRegistration(telegramId);
  } catch (err) {
    await handleFinalizeFailure(ctx, pending, err);
    return;
  }

  // HTML, not Markdown: nickname and room name are free text and Telegram's
  // legacy Markdown parser 400s on any unmatched _ * ` [ (e.g. a nickname like
  // "ali_2005"), which would make this reply silently vanish into bot.catch()
  // even though the user had just been fully registered above.
  const html =
    `You're in <b>${escapeHtml(room.name)}</b>, <b>${escapeHtml(pending.nickname!)}</b>! 🌙\n\n` +
    `All logging, progress, leaderboard, and settings are in the Mini App.\n` +
    `You can change your details anytime in Settings.\n\n` +
    `Tap below (or the menu button ☰) to open the app.`;

  const plain =
    `You're in ${room.name}, ${pending.nickname}! ` +
    `Open the Mini App from the menu button (☰) to get started.`;

  await sendConfirmation(ctx, telegramId, html, plain);
}

async function finalizeRegistration(ctx: MyContext, pending: PendingRegistration): Promise<void> {
  const telegramId = pending.telegram_id;
  if (!pending.real_name || !pending.nickname) {
    throw new Error(`Incomplete pending registration for ${telegramId}`);
  }
  if (pending.reminder_enabled === null || pending.fasting_reminder_enabled === null) {
    throw new Error(`Incomplete reminder answers for ${telegramId}`);
  }

  if (pending.role === "admin") {
    await finalizeAdminRegistration(ctx, pending);
    return;
  }
  await finalizeParticipantRegistration(ctx, pending);
}

/**
 * Process one text answer for the current pending step.
 *
 * The conversation forks on the first question and rejoins on the reminder
 * tail (PRD §2):
 *   role ─┬─ admin ──────→ real_name → room_name → categories → nickname ─┐
 *         └─ participant → room_password → real_name → nickname ──────────┤
 *   ┌──────────────────────────────────────────────────────────────────────┘
 *   └→ reminder_opt_in → [reminder_time] → fasting_opt_in → [fasting_time]
 */
export async function handleRegistrationAnswer(
  ctx: MyContext,
  pending: PendingRegistration,
  text: string
): Promise<void> {
  const telegramId = pending.telegram_id;
  const trimmed = text.trim();

  switch (pending.step) {
    case "role": {
      const role = parseRole(trimmed);
      if (role === null) {
        await promptCurrentStep(
          ctx,
          pending,
          "Please tap one of the two buttons below (or type \"admin\" or \"participant\")."
        );
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        role,
        step: role === "admin" ? "real_name" : "room_password",
      });
      await promptCurrentStep(ctx, next);
      return;
    }

    case "room_password": {
      const resolution = resolveJoinPassword(telegramId, trimmed);
      if (!resolution.room) {
        await promptCurrentStep(ctx, pending, resolution.error);
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        room_id: resolution.room.id,
        step: "real_name",
      });
      await promptCurrentStep(
        ctx,
        next,
        `Found it — you're joining <b>${escapeHtml(resolution.room.name)}</b>.`
      );
      return;
    }

    case "real_name": {
      const realName = parseRealName(trimmed);
      if (!realName) {
        await promptCurrentStep(
          ctx,
          pending,
          "Please enter your full name (1–100 characters)."
        );
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        real_name: realName,
        step: pending.role === "admin" ? "room_name" : "nickname",
      });
      await promptCurrentStep(ctx, next);
      return;
    }

    case "room_name": {
      if (trimmed.length === 0 || trimmed.length > MAX_ROOM_NAME_LENGTH) {
        await promptCurrentStep(
          ctx,
          pending,
          `Room name must be 1–${MAX_ROOM_NAME_LENGTH} characters.`
        );
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        room_name: trimmed,
        step: "categories",
      });
      await promptCurrentStep(ctx, next);
      return;
    }

    case "categories": {
      const answer = parseYesNo(trimmed);
      if (answer === null) {
        await promptCurrentStep(ctx, pending, "Please reply Yes or No.");
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        categories_enabled: answer ? 1 : 0,
        step: "nickname",
      });
      await promptCurrentStep(ctx, next);
      return;
    }

    case "nickname": {
      if (trimmed.length === 0 || trimmed.length > 50) {
        await promptCurrentStep(
          ctx,
          pending,
          "Nickname must be 1–50 characters."
        );
        return;
      }
      if (!pending.real_name || nicknameMatchesRealName(trimmed, pending.real_name)) {
        await promptCurrentStep(
          ctx,
          pending,
          "Your nickname must be different from your full name (case doesn't matter)."
        );
        return;
      }
      // Nickname uniqueness is per-room (PRD §3a). An admin's room does not
      // exist yet at this point and will be created empty, so nothing can
      // collide there — only the participant branch has a room to check.
      if (
        pending.room_id !== null &&
        isNicknameTaken(trimmed, { roomId: pending.room_id })
      ) {
        await promptCurrentStep(
          ctx,
          pending,
          "That nickname is already taken in this room — please choose another."
        );
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        nickname: trimmed,
        step: "reminder_opt_in",
      });
      await promptCurrentStep(ctx, next);
      return;
    }

    case "reminder_opt_in": {
      const answer = parseYesNo(trimmed);
      if (answer === null) {
        await promptCurrentStep(ctx, pending, "Please reply Yes or No.");
        return;
      }
      const next = updatePendingRegistration(
        telegramId,
        answer
          ? { reminder_enabled: 1, step: "reminder_time" }
          : { reminder_enabled: 0, reminder_time: null, step: "fasting_opt_in" }
      );
      await promptCurrentStep(ctx, next);
      return;
    }

    case "reminder_time": {
      if (!isValidReminderTime(trimmed)) {
        await promptCurrentStep(
          ctx,
          pending,
          "That time isn't valid. Use HH:mm (24h), e.g. 20:00"
        );
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        reminder_time: formatReminderHhMm(parseReminderTime(trimmed)),
        step: "fasting_opt_in",
      });
      await promptCurrentStep(ctx, next);
      return;
    }

    case "fasting_opt_in": {
      const answer = parseYesNo(trimmed);
      if (answer === null) {
        await promptCurrentStep(ctx, pending, "Please reply Yes or No.");
        return;
      }
      if (answer) {
        const next = updatePendingRegistration(telegramId, {
          fasting_reminder_enabled: 1,
          step: "fasting_time",
        });
        await promptCurrentStep(ctx, next);
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        fasting_reminder_enabled: 0,
        fasting_reminder_time: null,
      });
      await finalizeRegistration(ctx, next);
      return;
    }

    case "fasting_time": {
      if (!isValidReminderTime(trimmed)) {
        await promptCurrentStep(
          ctx,
          pending,
          "That time isn't valid. Use HH:mm (24h), e.g. 20:00"
        );
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        fasting_reminder_time: formatReminderHhMm(parseReminderTime(trimmed)),
      });
      await finalizeRegistration(ctx, next);
      return;
    }
  }
}

export interface JoinPasswordResolution {
  /** The room this password opens, or null when it opens nothing. */
  room: Room | null;
  /** Why not, ready to show the user. Empty when a room was found. */
  error: string;
}

/**
 * Validate a typed or deep-linked room password and resolve it to its room.
 *
 * Rate-limited per Telegram user (PRD §2) with the same allowRequest helper the
 * API routes use. The format check runs first so a malformed guess is rejected
 * without touching the database, and the "no such room" wording is identical
 * either way — nothing here reveals which passwords are close to real ones.
 */
export function resolveJoinPassword(
  telegramId: number,
  password: string
): JoinPasswordResolution {
  if (!allowRequest(telegramId, ROOM_JOIN_RATE_LIMIT_PER_MINUTE)) {
    return {
      room: null,
      error: "Too many attempts — please wait a minute before trying again.",
    };
  }

  const room = isValidRoomPassword(password) ? getRoomByPassword(password) : undefined;
  if (!room) {
    return {
      room: null,
      error: "No room has that password — double-check it with your admin.",
    };
  }

  return { room, error: "" };
}
