import cron from "node-cron";
import { backupDatabase } from "../db/backup.js";
import { config } from "../config.js";

async function runBackup(reason: string) {
  try {
    const dest = await backupDatabase();
    console.log(`DB backup (${reason}) written to ${dest}`);
  } catch (err) {
    console.error(`DB backup (${reason}) failed:`, err);
  }
}

/** Daily rolling backup at 03:00 in the challenge timezone, plus one run shortly after boot. */
export function startBackupScheduler() {
  cron.schedule("0 3 * * *", () => void runBackup("scheduled"), {
    timezone: config.timezone,
  });

  // Defer startup backup so listen/bot.start aren't blocked on I/O.
  setTimeout(() => void runBackup("startup"), 5_000);

  console.log(`Daily DB backup scheduled for 03:00 (${config.timezone})`);
}
