import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "reminder-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  setUserCurrentRoom,
  getUserByTelegramId,
  listHabits,
  updateHabit,
  updateUserProfile,
  upsertHabitLog,
} = await import("../db/repository.js");
const { db } = await import("../db/client.js");
const { formatDateParts, getTodayInTimezone } = await import("../utils/challenge.js");
const { buildReminderMessage, sendDueReminders } = await import("./reminder.js");

/** 20:00 in Asia/Hong_Kong. */
const AT_20 = new Date("2026-08-16T12:00:00.000Z");
/** 21:00 in Asia/Hong_Kong. */
const AT_21 = new Date("2026-08-16T13:00:00.000Z");
/** 20:00 in America/New_York (EDT, UTC-4 in August). */
const AT_20_NY = new Date("2026-08-17T00:00:00.000Z");

let nextSentMessageId = 5000;

/**
 * sendMessage has to hand back a real Message: sendDueReminders reads
 * message_id off it to queue the deletion, and a stub returning undefined would
 * throw into the per-user catch and quietly turn every send into a failure.
 */
function mockBot(sendMessage: (chatId: number, text: string) => Promise<void>) {
  return {
    api: {
      sendMessage: async (chatId: number, text: string, opts?: unknown) => {
        await sendMessage(chatId, text);
        void opts;
        return { message_id: nextSentMessageId++ };
      },
    },
  } as unknown as Bot<MyContext>;
}

let nextTelegramId = 870000001;

/** Everyone in these tests shares one room; habits are created inside it. */
const room = (() => {
  const owner = createUser(nextTelegramId++, "reminder-room-owner");
  return createRoom("Reminder room", "reminder-room-pass", owner.id);
})();

function makeUser(reminderEnabled: boolean, reminderTime = "20:00"): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `reminder-tester-${telegramId}`);
  setUserCurrentRoom(user.id, room.id);
  updateUserProfile(telegramId, { reminderEnabled, reminderTime });
  return telegramId;
}

function makeHabit(label: string) {
  return createHabit(room.id, uniqueHabitName(label), "binary", 5);
}

let nextHabitSuffix = 1;
function uniqueHabitName(label: string): string {
  return `${label} #${nextHabitSuffix++}`;
}

const todayKey = formatDateParts(getTodayInTimezone("Asia/Hong_Kong", AT_20));

/** The deletion the cleanup cron would find queued for this chat, if any. */
function queuedDeletion(telegramId: number): { message_id: number; delete_at: string } | undefined {
  return db
    .prepare(
      "SELECT message_id, delete_at FROM scheduled_message_deletions WHERE chat_id = ?"
    )
    .get(telegramId) as { message_id: number; delete_at: string } | undefined;
}

describe("sendDueReminders — auto-deletion", () => {
  it("queues the reminder it just sent for deletion an hour out", async () => {
    const telegramId = makeUser(true, "20:00");
    await sendDueReminders(mockBot(async () => {}), AT_20);

    const queued = queuedDeletion(telegramId);
    assert.ok(queued, "the reminder should be queued for deletion");
    assert.ok(queued.message_id > 0, "the queued row names the message that was sent");

    // An hour from now, give or take the second the row was written in.
    const dueIn = db
      .prepare(
        "SELECT CAST((julianday(?) - julianday('now')) * 24 * 60 AS INTEGER) AS minutes"
      )
      .get(queued.delete_at) as { minutes: number };
    assert.ok(
      dueIn.minutes >= 59 && dueIn.minutes <= 60,
      `expected ~60 minutes out, got ${dueIn.minutes}`
    );
  });

  it("queues nothing when the DM failed", async () => {
    const telegramId = makeUser(true, "20:00");
    const bot = mockBot(async () => {
      throw new Error("blocked");
    });
    await sendDueReminders(bot, AT_20);
    assert.equal(queuedDeletion(telegramId), undefined);
  });
});

