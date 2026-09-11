import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "profile-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createUser } = await import("../../db/repository.js");
const { getProfileRoute, patchProfileRoute } = await import("./profile.js");

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

function callGet(telegramId: number) {
  const result = capture();
  getProfileRoute({ telegramId } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callPatch(telegramId: number, body: unknown) {
  const result = capture();
  patchProfileRoute({ telegramId, body } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

let nextTelegramId = 780000001;
function makeUser(): number {
  const telegramId = nextTelegramId++;
  createUser(telegramId, `profile-tester-${telegramId}`);
  return telegramId;
}

describe("PATCH /api/profile — timezone", () => {
  it("accepts a valid IANA timezone and returns it from a later GET", () => {
    const telegramId = makeUser();

    const patched = callPatch(telegramId, { timezone: "America/New_York" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.timezone, "America/New_York");

    const fetched = callGet(telegramId);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.timezone, "America/New_York");
  });

  it("rejects a garbage timezone string", () => {
    const telegramId = makeUser();

    const { status, body } = callPatch(telegramId, { timezone: "Not/AZone" });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_timezone");
  });

  it("defaults to null (unset) for a user who has never set one", () => {
    const telegramId = makeUser();
    const { body } = callGet(telegramId);
    assert.equal(body.timezone, null);
  });

  it("resets to unset when explicitly patched with null", () => {
    const telegramId = makeUser();
    callPatch(telegramId, { timezone: "Asia/Tokyo" });

    const reset = callPatch(telegramId, { timezone: null });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.timezone, null);
  });

  it("403s for a telegram id with no registered user", () => {
    const { status, body } = callPatch(999_999_999, { timezone: "Asia/Tokyo" });
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });
});

describe("PATCH /api/profile — fasting reminder", () => {
  it("defaults to off at 20:00 and turns on with a chosen time", () => {
    const telegramId = makeUser();

    const initial = callGet(telegramId);
    assert.equal(initial.body.fastingReminderEnabled, false);
    assert.equal(initial.body.fastingReminderTime, "20:00");

    const patched = callPatch(telegramId, {
      fastingReminderEnabled: true,
      fastingReminderTime: "19:30",
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.fastingReminderEnabled, true);
    assert.equal(patched.body.fastingReminderTime, "19:30");

    assert.equal(callGet(telegramId).body.fastingReminderEnabled, true);
  });

  it("rejects a non-boolean opt-in and a null time", () => {
    const telegramId = makeUser();

    const badFlag = callPatch(telegramId, { fastingReminderEnabled: "yes" });
    assert.equal(badFlag.status, 400);
    assert.equal(badFlag.body.error, "invalid_fasting_reminder_enabled");

    // Unlike reminderTime there is no global default to fall back to, so null
    // is not a way to clear it.
    const nullTime = callPatch(telegramId, { fastingReminderTime: null });
    assert.equal(nullTime.status, 400);
    assert.equal(nullTime.body.error, "invalid_fasting_reminder_time");
  });
});

describe("PATCH /api/profile — streak display", () => {
  it("defaults to the weekly view starting on Monday", () => {
    const { body } = callGet(makeUser());
    assert.equal(body.streakDisplay, "weekly");
    assert.equal(body.weekStartDay, 1);
  });

  it("switches to the current-streak view and a Sunday week start", () => {
    const telegramId = makeUser();

    const patched = callPatch(telegramId, { streakDisplay: "current", weekStartDay: 0 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.streakDisplay, "current");
    assert.equal(patched.body.weekStartDay, 0);

    const fetched = callGet(telegramId);
    assert.equal(fetched.body.streakDisplay, "current");
    assert.equal(fetched.body.weekStartDay, 0);
  });

  it("rejects an unknown display and an out-of-range week start", () => {
    const telegramId = makeUser();

    const badDisplay = callPatch(telegramId, { streakDisplay: "monthly" });
    assert.equal(badDisplay.status, 400);
    assert.equal(badDisplay.body.error, "invalid_streak_display");

    for (const weekStartDay of [7, -1, 1.5, "1"]) {
      const bad = callPatch(telegramId, { weekStartDay });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, "invalid_week_start_day");
    }

    // Nothing was written by the rejected attempts.
    assert.equal(callGet(telegramId).body.weekStartDay, 1);
  });
});
