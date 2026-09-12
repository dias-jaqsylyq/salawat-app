import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "personal-habits-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  getUserByTelegramId,
  getUserTotalPoints,
  kickUserFromRoom,
  leaveCurrentRoom,
  listPersonalHabits,
  setRoomCategoriesEnabled,
  setUserCurrentRoom,
} = await import("../../db/repository.js");
const { MAX_PERSONAL_HABITS_PER_ROOM } = await import("../../config.js");
const {
  createPersonalHabitRoute,
  deletePersonalHabitLogRoute,
  deletePersonalHabitRoute,
  listPersonalHabitsRoute,
  logPersonalHabitRoute,
  patchPersonalHabitRoute,
} = await import("./personalHabits.js");
const { listAdminHabitsRoute } = await import("./adminHabits.js");
const { progressRoute } = await import("./progress.js");
const { progressWeekRoute } = await import("./progressWeek.js");

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

type Handler = (req: Request, res: Response) => void;

function call(
  handler: Handler,
  req: { telegramId: number; params?: Record<string, string>; body?: unknown }
): { status: number; body: any } {
  const result = capture();
  handler(req as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

const list = (telegramId: number) => call(listPersonalHabitsRoute, { telegramId });
const create = (telegramId: number, body: unknown) =>
  call(createPersonalHabitRoute, { telegramId, body });
const patch = (telegramId: number, id: number | string, body: unknown) =>
  call(patchPersonalHabitRoute, { telegramId, params: { id: String(id) }, body });
const remove = (telegramId: number, id: number | string) =>
  call(deletePersonalHabitRoute, { telegramId, params: { id: String(id) } });
const log = (telegramId: number, id: number | string, body: unknown = {}) =>
  call(logPersonalHabitRoute, { telegramId, params: { id: String(id) }, body });
const unlog = (telegramId: number, id: number | string) =>
  call(deletePersonalHabitLogRoute, { telegramId, params: { id: String(id) } });

let nextTelegramId = 980000001;
let nextRoomSuffix = 1;

function makeRoom(categoriesEnabled = false) {
  const owner = createUser(nextTelegramId++, `ph-owner-${nextTelegramId}`);
  const room = createRoom(
    `Personal room ${nextRoomSuffix}`,
    `personal-pass-${nextRoomSuffix++}`,
    owner.id,
    categoriesEnabled
  );
  setUserCurrentRoom(owner.id, room.id);
  return { room, ownerTelegramId: owner.telegram_id };
}

function makeMember(roomId: number): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `ph-member-${telegramId}`);
  setUserCurrentRoom(user.id, roomId);
  return telegramId;
}

describe("personal habits — CRUD", () => {
  it("creates, lists, edits and deletes a member's own habit", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);

    assert.deepEqual(list(telegramId).body, []);

    const created = create(telegramId, { name: "  Read 10 pages  ", type: "quantity" });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "Read 10 pages");
    assert.equal(created.body.type, "quantity");
    assert.equal(created.body.category, null);
    // Nothing about points is exposed, because there is nothing to expose.
    assert.equal("pointsWeight" in created.body, false);

    assert.equal(list(telegramId).body.length, 1);

    const edited = patch(telegramId, created.body.id, { name: "Read 20 pages", type: "binary" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, "Read 20 pages");
    assert.equal(edited.body.type, "binary");

    assert.equal(remove(telegramId, created.body.id).status, 200);
    assert.deepEqual(list(telegramId).body, []);
  });

  it("rejects an empty name, an unknown type and an empty patch", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);

    assert.equal(create(telegramId, { name: "   ", type: "binary" }).body.error, "invalid_name");
    assert.equal(create(telegramId, { name: "x", type: "weekly" }).body.error, "invalid_type");

    const created = create(telegramId, { name: "Walk", type: "binary" });
    assert.equal(patch(telegramId, created.body.id, {}).body.error, "invalid_body");
  });

  it("caps how many one member may keep in a room", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);

    for (let i = 0; i < MAX_PERSONAL_HABITS_PER_ROOM; i++) {
      assert.equal(create(telegramId, { name: `Habit ${i}`, type: "binary" }).status, 201);
    }
    const overflow = create(telegramId, { name: "One too many", type: "binary" });
    assert.equal(overflow.status, 400);
    assert.equal(overflow.body.error, "too_many_personal_habits");
  });
});

