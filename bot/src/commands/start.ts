import type { MyContext } from "../context.js";
import {
  ensurePendingRegistration,
  getPendingRegistration,
  getUserByTelegramId,
} from "../db/repository.js";
import { handleRegistrationAnswer, promptCurrentStep } from "../registration/flow.js";

export const REGISTERED_MENU_TEXT =
  "🌙 *Salawat Challenge*\n\n" +
  "You're already registered — logging, progress, and the leaderboard are in the app.\n\n" +
  "Tap the menu button (☰ next to the message box) to open it.";

export const HELP_UNREGISTERED_TEXT =
  "🌙 *Salawat Challenge*\n\n" +
  "Send /start to begin registration in this chat.\n" +
  "After that, use the menu button (☰) to open the Mini App.";

/** Registered users get the menu nudge; everyone else resumes or starts signup. */
export async function startCommand(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (getUserByTelegramId(telegramId)) {
    await ctx.reply(REGISTERED_MENU_TEXT, { parse_mode: "Markdown" });
    return;
  }

  const pending = ensurePendingRegistration(telegramId);
  await promptCurrentStep(ctx, pending);
}

export async function helpCommand(ctx: MyContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (getUserByTelegramId(telegramId)) {
    await ctx.reply(REGISTERED_MENU_TEXT, { parse_mode: "Markdown" });
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

  await ctx.reply(HELP_UNREGISTERED_TEXT, { parse_mode: "Markdown" });
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
