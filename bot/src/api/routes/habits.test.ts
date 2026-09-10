import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "habits-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createHabit, createUser, updateHabit } = await import("../../db/repository.js");
const { listHabitsRoute, logHabitRoute } = await import("./habits.js");

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

function callList(): { status: number; body: any } {
  const result = capture();
  listHabitsRoute({} as unknown as Request, result.res);
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

let nextTelegramId = 700000001;
function makeUser(): number {
  const telegramId = nextTelegramId++;
  createUser(telegramId, `habits-tester-${telegramId}`);
  return telegramId;
}

describe("GET /api/habits", () => {
  it("lists only active habits", () => {
    const active = createHabit("Read Qur'an", "quantity", 2);
    const inactive = createHabit("Retired habit", "binary", 5);
    updateHabit(inactive.id, { isActive: false });

    const { body } = callList();
    const ids = body.map((h: any) => h.id);
    assert.ok(ids.includes(active.id));
    assert.ok(!ids.includes(inactive.id));

    const listed = body.find((h: any) => h.id === active.id);
    assert.deepEqual(listed, {
      id: active.id,
      name: "Read Qur'an",
      type: "quantity",
      pointsWeight: 2,
    });
  });
});

describe("POST /api/habits/:id/log", () => {
  it("upserts a quantity habit's value for today, freezing points", () => {
    const telegramId = makeUser();
    const habit = createHabit("Salawat count", "quantity", 3);

    const first = callLog(telegramId, habit.id, { value: 10 });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      success: true,
      habitId: habit.id,
      value: 10,
      points: 30,
      logged: true,
    });

    // Second call same day overwrites rather than adding.
    const second = callLog(telegramId, habit.id, { value: 4 });
    assert.equal(second.body.value, 4);
    assert.equal(second.body.points, 12);
  });

  it("treats an omitted value as 1 for a binary habit", () => {
    const telegramId = makeUser();
    const habit = createHabit("Prayed Fajr in jamaat", "binary", 15);

    const { body } = callLog(telegramId, habit.id, {});
    assert.equal(body.value, 1);
    assert.equal(body.points, 15);
  });

  it("rejects a non-1 value for a binary habit", () => {
    const telegramId = makeUser();
    const habit = createHabit("Fasted today", "binary", 10);

    const { status, body } = callLog(telegramId, habit.id, { value: 5 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_value");
  });

  it("rejects a negative or non-integer value for a quantity habit", () => {
    const telegramId = makeUser();
    const habit = createHabit("Pages read", "quantity", 1);

    assert.equal(callLog(telegramId, habit.id, { value: -1 }).status, 400);
    assert.equal(callLog(telegramId, habit.id, { value: 1.5 }).status, 400);
  });

  it("rejects logging against a deactivated habit", () => {
    const telegramId = makeUser();
    const habit = createHabit("Soon retired", "binary", 5);
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
    const habit = createHabit("Registered users only", "binary", 5);
    const { status, body } = callLog(999_999_999, habit.id, {});
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });
});
