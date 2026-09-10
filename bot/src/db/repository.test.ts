import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "test-token";
process.env.CHALLENGE_START_DATE ??= "2026-08-01";
process.env.CHALLENGE_END_DATE ??= "2026-09-01";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  computePoints,
  createHabit,
  createUser,
  deactivateHabit,
  deleteHabitLog,
  getHabitById,
  getHabitStreak,
  getJamaatTotal,
  getUserHabitLogsForDate,
  getUserTotalPoints,
  listHabits,
  updateHabit,
  upsertHabitLog,
} = await import("./repository.js");
const { db } = await import("./client.js");

let nextTelegramId = 600000001;
function makeUser(): number {
  const user = createUser(nextTelegramId++, `tester-${nextTelegramId}`);
  return user.id;
}

describe("computePoints", () => {
  it("quantity: value * points_weight", () => {
    assert.equal(computePoints({ type: "quantity", points_weight: 10 }, 5), 50);
    assert.equal(computePoints({ type: "quantity", points_weight: 3 }, 0), 0);
  });

  it("binary: flat points_weight regardless of value", () => {
    assert.equal(computePoints({ type: "binary", points_weight: 20 }, 1), 20);
    // Binary points never scale with value, even if a caller passed something odd.
    assert.equal(computePoints({ type: "binary", points_weight: 20 }, 5), 20);
  });
});

describe("upsertHabitLog", () => {
  it("freezes points_earned for a quantity habit at write time", () => {
    const userId = makeUser();
    const habit = createHabit("Salawat count", "quantity", 2);

    const log = upsertHabitLog(userId, habit.id, 15, "2026-08-14");

    assert.equal(log.value, 15);
    assert.equal(log.points_earned, 30);
    assert.equal(log.log_date, "2026-08-14");
  });

  it("freezes flat points_earned for a binary habit", () => {
    const userId = makeUser();
    const habit = createHabit("Fasted today", "binary", 25);

    const log = upsertHabitLog(userId, habit.id, 1, "2026-08-14");

    assert.equal(log.points_earned, 25);
  });

  it("upserts on the same day: overwrites rather than accumulates", () => {
    const userId = makeUser();
    const habit = createHabit("Quran pages", "quantity", 5);

    upsertHabitLog(userId, habit.id, 3, "2026-08-14");
    const second = upsertHabitLog(userId, habit.id, 10, "2026-08-14");

    const rows = db
      .prepare("SELECT * FROM habit_logs WHERE user_id = ? AND habit_id = ?")
      .all(userId, habit.id) as { value: number; points_earned: number }[];

    assert.equal(rows.length, 1);
    assert.equal(second.value, 10);
    assert.equal(second.points_earned, 50);
    assert.equal(getUserTotalPoints(userId), 50);
  });
});

describe("habit weight changes are not retroactive", () => {
  it("keeps an already-logged day's points frozen after the habit's weight changes", () => {
    const userId = makeUser();
    const habit = createHabit("Dhikr count", "quantity", 10);

    const day1 = upsertHabitLog(userId, habit.id, 5, "2026-08-14");
    assert.equal(day1.points_earned, 50);

    updateHabit(habit.id, { pointsWeight: 100 });

    const day2 = upsertHabitLog(userId, habit.id, 5, "2026-08-15");
    assert.equal(day2.points_earned, 500);

    const day1Reloaded = db
      .prepare("SELECT points_earned FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?")
      .get(userId, habit.id, "2026-08-14") as { points_earned: number };
    assert.equal(day1Reloaded.points_earned, 50);

    assert.equal(getUserTotalPoints(userId), 550);
  });
});

describe("habit CRUD", () => {
  it("creates, lists (active-only vs all), and deactivates habits", () => {
    const active = createHabit("Prayed Fajr in jamaat", "binary", 15);
    const toDeactivate = createHabit("Old habit", "binary", 5);

    assert.equal(getHabitById(active.id)?.is_active, 1);

    const deactivated = deactivateHabit(toDeactivate.id);
    assert.equal(deactivated.is_active, 0);

    const activeOnly = listHabits({ activeOnly: true }).map((h) => h.id);
    assert.ok(activeOnly.includes(active.id));
    assert.ok(!activeOnly.includes(toDeactivate.id));

    const all = listHabits().map((h) => h.id);
    assert.ok(all.includes(active.id));
    assert.ok(all.includes(toDeactivate.id));
  });
});

describe("getHabitStreak", () => {
  it("counts consecutive logged days and stops at a gap", () => {
    const userId = makeUser();
    const habit = createHabit("Qiyam al-layl", "binary", 30);

    upsertHabitLog(userId, habit.id, 1, "2026-08-12");
    upsertHabitLog(userId, habit.id, 1, "2026-08-13");
    upsertHabitLog(userId, habit.id, 1, "2026-08-14");
    // 2026-08-11 intentionally skipped, breaking the streak beyond the 12th.

    assert.equal(getHabitStreak(userId, habit.id, "2026-08-14"), 3);
    assert.equal(getHabitStreak(userId, habit.id, "2026-08-15"), 0);
  });
});

describe("deleteHabitLog", () => {
  it("removes the row so the day drops out of the streak and today's totals", () => {
    const userId = makeUser();
    const habit = createHabit("Qiyam al-layl", "binary", 30);

    upsertHabitLog(userId, habit.id, 1, "2026-08-12");
    upsertHabitLog(userId, habit.id, 1, "2026-08-13");
    upsertHabitLog(userId, habit.id, 1, "2026-08-14");
    assert.equal(getHabitStreak(userId, habit.id, "2026-08-14"), 3);
    assert.equal(getUserTotalPoints(userId), 90);

    deleteHabitLog(userId, habit.id, "2026-08-14");

    assert.equal(getHabitStreak(userId, habit.id, "2026-08-14"), 0);
    assert.equal(getUserTotalPoints(userId), 60);
    assert.equal(getUserHabitLogsForDate(userId, "2026-08-14").has(habit.id), false);
  });

  it("is a no-op when there is no log for that day", () => {
    const userId = makeUser();
    const habit = createHabit("Qiyam al-layl", "binary", 30);

    assert.doesNotThrow(() => deleteHabitLog(userId, habit.id, "2026-08-14"));
    assert.equal(getUserTotalPoints(userId), 0);
  });
});

describe("getJamaatTotal / getUserTotalPoints", () => {
  it("sums points across all users' habit logs", () => {
    const alice = makeUser();
    const bob = makeUser();
    const habit = createHabit("Sadaqah given", "binary", 40);

    upsertHabitLog(alice, habit.id, 1, "2026-08-14");
    upsertHabitLog(bob, habit.id, 1, "2026-08-14");

    assert.equal(getUserTotalPoints(alice), 40);
    assert.equal(getUserTotalPoints(bob), 40);
    assert.ok(getJamaatTotal() >= 80);
  });
});
