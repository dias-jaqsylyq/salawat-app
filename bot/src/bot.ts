import { Bot } from "grammy";
import { config } from "./config.js";
import type { MyContext } from "./context.js";
import { helpCommand, registrationTextHandler, startCommand } from "./commands/start.js";

export function createBot(): Bot<MyContext> {
  const bot = new Bot<MyContext>(config.botToken);

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  // /deleteuser and /makeadmin are gone: both were global, single-tenant user
  // management, superseded by room-scoped kick and co-admin promote/demote
  // (MULTI ROOM PRD §3a). No global user-management command remains.

  bot.on("message:text", registrationTextHandler);

  bot.catch((err) => {
    console.error(`Error while handling update ${err.ctx.update.update_id}:`, err.error);
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
