import cron from "node-cron";
import type { Bot } from "grammy";
import { formatReminderHhMm, isValidReminderTime } from "../config.js";
import { config } from "../config.js";
import { broadcastUsers } from "../api/broadcastService.js";
import { getUsersWithFastingRemindersEnabled } from "../db/repository.js";
import type { MyContext } from "../context.js";
import type { DateParts, User } from "../types.js";
import { getTodayInTimezone } from "../utils/challenge.js";

const DEFAULT_FASTING_REMINDER_TIME = "20:00";
/** Sunday 1970-01-04 — fixed epoch for deterministic Sun/Wed occurrence counts. */
const FASTING_EPOCH_UTC = Date.UTC(1970, 0, 4);

export const FASTING_HADITHS = [
  {
    text: "The Messenger of Allah ﷺ was asked about fasting on Monday. He said: 'That is the day on which I was born and the day on which I received revelation.'",
    attribution: "Abu Qatada al-Ansari, Sahih Muslim 1162e",
  },
  {
    text: "Deeds are presented [to Allah] on Monday and Thursday, and I love that my deeds be presented while I am fasting.",
    attribution: "Abu Huraira, Jami' at-Tirmidhi 747",
  },
  {
    text: "The Messenger of Allah ﷺ used to be keen to fast on Mondays and Thursdays.",
    attribution: "Abu Huraira, Sunan an-Nasa'i 2360",
  },
] as const;

let sending = false;

function currentHhMmInTimezone(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function weekdayUtcFromCivilDate(parts: DateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function isFastingFireDay(weekday: number): weekday is 0 | 3 {
  return weekday === 0 || weekday === 3;
}

function civilDaysSinceEpoch(parts: DateParts): number {
  const current = Date.UTC(parts.year, parts.month - 1, parts.day);
  return Math.round((current - FASTING_EPOCH_UTC) / 86_400_000);
}

export function fastingHadithIndex(now: Date): number {
  const today = getTodayInTimezone(config.timezone, now);
  const days = civilDaysSinceEpoch(today);
  const weeks = Math.floor(days / 7);
  const rem = days % 7;
  const occurrence = weeks * 2 + (rem >= 3 ? 2 : 1) - 1;
  return ((occurrence % 3) + 3) % 3;
}

export function buildFastingReminderMessage(now: Date): string {
  const today = getTodayInTimezone(config.timezone, now);
  const weekday = weekdayUtcFromCivilDate(today);
  const tomorrow = weekday === 0 ? "Monday" : "Thursday";
  const hadith = FASTING_HADITHS[fastingHadithIndex(now)]!;
  return [
    "Fasting reminder",
    "",
    `Tomorrow is ${tomorrow} — a Sunnah day to fast.`,
    "",
    `"${hadith.text}"`,
    "",
    `— ${hadith.attribution}`,
  ].join("\n");
}

function effectiveFastingReminderTime(user: User): string {
  if (user.fasting_reminder_time && isValidReminderTime(user.fasting_reminder_time)) {
    const [h, m] = user.fasting_reminder_time.split(":").map(Number);
    return formatReminderHhMm({ hour: h!, minute: m! });
  }
  return DEFAULT_FASTING_REMINDER_TIME;
}

export async function sendDueFastingReminders(
  bot: Bot<MyContext>,
  now: Date = new Date()
): Promise<void> {
  if (sending) {
    console.warn("Skipping fasting reminder tick — previous send still in flight");
    return;
  }

  const today = getTodayInTimezone(config.timezone, now);
  const weekday = weekdayUtcFromCivilDate(today);
  if (!isFastingFireDay(weekday)) {
    return;
  }

  sending = true;
  try {
    const nowHhMm = currentHhMmInTimezone(now);
    const dueUsers = getUsersWithFastingRemindersEnabled().filter(
      (user) => effectiveFastingReminderTime(user) === nowHhMm
    );
    if (dueUsers.length === 0) return;

    const text = buildFastingReminderMessage(now);
    await broadcastUsers(dueUsers, async (user) => {
      await bot.api.sendMessage(user.telegram_id, text);
    });
  } finally {
    sending = false;
  }
}

export function startFastingReminderScheduler(bot: Bot<MyContext>): void {
  cron.schedule("* * * * *", () => void sendDueFastingReminders(bot), {
    timezone: config.timezone,
  });
  console.log(
    `Fasting reminder scheduler running every minute (${config.timezone}); Sunday/Wednesday only`
  );
}
