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
 * Snapshot the DB file next to itself before a destructive migration. Returns
 * the path, or null when there is nothing on disk to copy (`:memory:` in tests,
 * or a first boot). Deliberately NOT the rolling scheduler backup path — that
 * one gets overwritten every few hours, and this snapshot is the only copy of
 * the data the migration is about to rewrite.
 */
function snapshotDb(label: string): string | null {
  if (config.dbPath === ":memory:" || !existsSync(config.dbPath)) return null;
  // Fold the WAL into the main file first, so the plain file copy is complete.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dirname(config.dbPath), `salawat.${label}-${stamp}.db`);
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

  const snapshot = snapshotDb("pre-multiroom");
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

/**
 * Columns added to already-multi-room databases after the initial multi-room
 * schema shipped. resetForMultiRoom() only fires on a *pre*-multi-room file, so
 * a DB created by the first multi-room deploy needs these added in place —
 * additively, never by dropping anything, since by now a room may hold real
 * data. Each entry is the exact column definition from schema.sql.
 *
 * Idempotent: a column already present is skipped, so this is a no-op on a
 * fresh DB (schema.sql creates them) and on an already-migrated one.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  // Registration collects a fasting-reminder opt-in alongside the daily one
  // (PRD §2); the cron that acts on it lands later.
  {
    table: "users",
    column: "fasting_reminder_enabled",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "users",
    column: "fasting_reminder_time",
    definition: "TEXT NOT NULL DEFAULT '20:00'",
  },
  // Per-user streak display preference and the calendar week it draws from.
  // The CHECK constraints schema.sql carries cannot come along (see below); the
  // PATCH /api/profile validation is what enforces them on a migrated DB.
  {
    table: "users",
    column: "streak_display",
    definition: "TEXT NOT NULL DEFAULT 'weekly'",
  },
  {
    table: "users",
    column: "week_start_day",
    definition: "INTEGER NOT NULL DEFAULT 1",
  },
  // The admin's free-text goal line, and the day-or-week scoring unit. Normally
  // created by dropQuantityHabits()'s table rebuild or by schema.sql on a fresh
  // DB; listed here as the additive path for a DB that somehow has neither.
  // period's CHECK cannot come along (see below) — createHabitRoute validates it.
  { table: "habits", column: "description", definition: "TEXT" },
  { table: "habits", column: "period", definition: "TEXT NOT NULL DEFAULT 'daily'" },
  // Backfilled from created_at for everyone already in a room — see
  // backfillRoomJoinedAt().
  { table: "users", column: "room_joined_at", definition: "TEXT" },
  // The admin-vs-participant registration branch (PRD §2) parks its answers in
  // pending_registrations until finalize.
  { table: "pending_registrations", column: "role", definition: "TEXT" },
  { table: "pending_registrations", column: "room_name", definition: "TEXT" },
  { table: "pending_registrations", column: "categories_enabled", definition: "INTEGER" },
  { table: "pending_registrations", column: "room_id", definition: "INTEGER" },
  { table: "pending_registrations", column: "fasting_reminder_enabled", definition: "INTEGER" },
  { table: "pending_registrations", column: "fasting_reminder_time", definition: "TEXT" },
];

/**
 * Add any missing column from ADDED_COLUMNS. Returns the ones actually added.
 *
 * ALTER TABLE ADD COLUMN cannot express the CHECK constraints schema.sql puts on
 * pending_registrations.role, users.streak_display and users.week_start_day —
 * SQLite has no ADD CONSTRAINT. A migrated DB therefore enforces those in the
 * application layer only, which is where the registration flow and
 * PATCH /api/profile validate them anyway; a fresh DB gets the CHECKs from
 * schema.sql.
 */
export function addMissingColumns(): string[] {
  const added: string[] = [];
  for (const { table, column, definition } of ADDED_COLUMNS) {
    if (!tableExists(table)) continue;
    if (columnNames(table).includes(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    added.push(`${table}.${column}`);
  }
  return added;
}

/**
 * The CREATE TABLE statement schema.sql carries for one table, verbatim. Used
 * by the rebuild below so the new table can never drift from the schema file —
 * there is exactly one definition of `habits`, and it lives in schema.sql.
 */
function createTableStatement(table: string): string {
  const match = schema.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`)
  );
  if (!match) {
    throw new Error(`schema.sql has no CREATE TABLE for ${table}`);
  }
  return match[0];
}

/**
 * Rebuild one table from its current schema.sql definition, carrying over every
 * column the two shapes share and letting the rest take their declared default.
 * The SQLite "12-step ALTER TABLE" procedure, which is what dropping a column
 * mentioned in a CHECK constraint requires — plain ALTER TABLE DROP COLUMN
 * refuses those outright.
 *
 * Caller holds `foreign_keys = OFF` and `legacy_alter_table = ON`: the first so
 * the DROP does not cascade into habit_logs, the second so the RENAME is a
 * plain rename instead of rewriting references in other tables (habit_logs
 * already says REFERENCES habits(id), which is exactly where we want it to
 * point once the rename lands).
 */
function rebuildTableFromSchema(table: string): void {
  const tmp = `${table}__rebuild`;
  const before = columnNames(table);

  db.exec(
    createTableStatement(table).replace(
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      `CREATE TABLE ${tmp} (`
    )
  );
  // Columns only the new shape has (period, description) are left out of the
  // INSERT so they take their DEFAULT; columns only the old shape has (type)
  // are dropped on the floor, which is the whole point.
  const carried = columnNames(tmp).filter((column) => before.includes(column));
  const list = carried.join(", ");
  db.exec(`INSERT INTO ${tmp} (${list}) SELECT ${list} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
}

/**
 * Retire the 'quantity' habit type (every habit is done-or-not now).
 *
 * Quantity habits and their logs are deleted rather than converted: a count is
 * not a yes/no, so there is no honest binary reading of "7 pages", and the only
 * rooms that ever created one were testing. Their *points* go with them, which
 * is why this snapshots the file first.
 *
 * Then `type` itself is dropped from habits and personal_habits, by rebuilding
 * both from schema.sql — which is also what gives already-live rooms the new
 * `period` and `description` columns.
 *
 * Idempotent: keyed on `type` still existing, so it no-ops on a fresh DB (where
 * schema.sql never created the column) and on every boot after the first.
 * Returns true when it actually rewrote something.
 */
export function dropQuantityHabits(): boolean {
  const habitsHasType = tableExists("habits") && columnNames("habits").includes("type");
  const personalHasType =
    tableExists("personal_habits") && columnNames("personal_habits").includes("type");
  if (!habitsHasType && !personalHasType) return false;

  const snapshot = snapshotDb("pre-binary-only");
  console.warn(
    `db migration: retiring the 'quantity' habit type — DELETING every quantity ` +
      `habit and its logs, then dropping habits.type/personal_habits.type. ` +
      (snapshot ? `Snapshot of the old data: ${snapshot}` : `No file snapshot taken (${config.dbPath}).`)
  );

  // PRAGMA foreign_keys is a no-op inside a transaction, so both toggles have to
  // happen out here. See rebuildTableFromSchema for why each one is needed.
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  let deletedHabits = 0;
  let deletedLogs = 0;
  try {
    const migrate = db.transaction(() => {
      if (habitsHasType) {
        deletedLogs += db
          .prepare(
            `DELETE FROM habit_logs
             WHERE habit_id IN (SELECT id FROM habits WHERE type = 'quantity')`
          )
          .run().changes;
        deletedHabits += db.prepare(`DELETE FROM habits WHERE type = 'quantity'`).run().changes;
        rebuildTableFromSchema("habits");
      }
      if (personalHasType) {
        // Explicit, even though the FK says ON DELETE CASCADE: foreign keys are
        // off for the rebuild, so nothing would cascade.
        deletedLogs += db
          .prepare(
            `DELETE FROM personal_habit_logs
             WHERE personal_habit_id IN (SELECT id FROM personal_habits WHERE type = 'quantity')`
          )
          .run().changes;
        deletedHabits += db
          .prepare(`DELETE FROM personal_habits WHERE type = 'quantity'`)
          .run().changes;
        rebuildTableFromSchema("personal_habits");
      }
      // Every index the DROPs took with them is `IF NOT EXISTS`, so replaying
      // the schema puts them back and touches nothing else.
      db.exec(schema);

      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        // Inside the transaction on purpose: throwing rolls the whole rebuild
        // back rather than leaving a half-migrated file behind.
        throw new Error(
          `foreign_key_check found ${violations.length} violation(s) after the rebuild`
        );
      }
    });
    migrate();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }

  console.warn(
    `db migration: 'quantity' retired — deleted ${deletedHabits} habit(s) and ` +
      `${deletedLogs} log(s); habits/personal_habits rebuilt without \`type\`.`
  );
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

// Then retire 'quantity'. Has to come after db.exec(schema) (it reads the file
// for the table definitions it rebuilds from) and before addMissingColumns()
// (its rebuild is what gives a live DB `period` and `description`, so the
// additive path below finds them already there).
try {
  dropQuantityHabits();
} catch (err) {
  // Fatal, like resetForMultiRoom: the app assumes binary-only habits, so
  // booting on a DB that still has quantity rows would score them wrong. The
  // transaction has already rolled the rebuild back, and the pre-migration
  // snapshot is on disk either way.
  console.error(
    `db migration: dropQuantityHabits failed, database left unchanged ` +
      `(transaction rolled back): ${err instanceof Error ? err.message : String(err)}`,
    err
  );
  throw err;
}

/**
 * Give every current room member a room_joined_at. Members who predate the
 * column have no record of when they joined, so their registration date is the
 * closest honest answer — and for the common case (registered straight into the
 * room they are still in) it is the exact one. Only ever fills NULLs, so a real
 * join timestamp is never overwritten, and a user between rooms keeps NULL.
 *
 * Idempotent: a no-op once every member has one.
 */
export function backfillRoomJoinedAt(): number {
  if (!tableExists("users")) return 0;
  if (!columnNames("users").includes("room_joined_at")) return 0;
  const result = db
    .prepare(
      `UPDATE users SET room_joined_at = created_at
       WHERE room_joined_at IS NULL AND current_room_id IS NOT NULL`
    )
    .run();
  return result.changes;
}

// Then top up any column that a DB created by an earlier multi-room deploy is
// missing. Runs after db.exec(schema) so the tables it patches always exist.
const addedColumns = addMissingColumns();
if (addedColumns.length > 0) {
  console.warn(`db migration: added missing columns: ${addedColumns.join(", ")}`);
}

const backfilledJoins = backfillRoomJoinedAt();
if (backfilledJoins > 0) {
  console.warn(
    `db migration: backfilled users.room_joined_at from created_at for ${backfilledJoins} member(s).`
  );
}
