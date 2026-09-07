import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response } from "express";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN = "fasting-reminder-test";
process.env.CHALLENGE_START_DATE = "2026-08-01";
process.env.CHALLENGE_END_DATE = "2026-08-31";
process.env.TIMEZONE = "Asia/Hong_Kong";
process.env.DB_PATH = ":memory:";

const { createUser, updateUserProfile } = await import("../db/repository.js");
const {
  buildFastingReminderMessage,
  fastingHadithIndex,
  sendDueFastingReminders,
} = await import("../scheduler/fastingReminder.js");
const { getProfileRoute, patchProfileRoute } = await import("./routes/profile.js");

/** Sunday 2026-08-16 20:00 in Asia/Hong_Kong. */
const SUNDAY_20 = new Date("2026-08-16T12:00:00.000Z");
/** Wednesday 2026-08-19 20:00 in Asia/Hong_Kong. */
const WEDNESDAY_20 = new Date("2026-08-19T12:00:00.000Z");
/** Monday 2026-08-17 20:00 in Asia/Hong_Kong. */
const MONDAY_20 = new Date("2026-08-17T12:00:00.000Z");
/** Sunday 2026-08-16 21:00 in Asia/Hong_Kong. */
const SUNDAY_21 = new Date("2026-08-16T13:00:00.000Z");

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

function mockBot(sendMessage: (chatId: number, text: string) => Promise<void>) {
  return {
    api: { sendMessage },
  } as unknown as Bot<MyContext>;
}

function enableFasting(telegramId: number, time = "20:00"): void {
  updateUserProfile(telegramId, {
    fastingReminderEnabled: true,
    fastingReminderTime: time,
  });
}

it("sends Monday framing on Sunday and Thursday framing on Wednesday", async () => {
  const sundayId = 860000001;
  const wednesdayId = 860000002;
  createUser(sundayId, "Fast Sun", 100);
  createUser(wednesdayId, "Fast Wed", 100);
  enableFasting(sundayId);
  enableFasting(wednesdayId);

  const sent: { id: number; text: string }[] = [];
  const bot = mockBot(async (id, text) => {
    sent.push({ id, text });
  });

  await sendDueFastingReminders(bot, SUNDAY_20);
  assert.equal(sent.length, 2);
  assert.match(sent[0]!.text, /Tomorrow is Monday — a Sunnah day to fast/);
  assert.match(sent[0]!.text, /Fasting reminder/);
  assert.match(sent[0]!.text, /Sahih Muslim 1162e|Jami' at-Tirmidhi 747|Sunan an-Nasa'i 2360/);

  sent.length = 0;
  await sendDueFastingReminders(bot, WEDNESDAY_20);
  assert.equal(sent.length, 2);
  assert.match(sent[0]!.text, /Tomorrow is Thursday — a Sunnah day to fast/);
});

it("does not send on Monday or when disabled / time mismatches", async () => {
  const enabled = 860000010;
  const disabled = 860000011;
  const wrongTime = 860000012;
  createUser(enabled, "Enabled Fast", 100);
  createUser(disabled, "Disabled Fast", 100);
  createUser(wrongTime, "Wrong Time", 100);
  enableFasting(enabled);
  updateUserProfile(disabled, {
    reminderEnabled: true,
    fastingReminderEnabled: false,
    fastingReminderTime: "20:00",
  });
  enableFasting(wrongTime, "21:00");

  const sent: number[] = [];
  const bot = mockBot(async (id) => {
    sent.push(id);
  });

  await sendDueFastingReminders(bot, MONDAY_20);
  assert.deepEqual(
    sent.filter((id) => [enabled, disabled, wrongTime].includes(id)),
    []
  );

  sent.length = 0;
  await sendDueFastingReminders(bot, SUNDAY_20);
  assert.deepEqual(
    sent.filter((id) => [enabled, disabled, wrongTime].includes(id)),
    [enabled]
  );

  sent.length = 0;
  await sendDueFastingReminders(bot, SUNDAY_21);
  assert.deepEqual(
    sent.filter((id) => [enabled, disabled, wrongTime].includes(id)),
    [wrongTime]
  );
});

it("rotates hadith across consecutive fire days and stays stable on the same Sunday", () => {
  const sundayIndex = fastingHadithIndex(SUNDAY_20);
  const wednesdayIndex = fastingHadithIndex(WEDNESDAY_20);
  assert.notEqual(sundayIndex, wednesdayIndex);
  assert.equal(fastingHadithIndex(SUNDAY_20), sundayIndex);
  assert.equal(fastingHadithIndex(new Date("2026-08-16T12:30:00.000Z")), sundayIndex);

  const sundayText = buildFastingReminderMessage(SUNDAY_20);
  const wednesdayText = buildFastingReminderMessage(WEDNESDAY_20);
  assert.notEqual(sundayText, wednesdayText);
  assert.equal(buildFastingReminderMessage(SUNDAY_20), sundayText);
});

it("continues after one failed DM and skips overlapping ticks", async () => {
  const first = 860000020;
  const second = 860000021;
  createUser(first, "Fail User", 100);
  createUser(second, "Ok User", 100);
  enableFasting(first);
  enableFasting(second);

  const sent: number[] = [];
  const failingBot = mockBot(async (id) => {
    if (id === first) throw new Error("blocked");
    sent.push(id);
  });
  await sendDueFastingReminders(failingBot, SUNDAY_20);
  assert.deepEqual(
    sent.filter((id) => [first, second].includes(id)),
    [second]
  );

  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const slowBot = mockBot(async () => {
    started += 1;
    await hold;
  });
  const inFlight = sendDueFastingReminders(slowBot, SUNDAY_20);
  while (started === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await sendDueFastingReminders(slowBot, SUNDAY_20);
  assert.equal(started, 1);
  release();
  await inFlight;
});

it("returns fasting defaults and validates PATCH fields", () => {
  const telegramId = 860000030;
  createUser(telegramId, "Profile Fast", 100);

  const get = capture();
  getProfileRoute({ telegramId } as Request, get.res);
  assert.equal(get.status(), 200);
  assert.equal(get.body().fastingReminderEnabled, false);
  assert.equal(get.body().fastingReminderTime, "20:00");

  const badEnabled = capture();
  patchProfileRoute(
    { telegramId, body: { fastingReminderEnabled: "yes" } } as Request,
    badEnabled.res
  );
  assert.equal(badEnabled.status(), 400);
  assert.deepEqual(badEnabled.body(), {
    success: false,
    error: "invalid_fasting_reminder_enabled",
  });

  const badTime = capture();
  patchProfileRoute(
    { telegramId, body: { fastingReminderTime: null } } as Request,
    badTime.res
  );
  assert.equal(badTime.status(), 400);
  assert.deepEqual(badTime.body(), {
    success: false,
    error: "invalid_fasting_reminder_time",
  });

  const ok = capture();
  patchProfileRoute(
    {
      telegramId,
      body: { fastingReminderEnabled: true, fastingReminderTime: "21:15" },
    } as Request,
    ok.res
  );
  assert.equal(ok.status(), 200);
  assert.equal(ok.body().fastingReminderEnabled, true);
  assert.equal(ok.body().fastingReminderTime, "21:15");
});
