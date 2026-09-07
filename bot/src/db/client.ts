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
ensureUserColumn("reminder_time", "TEXT");
ensureUserColumn("fasting_reminder_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureUserColumn("fasting_reminder_time", "TEXT NOT NULL DEFAULT '20:00'");
ensureUserColumn("telegram_username", "TEXT");
ensureUserColumn("telegram_first_name", "TEXT");
ensureUserColumn("telegram_last_name", "TEXT");
ensureUserColumn("real_name", "TEXT");
ensureUserColumn("retained_jamaat_total", "INTEGER NOT NULL DEFAULT 0");
ensureUserColumn("progress_started_at", "TEXT");

/** Bootstrap/recovery admin from env — never the sole live auth source after seed. */
if (config.adminTelegramId !== null) {
  db.prepare("INSERT OR IGNORE INTO admins (telegram_id) VALUES (?)").run(
    config.adminTelegramId
  );
}
