import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "backfill-reminder-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createRoom, createUser, setUserCurrentRoom, updateUserProfile } = await import(
  "../db/repository.js"
);
const { db } = await import("../db/client.js");
const { BACKFILL_REMINDER_TEXT, sendDueBackfillReminders } = await import(
  "./backfillReminder.js"
);

/** 20:00 Sunday 2026-08-16 in Asia/Hong_Kong. */
const SUNDAY_20 = new Date("2026-08-16T12:00:00.000Z");
/** 20:00 Monday 2026-08-17 in Asia/Hong_Kong — never a fire day. */
const MONDAY_20 = new Date("2026-08-17T12:00:00.000Z");
/** 21:00 Sunday in Asia/Hong_Kong — an hour past the default time. */
const SUNDAY_21 = new Date("2026-08-16T13:00:00.000Z");
/**
 * Monday 15:00 in Asia/Hong_Kong, which is still Sunday 20:00 in Pacific/Midway
 * (UTC-11) — the instant that separates "the server's day" from "the user's".
 */
const MIDWAY_SUNDAY_20 = new Date("2026-08-17T07:00:00.000Z");

let nextSentMessageId = 8000;

/**
 * Returns a real Message: sendDueBackfillReminders reads message_id off it to
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

let nextTelegramId = 940000001;
let nextRoomSuffix = 1;

function makeRoom() {
  const owner = createUser(nextTelegramId++, `backfill-owner-${nextTelegramId}`);
  return createRoom(
    `Backfill room ${nextRoomSuffix}`,
    `backfill-pass-${nextRoomSuffix++}`,
    owner.id
  );
}

function makeUser(options: {
  reminderEnabled: boolean;
  time?: string;
  timezone?: string;
  inRoom?: boolean;
}): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `backfill-tester-${telegramId}`);
  if (options.inRoom !== false) setUserCurrentRoom(user.id, makeRoom().id);
  updateUserProfile(telegramId, {
    reminderEnabled: options.reminderEnabled,
    reminderTime: options.time ?? "20:00",
    timezone: options.timezone,
  });
  return telegramId;
}

/** The deletion the cleanup cron would find queued for this chat, if any. */
function queuedDeletion(telegramId: number): { message_id: number; delete_at: string } | undefined {
  return db
    .prepare("SELECT message_id, delete_at FROM scheduled_message_deletions WHERE chat_id = ?")
    .get(telegramId) as { message_id: number; delete_at: string } | undefined;
}

describe("backfill reminder — when it fires", () => {
  it("sends on Sunday evening at the user's reminder_time", async () => {
    const telegramId = makeUser({ reminderEnabled: true });

    const sent: { chatId: number; text: string }[] = [];
    await sendDueBackfillReminders(mockBot(sent), SUNDAY_20);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, telegramId);
    assert.equal(sent[0]!.text, BACKFILL_REMINDER_TEXT);
  });

  it("stays silent on other days and at other times", async () => {
    makeUser({ reminderEnabled: true });

    for (const now of [MONDAY_20, SUNDAY_21]) {
      const sent: { chatId: number; text: string }[] = [];
      await sendDueBackfillReminders(mockBot(sent), now);
      assert.deepEqual(sent, []);
    }
  });

  it("fires on the user's own Sunday evening, not the server's day", async () => {
    const midway = makeUser({ reminderEnabled: true, timezone: "Pacific/Midway" });
    // Same instant, same chosen time — but it is already Monday afternoon here.
    makeUser({ reminderEnabled: true, timezone: "Asia/Hong_Kong" });

    const sent: { chatId: number; text: string }[] = [];
    await sendDueBackfillReminders(mockBot(sent), MIDWAY_SUNDAY_20);

    assert.deepEqual(
      sent.map((s) => s.chatId),
      [midway]
    );
  });

  it("reaches a member even with the daily reminder turned off", async () => {
    const optedOut = makeUser({ reminderEnabled: false });

    const sent: { chatId: number; text: string }[] = [];
    await sendDueBackfillReminders(mockBot(sent), SUNDAY_20);

    assert.ok(
      sent.some((s) => s.chatId === optedOut),
      "reminder_enabled must not gate this reminder"
    );
  });

  it("skips a user who is between rooms", async () => {
    const roomless = makeUser({ reminderEnabled: true, inRoom: false });

    const sent: { chatId: number; text: string }[] = [];
    await sendDueBackfillReminders(mockBot(sent), SUNDAY_20);

    // Other members of this shared in-memory DB are still due; the one with no
    // room is the one that must be absent (PRD §3a).
    assert.ok(!sent.some((s) => s.chatId === roomless));
  });

  it("uses reminder_time — the same field and default as the daily reminder", async () => {
    const custom = makeUser({ reminderEnabled: true, time: "21:00" });

    let sent: { chatId: number; text: string }[] = [];
    await sendDueBackfillReminders(mockBot(sent), SUNDAY_20);
    assert.ok(!sent.some((s) => s.chatId === custom));

    sent = [];
    await sendDueBackfillReminders(mockBot(sent), SUNDAY_21);
    assert.ok(sent.some((s) => s.chatId === custom));
  });
});

describe("backfill reminder — auto-deletion", () => {
  it("queues the reminder it just sent for deletion an hour out", async () => {
    const telegramId = makeUser({ reminderEnabled: true });
    await sendDueBackfillReminders(mockBot([]), SUNDAY_20);

    const queued = queuedDeletion(telegramId);
    assert.ok(queued, "the reminder should be queued for deletion");
    assert.ok(queued.message_id > 0, "the queued row names the message that was sent");

    const dueIn = db
      .prepare("SELECT CAST((julianday(?) - julianday('now')) * 24 * 60 AS INTEGER) AS minutes")
      .get(queued.delete_at) as { minutes: number };
    assert.ok(
      dueIn.minutes >= 59 && dueIn.minutes <= 60,
      `expected ~60 minutes out, got ${dueIn.minutes}`
    );
  });
});
