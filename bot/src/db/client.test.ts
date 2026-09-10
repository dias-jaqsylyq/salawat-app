import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";

// A real file (not :memory:) so the pre-wipe snapshot path is exercised too.
const dataDir = mkdtempSync(join(tmpdir(), "salawat-client-test-"));
process.env.BOT_TOKEN ??= "client-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH = join(dataDir, "salawat.db");

const { db, resetForMultiRoom } = await import("./client.js");
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
    const habit = createHabit(room.id, "Qur'an pages", "quantity", 2, "IQ");

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
