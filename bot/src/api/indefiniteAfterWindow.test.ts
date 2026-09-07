import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN = "after-window-test";
process.env.CHALLENGE_START_DATE = "2020-01-01";
process.env.CHALLENGE_END_DATE = "2020-01-31";
process.env.TIMEZONE = "Asia/Hong_Kong";
process.env.DB_PATH = ":memory:";

const { createUser } = await import("../db/repository.js");
const { logRoute } = await import("./routes/log.js");

function responseCapture(): {
  res: Response;
  getStatus: () => number;
  getBody: () => any;
} {
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
  return { res, getStatus: () => status, getBody: () => body };
}

it("registers and logs after informational end", () => {
  const telegramId = 820000001;
  createUser(
    telegramId,
    "After Window",
    100,
    {
      telegramUsername: "after_window",
      telegramFirstName: "After",
      telegramLastName: "Window",
    },
    "After Window User"
  );

  const logging = responseCapture();
  logRoute(
    { telegramId, body: { count: 5 } } as Request,
    logging.res
  );
  assert.equal(logging.getStatus(), 200);
  assert.equal(logging.getBody().newTotal, 5);
});
