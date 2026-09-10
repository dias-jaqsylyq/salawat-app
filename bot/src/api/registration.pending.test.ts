import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN = "pending-reg-test";
process.env.CHALLENGE_START_DATE = "2026-08-01";
process.env.CHALLENGE_END_DATE = "2026-08-31";
process.env.TIMEZONE = "Asia/Hong_Kong";
process.env.DB_PATH = ":memory:";

const {
  createUser,
  deletePendingRegistration,
  ensurePendingRegistration,
  getPendingRegistration,
  getUserByTelegramId,
  updatePendingRegistration,
} = await import("../db/repository.js");
const { parseYesNo } = await import("../registration/flow.js");
const { registerRoute } = await import("./routes/register.js");
import type { Request, Response } from "express";

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

describe("parseYesNo", () => {
  it("accepts common yes/no variants", () => {
    assert.equal(parseYesNo("Yes"), true);
    assert.equal(parseYesNo("y"), true);
    assert.equal(parseYesNo("NO"), false);
    assert.equal(parseYesNo("n"), false);
    assert.equal(parseYesNo("maybe"), null);
  });
});

describe("pending_registrations", () => {
  it("resumes the same step and preserves answered fields", () => {
    const telegramId = 910000001;
    const created = ensurePendingRegistration(telegramId);
    // Signup now opens on the admin-or-participant question (PRD §2).
    assert.equal(created.step, "role");

    updatePendingRegistration(telegramId, {
      real_name: "Ali Nurlanov",
      step: "nickname",
    });
    const again = ensurePendingRegistration(telegramId);
    assert.equal(again.step, "nickname");
    assert.equal(again.real_name, "Ali Nurlanov");

    updatePendingRegistration(telegramId, {
      nickname: "Ali",
      reminder_enabled: 0,
      reminder_time: null,
      step: "reminder_opt_in",
    });

    const pending = getPendingRegistration(telegramId)!;
    createUser(
      telegramId,
      pending.nickname!,
      {
        telegramUsername: "ali",
        telegramFirstName: "Ali",
        telegramLastName: null,
      },
      pending.real_name,
      {
        reminderEnabled: false,
        reminderTime: "20:00",
      }
    );
    deletePendingRegistration(telegramId);

    const user = getUserByTelegramId(telegramId)!;
    assert.equal(user.real_name, "Ali Nurlanov");
    assert.equal(user.nickname, "Ali");
    assert.equal(user.reminder_enabled, 0);
    assert.equal(getPendingRegistration(telegramId), undefined);
  });

  it("stores reminder time when opted in", () => {
    const telegramId = 910000002;
    createUser(
      telegramId,
      "OptIn",
      {
        telegramUsername: null,
        telegramFirstName: "A",
        telegramLastName: null,
      },
      "Opt In Person",
      {
        reminderEnabled: true,
        reminderTime: "21:30",
      }
    );
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(user.reminder_enabled, 1);
    assert.equal(user.reminder_time, "21:30");
  });
});

describe("POST /api/register", () => {
  it("returns register_via_bot", () => {
    const result = capture();
    registerRoute(
      {
        telegramId: 910000099,
        telegramProfile: {
          telegramUsername: null,
          telegramFirstName: null,
          telegramLastName: null,
        },
        body: { nickname: "X", realName: "Someone" },
      } as Request,
      result.res
    );
    assert.equal(result.status(), 403);
    assert.deepEqual(result.body(), { success: false, error: "register_via_bot" });
  });
});
