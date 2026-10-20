import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "stats-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createPersonalHabit,
  createRoom,
  createUser,
  kickUserFromRoom,
  leaveCurrentRoom,
  setUserCurrentRoom,
  updateHabit,
  upsertHabitLog,
  upsertPersonalHabitLog,
} = await import("../../db/repository.js");
const { bestClosedWeekIndex, statsRoute, STATS_WEEKS } = await import("./stats.js");
const { getCurrentWeekBounds, shiftWeekStart } = await import("../../utils/challenge.js");
const { db } = await import("../../db/client.js");

let nextTelegramId = 960000001;
let nextRoom = 1;

function capture(): { res: Response; body: () => any } {
  let body: any;
  const res = {
    status() {
      return this;
    },
    json(value: any) {
      body = value;
      return this;
    },
  } as unknown as Response;
  return { res, body: () => body };
}

function callStats(telegramId: number): any {
  const result = capture();
  statsRoute({ telegramId } as unknown as Request, result.res);
  return result.body();
}

/** A fresh room with its owner inside, so each test starts from zero. */
function makeRoom(categoriesEnabled = false) {
  const n = nextRoom++;
  const ownerTelegramId = nextTelegramId++;
  const owner = createUser(ownerTelegramId, `stats-owner-${n}`);
  const room = createRoom(`Stats room ${n}`, `stats-room-pass-${n}`, owner.id, categoriesEnabled);
  setUserCurrentRoom(owner.id, room.id);
  return { room, owner, ownerTelegramId };
}

function addMember(roomId: number, nickname = `stats-member-${nextTelegramId}`) {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, nickname);
  setUserCurrentRoom(user.id, roomId);
  return { user, telegramId };
}

/** Pretend a habit has existed for a while, so all eight weeks are drawn. */
function backdate(habitId: number, weeksAgo = 20): void {
  db.prepare("UPDATE habits SET created_at = datetime('now', ?) WHERE id = ?").run(
    `-${weeksAgo * 7} days`,
    habitId
  );
}

const { weekStart: currentWeekStart } = getCurrentWeekBounds();
/** A day of the week `weeksAgo` weeks before the current one (0 = Monday). */
function dayOf(weeksAgo: number, weekday = 0): string {
  const monday = shiftWeekStart(currentWeekStart, -weeksAgo);
  const [y, m, d] = monday.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + weekday)).toISOString().slice(0, 10);
}

function habitIn(body: any, id: number): any {
  return body.habits.find((h: any) => h.id === id);
}

