import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";

// A real file (not :memory:) so the pre-wipe snapshot path is exercised too.
const dataDir = mkdtempSync(join(tmpdir(), "salawat-client-test-"));
process.env.BOT_TOKEN ??= "client-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH = join(dataDir, "salawat.db");

const { addMissingColumns, backfillRoomJoinedAt, db, dropQuantityHabits, resetForMultiRoom } =
  await import("./client.js");
const { createHabit, createRoom, createUser, getUserByTelegramId, setUserCurrentRoom } =
  await import("./repository.js");

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function tableNames(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((t) => t.name);
}

function columnNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function snapshotFiles(): string[] {
  return readdirSync(dataDir).filter((f) => f.startsWith("salawat.pre-multiroom-"));
}

/**
 * Recreate the single-tenant schema this DB had before the multi-room pivot
 * (see git show HEAD~1:bot/src/db/schema.sql) and put a registered user, a
 * habit, a log and an admin row in it — the exact contents a Railway volume
 * would carry into the migration.
 */
function seedPreMultiRoomDatabase(): void {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE IF EXISTS habit_logs;
    DROP TABLE IF EXISTS habits;
    DROP TABLE IF EXISTS room_admins;
    DROP TABLE IF EXISTS pending_registrations;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS rooms;

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      reminder_enabled INTEGER NOT NULL DEFAULT 1,
      reminder_time TEXT NOT NULL DEFAULT '20:00',
      timezone TEXT,
      telegram_username TEXT,
      telegram_first_name TEXT,
      telegram_last_name TEXT,
      real_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('quantity','binary')),
      points_weight INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE habit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      habit_id INTEGER NOT NULL REFERENCES habits(id),
      log_date TEXT NOT NULL,
      value INTEGER NOT NULL,
      points_earned INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, habit_id, log_date)
    );
    CREATE TABLE pending_registrations (
      telegram_id INTEGER PRIMARY KEY,
      step TEXT NOT NULL,
      real_name TEXT,
      nickname TEXT,
      reminder_enabled INTEGER,
      reminder_time TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE admins (
      telegram_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pending_admin_actions (
      admin_telegram_id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      target_telegram_id INTEGER NOT NULL,
      target_label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO users (telegram_id, nickname) VALUES (500000001, 'OldUser');
    INSERT INTO habits (name, type, points_weight) VALUES ('Salawat count', 'quantity', 1);
    INSERT INTO habit_logs (user_id, habit_id, log_date, value, points_earned)
      VALUES (1, 1, '2026-01-01', 10, 10);
    INSERT INTO admins (telegram_id) VALUES (500000001);
    INSERT INTO pending_admin_actions (admin_telegram_id, action, target_telegram_id, target_label)
      VALUES (500000001, 'delete_user', 500000002, 'someone');
  `);
  db.pragma("foreign_keys = ON");
}

describe("resetForMultiRoom", () => {
  it("no-ops on a database that is already multi-room", () => {
    const owner = createUser(500000009, "already-migrated");
    const room = createRoom("Kept room", "kept-room-pass", owner.id);
    setUserCurrentRoom(owner.id, room.id);

    assert.equal(resetForMultiRoom(), false);
    // Nothing was touched — the guard is what stops a redeploy wiping live data.
    assert.equal(getUserByTelegramId(500000009)?.nickname, "already-migrated");
    assert.equal(snapshotFiles().length, 0);
  });

  it("wipes a pre-multi-room database and recreates the room-scoped schema", () => {
    seedPreMultiRoomDatabase();
    assert.ok(tableNames().includes("admins"));
    assert.ok(!columnNames("habits").includes("room_id"));

    assert.equal(resetForMultiRoom(), true);

    // Retired tables are gone, room-scoped ones exist with their new columns.
    assert.ok(!tableNames().includes("admins"));
    assert.ok(!tableNames().includes("pending_admin_actions"));
    assert.ok(tableNames().includes("rooms"));
    assert.ok(tableNames().includes("room_admins"));
    assert.ok(columnNames("habits").includes("room_id"));
    assert.ok(columnNames("habits").includes("category"));
    assert.ok(columnNames("habit_logs").includes("room_id"));
    assert.ok(columnNames("users").includes("current_room_id"));
    assert.ok(columnNames("users").includes("role"));

    // No data is migrated: the old competition is gone, not folded into a room.
    for (const table of ["users", "habits", "habit_logs", "rooms", "room_admins"]) {
      const { count } = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      assert.equal(count, 0, `expected ${table} to be empty after the wipe`);
    }

    // The wiped data is still recoverable from the snapshot taken first.
    const snapshots = snapshotFiles();
    assert.equal(snapshots.length, 1);
    const snapshot = new Database(join(dataDir, snapshots[0]!), { readonly: true });
    try {
      const old = snapshot.prepare("SELECT nickname FROM users WHERE telegram_id = ?").get(500000001) as
        | { nickname: string }
        | undefined;
      assert.equal(old?.nickname, "OldUser");
    } finally {
      snapshot.close();
    }
  });

  it("is idempotent, and the fresh schema is immediately usable", () => {
    assert.equal(resetForMultiRoom(), false);

    const owner = createUser(500000002, "NewOwner");
    const room = createRoom("Fresh room", "fresh-room-pass", owner.id);
    setUserCurrentRoom(owner.id, room.id);
    const habit = createHabit(room.id, "Qur'an pages",  2, "IQ");

    assert.equal(habit.room_id, room.id);
    assert.equal(habit.category, "IQ");
    assert.equal(getUserByTelegramId(500000002)?.current_room_id, room.id);
  });

  it("also detects a pre-pivot database that has no admins table left", () => {
    seedPreMultiRoomDatabase();
    db.exec("DROP TABLE admins");
    // habits.room_id is the second, independent marker.
    assert.equal(resetForMultiRoom(), true);
    assert.ok(columnNames("habits").includes("room_id"));
  });
});

/**
 * Recreate the *first* multi-room schema — the one PR #12 shipped, before
 * registration grew an admin/participant branch and a fasting-reminder opt-in.
 * This is the shape a Railway volume already carries, so the additive migration
 * has to patch it in place without touching the rooms already in it.
 */
function seedFirstGenerationMultiRoomDatabase(): void {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE IF EXISTS habit_logs;
    DROP TABLE IF EXISTS habits;
    DROP TABLE IF EXISTS room_admins;
    DROP TABLE IF EXISTS pending_registrations;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS rooms;

    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      password TEXT NOT NULL UNIQUE,
      categories_enabled INTEGER NOT NULL DEFAULT 0,
      owner_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant',
      current_room_id INTEGER,
      reminder_enabled INTEGER NOT NULL DEFAULT 1,
      reminder_time TEXT NOT NULL DEFAULT '20:00',
      timezone TEXT,
      telegram_username TEXT,
      telegram_first_name TEXT,
      telegram_last_name TEXT,
      real_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pending_registrations (
      telegram_id INTEGER PRIMARY KEY,
      step TEXT NOT NULL,
      real_name TEXT,
      nickname TEXT,
      reminder_enabled INTEGER,
      reminder_time TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO rooms (name, password) VALUES ('Live room', 'live-room-pass');
    INSERT INTO users (telegram_id, nickname, role, current_room_id)
      VALUES (500000021, 'LiveMember', 'admin', 1);
    INSERT INTO pending_registrations (telegram_id, step, real_name)
      VALUES (500000022, 'nickname', 'Half Done');
  `);
  db.pragma("foreign_keys = ON");
}

describe("addMissingColumns", () => {
  it("adds the new registration columns to an already-multi-room database without touching its data", () => {
    seedFirstGenerationMultiRoomDatabase();
    assert.ok(!columnNames("users").includes("fasting_reminder_enabled"));
    assert.ok(!columnNames("pending_registrations").includes("role"));
    // The destructive migration must not fire on this DB — it is already
    // multi-room, and by now may hold a real room.
    assert.equal(resetForMultiRoom(), false);

    const added = addMissingColumns();

    assert.deepEqual(added, [
      "users.fasting_reminder_enabled",
      "users.fasting_reminder_time",
      "users.streak_display",
      "users.week_start_day",
      "users.room_joined_at",
      "pending_registrations.role",
      "pending_registrations.room_name",
      "pending_registrations.categories_enabled",
      "pending_registrations.room_id",
      "pending_registrations.fasting_reminder_enabled",
      "pending_registrations.fasting_reminder_time",
    ]);

    // Existing rows survive and pick up the documented defaults.
    const user = db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(500000021) as Record<string, unknown>;
    assert.equal(user.nickname, "LiveMember");
    assert.equal(user.current_room_id, 1);
    assert.equal(user.fasting_reminder_enabled, 0);
    assert.equal(user.fasting_reminder_time, "20:00");
    assert.equal(user.streak_display, "weekly");
    assert.equal(user.week_start_day, 1);
    // Added as NULL — the backfill below is what fills it in.
    assert.equal(user.room_joined_at, null);

    assert.equal(backfillRoomJoinedAt(), 1);
    const backfilled = db
      .prepare("SELECT room_joined_at, created_at FROM users WHERE telegram_id = ?")
      .get(500000021) as Record<string, unknown>;
    assert.equal(backfilled.room_joined_at, backfilled.created_at);

    const pending = db
      .prepare("SELECT * FROM pending_registrations WHERE telegram_id = ?")
      .get(500000022) as Record<string, unknown>;
    assert.equal(pending.real_name, "Half Done");
    assert.equal(pending.role, null);
    assert.equal(pending.room_id, null);

    const room = db.prepare("SELECT * FROM rooms WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(room.name, "Live room");
  });

  it("is idempotent", () => {
    assert.deepEqual(addMissingColumns(), []);
    // Every member already has a join date, so a second pass touches nothing.
    assert.equal(backfillRoomJoinedAt(), 0);
  });

  it("leaves a roomless user's room_joined_at null", () => {
    db.prepare(
      "INSERT INTO users (telegram_id, nickname, role, current_room_id) VALUES (?, ?, 'participant', NULL)"
    ).run(500000023, "BetweenRooms");

    assert.equal(backfillRoomJoinedAt(), 0);

    const roomless = db
      .prepare("SELECT room_joined_at FROM users WHERE telegram_id = ?")
      .get(500000023) as Record<string, unknown>;
    assert.equal(roomless.room_joined_at, null);
  });
});

/**
 * A multi-room DB from before habits went binary-only: `habits` and
 * `personal_habits` still carry `type`, with a mix of quantity and binary rows
 * and logs hanging off both. What a live Railway volume looks like the moment
 * dropQuantityHabits() first runs against it.
 */
function seedQuantityEraDatabase(): void {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE IF EXISTS personal_habit_logs;
    DROP TABLE IF EXISTS personal_habits;
    DROP TABLE IF EXISTS habit_logs;
    DROP TABLE IF EXISTS habits;
    DROP TABLE IF EXISTS room_admins;
    DROP TABLE IF EXISTS pending_registrations;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS rooms;
  `);
  db.exec(schemaSql());
  db.exec(`
    DROP TABLE habits;
    DROP TABLE personal_habits;
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('quantity','binary')),
      points_weight INTEGER NOT NULL,
      category TEXT CHECK (category IS NULL OR category IN ('IQ','SQ','PQ','EQ')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE personal_habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('quantity','binary')),
      category TEXT CHECK (category IS NULL OR category IN ('IQ','SQ','PQ','EQ')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO rooms (id, name, password) VALUES (1, 'Quantity room', 'quantity-room-pass');
    INSERT INTO users (id, telegram_id, nickname, current_room_id)
      VALUES (1, 500000031, 'QuantityMember', 1);

    INSERT INTO habits (id, room_id, name, type, points_weight, category)
      VALUES (1, 1, 'Pages read', 'quantity', 2, 'IQ'),
             (2, 1, 'Fasted', 'binary', 10, 'SQ');
    INSERT INTO habit_logs (user_id, habit_id, room_id, log_date, value, points_earned)
      VALUES (1, 1, 1, '2026-09-14', 7, 14),
             (1, 2, 1, '2026-09-14', 1, 10);

    INSERT INTO personal_habits (id, user_id, room_id, name, type)
      VALUES (1, 1, 1, 'Private pages', 'quantity'),
             (2, 1, 1, 'Private walk', 'binary');
    INSERT INTO personal_habit_logs (user_id, personal_habit_id, room_id, log_date, value)
      VALUES (1, 1, 1, '2026-09-14', 7),
             (1, 2, 1, '2026-09-14', 1);
  `);
  db.pragma("foreign_keys = ON");
}

function schemaSql(): string {
  return readFileSync(join(import.meta.dirname, "schema.sql"), "utf8");
}

function quantitySnapshotFiles(): string[] {
  return readdirSync(dataDir).filter((f) => f.startsWith("salawat.pre-binary-only-"));
}

describe("dropQuantityHabits", () => {
  it("deletes quantity habits and their logs, keeps binary ones, and drops the column", () => {
    seedQuantityEraDatabase();
    assert.ok(columnNames("habits").includes("type"));
    assert.ok(!columnNames("habits").includes("period"));

    assert.equal(dropQuantityHabits(), true);

    // `type` is gone from both tables; `period` and `description` have arrived.
    assert.ok(!columnNames("habits").includes("type"));
    assert.ok(columnNames("habits").includes("period"));
    assert.ok(columnNames("habits").includes("description"));
    assert.ok(!columnNames("personal_habits").includes("type"));

    // The quantity habit and its log are gone; the binary one is untouched,
    // points and category included, and defaults to the daily cadence.
    const habits = db.prepare("SELECT * FROM habits ORDER BY id").all() as Record<string, unknown>[];
    assert.equal(habits.length, 1);
    assert.equal(habits[0]!.name, "Fasted");
    assert.equal(habits[0]!.points_weight, 10);
    assert.equal(habits[0]!.category, "SQ");
    assert.equal(habits[0]!.period, "daily");
    assert.equal(habits[0]!.description, null);

    const logs = db.prepare("SELECT habit_id FROM habit_logs").all() as { habit_id: number }[];
    assert.deepEqual(logs, [{ habit_id: 2 }]);

    const personal = db
      .prepare("SELECT id, name FROM personal_habits")
      .all() as { id: number; name: string }[];
    assert.deepEqual(personal, [{ id: 2, name: "Private walk" }]);
    const personalLogs = db
      .prepare("SELECT personal_habit_id FROM personal_habit_logs")
      .all() as { personal_habit_id: number }[];
    assert.deepEqual(personalLogs, [{ personal_habit_id: 2 }]);

    // The rebuild leaves the file consistent and puts the indexes back.
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'habits'")
        .all() as { name: string }[]
    ).map((i) => i.name);
    assert.ok(indexes.includes("idx_habits_room_id"));

    // And the data it destroyed is on disk first.
    assert.equal(quantitySnapshotFiles().length, 1);
  });

  it("is a no-op the second time, and on a database that never had the column", () => {
    // Straight after the run above, `type` is gone — so this must do nothing.
    assert.equal(dropQuantityHabits(), false);
    assert.equal(quantitySnapshotFiles().length, 1);
    // Still intact: a second run must not touch the rows it left alone.
    const habits = db.prepare("SELECT name FROM habits").all() as { name: string }[];
    assert.deepEqual(habits, [{ name: "Fasted" }]);
  });
});

describe("dropQuantityHabits — a database that already has orphaned rows", () => {
  /**
   * The production failure this guards against. A long-lived database can hold
   * rows whose parent is gone — written while foreign_keys was off, which this
   * app's own migrations do. `PRAGMA foreign_key_check` with no argument audits
   * the *whole* file, so an unconditional "no violations" assertion made those
   * databases impossible to migrate and crash-looped the bot on a failure that
   * had nothing to do with the rebuild.
   */
  function seedOrphans(count: number): void {
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(
      `INSERT INTO habit_logs (user_id, habit_id, room_id, log_date, value, points_earned)
       VALUES (?, 2, 1, ?, 1, 10)`
    );
    // user 999 does not exist, and habit_logs.user_id has no ON DELETE clause.
    for (let i = 0; i < count; i++) insert.run(999, `orphan-${i}`);
    db.pragma("foreign_keys = ON");
  }

  it("migrates anyway, and leaves the orphans exactly as it found them", () => {
    seedQuantityEraDatabase();
    seedOrphans(12);

    const before = (db.pragma("foreign_key_check") as unknown[]).length;
    assert.equal(before, 12, "the seed should start out with orphans");

    // The whole point: this must not throw.
    assert.equal(dropQuantityHabits(), true);

    // The rebuild still did its job...
    assert.ok(!columnNames("habits").includes("type"));
    assert.ok(columnNames("habits").includes("period"));
    const survivors = db.prepare("SELECT name FROM habits").all() as { name: string }[];
    assert.deepEqual(survivors, [{ name: "Fasted" }]);

    // ...and the pre-existing orphans are neither repaired nor deleted. Quietly
    // dropping member history as a side effect of a schema change is not a call
    // a migration gets to make, and they are inert: every read joins or filters
    // by a live user, so nothing in the app can see them.
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM habit_logs WHERE user_id = 999").get() as { n: number })
        .n,
      12
    );
    assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 12);
  });
});
