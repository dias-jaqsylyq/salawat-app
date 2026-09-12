import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "fasting-reminder-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createRoom, createUser, setUserCurrentRoom, updateUserProfile } = await import(
  "../db/repository.js"
);
const { parseDateKey } = await import("../utils/challenge.js");
const {
  FASTING_HADITHS,
  buildFastingReminderMessage,
  fastingHadithIndex,
  sendDueFastingReminders,
} = await import("./fastingReminder.js");

/** 20:00 Sunday 2026-08-16 in Asia/Hong_Kong. */
const SUNDAY_20 = new Date("2026-08-16T12:00:00.000Z");
/** 20:00 Monday 2026-08-17 in Asia/Hong_Kong — never a fire day. */
const MONDAY_20 = new Date("2026-08-17T12:00:00.000Z");
/** 20:00 Wednesday 2026-08-19 in Asia/Hong_Kong. */
const WEDNESDAY_20 = new Date("2026-08-19T12:00:00.000Z");
/** 21:00 Sunday in Asia/Hong_Kong — an hour past the default time. */
const SUNDAY_21 = new Date("2026-08-16T13:00:00.000Z");
/**
 * Monday 15:00 in Asia/Hong_Kong, which is still Sunday 20:00 in Pacific/Midway
 * (UTC-11) — the instant that separates "the server's day" from "the user's".
 */
const MIDWAY_SUNDAY_20 = new Date("2026-08-17T07:00:00.000Z");

let nextSentMessageId = 7000;

/**
 * Returns a real Message: sendDueFastingReminders reads message_id off it to
 * queue the deletion, and a stub returning undefined would throw into
 * broadcastUsers' catch and silently count every send as a failure.
 */
function mockBot(sent: { chatId: number; text: string }[]) {
  return {
    api: {
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
        return { message_id: nextSentMessageId++ };
      },
    },
  } as unknown as Bot<MyContext>;
}

let nextTelegramId = 930000001;
let nextRoomSuffix = 1;

function makeRoom() {
  const owner = createUser(nextTelegramId++, `fasting-owner-${nextTelegramId}`);
  return createRoom(`Fasting room ${nextRoomSuffix}`, `fasting-pass-${nextRoomSuffix++}`, owner.id);
}

function makeUser(options: {
  enabled: boolean;
  time?: string;
  timezone?: string;
  inRoom?: boolean;
}): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `fasting-tester-${telegramId}`);
  if (options.inRoom !== false) setUserCurrentRoom(user.id, makeRoom().id);
  updateUserProfile(telegramId, {
    fastingReminderEnabled: options.enabled,
    fastingReminderTime: options.time ?? "20:00",
    timezone: options.timezone,
  });
  return telegramId;
}

describe("fasting reminder — when it fires", () => {
  it("sends Monday framing on Sunday and Thursday framing on Wednesday", async () => {
    const telegramId = makeUser({ enabled: true });

    let sent: { chatId: number; text: string }[] = [];
    await sendDueFastingReminders(mockBot(sent), SUNDAY_20);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, telegramId);
    assert.match(sent[0]!.text, /Tomorrow is Monday — a Sunnah day to fast/);
    assert.match(sent[0]!.text, /Sahih Muslim 1162e|Jami' at-Tirmidhi 747|Sunan an-Nasa'i 2360/);

    sent = [];
    await sendDueFastingReminders(mockBot(sent), WEDNESDAY_20);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /Tomorrow is Thursday — a Sunnah day to fast/);
  });

  it("stays silent on other days, at other times, and when opted out", async () => {
    makeUser({ enabled: true });
    makeUser({ enabled: false });

    for (const now of [MONDAY_20, SUNDAY_21]) {
      const sent: { chatId: number; text: string }[] = [];
      await sendDueFastingReminders(mockBot(sent), now);
      assert.deepEqual(sent, []);
    }
  });

  it("fires on the user's own Sunday evening, not the server's day", async () => {
    const midway = makeUser({ enabled: true, timezone: "Pacific/Midway" });
    // Same instant, same chosen time — but it is already Monday afternoon here.
    makeUser({ enabled: true, timezone: "Asia/Hong_Kong" });

    const sent: { chatId: number; text: string }[] = [];
    await sendDueFastingReminders(mockBot(sent), MIDWAY_SUNDAY_20);

    assert.deepEqual(
      sent.map((s) => s.chatId),
      [midway]
    );
    assert.match(sent[0]!.text, /Tomorrow is Monday/);
  });

  it("skips a user who is between rooms", async () => {
    const roomless = makeUser({ enabled: true, inRoom: false });

    const sent: { chatId: number; text: string }[] = [];
    await sendDueFastingReminders(mockBot(sent), SUNDAY_20);

    // Other opted-in members of this shared in-memory DB are still due; the one
    // with no room is the one that must be absent (PRD §3a).
    assert.ok(!sent.some((s) => s.chatId === roomless));
  });

  it("reaches every opted-in member the same way, whatever room they are in", async () => {
    const a = makeUser({ enabled: true });
    const b = makeUser({ enabled: true });

    const sent: { chatId: number; text: string }[] = [];
    await sendDueFastingReminders(mockBot(sent), SUNDAY_20);

    const reached = sent.map((s) => s.chatId);
    assert.ok(reached.includes(a) && reached.includes(b));
    // One shared text: the reminder is a bot-wide function, not room content.
    assert.equal(new Set(sent.map((s) => s.text)).size, 1);
  });
});

describe("fasting reminder — hadith rotation", () => {
  it("is stable within a fire day and advances to the next one", () => {
    const sunday = parseDateKey("2026-08-16");
    const wednesday = parseDateKey("2026-08-19");
    const nextSunday = parseDateKey("2026-08-23");

    assert.equal(fastingHadithIndex(sunday), fastingHadithIndex(sunday));
    assert.notEqual(fastingHadithIndex(sunday), fastingHadithIndex(wednesday));
    assert.notEqual(fastingHadithIndex(wednesday), fastingHadithIndex(nextSunday));
  });

  it("cycles through all three texts and back", () => {
    const fireDays = ["2026-08-16", "2026-08-19", "2026-08-23", "2026-08-26"].map(parseDateKey);
    const indexes = fireDays.map(fastingHadithIndex);

    assert.equal(new Set(indexes.slice(0, 3)).size, 3);
    assert.equal(indexes[3], indexes[0]);
  });

  it("quotes the hadith its index points at, with attribution", () => {
    const sunday = parseDateKey("2026-08-16");
    const hadith = FASTING_HADITHS[fastingHadithIndex(sunday)]!;
    const message = buildFastingReminderMessage(sunday);

    assert.ok(message.includes(hadith.text));
    assert.ok(message.includes(hadith.attribution));
    // Pure text: no habit, no logging prompt, no app link.
    assert.ok(!/\blog\b/i.test(message));
  });
});
