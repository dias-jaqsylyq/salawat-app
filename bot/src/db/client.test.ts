import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "client-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { db, dropStaleUserColumns } = await import("./client.js");
const { createHabit, createUser, getUserByTelegramId } = await import("./repository.js");

function columnNames(): string[] {
  return (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
}

describe("dropStaleUserColumns", () => {
  it(
    "drops pre-pivot columns, keeps existing rows and FKs intact, and unblocks new registrations",
    () => {
      // Simulate a Railway volume created before the habits/habit_logs pivot
      // (PIVOT_PLAN §1): the old users table carried these columns, including
      // `goal` — see git show caf5693:bot/src/db/schema.sql. Using a DEFAULT
      // here (unlike the real pre-pivot NOT NULL-with-no-default `goal`) is
      // just to satisfy SQLite's ALTER TABLE ADD COLUMN restriction on an
      // already-populated table — dropStaleUserColumns only keys off column
      // *name*, so this doesn't weaken what's being verified.
      db.exec(`
        ALTER TABLE users ADD COLUMN goal INTEGER NOT NULL DEFAULT 500;
        ALTER TABLE users ADD COLUMN fasting_reminder_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN fasting_reminder_time TEXT NOT NULL DEFAULT '20:00';
        ALTER TABLE users ADD COLUMN retained_jamaat_total INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN progress_started_at TEXT;
      `);
      assert.ok(columnNames().includes("goal"));

      // A pre-existing registered user and a habit log referencing them, so we
      // can confirm the migration doesn't disturb existing data or the FK.
      const oldUser = createUser(500000001, "OldUser");
      const habit = createHabit("Salawat count", "quantity", 1);
      db.prepare(
        "INSERT INTO habit_logs (user_id, habit_id, log_date, value, points_earned) VALUES (?, ?, ?, ?, ?)"
      ).run(oldUser.id, habit.id, "2026-01-01", 10, 10);

      const dropped = dropStaleUserColumns();
      assert.deepEqual(
        [...dropped].sort(),
        [
          "fasting_reminder_time",
          "fasting_reminder_enabled",
          "goal",
          "progress_started_at",
          "retained_jamaat_total",
        ].sort()
      );

      for (const name of dropped) {
        assert.ok(!columnNames().includes(name), `expected ${name} to be dropped`);
      }

      // Existing data survived, and the FK join into habit_logs still resolves.
      assert.equal(getUserByTelegramId(500000001)?.nickname, "OldUser");
      const joined = db
        .prepare(
          "SELECT u.nickname, hl.value FROM habit_logs hl JOIN users u ON u.id = hl.user_id WHERE u.telegram_id = ?"
        )
        .get(500000001) as { nickname: string; value: number };
      assert.deepEqual(joined, { nickname: "OldUser", value: 10 });

      // The exact reported case: a fresh registration that previously hit
      // "NOT NULL constraint failed: users.goal" now succeeds.
      createUser(7171181415, "Cr7");
      assert.equal(getUserByTelegramId(7171181415)?.nickname, "Cr7");

      // Idempotent: nothing left to drop on a second run.
      assert.deepEqual(dropStaleUserColumns(), []);
    }
  );
});
