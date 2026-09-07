import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response } from "express";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN = "before-window-test";
process.env.CHALLENGE_START_DATE = "2099-01-01";
process.env.CHALLENGE_END_DATE = "2100-01-01";
process.env.TIMEZONE = "Asia/Hong_Kong";
process.env.REMINDER_TIME = "20:00";
process.env.DB_PATH = ":memory:";

const { createUser } = await import("../db/repository.js");
const { logRoute } = await import("./routes/log.js");
const { progressRoute } = await import("./routes/progress.js");
const { sendDueReminders } = await import("../scheduler/reminder.js");

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

it("registers, logs, and counts streak before informational start", async () => {
  const telegramId = 810000001;
  createUser(
    telegramId,
    "Before Window",
    100,
    {
      telegramUsername: "before_window",
      telegramFirstName: "Before",
      telegramLastName: "Window",
    },
    "Before Window User"
  );

  const logging = responseCapture();
  logRoute(
    { telegramId, body: { count: 101 } } as Request,
    logging.res
  );
  assert.equal(logging.getStatus(), 200);
  assert.equal(logging.getBody().newTodayTotal, 101);

  const progress = responseCapture();
  progressRoute({ telegramId } as Request, progress.res);
  const body = progress.getBody();
  assert.equal(body.challengeStatus, "not_started");
  assert.equal(body.todayTotal, 101);
  assert.equal(body.dailyGoal, 100);
  assert.equal(body.streak, 1);
  assert.deepEqual(body.last7Days.at(-1), {
    date: body.last7Days.at(-1).date,
    total: 101,
    metGoal: true,
    locked: false,
  });

  const sentAt: number[] = [];
  const bot = {
    api: {
      async sendMessage(chatId: number) {
        sentAt.push(chatId);
        return {};
      },
    },
  } as unknown as Bot<MyContext>;

  // All are 20:00 Asia/Hong_Kong: before, inside, and after the date window.
  await sendDueReminders(bot, new Date("2098-06-01T12:00:00Z"));
  await sendDueReminders(bot, new Date("2099-06-01T12:00:00Z"));
  await sendDueReminders(bot, new Date("2101-06-01T12:00:00Z"));
  assert.deepEqual(sentAt, [telegramId, telegramId, telegramId]);
});
