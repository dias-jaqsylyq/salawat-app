import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN = "admin-period-test";
process.env.CHALLENGE_START_DATE = "2026-08-15";
process.env.CHALLENGE_END_DATE = "2026-09-13";
process.env.TIMEZONE = "Asia/Hong_Kong";
process.env.DB_PATH = ":memory:";

const { db } = await import("../db/client.js");
const {
  getExportRows,
  getJamaatTotal,
  getLeaderboard,
} = await import("../db/repository.js");
const { getChallengeWindowUtc } = await import("../utils/challenge.js");
const { buildExportCsv } = await import("./routes/export.js");
const { adminLeaderboardRoute } = await import("./routes/adminLeaderboard.js");

function insertUser(telegramId: number, nickname: string): number {
  const result = db
    .prepare("INSERT INTO users (telegram_id, nickname, goal) VALUES (?, ?, 100)")
    .run(telegramId, nickname);
  return Number(result.lastInsertRowid);
}

function insertLog(userId: number, count: number, loggedAt: string): void {
  db.prepare(
    "INSERT INTO logs (user_id, count, logged_at) VALUES (?, ?, ?)"
  ).run(userId, count, loggedAt);
}

it("separates all-time and inclusive Mawlid results/exports", () => {
  const alpha = insertUser(830000001, "Alpha");
  const beta = insertUser(830000002, "Beta");
  insertUser(830000003, "Gamma");

  // HKT window is [2026-08-14 16:00 UTC, 2026-09-13 16:00 UTC).
  insertLog(alpha, 1, "2026-08-14 15:59:59"); // before
  insertLog(alpha, 10, "2026-08-14 16:00:00"); // start boundary
  insertLog(alpha, 20, "2026-09-13 15:59:59"); // end date, included
  insertLog(alpha, 100, "2026-09-13 16:00:00"); // after
  insertLog(beta, 30, "2026-08-20 00:00:00"); // inside

  const window = getChallengeWindowUtc();
  assert.deepEqual(window, {
    startUtc: "2026-08-14 16:00:00",
    endUtc: "2026-09-13 16:00:00",
  });

  assert.deepEqual(
    getLeaderboard().map(({ nickname, total }) => ({ nickname, total })),
    [
      { nickname: "Alpha", total: 131 },
      { nickname: "Beta", total: 30 },
      { nickname: "Gamma", total: 0 },
    ]
  );
  assert.equal(getJamaatTotal(), 161);

  assert.deepEqual(
    getLeaderboard(window).map(({ nickname, total }) => ({ nickname, total })),
    [
      { nickname: "Alpha", total: 30 },
      { nickname: "Beta", total: 30 },
      { nickname: "Gamma", total: 0 },
    ]
  );
  assert.equal(getJamaatTotal(window), 60);
  assert.deepEqual(
    getExportRows(window).map(({ nickname, total }) => ({ nickname, total })),
    [
      { nickname: "Alpha", total: 30 },
      { nickname: "Beta", total: 30 },
      { nickname: "Gamma", total: 0 },
    ]
  );

  const csv = buildExportCsv("mawlid");
  assert.match(csv, /^rank,nickname,real_name,/);
  assert.match(csv, /\n1,Alpha,/);
  assert.match(csv, /\n1,Beta,/);
  assert.match(csv, /\n3,Gamma,/);

  let status = 200;
  let responseBody: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: any) {
      responseBody = value;
      return this;
    },
  } as unknown as Response;
  adminLeaderboardRoute(
    { query: { period: "invalid" } } as unknown as Request,
    res
  );
  assert.equal(status, 400);
  assert.deepEqual(responseBody, {
    success: false,
    error: "invalid_period",
  });
});
