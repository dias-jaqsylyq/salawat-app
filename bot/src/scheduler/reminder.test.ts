import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "reminder-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createUser,
  getUserByTelegramId,
  listHabits,
  updateHabit,
  updateUserProfile,
  upsertHabitLog,
} = await import("../db/repository.js");
const { formatDateParts, getTodayInTimezone } = await import("../utils/challenge.js");
const { buildReminderMessage, sendDueReminders } = await import("./reminder.js");

/** 20:00 in Asia/Hong_Kong. */
const AT_20 = new Date("2026-08-16T12:00:00.000Z");
/** 21:00 in Asia/Hong_Kong. */
const AT_21 = new Date("2026-08-16T13:00:00.000Z");

function mockBot(sendMessage: (chatId: number, text: string) => Promise<void>) {
  return {
    api: { sendMessage },
  } as unknown as Bot<MyContext>;
}

let nextTelegramId = 870000001;
function makeUser(reminderEnabled: boolean, reminderTime = "20:00"): number {
  const telegramId = nextTelegramId++;
  createUser(telegramId, `reminder-tester-${telegramId}`);
  updateUserProfile(telegramId, { reminderEnabled, reminderTime });
  return telegramId;
}

let nextHabitSuffix = 1;
function uniqueHabitName(label: string): string {
  return `${label} #${nextHabitSuffix++}`;
}

const todayKey = formatDateParts(getTodayInTimezone("Asia/Hong_Kong", AT_20));

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
    const unlogged = createHabit(uniqueHabitName("Unlogged habit"), "binary", 5);
    const logged = createHabit(uniqueHabitName("Logged habit"), "binary", 5);
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
    const habit = createHabit(uniqueHabitName("Retired habit"), "binary", 5);
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
    for (const habit of listHabits({ activeOnly: true })) {
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
