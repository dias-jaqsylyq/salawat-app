import { InlineKeyboard, Keyboard } from "grammy";
import {
  formatReminderHhMm,
  isValidReminderTime,
  MAX_GOAL,
  parseReminderTime,
  config,
} from "../config.js";
import { nicknameMatchesRealName, parseRealName } from "../api/realName.js";
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
    case "goal":
      return "What's your daily salawat goal? (positive whole number)";
    case "reminder_opt_in":
      return "Want a daily salawat reminder?";
    case "reminder_time":
      return "What time should we remind you? Reply with HH:mm (24h), e.g. 20:00";
    case "fasting_opt_in":
      return "Want Sunday/Wednesday fasting reminders?";
    case "fasting_time":
      return "What time for fasting reminders? Reply with HH:mm (24h), e.g. 20:00";
  }
}

function usesYesNoKeyboard(step: RegistrationStep): boolean {
  return step === "reminder_opt_in" || step === "fasting_opt_in";
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
  if (!pending.real_name || !pending.nickname || pending.goal === null) {
    throw new Error(`Incomplete pending registration for ${telegramId}`);
  }
  if (pending.reminder_enabled === null || pending.fasting_reminder_enabled === null) {
    throw new Error(`Incomplete reminder answers for ${telegramId}`);
  }

  const reminderEnabled = pending.reminder_enabled === 1;
  const fastingEnabled = pending.fasting_reminder_enabled === 1;

  createUser(telegramId, pending.nickname, pending.goal, profileFromContext(ctx), pending.real_name, {
    reminderEnabled,
    reminderTime: reminderEnabled ? pending.reminder_time : null,
    fastingReminderEnabled: fastingEnabled,
    fastingReminderTime: fastingEnabled
      ? (pending.fasting_reminder_time ?? "20:00")
      : "20:00",
  });

  deletePendingRegistration(telegramId);

  const openApp = new InlineKeyboard().url("Open App", config.miniAppDeepLink);
  await ctx.reply(
    `You're in, *${pending.nickname}*! 🌙\n\n` +
      `All logging, progress, leaderboard, and settings are in the Mini App.\n` +
      `You can change your details anytime in Settings.\n\n` +
      `Tap below (or the menu button ☰) to open the app.`,
    { parse_mode: "Markdown", reply_markup: openApp }
  );
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
        step: "goal",
      });
      await promptCurrentStep(ctx, next);
      return;
    }

    case "goal": {
      const goal = Number(trimmed);
      if (!Number.isInteger(goal) || goal <= 0 || goal > MAX_GOAL) {
        await promptCurrentStep(
          ctx,
          pending,
          `Please enter a positive whole number (max ${MAX_GOAL.toLocaleString()}).`
        );
        return;
      }
      const next = updatePendingRegistration(telegramId, {
        goal,
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
        step: "fasting_opt_in",
      });
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
      const normalized = formatReminderHhMm(parseReminderTime(trimmed));
      const next = updatePendingRegistration(telegramId, {
        reminder_time: normalized,
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
        fasting_reminder_time: "20:00",
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
      const normalized = formatReminderHhMm(parseReminderTime(trimmed));
      const next = updatePendingRegistration(telegramId, {
        fasting_reminder_time: normalized,
      });
      await finalizeRegistration(ctx, next);
      return;
    }
  }
}
