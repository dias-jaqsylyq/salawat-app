import { InlineKeyboard, Keyboard } from "grammy";
import { formatReminderHhMm, isValidReminderTime, parseReminderTime, config } from "../config.js";
import { nicknameMatchesRealName, parseRealName } from "../api/realName.js";
import { escapeHtml } from "../api/broadcastFormatting.js";
import {
  createUser,
  deletePendingRegistration,
  isNicknameTaken,
  updatePendingRegistration,
} from "../db/repository.js";
import type { MyContext } from "../context.js";
import type { PendingRegistration, RegistrationStep, TelegramProfile } from "../types.js";

const YES_NO_KEYBOARD = new Keyboard()
  .text("Yes")
  .text("No")
  .resized()
  .oneTime();

const REMOVE_KEYBOARD = { remove_keyboard: true as const };

export function parseYesNo(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (["yes", "y", "yeah", "yep"].includes(normalized)) return true;
  if (["no", "n", "nope"].includes(normalized)) return false;
  return null;
}

export function promptTextForStep(step: RegistrationStep): string {
  switch (step) {
    case "real_name":
      return "Assalamu alaikum! Let's get you set up.\n\nWhat's your full name? (private — only admins see this for prizes)";
    case "nickname":
      return "Choose a nickname for the leaderboard (1–50 characters).\nIt must be different from your full name.";
    case "reminder_opt_in":
      return "Want a daily reminder to log your habits?";
    case "reminder_time":
      return "What time should we remind you? Reply with HH:mm (24h), e.g. 20:00";
  }
}

function usesYesNoKeyboard(step: RegistrationStep): boolean {
  return step === "reminder_opt_in";
}

export async function promptCurrentStep(
  ctx: MyContext,
  pending: PendingRegistration,
  preface?: string
): Promise<void> {
  const text = preface
    ? `${preface}\n\n${promptTextForStep(pending.step)}`
    : promptTextForStep(pending.step);

  if (usesYesNoKeyboard(pending.step)) {
    await ctx.reply(text, { reply_markup: YES_NO_KEYBOARD });
    return;
  }

  await ctx.reply(text, { reply_markup: REMOVE_KEYBOARD });
}

function profileFromContext(ctx: MyContext): TelegramProfile {
  const from = ctx.from;
  return {
    telegramUsername: from?.username ?? null,
    telegramFirstName: from?.first_name ?? null,
    telegramLastName: from?.last_name ?? null,
  };
}

async function finalizeRegistration(ctx: MyContext, pending: PendingRegistration): Promise<void> {
  const telegramId = pending.telegram_id;
  if (!pending.real_name || !pending.nickname) {
    throw new Error(`Incomplete pending registration for ${telegramId}`);
  }
  if (pending.reminder_enabled === null) {
    throw new Error(`Incomplete reminder answer for ${telegramId}`);
  }

  const reminderEnabled = pending.reminder_enabled === 1;

  try {
    createUser(telegramId, pending.nickname, profileFromContext(ctx), pending.real_name, {
      reminderEnabled,
      // reminderTime is a non-nullable column (default '20:00'); this placeholder
      // is inert whenever reminderEnabled is false.
      reminderTime: reminderEnabled ? (pending.reminder_time ?? "20:00") : "20:00",
    });
    deletePendingRegistration(telegramId);
  } catch (err) {
    // Never let a DB failure here vanish silently into bot.catch() — the pending
    // row is left in place (not deleted) so the user can simply retry.
    console.error(`finalizeRegistration: failed to save user ${telegramId}:`, err);
    await ctx.reply(
      "Something went wrong finishing your signup. Please try again — resend your last answer, " +
        "or contact an admin if this keeps happening."
    );
    return;
  }

  const openApp = new InlineKeyboard().url("Open App", config.miniAppDeepLink);
  // HTML, not Markdown: the nickname is free-text and Telegram's legacy Markdown
  // parser 400s on any unmatched _ * ` [ in the message (e.g. a nickname like
  // "ali_2005"), which previously made this reply silently vanish into
  // bot.catch() even though the user had just been fully registered above.
  const confirmationText =
    `You're in, <b>${escapeHtml(pending.nickname)}</b>! 🌙\n\n` +
    `All logging, progress, leaderboard, and settings are in the Mini App.\n` +
    `You can change your details anytime in Settings.\n\n` +
    `Tap below (or the menu button ☰) to open the app.`;

  try {
    await ctx.reply(confirmationText, { parse_mode: "HTML", reply_markup: openApp });
  } catch (err) {
    // The account is already saved at this point — don't leave the user
    // thinking signup failed just because the fancy confirmation didn't send.
    console.error(
      `finalizeRegistration: user ${telegramId} was saved but the confirmation reply failed:`,
      err
    );
    try {
      await ctx.reply(
        `You're in, ${pending.nickname}! Open the Mini App from the menu button (☰) to get started.`
      );
    } catch (fallbackErr) {
      console.error(
        `finalizeRegistration: fallback confirmation also failed for ${telegramId}:`,
        fallbackErr
      );
    }
  }
}

/**
 * Process one text answer for the current pending step.
 * Returns true if the message was handled as part of registration.
 */
export async function handleRegistrationAnswer(
  ctx: MyContext,
  pending: PendingRegistration,
  text: string
): Promise<void> {
  const telegramId = pending.telegram_id;
  const trimmed = text.trim();

  switch (pending.step) {
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
      if (isNicknameTaken(trimmed)) {
        await promptCurrentStep(
          ctx,
          pending,
          "That nickname is already taken — please choose another."
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
      if (answer) {
        const next = updatePendingRegistration(telegramId, {
          reminder_enabled: 1,
          step: "reminder_time",
        });
        await promptCurrentStep(ctx, next);
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        reminder_enabled: 0,
        reminder_time: null,
      });
      await finalizeRegistration(ctx, next);
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
      const normalized = formatReminderHhMm(parseReminderTime(trimmed));
      const next = updatePendingRegistration(telegramId, {
        reminder_time: normalized,
      });
      await finalizeRegistration(ctx, next);
      return;
    }
  }
}
