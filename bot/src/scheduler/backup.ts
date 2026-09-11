import cron from "node-cron";
import {
  BACKUP_KEEP,
  STARTUP_BACKUP_MIN_AGE_MS,
  backupDatabase,
  newestBackupAgeMs,
} from "../db/backup.js";
import { config } from "../config.js";

/**
 * Whether the boot-time backup should run, given the age of the newest backup
 * already on disk.
 *
 * Split out from the scheduler so the crash-loop case is testable without
 * waiting on timers: a service restarting every few seconds asks this on every
 * boot, and gets false every time until the existing backup has genuinely aged.
 */
export function shouldRunStartupBackup(
  newestAgeMs: number | null,
  minAgeMs = STARTUP_BACKUP_MIN_AGE_MS
): boolean {
  if (newestAgeMs === null) return true;
  return newestAgeMs >= minAgeMs;
}

async function runBackup(reason: string) {
  try {
    const dest = await backupDatabase();
    console.log(`DB backup (${reason}) written to ${dest} (keeping ${BACKUP_KEEP})`);
  } catch (err) {
    console.error(`DB backup (${reason}) failed:`, err);
  }
}

/** The boot-time backup, skipped while a recent one already covers this state. */
async function runStartupBackup() {
  let ageMs: number | null;
  try {
    ageMs = newestBackupAgeMs();
  } catch (err) {
    console.error("DB backup (startup): could not read existing backups:", err);
    return;
  }

  if (!shouldRunStartupBackup(ageMs)) {
    const ageHours = ((ageMs ?? 0) / 3_600_000).toFixed(1);
    console.log(
      `DB backup (startup) skipped — newest backup is only ${ageHours}h old ` +
        `(threshold ${STARTUP_BACKUP_MIN_AGE_MS / 3_600_000}h). ` +
        `This is what stops a restart loop from rotating good backups away.`
    );
    return;
  }

  await runBackup("startup");
}

/** Daily rolling backup at 03:00 in the challenge timezone, plus one run shortly after boot. */
export function startBackupScheduler() {
  cron.schedule("0 3 * * *", () => void runBackup("scheduled"), {
    timezone: config.timezone,
  });

  // Defer startup backup so listen/bot.start aren't blocked on I/O.
  setTimeout(() => void runStartupBackup(), 5_000);

  console.log(
    `Daily DB backup scheduled for 03:00 (${config.timezone}), keeping the ${BACKUP_KEEP} most recent.`
  );
}
