import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN = "real-name-test";
process.env.CHALLENGE_START_DATE = "2026-08-01";
process.env.CHALLENGE_END_DATE = "2026-08-31";
process.env.TIMEZONE = "Asia/Hong_Kong";
process.env.DB_PATH = ":memory:";

const { db } = await import("../db/client.js");
const { createUser, getUserByTelegramId } = await import("../db/repository.js");
const { registerRoute } = await import("./routes/register.js");
const { progressRoute } = await import("./routes/progress.js");
const { getProfileRoute, patchProfileRoute } = await import("./routes/profile.js");
const { leaderboardRoute } = await import("./routes/leaderboard.js");
const { adminLeaderboardRoute } = await import("./routes/adminLeaderboard.js");
const { buildExportCsv } = await import("./routes/export.js");

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

function telegramProfile(telegramId: number) {
  return {
    telegramUsername: `user_${telegramId}`,
    telegramFirstName: "First",
    telegramLastName: "Last",
  };
}

function callRegister(telegramId: number, body: unknown) {
  const result = capture();
  registerRoute(
    { telegramId, telegramProfile: telegramProfile(telegramId), body } as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

function callProgress(telegramId: number) {
  const result = capture();
  progressRoute({ telegramId } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callProfileGet(telegramId: number) {
  const result = capture();
  getProfileRoute({ telegramId } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callProfilePatch(telegramId: number, body: unknown) {
  const result = capture();
  patchProfileRoute({ telegramId, body } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callLeaderboard(telegramId: number) {
  const result = capture();
  leaderboardRoute({ telegramId } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callAdminLeaderboard() {
  const result = capture();
  adminLeaderboardRoute({ query: { period: "all" } } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function assertNoRealNameKeys(value: unknown): void {
  const json = JSON.stringify(value);
  assert.equal(json.includes("realName"), false, `public JSON leaked realName: ${json}`);
  assert.equal(json.includes("real_name"), false, `public JSON leaked real_name: ${json}`);
}

it("requires a valid real name that differs from nickname", () => {
  const blocked = callRegister(850000001, { nickname: "Ali", goal: 100, realName: "Ali Nurlanov" });
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.body, { success: false, error: "register_via_bot" });

  createUser(850000005, "Ali", 100, telegramProfile(850000005), "Ali Nurlanov");
  const stored = getUserByTelegramId(850000005);
  assert.equal(stored?.real_name, "Ali Nurlanov");

  const progress = callProgress(850000005);
  assert.equal(progress.status, 200);
  assert.equal(progress.body.registered, true);
  assert.equal(progress.body.needsRealName, false);
  assertNoRealNameKeys(progress.body);
});

it("flags legacy users and lets PATCH set a real name without leaking it", () => {
  const telegramId = 850000010;
  createUser(telegramId, "LegacyNick", 100, telegramProfile(telegramId), null);
  assert.equal(getUserByTelegramId(telegramId)?.real_name, null);

  const before = callProgress(telegramId);
  assert.equal(before.body.registered, true);
  assert.equal(before.body.needsRealName, true);
  assertNoRealNameKeys(before.body);

  const profile = callProfileGet(telegramId);
  assert.equal(profile.status, 200);
  assertNoRealNameKeys(profile.body);

  const matchCurrent = callProfilePatch(telegramId, { realName: "legacynick" });
  assert.equal(matchCurrent.status, 400);
  assert.deepEqual(matchCurrent.body, { success: false, error: "nickname_matches_real_name" });

  const saved = callProfilePatch(telegramId, { realName: " Legacy Person " });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.nickname, "LegacyNick");
  assertNoRealNameKeys(saved.body);
  assert.equal(getUserByTelegramId(telegramId)?.real_name, "Legacy Person");

  const after = callProgress(telegramId);
  assert.equal(after.body.needsRealName, false);
  assertNoRealNameKeys(after.body);

  const nicknameClash = callProfilePatch(telegramId, { nickname: "legacy person" });
  assert.equal(nicknameClash.status, 400);
  assert.deepEqual(nicknameClash.body, {
    success: false,
    error: "nickname_matches_real_name",
  });
});

it("keeps real names off public leaderboard and on admin results/CSV", () => {
  createUser(850000020, "PublicNick", 50, telegramProfile(850000020), "Private Person");

  const publicBoard = callLeaderboard(850000020);
  assert.equal(publicBoard.status, 200);
  const publicRow = publicBoard.body.leaderboard.find(
    (entry: { nickname: string }) => entry.nickname === "PublicNick"
  );
  assert.equal(publicRow?.nickname, "PublicNick");
  assert.equal(publicRow?.isYou, true);
  assertNoRealNameKeys(publicBoard.body);

  const adminBoard = callAdminLeaderboard();
  assert.equal(adminBoard.status, 200);
  const row = adminBoard.body.leaderboard.find((entry: { nickname: string }) => entry.nickname === "PublicNick");
  assert.equal(row.realName, "Private Person");

  const csv = buildExportCsv("all");
  assert.match(csv, /^rank,nickname,real_name,/);
  assert.match(csv, /,PublicNick,Private Person,/);

  db.prepare("UPDATE users SET real_name = NULL WHERE telegram_id = ?").run(850000020);
  const unnamedAdmin = callAdminLeaderboard();
  const unnamed = unnamedAdmin.body.leaderboard.find(
    (entry: { nickname: string }) => entry.nickname === "PublicNick"
  );
  assert.equal(unnamed.realName, null);
  assert.match(buildExportCsv("all"), /,PublicNick,,/);
});
