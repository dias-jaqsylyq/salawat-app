import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "extended-level-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  getHabitById,
  getHabitStreak,
  getUserByTelegramId,
  getUserTotalPoints,
  setUserCurrentRoom,
  updateHabit,
} = await import("../../db/repository.js");
const { deleteHabitLogRoute, habitLogWindowRoute, listHabitsRoute, logHabitRoute } = await import(
  "./habits.js"
);
const { createHabitRoute, patchHabitRoute } = await import("./adminHabits.js");
const {
  createPersonalHabitRoute,
  logPersonalHabitRoute,
  patchPersonalHabitRoute,
  personalHabitLogWindowRoute,
} = await import("./personalHabits.js");
const { leaderboardRoute } = await import("./leaderboard.js");
const { getCurrentWeekBounds, getDayKeyInTimezone, shiftWeekStart } = await import(
  "../../utils/challenge.js"
);
const { db } = await import("../../db/client.js");

function call(
  route: (req: Request, res: Response) => void,
  req: Record<string, unknown>
): { status: number; body: any } {
  let status = 200;
  let body: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: any) {
      body = value;
      return this;
    },
  } as unknown as Response;
  route({ query: {}, params: {}, body: {}, ...req } as unknown as Request, res);
  return { status, body };
}

function log(telegramId: number, habitId: number, body: unknown = {}, date?: string) {
  return call(logHabitRoute, {
    telegramId,
    params: { id: String(habitId) },
    body,
    query: date === undefined ? {} : { date },
  });
}

function unlog(telegramId: number, habitId: number, date?: string) {
  return call(deleteHabitLogRoute, {
    telegramId,
    params: { id: String(habitId) },
    query: date === undefined ? {} : { date },
  });
}

function windowRow(telegramId: number, habitId: number, date?: string) {
  const { body } = call(habitLogWindowRoute, {
    telegramId,
    query: date === undefined ? {} : { date },
  });
  return body.habits.find((h: any) => h.habitId === habitId);
}

const today = getDayKeyInTimezone();
const { weekStart } = getCurrentWeekBounds();
const LAST_WEEK = shiftWeekStart(weekStart, -1);
const TWO_WEEKS_AGO = shiftWeekStart(weekStart, -2);
const TOO_OLD_WEEK = shiftWeekStart(weekStart, -3);

let nextTelegramId = 760000001;
const room = (() => {
  const owner = createUser(nextTelegramId++, "ext-room-owner");
  return createRoom("Extended room", "extended-room-pass", owner.id);
})();

function makeUser(backfillable = true): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `ext-tester-${telegramId}`);
  setUserCurrentRoom(user.id, room.id);
  if (backfillable) {
    db.prepare("UPDATE users SET room_joined_at = '2000-01-01 00:00:00' WHERE id = ?").run(user.id);
  }
  return telegramId;
}

/**
 * Reading 30 min = 1 pt, 45 min = 2 pts. Backdated so the whole window is
 * open, and extended_from moved to `extendedFrom` as if the admin had switched
 * Extended on that day.
 */
function makeReading(extendedFrom: string = TWO_WEEKS_AGO, base = 1, extended = 2) {
  const habit = createHabit(room.id, "Reading", base, null, "daily", "30 min, 45 min for two points", extended);
  db.prepare("UPDATE habits SET created_at = '2000-01-01 00:00:00', extended_from = ? WHERE id = ?").run(
    extendedFrom,
    habit.id
  );
  return getHabitById(habit.id)!;
}

function pointsOf(telegramId: number): number {
  return getUserTotalPoints(getUserByTelegramId(telegramId)!.id);
}

