import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "room-scope-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  addRoomAdmin,
  createHabit,
  createRoom,
  createUser,
  setUserCurrentRoom,
  upsertHabitLog,
} = await import("../db/repository.js");
const { config } = await import("../config.js");
const { formatDateParts, getTodayInTimezone } = await import("../utils/challenge.js");
const { deleteHabitLogRoute, listHabitsRoute, logHabitRoute } = await import("./routes/habits.js");
const { progressRoute } = await import("./routes/progress.js");
const { leaderboardRoute } = await import("./routes/leaderboard.js");
const { listAdminHabitsRoute, patchHabitRoute } = await import("./routes/adminHabits.js");
const { adminLeaderboardRoute } = await import("./routes/adminLeaderboard.js");
const { adminStatsRoute } = await import("./routes/adminStatus.js");
const { adminExportCsvRoute } = await import("./routes/export.js");

const TODAY = formatDateParts(getTodayInTimezone(config.timezone));

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

/** A response that records the CSV body and headers instead of JSON. */
function captureCsv(): {
  res: Response;
  status: () => number;
  text: () => string;
  headers: () => Record<string, string>;
} {
  let status = 200;
  let text = "";
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    send(value: string) {
      text = value;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => status, text: () => text, headers: () => headers };
}

function call(
  handler: (req: Request, res: Response) => void,
  req: Partial<Request> & { telegramId: number }
): { status: number; body: any } {
  const result = capture();
  handler(req as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

let nextTelegramId = 960000001;

function makeRoom(name: string, password: string) {
  const owner = createUser(nextTelegramId++, `${password}-owner`);
  const room = createRoom(name, password, owner.id);
  setUserCurrentRoom(owner.id, room.id);
  addRoomAdmin(room.id, owner.id);
  return { room, owner };
}

function joinRoom(roomId: number, nickname: string) {
  const user = createUser(nextTelegramId++, nickname);
  setUserCurrentRoom(user.id, roomId);
  return user;
}

/**
 * Two rooms living side by side in one database, each with its own admin,
 * member, habit and logged points — the shape every assertion below checks the
 * API never lets leak across (MULTI ROOM PRD §3).
 */
const alpha = makeRoom("Alpha room", "alpha-room-pass");
const beta = makeRoom("Beta room", "beta-room-pass");

const alphaMember = joinRoom(alpha.room.id, "alpha-member");
const betaMember = joinRoom(beta.room.id, "beta-member");

const alphaHabit = createHabit(alpha.room.id, "Alpha habit", "quantity", 2);
const betaHabit = createHabit(beta.room.id, "Beta habit", "quantity", 5);

upsertHabitLog(alphaMember.id, alphaHabit.id, 10, TODAY);
upsertHabitLog(betaMember.id, betaHabit.id, 10, TODAY);

/** Registered, but between rooms (PRD §3a) — reads answer empty, writes 400. */
const roomless = createUser(nextTelegramId++, "roomless-user");

describe("GET /api/habits", () => {
  it("lists only the caller's own room's habits", () => {
    const { body } = call(listHabitsRoute, { telegramId: alphaMember.telegram_id });
    assert.deepEqual(
      body.map((h: any) => h.id),
      [alphaHabit.id]
    );
  });

  it("is empty for a user between rooms", () => {
    const { status, body } = call(listHabitsRoute, { telegramId: roomless.telegram_id });
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });
});

describe("POST/DELETE /api/habits/:id/log", () => {
  it("404s on another room's habit, exactly like an unknown id", () => {
    const logged = call(logHabitRoute, {
      telegramId: alphaMember.telegram_id,
      params: { id: String(betaHabit.id) },
      body: { value: 1 },
    } as any);
    assert.equal(logged.status, 404);
    assert.equal(logged.body.error, "habit_not_found");

    const deleted = call(deleteHabitLogRoute, {
      telegramId: alphaMember.telegram_id,
      params: { id: String(betaHabit.id) },
    } as any);
    assert.equal(deleted.status, 404);
    assert.equal(deleted.body.error, "habit_not_found");
  });

  it("400s for a user between rooms", () => {
    const { status, body } = call(logHabitRoute, {
      telegramId: roomless.telegram_id,
      params: { id: String(alphaHabit.id) },
      body: { value: 1 },
    } as any);
    assert.equal(status, 400);
    assert.equal(body.error, "no_room");
  });
});

describe("GET /api/progress", () => {
  it("reports the caller's room, its habits and only its points", () => {
    const { body } = call(progressRoute, { telegramId: alphaMember.telegram_id });
    assert.equal(body.registered, true);
    assert.deepEqual(body.room, {
      id: alpha.room.id,
      name: "Alpha room",
      categoriesEnabled: false,
    });
    assert.equal(body.totalPoints, 20);
    assert.deepEqual(
      body.today.map((entry: any) => entry.habitId),
      [alphaHabit.id]
    );
    assert.deepEqual(
      body.streaks.map((entry: any) => entry.habitId),
      [alphaHabit.id]
    );
  });

  it("leaves points earned in a previous room behind on a move", () => {
    // The logs survive the move (PRD §1) — they just stop counting here.
    setUserCurrentRoom(betaMember.id, alpha.room.id);
    const { body } = call(progressRoute, { telegramId: betaMember.telegram_id });
    assert.equal(body.room.id, alpha.room.id);
    assert.equal(body.totalPoints, 0);
    setUserCurrentRoom(betaMember.id, beta.room.id);
  });

  it("answers an empty day for a user between rooms", () => {
    const { body } = call(progressRoute, { telegramId: roomless.telegram_id });
    assert.equal(body.registered, true);
    assert.equal(body.room, null);
    assert.equal(body.totalPoints, 0);
    assert.deepEqual(body.today, []);
    assert.deepEqual(body.streaks, []);
  });
});

describe("GET /api/leaderboard", () => {
  it("ranks only the caller's own room's members", () => {
    const { body } = call(leaderboardRoute, { telegramId: alphaMember.telegram_id });
    const nicknames = body.leaderboard.map((row: any) => row.nickname);
    assert.ok(nicknames.includes("alpha-member"));
    assert.ok(!nicknames.includes("beta-member"));
  });

  it("is empty for a user between rooms", () => {
    const { body } = call(leaderboardRoute, { telegramId: roomless.telegram_id });
    assert.deepEqual(body.leaderboard, []);
  });
});

describe("admin routes", () => {
  it("lists only the caller's own room's habits", () => {
    const { body } = call(listAdminHabitsRoute, { telegramId: alpha.owner.telegram_id });
    assert.deepEqual(
      body.map((h: any) => h.id),
      [alphaHabit.id]
    );
  });

  it("404s when an admin patches another room's habit", () => {
    const { status, body } = call(patchHabitRoute, {
      telegramId: alpha.owner.telegram_id,
      params: { id: String(betaHabit.id) },
      body: { isActive: false },
    } as any);
    assert.equal(status, 404);
    assert.equal(body.error, "habit_not_found");
    // ...and the other room's habit is untouched.
    const stillActive = call(listAdminHabitsRoute, { telegramId: beta.owner.telegram_id });
    assert.equal(stillActive.body[0].isActive, true);
  });

  it("ranks and counts only the caller's own room's members", () => {
    const board = call(adminLeaderboardRoute, { telegramId: alpha.owner.telegram_id });
    const nicknames = board.body.leaderboard.map((row: any) => row.nickname);
    assert.ok(nicknames.includes("alpha-member"));
    assert.ok(!nicknames.includes("beta-member"));

    const stats = call(adminStatsRoute, { telegramId: alpha.owner.telegram_id });
    assert.equal(stats.body.participantCount, 2);
  });

  it("marks who already holds admin status, for the promote/demote UI", () => {
    const { body } = call(adminLeaderboardRoute, { telegramId: alpha.owner.telegram_id });
    const owner = body.leaderboard.find((row: any) => row.telegramId === alpha.owner.telegram_id);
    const member = body.leaderboard.find((row: any) => row.telegramId === alphaMember.telegram_id);
    assert.equal(owner.isRoomAdmin, true);
    assert.equal(owner.isYou, true);
    assert.equal(member.isRoomAdmin, false);
    assert.equal(member.isYou, false);
  });

  it("exports only the caller's own room, naming the file after it", () => {
    const result = captureCsv();
    adminExportCsvRoute(
      { telegramId: alpha.owner.telegram_id } as unknown as Request,
      result.res
    );
    assert.match(result.text(), /alpha-member/);
    assert.doesNotMatch(result.text(), /beta-member/);
    assert.match(
      result.headers()["Content-Disposition"]!,
      new RegExp(`habit-tracker-alpha-room-${alpha.room.id}-`)
    );
  });
});