describe("personal habits — ownership", () => {
  it("404s another member's habit exactly like a habit that does not exist", () => {
    const { room } = makeRoom();
    const mine = makeMember(room.id);
    const theirs = makeMember(room.id);

    const created = create(theirs, { name: "Private", type: "binary" });
    const id = created.body.id;

    // Same room, different owner.
    assert.equal(patch(mine, id, { name: "Hijacked" }).status, 404);
    assert.equal(remove(mine, id).status, 404);
    assert.equal(log(mine, id).status, 404);
    assert.equal(unlog(mine, id).status, 404);
    // And an id nobody owns answers identically.
    assert.equal(patch(mine, 999_999, { name: "x" }).body.error, "personal_habit_not_found");

    // Their list is unaffected, and mine never saw it.
    assert.equal(list(theirs).body.length, 1);
    assert.deepEqual(list(mine).body, []);
  });

  it("is invisible to the room's admin", () => {
    const { room, ownerTelegramId } = makeRoom();
    const member = makeMember(room.id);
    createHabit(room.id, "Room habit", "binary", 5);
    create(member, { name: "Totally private", type: "binary" });

    const adminView = call(listAdminHabitsRoute, { telegramId: ownerTelegramId });
    assert.deepEqual(
      adminView.body.map((habit: { name: string }) => habit.name),
      ["Room habit"]
    );
  });
});

describe("personal habits — categories", () => {
  it("requires one while the room has categories enabled", () => {
    const { room } = makeRoom(true);
    const telegramId = makeMember(room.id);

    assert.equal(
      create(telegramId, { name: "Dhikr", type: "binary" }).body.error,
      "category_required"
    );
    assert.equal(
      create(telegramId, { name: "Dhikr", type: "binary", category: "XX" }).body.error,
      "invalid_category"
    );

    const created = create(telegramId, { name: "Dhikr", type: "binary", category: "SQ" });
    assert.equal(created.status, 201);
    assert.equal(created.body.category, "SQ");
  });

  it("rejects one while the room has categories disabled", () => {
    const { room } = makeRoom(false);
    const telegramId = makeMember(room.id);

    assert.equal(
      create(telegramId, { name: "Dhikr", type: "binary", category: "SQ" }).body.error,
      "category_not_allowed"
    );
  });

  it("follows the room when the setting is flipped", () => {
    const { room } = makeRoom(true);
    const telegramId = makeMember(room.id);
    const created = create(telegramId, { name: "Dhikr", type: "binary", category: "SQ" });

    setRoomCategoriesEnabled(room.id, false);
    // The stored value survives the flip, same as a room habit (PRD §0).
    assert.equal(list(telegramId).body[0].category, "SQ");
    assert.equal(
      patch(telegramId, created.body.id, { category: "IQ" }).body.error,
      "category_not_allowed"
    );
  });
});

