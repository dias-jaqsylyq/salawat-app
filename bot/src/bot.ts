import { Bot, GrammyError, HttpError } from "grammy";
import { config } from "./config.js";
import type { MyContext } from "./context.js";
import {
  helpCommand,
  registrationTextHandler,
  startCommand,
  unsupportedMessageHandler,
} from "./commands/start.js";

/**
 * What the user sees when a handler threw before it managed to reply. Kept
 * deliberately vague about the cause (they can't act on "SQLITE_BUSY") but
 * explicit that their message did not land, so they retry instead of waiting.
 */
export const UNEXPECTED_ERROR_TEXT =
  "Something went wrong handling that — please try again in a moment. " +
  "If it keeps happening, send /help.";

/**
 * True for an error where replying is pointless or would fail again: the user
 * blocked the bot, the chat is gone, or we're being rate-limited by Telegram.
 * Answering those just turns one logged failure into two.
 */
export function isUnreplyableError(error: unknown): boolean {
  if (error instanceof HttpError) return true;
  if (!(error instanceof GrammyError)) return false;
  return (
    error.error_code === 403 || // bot blocked / kicked
    error.error_code === 429 || // flood control
    error.description.includes("chat not found")
  );
}

export function createBot(): Bot<MyContext> {
  const bot = new Bot<MyContext>(config.botToken);

  // Everything the bot does is a one-to-one signup conversation, so it only
  // listens in private chats. Added to a group, it would otherwise run a
  // personal registration in front of everyone and hit the database once per
  // group message.
  const privateChat = bot.chatType("private");

  privateChat.command("start", startCommand);
  privateChat.command("help", helpCommand);
  // /deleteuser and /makeadmin are gone: both were global, single-tenant user
  // management, superseded by room-scoped kick and co-admin promote/demote
  // (MULTI ROOM PRD §3a). No global user-management command remains.

  privateChat.on("message:text", registrationTextHandler);
  // Catch-all for photos, documents, stickers, voice notes and the rest. Last,
  // so it only sees what the text handler above did not.
  privateChat.on("message", unsupportedMessageHandler);

  bot.catch(async (err) => {
    console.error(`Error while handling update ${err.ctx.update.update_id}:`, err.error);

    // Logging alone used to be the whole handler, which meant a thrown handler
    // left the user staring at a chat that never answered. Tell them, unless
    // the error itself is the reason we can't.
    if (isUnreplyableError(err.error)) return;
    if (err.ctx.chat?.type !== "private") return;
    try {
      await err.ctx.reply(UNEXPECTED_ERROR_TEXT);
    } catch (replyErr) {
      console.error(
        `Failed to send the fallback error reply for update ${err.ctx.update.update_id}:`,
        replyErr
      );
    }
  });

  return bot;
}

/** Points the chat menu button (next to the message box) at the Mini App. */
export async function setupMenuButton(bot: Bot<MyContext>): Promise<void> {
  await bot.api.setChatMenuButton({
    menu_button: {
      type: "web_app",
      text: "Open App",
      web_app: { url: config.miniAppUrl },
    },
  });
}
