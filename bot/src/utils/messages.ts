import type { Api } from "grammy";

/**
 * Delete a Telegram message, never throwing.
 *
 * Telegram refuses deletions for a whole family of perfectly ordinary reasons —
 * the message is older than 48 hours (the Bot API's hard limit, which applies to
 * the user's own messages in a private chat just as much as to ours), the user
 * already deleted it themselves, or they have since blocked the bot. None of
 * those should abort whatever loop the caller is running, so every call site
 * gets its own try/catch here rather than one around the batch.
 *
 * Returns whether the message is gone as far as we know.
 */
export async function safeDeleteMessage(
  api: Api,
  chatId: number,
  messageId: number
): Promise<boolean> {
  try {
    await api.deleteMessage(chatId, messageId);
    return true;
  } catch (err) {
    console.warn(`Could not delete message ${messageId} in chat ${chatId}:`, err);
    return false;
  }
}