describe("GET /api/stats", () => {
  it("gives a member between rooms an empty payload", () => {
    const telegramId = nextTelegramId++;
    createUser(telegramId, "stats-roomless");
    const body = callStats(telegramId);
    assert.equal(body.room, null);
    assert.deepEqual(body.habits, []);
    assert.equal(body.weekStarts.length, STATS_WEEKS);
    assert.equal(body.weekStarts[STATS_WEEKS - 1], currentWeekStart);
  });

  it("an empty room: every habit at zero, header still filled in", () => {
    const { room, ownerTelegramId } = makeRoom();
    createHabit(room.id, "Never logged", 1);
    const body = callStats(ownerTelegramId);
    assert.equal(body.room.memberCount, 1);
    assert.equal(body.room.totalPoints, 0);
    assert.match(body.room.since, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.habits.length, 1);
    assert.equal(body.habits[0].completions, 0);
    assert.equal(body.habits[0].bestWeekIndex, null);
  });

  it("counts only the caller's room", () => {
    const a = makeRoom();
    const b = makeRoom();
    const habitA = createHabit(a.room.id, "Room A habit", 2);
    const habitB = createHabit(b.room.id, "Room B habit", 5);
    upsertHabitLog(a.owner.id, habitA.id, 1, dayOf(0));
    upsertHabitLog(b.owner.id, habitB.id, 1, dayOf(0));
    upsertHabitLog(b.owner.id, habitB.id, 1, dayOf(0, 1));

    const body = callStats(a.ownerTelegramId);
    assert.deepEqual(
      body.habits.map((h: any) => h.id),
      [habitA.id]
    );
    assert.equal(body.room.totalPoints, 2);
    assert.equal(habitIn(body, habitA.id).completions, 1);
  });

  it("excludes personal habits entirely", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Room habit", 1);
    const personal = createPersonalHabit(owner.id, room.id, "Private walk", null);
    upsertPersonalHabitLog(personal.id, 1, dayOf(0));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));

    const body = callStats(ownerTelegramId);
    assert.deepEqual(
      body.habits.map((h: any) => h.name),
      ["Room habit"]
    );
    assert.ok(!JSON.stringify(body).includes("Private walk"));
  });

  it("keeps the logs of members who left; a kicked member's are gone", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Shared", 3);
    const leaver = addMember(room.id);
    const kicked = addMember(room.id);
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));
    upsertHabitLog(leaver.user.id, habit.id, 1, dayOf(0));
    upsertHabitLog(kicked.user.id, habit.id, 1, dayOf(0));

    leaveCurrentRoom(leaver.user.id);
    kickUserFromRoom(kicked.user.id, room.id);

    const body = callStats(ownerTelegramId);
    assert.equal(body.room.memberCount, 1);
    assert.equal(habitIn(body, habit.id).completions, 2);
    assert.equal(body.room.totalPoints, 6);
  });

  it("ignores log rows whose user record no longer exists", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "With orphans", 4, null, "daily", null, null, {
      unitLabel: "min",
      amountBasic: 10,
      amountExtended: null,
    });
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));
    // Written while foreign_keys was off, as production's orphans were.
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO habit_logs (user_id, habit_id, room_id, log_date, value, points_earned, amount_logged)
       VALUES (987654321, ?, ?, ?, 1, 4, 10)`
    ).run(habit.id, room.id, dayOf(0, 1));
    db.pragma("foreign_keys = ON");

    const body = callStats(ownerTelegramId);
    const stats = habitIn(body, habit.id);
    assert.equal(stats.completions, 1);
    assert.equal(stats.estimatedAmount, 10);
    assert.equal(stats.weekly[STATS_WEEKS - 1], 1);
    assert.equal(body.room.totalPoints, 4);
  });

  it("counts a weekly habit once per member per week, however many days are marked", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Charity", 5, null, "weekly", null, null, {
      unitLabel: "times",
      amountBasic: 1,
      amountExtended: null,
    });
    backdate(habit.id);
    const other = addMember(room.id);
    upsertHabitLog(owner.id, habit.id, 1, dayOf(1, 0));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(1, 2));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(1, 6));
    upsertHabitLog(other.user.id, habit.id, 1, dayOf(1, 3));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(2, 4));

    const stats = habitIn(callStats(ownerTelegramId), habit.id);
    assert.equal(stats.completions, 3);
    assert.equal(stats.estimatedAmount, 3);
    assert.equal(stats.weekly[STATS_WEEKS - 2], 2);
    assert.equal(stats.weekly[STATS_WEEKS - 3], 1);
  });

  it("shows a deactivated habit with its history, marked inactive", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Retired", 1);
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));
    updateHabit(habit.id, { isActive: false });

    const stats = habitIn(callStats(ownerTelegramId), habit.id);
    assert.equal(stats.active, false);
    assert.equal(stats.completions, 1);
  });

  it("draws only the weeks a young habit has had", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Brand new", 1);
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));
    const stats = habitIn(callStats(ownerTelegramId), habit.id);
    assert.deepEqual(stats.weekly, [null, null, null, null, null, null, null, 1]);

    // Three weeks old: three leading weeks are real zeros, not gaps.
    backdate(habit.id, 3);
    const older = habitIn(callStats(ownerTelegramId), habit.id);
    assert.deepEqual(older.weekly, [null, null, null, null, 0, 0, 0, 1]);
  });

  it("starts the bars at the first log when it predates the habit's creation week", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Logged early", 1);
    upsertHabitLog(owner.id, habit.id, 1, dayOf(1, 6));
    const stats = habitIn(callStats(ownerTelegramId), habit.id);
    assert.deepEqual(stats.weekly.slice(5), [null, 1, 0]);
  });

  it("marks the current week and picks the best week among closed weeks only", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Busy now", 1);
    backdate(habit.id);
    for (let day = 0; day < 7; day++) upsertHabitLog(owner.id, habit.id, 1, dayOf(0, day));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(3));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(3, 1));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(5));
    upsertHabitLog(owner.id, habit.id, 1, dayOf(5, 1));

    const stats = habitIn(callStats(ownerTelegramId), habit.id);
    assert.equal(stats.currentWeekIndex, STATS_WEEKS - 1);
    assert.equal(stats.weekly[STATS_WEEKS - 1], 7, "the current week still counts");
    // Weeks 3 and 5 ago tie at 2: the more recent one wins, and the bigger
    // current week is never "best".
    assert.equal(stats.bestWeekIndex, STATS_WEEKS - 1 - 3);
  });

  it("bestClosedWeekIndex: ties to the most recent, null when every closed week is 0", () => {
    assert.equal(bestClosedWeekIndex([null, null, 0, 0, 0, 0, 0, 9]), null);
    assert.equal(bestClosedWeekIndex([3, 1, 3, 0, 0, 0, 0, 0]), 2);
    assert.equal(bestClosedWeekIndex([0, 0, 0, 0, 0, 0, 1, 0]), 6);
  });

  it("sums frozen amounts: a later amount change only affects new logs", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Quran reading", 2, null, "daily", null, 3, {
      unitLabel: "min",
      amountBasic: 30,
      amountExtended: 45,
    });
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));
    upsertHabitLog(owner.id, habit.id, 2, dayOf(0, 1));
    updateHabit(habit.id, { amountBasic: 10 });
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0, 2));

    const stats = habitIn(callStats(ownerTelegramId), habit.id);
    assert.equal(stats.unit, "min");
    assert.equal(stats.estimatedAmount, 30 + 45 + 10);
  });

  it("estimatedAmount is null for a habit with no unit", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "No unit", 1);
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));
    const stats = habitIn(callStats(ownerTelegramId), habit.id);
    assert.equal(stats.unit, null);
    assert.equal(stats.estimatedAmount, null);
  });

  it("sends categories only when the room has them enabled", () => {
    const withCategories = makeRoom(true);
    createHabit(withCategories.room.id, "Categorised", 1, "SQ");
    const on = callStats(withCategories.ownerTelegramId);
    assert.equal(on.categoriesEnabled, true);
    assert.equal(on.habits[0].category, "SQ");

    db.prepare("UPDATE rooms SET categories_enabled = 0 WHERE id = ?").run(withCategories.room.id);
    const off = callStats(withCategories.ownerTelegramId);
    assert.equal(off.categoriesEnabled, false);
    assert.equal(off.habits[0].category, null);
  });

  it("contains no user identifiers anywhere in the response", () => {
    const { room, owner, ownerTelegramId } = makeRoom();
    const habit = createHabit(room.id, "Anonymous", 1);
    const member = addMember(room.id, "very-identifiable-nickname");
    db.prepare("UPDATE users SET real_name = 'Identifiable Realname' WHERE id = ?").run(member.user.id);
    upsertHabitLog(owner.id, habit.id, 1, dayOf(0));
    upsertHabitLog(member.user.id, habit.id, 1, dayOf(0));

    const body = callStats(ownerTelegramId);
    const forbiddenKeys = /user|telegram|nickname|name_real|real_?name|member_?id|username|first_?name|last_?name/i;
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (value !== null && typeof value === "object") {
        for (const [key, v] of Object.entries(value)) {
          assert.ok(!forbiddenKeys.test(key), `identifier-like key ${path}.${key}`);
          walk(v, `${path}.${key}`);
        }
      }
    };
    walk(body, "body");

    const text = JSON.stringify(body);
    for (const needle of [
      "very-identifiable-nickname",
      "Identifiable Realname",
      String(member.telegramId),
      String(ownerTelegramId),
    ]) {
      assert.ok(!text.includes(needle), `response leaks ${needle}`);
    }
    // Only the documented keys, so a new field has to be added here on purpose.
    assert.deepEqual(Object.keys(body).sort(), ["categoriesEnabled", "habits", "room", "weekStarts"]);
    assert.deepEqual(Object.keys(body.room).sort(), ["memberCount", "since", "totalPoints"]);
    assert.deepEqual(Object.keys(body.habits[0]).sort(), [
      "active",
      "bestWeekIndex",
      "category",
      "completions",
      "currentWeekIndex",
      "estimatedAmount",
      "id",
      "name",
      "unit",
      "weekly",
    ]);
  });
});