describe("daily habit with two levels — logging", () => {
  it("switches a day Basic -> Extended -> Basic, rewriting only that day's points", () => {
    const telegramId = makeUser();
    const habit = makeReading();

    assert.equal(log(telegramId, habit.id, {}, LAST_WEEK).body.points, 1); // another day
    const basic = log(telegramId, habit.id, { level: "basic" });
    assert.equal(basic.status, 200);
    assert.equal(basic.body.level, "basic");
    assert.equal(basic.body.points, 1);
    assert.equal(pointsOf(telegramId), 2);

    const extended = log(telegramId, habit.id, { level: "extended" });
    assert.equal(extended.status, 200);
    assert.equal(extended.body.level, "extended");
    assert.equal(extended.body.value, 2);
    assert.equal(extended.body.points, 2, "extended is the total, not base + extended");
    assert.equal(pointsOf(telegramId), 3);

    // Still one row for the day.
    const user = getUserByTelegramId(telegramId)!;
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?")
      .get(user.id, habit.id, today) as { n: number };
    assert.equal(rows.n, 1);

    assert.equal(log(telegramId, habit.id, { level: "basic" }).body.points, 1);
    assert.equal(pointsOf(telegramId), 2);
    // The other day never moved.
    assert.equal(windowRow(telegramId, habit.id, LAST_WEEK).points, 1);
  });

  it("unlogs via DELETE (tapping the selected level), from either level", () => {
    const telegramId = makeUser();
    const habit = makeReading();
    log(telegramId, habit.id, { level: "extended" });
    assert.equal(unlog(telegramId, habit.id).status, 200);
    const row = windowRow(telegramId, habit.id);
    assert.equal(row.logged, false);
    assert.equal(row.level, null);
    assert.equal(pointsOf(telegramId), 0);
  });

  it("counts any level as done for the streak", () => {
    const telegramId = makeUser();
    const habit = makeReading();
    log(telegramId, habit.id, { level: "extended" });
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(getHabitStreak(user.id, habit.id, today), 1);
  });

  it("an old client posting {} or {value: 1} still logs Basic", () => {
    const telegramId = makeUser();
    const habit = makeReading();
    assert.equal(log(telegramId, habit.id, {}).body.level, "basic");
    assert.equal(log(telegramId, habit.id, { value: 1 }).body.points, 1);
  });

  it("exposes extendedPoints, the logged level and per-day availability", () => {
    const telegramId = makeUser();
    const habit = makeReading(LAST_WEEK);
    log(telegramId, habit.id, { level: "extended" });

    const listed = call(listHabitsRoute, { telegramId }).body.find((h: any) => h.id === habit.id);
    assert.equal(listed.extendedPoints, 2);
    assert.equal(listed.pointsWeight, 1);

    const row = windowRow(telegramId, habit.id);
    assert.equal(row.extendedPoints, 2);
    assert.equal(row.extendedAvailable, true);
    assert.equal(row.level, "extended");
    assert.equal(row.points, 2);

    assert.equal(windowRow(telegramId, habit.id, TWO_WEEKS_AGO).extendedAvailable, false);
  });
});