describe("sendDueReminders — scheduling", () => {
  it("only messages users whose reminders are enabled and whose time matches", async () => {
    const enabled = makeUser(true, "20:00");
    const disabled = makeUser(false, "20:00");
    const wrongTime = makeUser(true, "21:00");

    const sent: number[] = [];
    const bot = mockBot(async (id) => {
      sent.push(id);
    });

    await sendDueReminders(bot, AT_20);
    assert.deepEqual(
      sent.filter((id) => [enabled, disabled, wrongTime].includes(id)),
      [enabled]
    );

    sent.length = 0;
    await sendDueReminders(bot, AT_21);
    assert.deepEqual(
      sent.filter((id) => [enabled, disabled, wrongTime].includes(id)),
      [wrongTime]
    );
  });

  it("continues after one failed DM and skips overlapping ticks", async () => {
    const first = makeUser(true, "20:00");
    const second = makeUser(true, "20:00");

    const sent: number[] = [];
    const failingBot = mockBot(async (id) => {
      if (id === first) throw new Error("blocked");
      sent.push(id);
    });
    await sendDueReminders(failingBot, AT_20);
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
    const inFlight = sendDueReminders(slowBot, AT_20);
    while (started === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await sendDueReminders(slowBot, AT_20);
    assert.equal(started, 1);
    release();
    await inFlight;
  });
});

describe("sendDueReminders — per-user timezone", () => {
  it("fires by each user's own timezone, falling back to config.timezone when unset", async () => {
    const hkUser = makeUser(true, "20:00"); // no timezone set → falls back to config.timezone
    const nyUser = makeUser(true, "20:00");
    updateUserProfile(nyUser, { timezone: "America/New_York" });

    const sent: number[] = [];
    const bot = mockBot(async (id) => {
      sent.push(id);
    });

    // 20:00 in Hong Kong: only the fallback (unset-timezone) user is due.
    await sendDueReminders(bot, AT_20);
    assert.deepEqual(sent.filter((id) => [hkUser, nyUser].includes(id)), [hkUser]);

    // The same real-world moment is not 20:00 for the NY user, so they aren't
    // messaged again here — only at 20:00 their own time (AT_20_NY, below).
    sent.length = 0;
    await sendDueReminders(bot, AT_20_NY);
    assert.deepEqual(sent.filter((id) => [hkUser, nyUser].includes(id)), [nyUser]);
  });

  it("skips a user with a corrupted stored timezone instead of crashing the whole tick", async () => {
    const bad = makeUser(true, "20:00");
    const fine = makeUser(true, "20:00");
    // Bypass app-level validation (PATCH /api/profile rejects this) to simulate
    // already-corrupted data landing in the DB some other way.
    db.prepare("UPDATE users SET timezone = ? WHERE telegram_id = ?").run("Not/AZone", bad);

    const sent: number[] = [];
    const bot = mockBot(async (id) => {
      sent.push(id);
    });

    await assert.doesNotReject(() => sendDueReminders(bot, AT_20));
    assert.deepEqual(sent.filter((id) => [bad, fine].includes(id)), [fine]);
  });
});

describe("buildReminderMessage", () => {
  it("lists unlogged habit names when there are any", () => {
    const text = buildReminderMessage(["Fajr", "Qur'an"]);
    assert.match(text, /Still to log: Fajr, Qur'an/);
  });

  it("returns an all-caught-up message when nothing is left to log", () => {
    const text = buildReminderMessage([]);
    assert.match(text, /all caught up/i);
    assert.doesNotMatch(text, /Still to log/);
  });
});

describe("sendDueReminders — message content", () => {
  it("names today's unlogged active habits and omits already-logged ones", async () => {
    const telegramId = makeUser(true, "20:00");
    const user = getUserByTelegramId(telegramId)!;
    const unlogged = makeHabit("Unlogged habit");
    const logged = makeHabit("Logged habit");
    upsertHabitLog(user.id, logged.id, 1, todayKey);

    let captured = "";
    const bot = mockBot(async (_id, text) => {
      captured = text;
    });
    await sendDueReminders(bot, AT_20);

    assert.ok(captured.includes(unlogged.name));
    assert.ok(!captured.includes(logged.name));
  });

  it("never lists a deactivated habit as unlogged", async () => {
    const telegramId = makeUser(true, "20:00");
    const habit = makeHabit("Retired habit");
    updateHabit(habit.id, { isActive: false });

    let captured = "";
    const bot = mockBot(async (_id, text) => {
      captured = text;
    });
    await sendDueReminders(bot, AT_20);

    assert.ok(!captured.includes(habit.name));
  });

  it("sends the all-caught-up message once every active habit is logged today", async () => {
    const telegramId = makeUser(true, "20:00");
    const user = getUserByTelegramId(telegramId)!;
    for (const habit of listHabits({ activeOnly: true, roomId: room.id })) {
      upsertHabitLog(user.id, habit.id, 1, todayKey);
    }

    let captured = "";
    const bot = mockBot(async (_id, text) => {
      captured = text;
    });
    await sendDueReminders(bot, AT_20);

    assert.match(captured, /all caught up/i);
  });
});
