import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
db.exec(schema);

/** Idempotent column adds for DBs created before a given schema revision. */
function ensureUserColumn(name: string, ddl: string) {
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`);
  }
}

ensureUserColumn("reminder_enabled", "INTEGER NOT NULL DEFAULT 1");
ensureUserColumn("reminder_time", "TEXT NOT NULL DEFAULT '20:00'");
ensureUserColumn("telegram_username", "TEXT");
ensureUserColumn("telegram_first_name", "TEXT");
ensureUserColumn("telegram_last_name", "TEXT");
ensureUserColumn("real_name", "TEXT");
ensureUserColumn("timezone", "TEXT");

const STALE_USER_COLUMNS = [
  "goal",
  "fasting_reminder_enabled",
  "fasting_reminder_time",
  "retained_jamaat_total",
  "progress_started_at",
];

/**
 * One-time structural fixup for DBs created before the habits/habit_logs pivot
 * (PIVOT_PLAN §1). ensureUserColumn above only ADDs columns, never drops the
 * old ones — so a pre-pivot `users.goal INTEGER NOT NULL` (no DEFAULT) survives
 * on an existing DB file and breaks every createUser() INSERT that doesn't
 * supply it (every registration). Idempotent: no-ops once these columns are gone.
 */
export function dropStaleUserColumns(): string[] {
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const stale = STALE_USER_COLUMNS.filter((name) => cols.some((c) => c.name === name));
  if (stale.length === 0) return stale;

  const migrate = db.transaction(() => {
    for (const name of stale) {
      db.exec(`ALTER TABLE users DROP COLUMN ${name}`);
    }
  });
  migrate();
  console.log(`db migration: dropped stale pre-pivot users column(s): ${stale.join(", ")}`);
  return stale;
}

try {
  dropStaleUserColumns();
} catch (err) {
  // db.transaction() rolls back automatically on throw, so a partial failure
  // (e.g. one of these columns unexpectedly still has an index/constraint on
  // some older file) leaves the users table exactly as it was — never half
  // migrated. Log loudly and keep booting rather than crash-looping: the bot
  // still serves everything else even if registration keeps hitting the
  // pre-existing NOT NULL error until this is investigated.
  console.error(
    `db migration: dropStaleUserColumns failed, users table left unchanged (transaction rolled back): ` +
      `${err instanceof Error ? err.message : String(err)}`,
    err
  );
}

/** Bootstrap/recovery admin from env — never the sole live auth source after seed. */
if (config.adminTelegramId !== null) {
  db.prepare("INSERT OR IGNORE INTO admins (telegram_id) VALUES (?)").run(
    config.adminTelegramId
  );
}