describe("personal habits — logging", () => {
  it("logs and unlogs a binary habit without touching any total", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    const user = getUserByTelegramId(telegramId)!;
    const created = create(telegramId, { name: "Walk", type: "binary" });

    const logged = log(telegramId, created.body.id);
    assert.equal(logged.status, 200);
    assert.equal(logged.body.logged, true);
    assert.equal(logged.body.value, 1);
    assert.equal("points" in logged.body, false);
    assert.equal(getUserTotalPoints(user.id, room.id), 0);

    assert.equal(unlog(telegramId, created.body.id).body.logged, false);
  });

  it("validates a quantity value the same way room habits do", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    const created = create(telegramId, { name: "Pages", type: "quantity" });

    assert.equal(log(telegramId, created.body.id, {}).body.error, "invalid_value");
    assert.equal(log(telegramId, created.body.id, { value: -1 }).body.error, "invalid_value");
    assert.equal(log(telegramId, created.body.id, { value: 1.5 }).body.error, "invalid_value");
    assert.equal(log(telegramId, created.body.id, { value: 12 }).body.value, 12);
    // Upsert, not accumulate.
    assert.equal(log(telegramId, created.body.id, { value: 3 }).body.value, 3);
  });

  it("takes a personal habit's logs with it when the habit is deleted", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    const created = create(telegramId, { name: "Walk", type: "binary" });
    log(telegramId, created.body.id);

    remove(telegramId, created.body.id);

    const progress = call(progressRoute, { telegramId });
    assert.deepEqual(progress.body.personalToday, []);
    assert.deepEqual(progress.body.personalStreaks, []);
  });
});

describe("personal habits — progress", () => {
  it("reports today and the streak without moving any point total", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    const created = create(telegramId, { name: "Walk", type: "binary" });

    const before = call(progressRoute, { telegramId }).body;
    assert.deepEqual(before.personalToday, [
      { personalHabitId: created.body.id, logged: false, value: 0 },
    ]);
    assert.deepEqual(before.personalStreaks, [
      { personalHabitId: created.body.id, streak: 0 },
    ]);

    log(telegramId, created.body.id);

    const after = call(progressRoute, { telegramId }).body;
    assert.deepEqual(after.personalToday, [
      { personalHabitId: created.body.id, logged: true, value: 1 },
    ]);
    assert.equal(after.personalStreaks[0].streak, 1);
    // The point totals are exactly where they were.
    assert.equal(after.todayPoints, 0);
    assert.equal(after.totalPoints, 0);
    assert.deepEqual(after.today, []);
    assert.deepEqual(after.streaks, []);
  });

  it("appears in the weekly grid alongside the room's habits, flagged but not separated", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    createHabit(room.id, "Room habit", "binary", 5);
    create(telegramId, { name: "My habit", type: "binary" });

    const week = call(progressWeekRoute, { telegramId }).body;
    assert.deepEqual(
      week.habits.map((h: { name: string; personal: boolean }) => [h.name, h.personal]),
      [
        ["Room habit", false],
        ["My habit", true],
      ]
    );
    assert.equal(week.habits[1].days.length, 7);
  });
});

describe("personal habits — room membership", () => {
  it("are deleted when the member leaves the room", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    const user = getUserByTelegramId(telegramId)!;
    const created = create(telegramId, { name: "Walk", type: "binary" });
    log(telegramId, created.body.id);

    assert.equal(leaveCurrentRoom(user.id).left, true);
    assert.deepEqual(listPersonalHabits(user.id, room.id), []);

    // Rejoining the same room starts from an empty list.
    setUserCurrentRoom(user.id, room.id);
    assert.deepEqual(list(telegramId).body, []);
  });

  it("are deleted when the member is kicked", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    const user = getUserByTelegramId(telegramId)!;
    create(telegramId, { name: "Walk", type: "binary" });

    assert.equal(kickUserFromRoom(user.id, room.id).kicked, true);
    assert.deepEqual(listPersonalHabits(user.id, room.id), []);
  });

  it("answers an empty list for a member between rooms", () => {
    const { room } = makeRoom();
    const telegramId = makeMember(room.id);
    const user = getUserByTelegramId(telegramId)!;
    create(telegramId, { name: "Walk", type: "binary" });
    setUserCurrentRoom(user.id, null);

    const result = list(telegramId);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, []);
    // And writes say so plainly rather than 500ing.
    assert.equal(create(telegramId, { name: "x", type: "binary" }).body.error, "no_room");
  });
});
