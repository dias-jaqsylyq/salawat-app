import type { Api } from "grammy";
import { config } from "../config.js";

/**
 * The chat menu button — the one next to the message box — follows the user's
 * membership: "Open App" while they are in a room, the plain commands menu
 * while they are not.
 *
 * The Mini App has nothing to show someone with no room; opening it lands them
 * on a screen whose only advice is to come back to the bot and send /start. A
 * button that leads nowhere is worse than no button, so it is taken away for
 * exactly as long as that is true.
 *
 * Telegram offers no way to remove the button outright: the choices are
 * web_app, commands, and default. "default" is not it — the bot-wide default
 * set at startup (setupMenuButton) *is* the web_app button, so resetting to it
 * would put "Open App" straight back. Hence commands, which is also where the
 * /start they need lives.
 */
function appMenuButton() {
  return { type: "web_app" as const, text: "Open App", web_app: { url: config.miniAppUrl } };
}

/**
 * Every call here is best-effort. Telegram refuses for reasons that have
 * nothing to do with what we were doing — the user blocked the bot, the chat is
 * gone, we are being rate-limited — and none of them is a reason to fail the
 * leave, the kick or the registration that triggered it. The button is
 * cosmetic; the membership change is not.
 */
async function setMenuButton(
  api: Api,
  chatId: number,
  menuButton: ReturnType<typeof appMenuButton> | { type: "commands" }
): Promise<void> {
  try {
    await api.setChatMenuButton({ chat_id: chatId, menu_button: menuButton });
  } catch (err) {
    console.error(`Could not set the chat menu button for ${chatId}:`, err);
  }
}

/** Give this one chat the "Open App" button, on joining a room. */
export async function showAppMenuButton(api: Api, chatId: number): Promise<void> {
  // Same guard as the bot-wide setup at startup: pointing anyone at a
  // placeholder URL produces a button that only fails when tapped.
  if (config.miniAppUrlIsPlaceholder) return;
  await setMenuButton(api, chatId, appMenuButton());
}

/** Take it away again, on leaving one. */
export async function hideAppMenuButton(api: Api, chatId: number): Promise<void> {
  await setMenuButton(api, chatId, { type: "commands" });
}
