import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "habits-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  getUserByTelegramId,
  getUserTotalPoints,
  setUserCurrentRoom,
  updateHabit,
} = await import("../../db/repository.js");
const { deleteHabitLogRoute, listHabitsRoute, logHabitRoute } = await import("./habits.js");

function capture(): { res: Response; status: () => number; body: () => any } {
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
  return { res, status: () => status, body: () => body };
}

function callList(telegramId: number): { status: number; body: any } {
  const result = capture();
  listHabitsRoute({ telegramId } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callLog(
  telegramId: number,
  habitId: number | string,
  body: unknown
): { status: number; body: any } {
  const result = capture();
  logHabitRoute(
    { telegramId, params: { id: String(habitId) }, body } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

function callDeleteLog(
  telegramId: number,
  habitId: number | string
): { status: number; body: any } {
  const result = capture();
  deleteHabitLogRoute(
    { telegramId, params: { id: String(habitId) } } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

let nextTelegramId = 700000001;

/** One shared room: every habit and every logger in this file belongs to it. */
const room = (() => {
  const owner = createUser(nextTelegramId++, "habits-room-owner");
  return createRoom("Habits room", "habits-room-pass", owner.id);
})();

function makeUser(): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `habits-tester-${telegramId}`);
  setUserCurrentRoom(user.id, room.id);
  return telegramId;
}

function makeHabit(
  name: string,
  pointsWeight: number,
  period: "daily" | "weekly" = "daily"
) {
  return createHabit(room.id, name, pointsWeight, null, period);
}

describe("GET /api/habits", () => {
  it("lists only active habits", () => {
    const active = makeHabit("Read Qur'an", 2);
    const inactive = makeHabit("Retired habit", 5);
    updateHabit(inactive.id, { isActive: false });

    const { body } = callList(makeUser());
    const ids = body.map((h: any) => h.id);
    assert.ok(ids.includes(active.id));
    assert.ok(!ids.includes(inactive.id));

    const listed = body.find((h: any) => h.id === active.id);
    assert.deepEqual(listed, {
      id: active.id,
      name: "Read Qur'an",
      description: null,
      period: "daily",
      pointsWeight: 2,
      category: null,
    });
  });
});

describe("POST /api/habits/:id/log", () => {
  it("marks today done, freezing the habit's flat weight", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Salawat", 3);

    const first = callLog(telegramId, habit.id, {});
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      success: true,
      habitId: habit.id,
      value: 1,
      points: 3,
      logged: true,
    });

    // Second call same day overwrites rather than adding.
    const second = callLog(telegramId, habit.id, { value: 1 });
    assert.equal(second.body.value, 1);
    assert.equal(second.body.points, 3);
  });

  it("scores a weekly habit once however many days of the week are marked", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Weekly khatm", 20, "weekly");
    const user = getUserByTelegramId(telegramId)!;

    // Both calls land on the caller's today, so the second is the same row —
    // the week-level cap is exercised properly in repository.test.ts, where the
    // dates can be chosen. Here we only care that the route stays flat.
    assert.equal(callLog(telegramId, habit.id, {}).body.points, 20);
    assert.equal(callLog(telegramId, habit.id, {}).body.points, 20);
    assert.equal(getUserTotalPoints(user.id), 20);
  });

  it("rejects a value other than 1", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Fasted today", 10);

    assert.equal(callLog(telegramId, habit.id, { value: 5 }).status, 400);
    assert.equal(callLog(telegramId, habit.id, { value: -1 }).status, 400);
    assert.equal(callLog(telegramId, habit.id, { value: 1.5 }).status, 400);
    assert.equal(callLog(telegramId, habit.id, { value: 5 }).body.error, "invalid_value");
  });

  it("rejects logging against a deactivated habit", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Soon retired", 5);
    updateHabit(habit.id, { isActive: false });

    const { status, body } = callLog(telegramId, habit.id, {});
    assert.equal(status, 400);
    assert.equal(body.error, "habit_inactive");
  });

  it("404s for an unknown habit id", () => {
    const telegramId = makeUser();
    const { status, body } = callLog(telegramId, 999_999, {});
    assert.equal(status, 404);
    assert.equal(body.error, "habit_not_found");
  });

  it("403s for a telegram id with no registered user", () => {
    const habit = makeHabit("Registered users only", 5);
    const { status, body } = callLog(999_999_999, habit.id, {});
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });
});

describe("DELETE /api/habits/:id/log", () => {
  it("removes today's binary log and its points", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Prayed Fajr in jamaat", 15);
    callLog(telegramId, habit.id, {});
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(getUserTotalPoints(user.id), 15);

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, logged: false });
    assert.equal(getUserTotalPoints(user.id), 0);
  });

  it("removes today's weekly log and the points it banked", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Weekly unlog", 30, "weekly");
    callLog(telegramId, habit.id, {});
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(getUserTotalPoints(user.id), 30);

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, logged: false });
    // Nothing else in the week is marked, so the week loses its points.
    assert.equal(getUserTotalPoints(user.id), 0);
  });

  it("is idempotent when there is no log for today", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Never logged", 5);

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, logged: false });
  });

  it("succeeds even against a deactivated habit", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Soon retired", 5);
    callLog(telegramId, habit.id, {});
    updateHabit(habit.id, { isActive: false });

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, logged: false });
  });

  it("404s for an unknown habit id", () => {
    const telegramId = makeUser();
    const { status, body } = callDeleteLog(telegramId, 999_999);
    assert.equal(status, 404);
    assert.equal(body.error, "habit_not_found");
  });

  it("403s for a telegram id with no registered user", () => {
    const habit = makeHabit("Registered users only", 5);
    const { status, body } = callDeleteLog(999_999_999, habit.id);
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });
});
