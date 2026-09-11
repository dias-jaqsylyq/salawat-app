import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { db } from "./client.js";

/**
 * How many rolling backups to keep. A week's worth at one scheduled backup a
 * day, which is what makes "we noticed the damage on Thursday" recoverable —
 * the previous single-file scheme overwrote the only copy every night, so any
 * corruption that went unnoticed for a day was already in the backup.
 */
export const BACKUP_KEEP = 7;

/**
 * How recent an existing backup has to be for the startup backup to be skipped.
 *
 * This is the crash-loop guard. A process that boots, backs up and dies repeats
 * every few seconds, and without this it would push seven fresh backups of the
 * broken state through the rotation within a minute — destroying exactly the
 * history someone is about to need. Scheduled backups are never skipped.
 */
export const STARTUP_BACKUP_MIN_AGE_MS = 12 * 60 * 60 * 1000;

/** Directory the rolling backups live in, next to the live DB file. */
export function getBackupDir(): string {
  return join(dirname(config.dbPath), "backups");
}

/** Pre-rotation backup path, kept only so restore docs can still name it. */
export const LEGACY_BACKUP_FILENAME = "salawat.backup.db";

const BACKUP_FILE_PATTERN = /^salawat-\d{8}T\d{6}Z(?:-\d+)?\.db$/;

/** UTC timestamp, chosen so the filenames sort chronologically as plain strings. */
export function backupFilename(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `salawat-${stamp}.db`;
}

export interface BackupFile {
  name: string;
  path: string;
  mtimeMs: number;
}

/** Every rotated backup on disk, newest first. */
export function listBackups(): BackupFile[] {
  const dir = getBackupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .map((name) => {
      const path = join(dir, name);
      return { name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

/** Age of the most recent backup in ms, or null when there is none. */
export function newestBackupAgeMs(now = Date.now()): number | null {
  const [newest] = listBackups();
  return newest === undefined ? null : now - newest.mtimeMs;
}

/** Delete all but the `keep` newest backups. Returns the filenames removed. */
export function pruneBackups(keep = BACKUP_KEEP): string[] {
  const removed: string[] = [];
  for (const backup of listBackups().slice(keep)) {
    rmSync(backup.path, { force: true });
    removed.push(backup.name);
  }
  return removed;
}

/**
 * Online WAL-safe backup via better-sqlite3 (no sqlite3 CLI required), written
 * to a new timestamped file and followed by a prune down to BACKUP_KEEP.
 *
 * Returns the path written. Unlike the single-file scheme this replaced,
 * nothing existing is ever overwritten: a backup either joins the rotation or
 * fails, so a bad snapshot cannot destroy a good one.
 */
export async function backupDatabase(now = new Date()): Promise<string> {
  const dir = getBackupDir();
  mkdirSync(dir, { recursive: true });

  // Same-second collisions can't happen on the daily schedule, but a manual run
  // alongside it shouldn't clobber anything either.
  const base = backupFilename(now);
  let dest = join(dir, base);
  for (let suffix = 2; existsSync(dest); suffix++) {
    dest = join(dir, base.replace(/\.db$/, `-${suffix}.db`));
  }

  await db.backup(dest);
  pruneBackups();
  return dest;
}
