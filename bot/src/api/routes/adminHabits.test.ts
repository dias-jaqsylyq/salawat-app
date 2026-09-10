import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "admin-habits-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createHabit, createRoom, createUser, listHabits, setUserCurrentRoom } = await import(
  "../../db/repository.js"
);
const { createHabitRoute, listAdminHabitsRoute, patchHabitRoute } = await import(
  "./adminHabits.js"
);

/** An admin with a room of their own — POST resolves the new habit's room from them. */
const ADMIN_TELEGRAM_ID = 940000001;
const room = (() => {
  const owner = createUser(ADMIN_TELEGRAM_ID, "admin-habits-owner");
  const created = createRoom("Admin habits room", "admin-habits-pass", owner.id);
  setUserCurrentRoom(owner.id, created.id);
  return created;
})();

/** An admin-shaped caller who is not in any room yet. */
const ROOMLESS_TELEGRAM_ID = 940000002;
createUser(ROOMLESS_TELEGRAM_ID, "admin-habits-roomless");

function makeHabit(name: string, type: "quantity" | "binary", pointsWeight: number) {
  return createHabit(room.id, name, type, pointsWeight);
}

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

function callList(telegramId: number = ADMIN_TELEGRAM_ID): { status: number; body: any } {
  const result = capture();
  listAdminHabitsRoute({ telegramId } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callCreate(
  body: unknown,
  telegramId: number = ADMIN_TELEGRAM_ID
): { status: number; body: any } {
  const result = capture();
  createHabitRoute({ body, telegramId } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callPatch(
  id: number | string,
  body: unknown,
  telegramId: number = ADMIN_TELEGRAM_ID
): { status: number; body: any } {
  const result = capture();
  patchHabitRoute(
    { params: { id: String(id) }, body, telegramId } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

describe("GET /api/admin/habits", () => {
  it("lists all habits, including inactive ones", () => {
    const active = makeHabit("Admin-visible active", "quantity", 1);
    const inactive = makeHabit("Admin-visible inactive", "binary", 1);
    callPatch(inactive.id, { isActive: false });

    const { body } = callList();
    const ids = body.map((h: any) => h.id);
    assert.ok(ids.includes(active.id));
    assert.ok(ids.includes(inactive.id));
  });
});

describe("POST /api/admin/habits", () => {
  it("creates a habit and returns it", () => {
    const { status, body } = callCreate({ name: "New habit", type: "quantity", pointsWeight: 4 });
    assert.equal(status, 201);
    assert.equal(body.name, "New habit");
    assert.equal(body.type, "quantity");
    assert.equal(body.pointsWeight, 4);
    assert.equal(body.isActive, true);
  });

  it("puts the habit in the calling admin's room", () => {
    const { status, body } = callCreate({ name: "Room-scoped", type: "binary", pointsWeight: 1 });
    assert.equal(status, 201);
    assert.deepEqual(
      listHabits({ roomId: room.id }).map((h) => h.id).includes(body.id),
      true
    );
  });

  it("400s when the caller is not in a room", () => {
    const { status, body } = callCreate(
      { name: "Homeless habit", type: "binary", pointsWeight: 1 },
      ROOMLESS_TELEGRAM_ID
    );
    assert.equal(status, 400);
    assert.equal(body.error, "no_room");
  });

  it("rejects an invalid type", () => {
    const { status, body } = callCreate({ name: "Bad type", type: "counter", pointsWeight: 1 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_type");
  });

  it("rejects a non-positive points weight", () => {
    const { status, body } = callCreate({ name: "Bad weight", type: "binary", pointsWeight: 0 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_points_weight");
  });

  it("rejects an empty name", () => {
    const { status, body } = callCreate({ name: "  ", type: "binary", pointsWeight: 1 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_name");
  });
});

describe("PATCH /api/admin/habits/:id", () => {
  it("is non-destructive: deactivating and reactivating a habit round-trips", () => {
    const habit = makeHabit("Toggle me", "binary", 5);

    const off = callPatch(habit.id, { isActive: false });
    assert.equal(off.body.isActive, false);

    const on = callPatch(habit.id, { isActive: true });
    assert.equal(on.body.isActive, true);
  });

  it("edits name and pointsWeight without touching the other", () => {
    const habit = makeHabit("Original name", "quantity", 2);

    const renamed = callPatch(habit.id, { name: "Renamed" });
    assert.equal(renamed.body.name, "Renamed");
    assert.equal(renamed.body.pointsWeight, 2);

    const reweighted = callPatch(habit.id, { pointsWeight: 9 });
    assert.equal(reweighted.body.name, "Renamed");
    assert.equal(reweighted.body.pointsWeight, 9);
  });

  it("404s for an unknown habit id", () => {
    const { status, body } = callPatch(999_999, { isActive: false });
    assert.equal(status, 404);
    assert.equal(body.error, "habit_not_found");
  });

  it("400s when the body has none of the recognized fields", () => {
    const habit = makeHabit("Empty patch", "binary", 1);
    const { status, body } = callPatch(habit.id, {});
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_body");
  });
});
