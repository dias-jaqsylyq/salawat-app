import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "admin-habits-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  getUserByTelegramId,
  listHabits,
  setUserCurrentRoom,
  upsertHabitLog,
} = await import("../../db/repository.js");
const { db, runAmountMigration } = await import("../../db/client.js");
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

function makeHabit(
  name: string,
  pointsWeight: number,
  period: "daily" | "weekly" = "daily"
) {
  return createHabit(room.id, name, pointsWeight, null, period);
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
    const active = makeHabit("Admin-visible active", 1);
    const inactive = makeHabit("Admin-visible inactive", 1);
    callPatch(inactive.id, { isActive: false });

    const { body } = callList();
    const ids = body.map((h: any) => h.id);
    assert.ok(ids.includes(active.id));
    assert.ok(ids.includes(inactive.id));
  });
});

describe("POST /api/admin/habits", () => {
  it("creates a habit and returns it", () => {
    const { status, body } = callCreate({ name: "New habit", pointsWeight: 4 });
    assert.equal(status, 201);
    assert.equal(body.name, "New habit");
    assert.equal(body.pointsWeight, 4);
    assert.equal(body.isActive, true);
  });

  it("puts the habit in the calling admin's room", () => {
    const { status, body } = callCreate({ name: "Room-scoped", pointsWeight: 1 });
    assert.equal(status, 201);
    assert.deepEqual(
      listHabits({ roomId: room.id }).map((h) => h.id).includes(body.id),
      true
    );
  });

  it("400s when the caller is not in a room", () => {
    const { status, body } = callCreate(
      { name: "Homeless habit", pointsWeight: 1 },
      ROOMLESS_TELEGRAM_ID
    );
    assert.equal(status, 400);
    assert.equal(body.error, "no_room");
  });

  it("ignores a `type` a stale client still sends", () => {
    // The field is retired. An older Mini App build posting it must not 400 —
    // it simply has no say in what gets created.
    const { status } = callCreate({ name: "Stale client", type: "counter", pointsWeight: 1 });
    assert.equal(status, 201);
  });

  it("rejects a non-positive points weight", () => {
    const { status, body } = callCreate({ name: "Bad weight", pointsWeight: 0 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_points_weight");
  });

  it("rejects an empty name", () => {
    const { status, body } = callCreate({ name: "  ", pointsWeight: 1 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_name");
  });
});

describe("PATCH /api/admin/habits/:id", () => {
  it("is non-destructive: deactivating and reactivating a habit round-trips", () => {
    const habit = makeHabit("Toggle me", 5);

    const off = callPatch(habit.id, { isActive: false });
    assert.equal(off.body.isActive, false);

    const on = callPatch(habit.id, { isActive: true });
    assert.equal(on.body.isActive, true);
  });

  it("edits name and pointsWeight without touching the other", () => {
    const habit = makeHabit("Original name", 2);

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
    const habit = makeHabit("Empty patch", 1);
    const { status, body } = callPatch(habit.id, {});
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_body");
  });
});

describe("period and description", () => {
  it("defaults to daily and no goal line", () => {
    const { body } = callCreate({ name: "Plain habit", pointsWeight: 3 });
    assert.equal(body.period, "daily");
    assert.equal(body.description, null);
  });

  it("creates a weekly habit with a goal line, trimming it", () => {
    const { status, body } = callCreate({
      name: "Weekly khatm",
      pointsWeight: 30,
      period: "weekly",
      description: "  min 30 min  ",
    });
    assert.equal(status, 201);
    assert.equal(body.period, "weekly");
    assert.equal(body.description, "min 30 min");
  });

  it("rejects a period that is neither daily nor weekly", () => {
    const { status, body } = callCreate({
      name: "Fortnightly",
      pointsWeight: 1,
      period: "fortnightly",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_period");
  });

  it("rejects a description that is not a string, or is too long", () => {
    assert.equal(
      callCreate({ name: "Bad goal", pointsWeight: 1, description: 42 }).body.error,
      "invalid_description"
    );
    assert.equal(
      callCreate({ name: "Long goal", pointsWeight: 1, description: "x".repeat(201) }).body.error,
      "invalid_description"
    );
  });

  it("treats a blank description as no description at all", () => {
    const { body } = callCreate({ name: "Blank goal", pointsWeight: 1, description: "   " });
    assert.equal(body.description, null);
  });

  it("edits and clears the goal line", () => {
    const created = callCreate({ name: "Editable", pointsWeight: 2, description: "before" });
    assert.equal(callPatch(created.body.id, { description: "after" }).body.description, "after");
    assert.equal(callPatch(created.body.id, { description: null }).body.description, null);
    // A description on its own is a valid patch — it must not read as an empty body.
    assert.equal(callPatch(created.body.id, { description: "again" }).status, 200);
  });

  it("refuses to change a habit's period after creation", () => {
    const created = callCreate({ name: "Fixed cadence", pointsWeight: 2, period: "weekly" });

    // `period` alone is not a patch at all: nothing else in the body means there
    // is nothing to change.
    const { status, body } = callPatch(created.body.id, { period: "daily" });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_body");

    // And sending it alongside a real change leaves the cadence alone.
    const renamed = callPatch(created.body.id, { name: "Still weekly", period: "daily" });
    assert.equal(renamed.body.name, "Still weekly");
    assert.equal(renamed.body.period, "weekly");
  });
});

describe("habit amounts (unit + amount per completion)", () => {
  const adminUserId = () => getUserByTelegramId(ADMIN_TELEGRAM_ID)!.id;

  it("creates a habit with a unit and amounts, and lists them", () => {
    const created = callCreate({
      name: "Quran reading",
      pointsWeight: 2,
      extendedPoints: 3,
      unitLabel: "  min  ",
      amountBasic: 30,
      amountExtended: 45.5,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.unitLabel, "min");
    assert.equal(created.body.amountBasic, 30);
    assert.equal(created.body.amountExtended, 45.5);
    assert.equal(created.body.hasLoggedAmounts, false);

    const listed = callList().body.find((h: any) => h.id === created.body.id);
    assert.equal(listed.unitLabel, "min");
  });

  it("a habit without a unit answers nulls, so an old client sees nothing new to handle", () => {
    const created = callCreate({ name: "No unit", pointsWeight: 1 });
    assert.equal(created.body.unitLabel, null);
    assert.equal(created.body.amountBasic, null);
    assert.equal(created.body.amountExtended, null);
  });

  it("validates the unit label", () => {
    for (const unitLabel of ["x".repeat(17), "<b>", "min>", "a\u0007b", 5]) {
      const result = callCreate({ name: "Bad unit", pointsWeight: 1, unitLabel, amountBasic: 1 });
      assert.equal(result.status, 400, JSON.stringify(unitLabel));
      assert.equal(result.body.error, "invalid_unit_label");
    }
    assert.equal(
      callCreate({ name: "Max unit", pointsWeight: 1, unitLabel: "x".repeat(16) }).status,
      201
    );
  });

  it("validates amounts: finite, > 0, at most 100000, decimals allowed", () => {
    for (const amountBasic of [0, -1, 100001, Number.NaN, Infinity, "30"]) {
      const result = callCreate({ name: "Bad amount", pointsWeight: 1, unitLabel: "min", amountBasic });
      assert.equal(result.status, 400, String(amountBasic));
      assert.equal(result.body.error, "invalid_amount");
    }
    assert.equal(
      callCreate({ name: "Half juz", pointsWeight: 1, unitLabel: "juz", amountBasic: 0.5 }).status,
      201
    );
    assert.equal(
      callCreate({ name: "Max amount", pointsWeight: 1, unitLabel: "min", amountBasic: 100000 }).status,
      201
    );
  });

  it("enforces the pairing rules", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ amountBasic: 30 }, "amount_requires_unit"],
      [{ unitLabel: "min", amountBasic: 30, amountExtended: 45 }, "amount_extended_not_allowed"],
      [
        { extendedPoints: 3, unitLabel: "min", amountExtended: 45 },
        "amount_extended_requires_basic",
      ],
      [
        { extendedPoints: 3, unitLabel: "min", amountBasic: 30, amountExtended: 20 },
        "amount_extended_below_basic",
      ],
    ];
    for (const [extra, error] of cases) {
      const result = callCreate({ name: "Pairing", pointsWeight: 2, ...extra });
      assert.equal(result.status, 400, error);
      assert.equal(result.body.error, error);
    }

    const habit = callCreate({ name: "Pairing patch", pointsWeight: 2, extendedPoints: 3 }).body;
    callPatch(habit.id, { unitLabel: "min", amountBasic: 30, amountExtended: 40 });
    assert.equal(callPatch(habit.id, { unitLabel: null }).body.error, "amount_requires_unit");
    assert.equal(
      callPatch(habit.id, { amountBasic: 50 }).body.error,
      "amount_extended_below_basic"
    );
    // Clearing all three together is fine.
    const cleared = callPatch(habit.id, { unitLabel: "", amountBasic: null, amountExtended: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.unitLabel, null);
  });

  it("switching Extended off together with amount fields drops the stored Extended amount", () => {
    const habit = callCreate({
      name: "Extended off",
      pointsWeight: 2,
      extendedPoints: 3,
      unitLabel: "min",
      amountBasic: 30,
      amountExtended: 45,
    }).body;
    const off = callPatch(habit.id, { extendedPoints: null, unitLabel: "min", amountBasic: 30 });
    assert.equal(off.status, 200);
    assert.equal(off.body.amountExtended, null);
  });

  it("the first amount backfills existing logs, and hasLoggedAmounts turns on", () => {
    const habit = makeHabit("Backfilled via route", 1);
    upsertHabitLog(adminUserId(), habit.id, 1, "2026-05-04");
    assert.equal(callList().body.find((h: any) => h.id === habit.id).hasLoggedAmounts, false);

    const patched = callPatch(habit.id, { unitLabel: "pages", amountBasic: 2 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.hasLoggedAmounts, true);
    const row = db
      .prepare("SELECT amount_logged FROM habit_logs WHERE habit_id = ?")
      .get(habit.id) as { amount_logged: number };
    assert.equal(row.amount_logged, 2);
  });

  it("answers 503 for amount writes when the columns are missing, and nothing else breaks", () => {
    const habit = makeHabit("Before the columns went", 1);
    db.exec(`
      ALTER TABLE habits DROP COLUMN unit_label;
      ALTER TABLE habits DROP COLUMN amount_basic;
      ALTER TABLE habits DROP COLUMN amount_extended;
      ALTER TABLE habits DROP COLUMN amount_backfilled_at;
      ALTER TABLE habit_logs DROP COLUMN amount_logged;
    `);
    try {
      const plain = callCreate({ name: "Plain without columns", pointsWeight: 2 });
      assert.equal(plain.status, 201);
      assert.equal(plain.body.unitLabel, null);
      assert.equal(callList().status, 200);
      assert.equal(callPatch(habit.id, { name: "Renamed without columns" }).status, 200);
      const unit = callPatch(habit.id, { unitLabel: "min", amountBasic: 5 });
      assert.equal(unit.status, 503);
      assert.equal(unit.body.error, "amounts_unavailable");
      assert.equal(upsertHabitLog(adminUserId(), habit.id, 1, "2026-05-05").points_earned, 1);
    } finally {
      assert.equal(runAmountMigration(), true);
    }
  });
});