describe("extended_from — Extended only on or after the day it was switched on", () => {
  it("rejects Extended before extended_from, accepts it on and after", () => {
    const telegramId = makeUser();
    const habit = makeReading(LAST_WEEK);

    const before = log(telegramId, habit.id, { level: "extended" }, TWO_WEEKS_AGO);
    assert.equal(before.status, 400);
    assert.equal(before.body.error, "extended_not_available_yet");
    // Basic is still fine that day.
    assert.equal(log(telegramId, habit.id, { level: "basic" }, TWO_WEEKS_AGO).status, 200);

    assert.equal(log(telegramId, habit.id, { level: "extended" }, LAST_WEEK).body.points, 2);
    assert.equal(log(telegramId, habit.id, { level: "extended" }).body.points, 2);
  });

  it("is set to today when an admin enables Extended, kept on a points edit, reset on off/on", () => {
    const admin = makeUser();
    const created = call(createHabitRoute, {
      telegramId: admin,
      body: { name: "Reading 2", pointsWeight: 1, extendedPoints: 2 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.extendedPoints, 2);
    assert.equal(created.body.extendedFrom, today);
    const id = created.body.id;
    const patch = (body: unknown) =>
      call(patchHabitRoute, { telegramId: admin, params: { id: String(id) }, body });

    // Pretend it was enabled long ago; editing the points must keep that date.
    db.prepare("UPDATE habits SET extended_from = ? WHERE id = ?").run(TWO_WEEKS_AGO, id);
    const edited = patch({ extendedPoints: 3 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.extendedPoints, 3);
    assert.equal(edited.body.extendedFrom, TWO_WEEKS_AGO);
    // So does an unrelated edit.
    assert.equal(patch({ description: "45 min" }).body.extendedFrom, TWO_WEEKS_AGO);

    const off = patch({ extendedPoints: null });
    assert.equal(off.body.extendedPoints, null);
    assert.equal(off.body.extendedFrom, null);

    const on = patch({ extendedPoints: 2 });
    assert.equal(on.body.extendedFrom, today, "re-enabling starts a fresh date");

    // Backend enforces it, not just the UI: last week is now before extended_from.
    db.prepare("UPDATE habits SET created_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
    const member = makeUser();
    if (LAST_WEEK < today) {
      const early = log(member, id, { level: "extended" }, LAST_WEEK);
      assert.equal(early.body.error, "extended_not_available_yet");
    }
    assert.equal(log(member, id, { level: "extended" }).body.points, 2);
  });
});

describe("Extended — rejection cases and existing limits", () => {
  it("rejects Extended on a habit without a second level", () => {
    const telegramId = makeUser();
    const habit = createHabit(room.id, "Single", 1);
    const { status, body } = log(telegramId, habit.id, { level: "extended" });
    assert.equal(status, 400);
    assert.equal(body.error, "no_extended_level");
  });

  it("rejects Extended on a weekly habit, even one that somehow carries extended_points", () => {
    const telegramId = makeUser();
    const habit = createHabit(room.id, "Weekly", 3, null, "weekly");
    db.prepare("UPDATE habits SET extended_points = 5, extended_from = ? WHERE id = ?").run(
      TWO_WEEKS_AGO,
      habit.id
    );
    const { status, body } = log(telegramId, habit.id, { level: "extended" });
    assert.equal(status, 400);
    assert.equal(body.error, "extended_level_not_allowed");
    // Basic on the weekly habit is unchanged.
    assert.equal(log(telegramId, habit.id, {}).body.points, 3);
  });

  it("rejects an unknown level", () => {
    const telegramId = makeUser();
    const habit = makeReading();
    assert.equal(log(telegramId, habit.id, { level: "max" }).body.error, "invalid_level");
    assert.equal(log(telegramId, habit.id, { level: 2 }).body.error, "invalid_level");
  });

  it("keeps the window, join-date, creation-date and inactive limits for Extended", () => {
    const habit = makeReading(TOO_OLD_WEEK);
    const member = makeUser();
    assert.equal(
      log(member, habit.id, { level: "extended" }, TOO_OLD_WEEK).body.error,
      "date_out_of_window"
    );

    // Joined today: nothing before today.
    const newcomer = makeUser(false);
    if (LAST_WEEK < today) {
      assert.equal(
        log(newcomer, habit.id, { level: "extended" }, LAST_WEEK).body.error,
        "date_out_of_window"
      );
    }

    // Habit created today: nothing before today, whatever extended_from says.
    const fresh = createHabit(room.id, "Fresh", 1, null, "daily", null, 2);
    db.prepare("UPDATE habits SET extended_from = ? WHERE id = ?").run(TWO_WEEKS_AGO, fresh.id);
    if (LAST_WEEK < today) {
      assert.equal(
        log(member, fresh.id, { level: "extended" }, LAST_WEEK).body.error,
        "date_out_of_window"
      );
    }

    updateHabit(habit.id, { isActive: false });
    assert.equal(log(member, habit.id, { level: "extended" }).body.error, "habit_inactive");
  });

  it("disabling Extended later keeps existing level-2 logs done with their points", () => {
    const telegramId = makeUser();
    const habit = makeReading();
    log(telegramId, habit.id, { level: "extended" }, LAST_WEEK);
    updateHabit(habit.id, { extendedPoints: null });

    const row = windowRow(telegramId, habit.id, LAST_WEEK);
    assert.equal(row.logged, true);
    assert.equal(row.level, "extended");
    assert.equal(row.points, 2);
    assert.equal(row.extendedPoints, null);
    assert.equal(row.extendedAvailable, false);
    assert.equal(pointsOf(telegramId), 2);

    assert.equal(log(telegramId, habit.id, { level: "extended" }).body.error, "no_extended_level");
  });

  it("an admin points change is not retroactive", () => {
    const telegramId = makeUser();
    const habit = makeReading();
    log(telegramId, habit.id, { level: "extended" }, LAST_WEEK);
    updateHabit(habit.id, { pointsWeight: 2, extendedPoints: 5 });
    assert.equal(windowRow(telegramId, habit.id, LAST_WEEK).points, 2);
    assert.equal(log(telegramId, habit.id, { level: "extended" }).body.points, 5);
  });
});

describe("admin habit form — extendedPoints validation", () => {
  const admin = makeUser();
  const create = (body: Record<string, unknown>) =>
    call(createHabitRoute, { telegramId: admin, body: { name: "H", pointsWeight: 2, ...body } });

  it("rejects extended below base, a non-integer, and any weekly habit", () => {
    assert.equal(create({ extendedPoints: 1 }).body.error, "extended_points_below_base");
    assert.equal(create({ extendedPoints: 2.5 }).body.error, "invalid_extended_points");
    assert.equal(create({ extendedPoints: "3" }).body.error, "invalid_extended_points");
    assert.equal(
      create({ period: "weekly", extendedPoints: 3 }).body.error,
      "extended_level_not_allowed"
    );
    // extended == base is allowed (the rule is >=).
    assert.equal(create({ extendedPoints: 2 }).status, 201);
  });

  it("single-level by default", () => {
    const created = create({});
    assert.equal(created.body.extendedPoints, null);
    assert.equal(created.body.extendedFrom, null);
  });

  it("checks extended >= base against the stored values on PATCH", () => {
    const id = create({ extendedPoints: 3 }).body.id;
    const patch = (body: unknown) =>
      call(patchHabitRoute, { telegramId: admin, params: { id: String(id) }, body });
    assert.equal(patch({ pointsWeight: 4 }).body.error, "extended_points_below_base");
    assert.equal(patch({ extendedPoints: 1 }).body.error, "extended_points_below_base");
    assert.equal(patch({ pointsWeight: 4, extendedPoints: 4 }).status, 200);
    // Single-level habits can raise their base freely.
    const single = create({}).body.id;
    assert.equal(
      call(patchHabitRoute, {
        telegramId: admin,
        params: { id: String(single) },
        body: { pointsWeight: 9 },
      }).status,
      200
    );
  });

  it("refuses to enable Extended on a weekly habit via PATCH", () => {
    const id = create({ period: "weekly" }).body.id;
    const { body } = call(patchHabitRoute, {
      telegramId: admin,
      params: { id: String(id) },
      body: { extendedPoints: 3 },
    });
    assert.equal(body.error, "extended_level_not_allowed");
  });
});

describe("personal habits — level only, no points", () => {
  it("logs Extended only when hasExtended is on, and keeps it after switching off", () => {
    const telegramId = makeUser();
    const created = call(createPersonalHabitRoute, {
      telegramId,
      body: { name: "Run", hasExtended: true },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.hasExtended, true);
    const id = created.body.id;
    const plog = (body: unknown) =>
      call(logPersonalHabitRoute, { telegramId, params: { id: String(id) }, body });

    const ext = plog({ level: "extended" });
    assert.equal(ext.status, 200);
    assert.equal(ext.body.level, "extended");
    assert.equal(ext.body.points, undefined);
    assert.equal(pointsOf(telegramId), 0);

    let row = call(personalHabitLogWindowRoute, { telegramId }).body.habits.find(
      (h: any) => h.personalHabitId === id
    );
    assert.equal(row.hasExtended, true);
    assert.equal(row.level, "extended");

    const off = call(patchPersonalHabitRoute, {
      telegramId,
      params: { id: String(id) },
      body: { hasExtended: false },
    });
    assert.equal(off.body.hasExtended, false);
    row = call(personalHabitLogWindowRoute, { telegramId }).body.habits.find(
      (h: any) => h.personalHabitId === id
    );
    assert.equal(row.logged, true);
    assert.equal(row.level, "extended");
    assert.equal(plog({ level: "extended" }).body.error, "no_extended_level");
    assert.equal(plog({ level: "basic" }).body.level, "basic");
  });

  it("rejects a non-boolean hasExtended", () => {
    const telegramId = makeUser();
    const { status, body } = call(createPersonalHabitRoute, {
      telegramId,
      body: { name: "Run", hasExtended: "yes" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_has_extended");
  });
});

describe("privacy", () => {
  it("another member sees neither someone's level nor their points", () => {
    const alice = makeUser();
    const bob = makeUser();
    const habit = makeReading();
    log(alice, habit.id, { level: "extended" });

    const board = call(leaderboardRoute, { telegramId: bob }).body;
    const aliceRow = board.leaderboard.find((r: any) => !r.isYou && r.nickname === `ext-tester-${alice}`);
    assert.ok(aliceRow);
    assert.equal(aliceRow.points, undefined);
    assert.ok(!JSON.stringify(board).includes("level"));
    assert.ok(!JSON.stringify(board).includes("xtended"));

    // Bob's own Log screen reflects Bob only.
    const bobRow = windowRow(bob, habit.id);
    assert.equal(bobRow.logged, false);
    assert.equal(bobRow.level, null);
    assert.equal(bobRow.points, 0);
  });
});

describe("a database whose Extended-level migration failed", () => {
  it("keeps every single-level path working and answers 503 only for Extended writes", async () => {
    const { runExtendedLevelMigration } = await import("../../db/client.js");
    const admin = makeUser();
    const before = makeReading();
    db.exec(`
      ALTER TABLE habits DROP COLUMN extended_points;
      ALTER TABLE habits DROP COLUMN extended_from;
      ALTER TABLE personal_habits DROP COLUMN extended_enabled;
    `);
    try {
      const single = call(createHabitRoute, {
        telegramId: admin,
        body: { name: "Plain", pointsWeight: 2 },
      });
      assert.equal(single.status, 201);
      assert.equal(single.body.extendedPoints, null);
      const patched = call(patchHabitRoute, {
        telegramId: admin,
        params: { id: String(single.body.id) },
        body: { name: "Plain renamed", pointsWeight: 3 },
      });
      assert.equal(patched.status, 200);

      const extended = call(createHabitRoute, {
        telegramId: admin,
        body: { name: "Two levels", pointsWeight: 1, extendedPoints: 2 },
      });
      assert.equal(extended.status, 503);
      assert.equal(extended.body.error, "extended_level_unavailable");
      const off = call(patchHabitRoute, {
        telegramId: admin,
        params: { id: String(single.body.id) },
        body: { extendedPoints: null },
      });
      assert.equal(off.status, 503);

      // Logging still works, as Basic; Extended is simply not offered.
      const member = makeUser();
      assert.equal(log(member, before.id, {}).body.points, 1);
      assert.equal(log(member, before.id, { level: "extended" }).body.error, "no_extended_level");
      assert.equal(windowRow(member, before.id).extendedPoints, null);

      const personal = call(createPersonalHabitRoute, { telegramId: member, body: { name: "Walk" } });
      assert.equal(personal.status, 201);
      assert.equal(
        call(createPersonalHabitRoute, {
          telegramId: member,
          body: { name: "Walk 2", hasExtended: true },
        }).status,
        503
      );
    } finally {
      assert.equal(runExtendedLevelMigration(), true);
    }
  });
});
