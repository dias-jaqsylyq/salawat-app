import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import type { Bot } from "grammy";
import type { MyContext } from "../../context.js";

process.env.BOT_TOKEN ??= "admin-room-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  getHabitById,
  getRoomById,
  getUserByTelegramId,
  setUserCurrentRoom,
} = await import("../../db/repository.js");
const { createAdminRoomRoutes } = await import("./adminRoom.js");
const { createHabitRoute, patchHabitRoute } = await import("./adminHabits.js");

const bot = { botInfo: { username: "test_habit_bot" } } as unknown as Bot<MyContext>;
const { getAdminRoomRoute, patchAdminRoomRoute, regenerateRoomPasswordRoute } =
  createAdminRoomRoutes(bot);

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

function call(
  handler: (req: Request, res: Response) => void,
  req: Record<string, unknown>
): { status: number; body: any } {
  const result = capture();
  handler(req as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

let nextTelegramId = 970000001;

function makeRoom(name: string, password: string) {
  const owner = createUser(nextTelegramId++, `${password}-owner`);
  const room = createRoom(name, password, owner.id);
  setUserCurrentRoom(owner.id, room.id);
  return { room, ownerTelegramId: owner.telegram_id };
}

describe("GET /api/admin/room", () => {
  it("returns the room with its password and share link", () => {
    const { room, ownerTelegramId } = makeRoom("Info room", "info-room-pass");
    const { status, body } = call(getAdminRoomRoute, { telegramId: ownerTelegramId });

    assert.equal(status, 200);
    assert.equal(body.id, room.id);
    assert.equal(body.name, "Info room");
    assert.equal(body.categoriesEnabled, false);
    assert.equal(body.password, "info-room-pass");
    assert.equal(body.inviteLink, "https://t.me/test_habit_bot?start=info-room-pass");
    assert.equal(body.participantCount, 1);
  });
});

describe("PATCH /api/admin/room", () => {
  it("toggles categories on and back off, preserving stored habit categories", () => {
    const { room, ownerTelegramId } = makeRoom("Toggle room", "toggle-room-pass");
    const habit = createHabit(room.id, "Categorised", "binary", 1, "SQ");

    const on = call(patchAdminRoomRoute, {
      telegramId: ownerTelegramId,
      body: { categoriesEnabled: true },
    });
    assert.equal(on.status, 200);
    assert.equal(on.body.categoriesEnabled, true);

    const off = call(patchAdminRoomRoute, {
      telegramId: ownerTelegramId,
      body: { categoriesEnabled: false },
    });
    assert.equal(off.body.categoriesEnabled, false);
    // Switching categories off never clears what was already stored (PRD §0).
    assert.equal(getHabitById(habit.id)?.category, "SQ");
  });

  it("rejects a non-boolean", () => {
    const { ownerTelegramId } = makeRoom("Bad toggle room", "bad-toggle-pass");
    const { status, body } = call(patchAdminRoomRoute, {
      telegramId: ownerTelegramId,
      body: { categoriesEnabled: "yes" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_categories_enabled");
  });
});

describe("POST /api/admin/room/password", () => {
  it("generates a new password, leaving membership untouched", () => {
    const { room, ownerTelegramId } = makeRoom("Regen room", "regen-room-pass");
    const member = createUser(nextTelegramId++, "regen-member");
    setUserCurrentRoom(member.id, room.id);

    const { status, body } = call(regenerateRoomPasswordRoute, {
      telegramId: ownerTelegramId,
      body: {},
    });
    assert.equal(status, 200);
    assert.notEqual(body.password, "regen-room-pass");
    assert.equal(getRoomById(room.id)?.password, body.password);
    assert.equal(body.inviteLink, `https://t.me/test_habit_bot?start=${body.password}`);
    // Only future joins are blocked — the member who already joined stays put (PRD §3a).
    assert.equal(getUserByTelegramId(member.telegram_id)?.current_room_id, room.id);
  });

  it("accepts an admin-chosen password", () => {
    const { room, ownerTelegramId } = makeRoom("Custom room", "custom-room-pass");
    const { status, body } = call(regenerateRoomPasswordRoute, {
      telegramId: ownerTelegramId,
      body: { password: "MyRoom2026" },
    });
    assert.equal(status, 200);
    assert.equal(body.password, "MyRoom2026");
    assert.equal(getRoomById(room.id)?.password, "MyRoom2026");
  });

  it("rejects one that is too short or outside the deep-link charset", () => {
    const { ownerTelegramId } = makeRoom("Short room", "short-room-pass");
    for (const password of ["abc", "has spaces", "точка"]) {
      const { status, body } = call(regenerateRoomPasswordRoute, {
        telegramId: ownerTelegramId,
        body: { password },
      });
      assert.equal(status, 400, `expected ${password} to be rejected`);
      assert.equal(body.error, "invalid_password");
    }
  });

  it("409s when another room already answers to it", () => {
    makeRoom("Taken room", "taken-room-pass");
    const { ownerTelegramId } = makeRoom("Clashing room", "clashing-room-pass");

    const { status, body } = call(regenerateRoomPasswordRoute, {
      telegramId: ownerTelegramId,
      body: { password: "taken-room-pass" },
    });
    assert.equal(status, 409);
    assert.equal(body.error, "password_taken");
  });

  it("is a no-op when the admin retypes the room's current password", () => {
    const { room, ownerTelegramId } = makeRoom("Same room", "same-room-pass");
    const { status, body } = call(regenerateRoomPasswordRoute, {
      telegramId: ownerTelegramId,
      body: { password: "same-room-pass" },
    });
    assert.equal(status, 200);
    assert.equal(body.password, "same-room-pass");
    assert.equal(getRoomById(room.id)?.password, "same-room-pass");
  });
});

describe("habit categories follow the room's mode", () => {
  it("requires a category in a categories-enabled room and rejects a bad one", () => {
    const { room, ownerTelegramId } = makeRoom("Categories on", "categories-on-pass");
    call(patchAdminRoomRoute, { telegramId: ownerTelegramId, body: { categoriesEnabled: true } });

    const missing = call(createHabitRoute, {
      telegramId: ownerTelegramId,
      body: { name: "No category", type: "binary", pointsWeight: 1 },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "category_required");

    const bad = call(createHabitRoute, {
      telegramId: ownerTelegramId,
      body: { name: "Bad category", type: "binary", pointsWeight: 1, category: "XQ" },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_category");

    const created = call(createHabitRoute, {
      telegramId: ownerTelegramId,
      body: { name: "Good category", type: "binary", pointsWeight: 1, category: "EQ" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.category, "EQ");
    assert.equal(getHabitById(created.body.id)?.room_id, room.id);

    const recategorised = call(patchHabitRoute, {
      telegramId: ownerTelegramId,
      params: { id: String(created.body.id) },
      body: { category: "PQ" },
    });
    assert.equal(recategorised.body.category, "PQ");

    const cleared = call(patchHabitRoute, {
      telegramId: ownerTelegramId,
      params: { id: String(created.body.id) },
      body: { category: null },
    });
    assert.equal(cleared.status, 400);
    assert.equal(cleared.body.error, "category_required");
  });

  it("rejects a category in a categories-disabled room", () => {
    const { ownerTelegramId } = makeRoom("Categories off", "categories-off-pass");

    const { status, body } = call(createHabitRoute, {
      telegramId: ownerTelegramId,
      body: { name: "Unwanted category", type: "binary", pointsWeight: 1, category: "IQ" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "category_not_allowed");

    const plain = call(createHabitRoute, {
      telegramId: ownerTelegramId,
      body: { name: "Plain habit", type: "binary", pointsWeight: 1 },
    });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.category, null);
  });
});
