import type { MyContext } from "../context.js";
import {
  addAdmin,
  clearPendingAdminAction,
  deleteUserCompletely,
  getPendingAdminAction,
  getPendingRegistration,
  getUserByNickname,
  getUserByTelegramId,
  getUserByTelegramUsername,
  isAdmin,
  setPendingAdminAction,
} from "../db/repository.js";

const NOT_AUTHORIZED = "Not authorized.";

function requireAdminSender(ctx: MyContext): number | null {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAdmin(telegramId)) {
    return null;
  }
  return telegramId;
}

function usageDeleteUser(): string {
  return "Usage: /deleteuser <nickname or telegram_id>";
}

function usageMakeAdmin(): string {
  return "Usage: /makeadmin <telegram_id or @username>";
}

function parseTelegramIdArg(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function labelForUser(telegramId: number, fallback?: string): string {
  const user = getUserByTelegramId(telegramId);
  if (user) return user.nickname;
  if (fallback) return fallback;
  return String(telegramId);
}

/** /deleteuser <nickname|telegram_id> — admin only; asks for YES confirmation. */
export async function deleteUserCommand(ctx: MyContext): Promise<void> {
  const adminId = requireAdminSender(ctx);
  if (adminId === null) {
    await ctx.reply(NOT_AUTHORIZED);
    return;
  }

  const arg = ctx.match?.toString().trim() ?? "";
  if (!arg) {
    await ctx.reply(usageDeleteUser());
    return;
  }

  const asId = parseTelegramIdArg(arg);
  let targetTelegramId: number | null = null;
  let targetLabel: string;

  if (asId !== null) {
    const user = getUserByTelegramId(asId);
    const pending = getPendingRegistration(asId);
    if (!user && !pending && !isAdmin(asId)) {
      await ctx.reply(`No user found for Telegram id ${asId}.`);
      return;
    }
    targetTelegramId = asId;
    targetLabel = user?.nickname ?? (pending?.nickname ? pending.nickname : String(asId));
  } else {
    const user = getUserByNickname(arg);
    if (!user) {
      await ctx.reply(`No user found with nickname "${arg}".`);
      return;
    }
    targetTelegramId = user.telegram_id;
    targetLabel = user.nickname;
  }

  if (targetTelegramId === adminId) {
    await ctx.reply("You can't delete your own account with /deleteuser.");
    return;
  }

  setPendingAdminAction(adminId, "delete_user", targetTelegramId, targetLabel);
  await ctx.reply(
    `Are you sure you want to delete ${targetLabel}? This removes all their data permanently. Reply YES to confirm.`
  );
}

/** /makeadmin <telegram_id|@username> — admin only; asks for YES confirmation. */
export async function makeAdminCommand(ctx: MyContext): Promise<void> {
  const adminId = requireAdminSender(ctx);
  if (adminId === null) {
    await ctx.reply(NOT_AUTHORIZED);
    return;
  }

  const arg = ctx.match?.toString().trim() ?? "";
  if (!arg) {
    await ctx.reply(usageMakeAdmin());
    return;
  }

  let targetTelegramId: number | null = null;
  let targetLabel: string;

  const asId = parseTelegramIdArg(arg);
  if (asId !== null) {
    targetTelegramId = asId;
    targetLabel = labelForUser(asId);
  } else {
    const fromDb = getUserByTelegramUsername(arg);
    if (fromDb) {
      targetTelegramId = fromDb.telegram_id;
      targetLabel = fromDb.nickname;
    } else {
      const username = arg.replace(/^@/, "");
      try {
        const chat = await ctx.api.getChat(`@${username}`);
        if (chat.type !== "private") {
          await ctx.reply(`Could not resolve @${username} to a Telegram user.`);
          return;
        }
        targetTelegramId = chat.id;
        const registered = getUserByTelegramId(chat.id);
        targetLabel =
          registered?.nickname ??
          ("username" in chat && chat.username ? `@${chat.username}` : String(chat.id));
      } catch (err) {
        console.error(`makeadmin: failed to resolve @${username}:`, err);
        await ctx.reply(`Could not find Telegram user @${username}.`);
        return;
      }
    }
  }

  if (isAdmin(targetTelegramId)) {
    await ctx.reply(`${targetLabel} is already an admin.`);
    return;
  }

  setPendingAdminAction(adminId, "make_admin", targetTelegramId, targetLabel);
  await ctx.reply(
    `Are you sure you want to make ${targetLabel} an admin? They will have full admin powers. Reply YES to confirm.`
  );
}

/**
 * Handle YES / cancel for a pending admin action.
 * Returns true when the message was consumed (so registration must not handle it).
 */
export async function adminConfirmTextHandler(ctx: MyContext): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAdmin(telegramId)) return false;

  const pending = getPendingAdminAction(telegramId);
  if (!pending) return false;

  const text = ctx.message?.text;
  if (!text || text.startsWith("/")) return false;

  if (text.trim() === "YES") {
    clearPendingAdminAction(telegramId);

    if (pending.action === "delete_user") {
      if (pending.target_telegram_id === telegramId) {
        await ctx.reply("You can't delete your own account with /deleteuser.");
        return true;
      }
      deleteUserCompletely(pending.target_telegram_id);
      await ctx.reply(
        `Deleted ${pending.target_label} (Telegram id ${pending.target_telegram_id}). All their data is gone.`
      );
      return true;
    }

    if (pending.action === "make_admin") {
      addAdmin(pending.target_telegram_id);
      await ctx.reply(
        `${pending.target_label} is now an admin (Telegram id ${pending.target_telegram_id}).`
      );
      return true;
    }

    await ctx.reply("Unknown pending action — cancelled.");
    return true;
  }

  clearPendingAdminAction(telegramId);
  await ctx.reply("Cancelled.");
  return true;
}
