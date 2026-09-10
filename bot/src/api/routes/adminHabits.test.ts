import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "admin-habits-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createHabit } = await import("../../db/repository.js");
const { createHabitRoute, listAdminHabitsRoute, patchHabitRoute } = await import(
  "./adminHabits.js"
);

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
  listAdminHabitsRoute({} as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callCreate(body: unknown): { status: number; body: any } {
  const result = capture();
  createHabitRoute({ body } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callPatch(id: number | string, body: unknown): { status: number; body: any } {
  const result = capture();
  patchHabitRoute({ params: { id: String(id) }, body } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

describe("GET /api/admin/habits", () => {
  it("lists all habits, including inactive ones", () => {
    const active = createHabit("Admin-visible active", "quantity", 1);
    const inactive = createHabit("Admin-visible inactive", "binary", 1);
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
    const habit = createHabit("Toggle me", "binary", 5);

    const off = callPatch(habit.id, { isActive: false });
    assert.equal(off.body.isActive, false);

    const on = callPatch(habit.id, { isActive: true });
    assert.equal(on.body.isActive, true);
  });

  it("edits name and pointsWeight without touching the other", () => {
    const habit = createHabit("Original name", "quantity", 2);

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
    const habit = createHabit("Empty patch", "binary", 1);
    const { status, body } = callPatch(habit.id, {});
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_body");
  });
});
