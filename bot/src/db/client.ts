import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureParentDir(path: string) {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

ensureParentDir(config.dbPath);

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");

/**
 * Every table the app owns, in an order that is safe to drop even with
 * foreign keys enforced (children before parents).
 * `admins`/`pending_admin_actions` are pre-multi-room tables that no longer
 * exist in schema.sql — listed so an old DB file loses them too.
 */
const APP_TABLES = [
  "habit_logs",
  "habits",
  "room_admins",
  "pending_registrations",
  "pending_admin_actions",
  "admins",
  "users",
  "rooms",
];

function tableExists(name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { hit: number } | undefined;
  return row !== undefined;
}

function columnNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name
  );
}

/**
 * True for a DB file created before the multi-room pivot. Two independent
 * markers, either of which is conclusive: the retired global `admins` table,
 * and a `habits` table with no `room_id`. Both are gone after a reset, so this
 * goes false permanently once the reset has run.
 */
function needsMultiRoomReset(): boolean {
  if (tableExists("admins")) return true;
  if (tableExists("habits") && !columnNames("habits").includes("room_id")) return true;
  return false;
}

/**
 * Snapshot the DB file next to itself before the destructive reset. Returns the
 * path, or null when there is nothing on disk to copy (`:memory:` in tests, or
 * a first boot). Deliberately NOT the rolling scheduler backup path — that one
 * gets overwritten every few hours, and this snapshot is the only copy of the
 * pre-pivot data.
 */
function snapshotBeforeReset(): string | null {
  if (config.dbPath === ":memory:" || !existsSync(config.dbPath)) return null;
  // Fold the WAL into the main file first, so the plain file copy is complete.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dirname(config.dbPath), `salawat.pre-multiroom-${stamp}.db`);
  copyFileSync(config.dbPath, dest);
  return dest;
}

/**
 * One-time destructive migration to the multi-room schema (MULTI ROOM PRD §1, §5).
 *
 * There is no data migration: rooms/users/habits/logs from the single-tenant era
 * are wiped, not folded into a "default room" — confirmed as disposable test data.
 * Every table is dropped and recreated from schema.sql, so nothing survives with
 * a stale shape (the failure mode behind the earlier stale-column incident).
 *
 * Idempotent: no-ops on a DB that is already multi-room, and on a fresh one.
 * Returns true when it actually wiped something.
 */
export function resetForMultiRoom(): boolean {
  if (!needsMultiRoomReset()) return false;

  const snapshot = snapshotBeforeReset();
  console.warn(
    `db migration: pre-multi-room DB detected — DROPPING all app tables and recreating them ` +
      `from schema.sql (no data is migrated). ` +
      (snapshot ? `Snapshot of the old data: ${snapshot}` : `No file snapshot taken (${config.dbPath}).`)
  );

  // PRAGMA foreign_keys is a no-op inside a transaction, so it has to be
  // toggled out here — DROP order is child-first anyway, this is belt and braces.
  db.pragma("foreign_keys = OFF");
  try {
    const wipe = db.transaction(() => {
      for (const table of APP_TABLES) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      db.exec(schema);
    });
    wipe();
  } finally {
    db.pragma("foreign_keys = ON");
  }

  console.warn("db migration: multi-room schema created, all previous data wiped.");
  return true;
}

try {
  resetForMultiRoom();
} catch (err) {
  // Unlike the old pre-pivot column fixup, this one is fatal on purpose: the
  // rest of the code assumes room-scoped tables, so booting on a half-migrated
  // or still-single-tenant DB would fail every query anyway — louder here than
  // at request time. db.transaction() has already rolled the drops back.
  console.error(
    `db migration: resetForMultiRoom failed, database left unchanged (transaction rolled back): ` +
      `${err instanceof Error ? err.message : String(err)}`,
    err
  );
  throw err;
}

// No-op right after a reset; creates the tables on a brand-new DB file.
db.exec(schema);
