import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "test-token";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createHabit, createRoom, createUser, setUserCurrentRoom, upsertHabitLog } = await import(
  "../../db/repository.js"
);
const { getCurrentWeekBounds, shiftWeekStart } = await import("../../utils/challenge.js");
const { leaderboardRoute } = await import("./leaderboard.js");
const { adminLeaderboardRoute } = await import("./adminLeaderboard.js");

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
  route({ query: {}, ...req } as unknown as Request, res);
  return { status, body };
}

let nextTelegramId = 770000001;

const { weekStart, weekEnd } = getCurrentWeekBounds();
/** A day inside the week before this one — never part of the weekly board. */
const LAST_WEEK = shiftWeekStart(weekStart, -1);

const room = (() => {
  const owner = createUser(nextTelegramId++, "board-owner");
  const created = createRoom("Board room", "board-room-pass", owner.id);
  setUserCurrentRoom(owner.id, created.id);
  return { id: created.id, owner };
})();

function member(nickname: string) {
  const user = createUser(nextTelegramId++, nickname);
  setUserCurrentRoom(user.id, room.id);
  return user;
}

const daily = createHabit(room.id, "Board daily", 5);
const weekly = createHabit(room.id, "Board weekly", 30, null, "weekly");

// leader: 5 + 30 this week. tiedA/tiedB: 5 each. idler: nothing this week, but
// a pile of points last week, which the weekly board must ignore entirely.
const leader = member("board-leader");
const tiedA = member("board-tied-a");
const tiedB = member("board-tied-b");
const idler = member("board-idler");

upsertHabitLog(leader.id, daily.id, 1, weekStart);
upsertHabitLog(leader.id, weekly.id, 1, weekEnd);
upsertHabitLog(tiedA.id, daily.id, 1, weekStart);
upsertHabitLog(tiedB.id, daily.id, 1, weekStart);
upsertHabitLog(idler.id, daily.id, 1, LAST_WEEK);

describe("GET /api/leaderboard — what a member may see", () => {
  it("covers this week only: daily and weekly points together, nothing from last week", () => {
    const { body } = call(leaderboardRoute, { telegramId: leader.telegram_id });

    assert.equal(body.weekStart, weekStart);
    assert.equal(body.weekEnd, weekEnd);
    // 5 from the daily habit, 30 from the weekly one.
    const you = body.leaderboard.find((row: any) => row.isYou);
    assert.equal(you.points, 35);

    // The idler earned last week and nothing this week: still on the board, and
    // last week's points are not on it.
    const names = body.leaderboard.map((row: any) => row.nickname);
    assert.ok(names.includes("board-idler"));
  });

  it("shows every member's name and place but nobody else's points", () => {
    const { body } = call(leaderboardRoute, { telegramId: tiedA.telegram_id });

    const names = body.leaderboard.map((row: any) => row.nickname);
    for (const nickname of ["board-leader", "board-tied-a", "board-tied-b", "board-idler"]) {
      assert.ok(names.includes(nickname), `${nickname} missing from the board`);
    }

    for (const row of body.leaderboard) {
      if (row.isYou) continue;
      // Absent, not zero and not null: a client cannot render a figure that was
      // never sent, and cannot mistake a hidden score for a real 0.
      assert.equal("points" in row, false, `${row.nickname} leaked a points field`);
      assert.equal("totalPoints" in row, false, `${row.nickname} leaked a totalPoints field`);
      assert.equal("realName" in row, false, `${row.nickname} leaked a real name`);
      assert.equal("telegramId" in row, false, `${row.nickname} leaked a telegram id`);
    }

    const you = body.leaderboard.find((row: any) => row.isYou);
    assert.equal(you.nickname, "board-tied-a");
    assert.equal(you.points, 5);
  });

  it("gives tied members the same place and skips the places they used up", () => {
    const { body } = call(leaderboardRoute, { telegramId: leader.telegram_id });
    const rankOf = (nickname: string) =>
      body.leaderboard.find((row: any) => row.nickname === nickname).rank;

    assert.equal(rankOf("board-leader"), 1);
    // Both on 5 — both second, and the next member is fourth, not third.
    assert.equal(rankOf("board-tied-a"), 2);
    assert.equal(rankOf("board-tied-b"), 2);
    assert.equal(rankOf("board-idler"), 4);
  });

  it("is empty, but still names the week, for a user between rooms", () => {
    const wanderer = createUser(nextTelegramId++, "board-roomless");
    const { body } = call(leaderboardRoute, { telegramId: wanderer.telegram_id });
    assert.deepEqual(body.leaderboard, []);
    assert.equal(body.weekStart, weekStart);
  });
});

describe("GET /api/admin/leaderboard — what an admin may see", () => {
  it("defaults to all-time, with everyone's real points", () => {
    const { body } = call(adminLeaderboardRoute, { telegramId: room.owner.telegram_id });

    assert.equal(body.period, "all-time");
    const pointsOf = (nickname: string) =>
      body.leaderboard.find((row: any) => row.nickname === nickname).totalPoints;

    assert.equal(pointsOf("board-leader"), 35);
    // Last week's points are all-time points — only the weekly view drops them.
    assert.equal(pointsOf("board-idler"), 5);
  });

  it("switches to the same week members see, still with everyone's points", () => {
    const { body } = call(adminLeaderboardRoute, {
      telegramId: room.owner.telegram_id,
      query: { period: "weekly" },
    });

    assert.equal(body.period, "weekly");
    assert.equal(body.weekStart, weekStart);
    const pointsOf = (nickname: string) =>
      body.leaderboard.find((row: any) => row.nickname === nickname).totalPoints;

    assert.equal(pointsOf("board-leader"), 35);
    assert.equal(pointsOf("board-tied-a"), 5);
    // Nothing this week, so 0 here even though all-time says 5.
    assert.equal(pointsOf("board-idler"), 0);
  });

  it("rejects an unknown period rather than quietly picking one", () => {
    const { status, body } = call(adminLeaderboardRoute, {
      telegramId: room.owner.telegram_id,
      query: { period: "monthly" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_period");
  });
});
