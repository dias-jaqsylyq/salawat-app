import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN = "reset-progress-test";
process.env.CHALLENGE_START_DATE = "2026-08-01";
process.env.CHALLENGE_END_DATE = "2026-08-31";
process.env.TIMEZONE = "Asia/Hong_Kong";
process.env.DB_PATH = ":memory:";

const { db } = await import("../db/client.js");
const {
  addLog,
  createUser,
  getDayOverrides,
  getJamaatTotal,
  getUserByTelegramId,
  getUserTotal,
  upsertDayOverride,
} = await import("../db/repository.js");
const { getChallengeWindowUtc } = await import("../utils/challenge.js");
const { computeUserProgressFields } = await import("./routes/progressFields.js");
const { resetProgressRoute } = await import("./routes/resetProgress.js");

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

function callReset(
  telegramId: number,
  body: unknown
): { status: number; body: any } {
  const result = capture();
  resetProgressRoute(
    { telegramId, body } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

it("soft resets repeatedly, then fully drops retained Jamaat contribution", () => {
  const telegramId = 840000001;
  const user = createUser(
    telegramId,
    "Reset User",
    100,
    {
      telegramUsername: "reset_user",
      telegramFirstName: "Reset",
      telegramLastName: "User",
    }
  );
  db.prepare(
    "UPDATE users SET reminder_enabled = 0, reminder_time = '21:30' WHERE id = ?"
  ).run(user.id);

  addLog(user.id, 100);
  upsertDayOverride(user.id, "2026-08-14", true);
  assert.equal(getUserTotal(user.id), 100);
  assert.equal(getJamaatTotal(), 100);
  assert.equal(getJamaatTotal(getChallengeWindowUtc()), 100);

  const first = callReset(telegramId, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.dropFromJamaat, false);
  assert.equal(first.body.total, 0);
  assert.equal(first.body.deleted.logs, 1);
  assert.equal(first.body.deleted.dayGoalOverrides, 1);
  assert.equal(getUserTotal(user.id), 0);
  assert.equal(getJamaatTotal(), 100);
  // Retained carry has no timestamps and intentionally affects all-time only.
  assert.equal(getJamaatTotal(getChallengeWindowUtc()), 0);
  assert.equal(getDayOverrides(user.id, "2026-08-01", "2026-08-31").size, 0);

  const afterFirst = getUserByTelegramId(telegramId)!;
  assert.equal(afterFirst.nickname, "Reset User");
  assert.equal(afterFirst.goal, 100);
  assert.equal(afterFirst.reminder_enabled, 0);
  assert.equal(afterFirst.reminder_time, "21:30");
  assert.equal(afterFirst.retained_jamaat_total, 100);
  assert.ok(afterFirst.progress_started_at);
  const progress = computeUserProgressFields(afterFirst);
  assert.equal(progress.total, 0);
  assert.equal(progress.streak, 0);
  assert.equal(progress.last7Days.at(-2)?.locked, true);
  assert.equal(progress.last7Days.at(-1)?.locked, false);

  addLog(user.id, 50);
  assert.equal(getJamaatTotal(), 150);
  const second = callReset(telegramId, { dropFromJamaat: false });
  assert.equal(second.status, 200);
  assert.equal(getUserByTelegramId(telegramId)!.retained_jamaat_total, 150);
  assert.equal(getJamaatTotal(), 150);

  addLog(user.id, 25);
  assert.equal(getJamaatTotal(), 175);
  const dropped = callReset(telegramId, { dropFromJamaat: true });
  assert.equal(dropped.status, 200);
  assert.equal(dropped.body.dropFromJamaat, true);
  assert.equal(getUserByTelegramId(telegramId)!.retained_jamaat_total, 0);
  assert.equal(getUserTotal(user.id), 0);
  assert.equal(getJamaatTotal(), 0);
});

it("defaults false, validates body, and requires registration", () => {
  const invalid = callReset(840000001, { dropFromJamaat: "yes" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "invalid_drop_from_jamaat");

  const missing = callReset(999999999, {});
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error, "not_registered");
});
