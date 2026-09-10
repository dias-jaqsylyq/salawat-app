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
