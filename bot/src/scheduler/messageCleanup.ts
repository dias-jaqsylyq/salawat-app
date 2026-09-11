import cron from "node-cron";
import type { Bot } from "grammy";
import { MESSAGE_DELETION_BATCH_SIZE, config } from "../config.js";
import { deleteScheduledMessageDeletion, listDueMessageDeletions } from "../db/repository.js";
import { safeDeleteMessage } from "../utils/messages.js";
import type { MyContext } from "../context.js";

let running = false;

/**
 * Delete every message whose deadline has passed.
 *
 * The queue lives in SQLite rather than in setTimeout handles so a reminder
 * sent at 20:00 still disappears at 21:00 across a redeploy — an in-process
 * timer dies with the process and leaves the message in the chat forever.
 *
 * A row is dropped whether or not Telegram accepted the delete. Some messages
 * can never be deleted (older than Telegram's 48-hour window, already removed
 * by the user, bot blocked), and keeping those queued would retry them every
 * minute for the life of the deployment.
 */
export async function runDueMessageDeletions(bot: Bot<MyContext>): Promise<void> {
  if (running) {
    console.warn("Skipping message-cleanup tick — previous run still in flight");
    return;
  }

  running = true;
  try {
    const due = listDueMessageDeletions(MESSAGE_DELETION_BATCH_SIZE);
    for (const row of due) {
      await safeDeleteMessage(bot.api, row.chat_id, row.message_id);
      deleteScheduledMessageDeletion(row.id);
    }
  } finally {
    running = false;
  }
}

export function startMessageCleanupScheduler(bot: Bot<MyContext>): void {
  cron.schedule("* * * * *", () => void runDueMessageDeletions(bot), {
    timezone: config.timezone,
  });

  console.log(
    `Message cleanup scheduler running every minute; reminders are deleted after ` +
      `${config.reminderDeleteAfterMinutes} minute(s)`
  );
}
