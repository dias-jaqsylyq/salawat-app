import cron from "node-cron";
import type { Bot } from "grammy";
import { config, formatReminderHhMm, isValidReminderTime } from "../config.js";
import { broadcastUsers } from "../api/broadcastService.js";
import { getUsersWithFastingRemindersEnabled } from "../db/repository.js";
import type { MyContext } from "../context.js";
import type { DateParts, User } from "../types.js";
import { getUserTimezone, getUserToday } from "../utils/challenge.js";
import { weekdayOfDate } from "../utils/dates.js";

/** Schema default, and the fallback when a stored time is missing or corrupt. */
const DEFAULT_FASTING_REMINDER_TIME = "20:00";
/** Sunday 1970-01-04 — fixed epoch for deterministic Sun/Wed occurrence counts. */
const FASTING_EPOCH_UTC = Date.UTC(1970, 0, 4);

/**
 * The three hadith the reminder rotates through. Fixed and shared by every
 * room: this is a function of the bot, not a per-room setting, and every member
 * — admins included — opts in the same way, in Settings.
 */
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

function currentHhMmInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

/** Sunday (frames Monday's fast) or Wednesday (frames Thursday's) — nothing else. */
function isFastingFireDay(weekday: number): weekday is 0 | 3 {
  return weekday === 0 || weekday === 3;
}

function civilDaysSinceEpoch(parts: DateParts): number {
  const current = Date.UTC(parts.year, parts.month - 1, parts.day);
  return Math.round((current - FASTING_EPOCH_UTC) / 86_400_000);
}

/**
 * Which hadith a given fire day gets: the count of Sunday/Wednesday occurrences
 * since a fixed Sunday, modulo three. Derived from the date alone, so it needs
 * no stored counter, is stable for every tick of the same day, and never
 * repeats the text two fire days running.
 */
export function fastingHadithIndex(today: DateParts): number {
  const days = civilDaysSinceEpoch(today);
  const weeks = Math.floor(days / 7);
  const rem = days % 7;
  const occurrence = weeks * 2 + (rem >= 3 ? 2 : 1) - 1;
  return ((occurrence % 3) + 3) % 3;
}

/**
 * Pure text, with no habit attached and nothing to log: it is a nudge about
 * tomorrow's fast, not a tracker entry, in any room or none.
 */
export function buildFastingReminderMessage(today: DateParts): string {
  const tomorrow = weekdayOfDate(today) === 0 ? "Monday" : "Thursday";
  const hadith = FASTING_HADITHS[fastingHadithIndex(today)]!;
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

/**
 * One evening send, entirely in each recipient's own timezone: whether it is
 * their Sunday or Wednesday, whether their chosen time has come, and which
 * hadith their date maps to. Two members in different zones therefore get it on
 * their own evenings rather than on the server's.
 *
 * One time covers both days — there is no separate Sunday and Wednesday
 * setting.
 */
export async function sendDueFastingReminders(
  bot: Bot<MyContext>,
  now: Date = new Date()
): Promise<void> {
  if (sending) {
    console.warn("Skipping fasting reminder tick — previous send still in flight");
    return;
  }

  sending = true;
  try {
    const dueUsers: User[] = [];
    // Each recipient's own local date, kept so the message can be built from
    // the day *they* are having — two zones can be on different fire days at
    // the same instant.
    const todayByUserId = new Map<number, DateParts>();

    for (const user of getUsersWithFastingRemindersEnabled()) {
      const today = getUserToday(user, now);
      if (!isFastingFireDay(weekdayOfDate(today))) continue;
      if (effectiveFastingReminderTime(user) !== currentHhMmInTimezone(now, getUserTimezone(user))) {
        continue;
      }
      dueUsers.push(user);
      todayByUserId.set(user.id, today);
    }
    if (dueUsers.length === 0) return;

    await broadcastUsers(dueUsers, async (user) => {
      const text = buildFastingReminderMessage(todayByUserId.get(user.id)!);
      await bot.api.sendMessage(user.telegram_id, text);
    });
  } finally {
    sending = false;
  }
}

/**
 * Deliberately its own cron, parallel to the daily reminder's rather than
 * folded into it: the two have different opt-ins, different schedules and
 * unrelated content, and a failure in one must not silence the other.
 */
export function startFastingReminderScheduler(bot: Bot<MyContext>): void {
  cron.schedule("* * * * *", () => void sendDueFastingReminders(bot), {
    timezone: config.timezone,
  });
  console.log(
    `Fasting reminder scheduler running every minute (ticks in ${config.timezone}); ` +
      `fires on each user's own Sunday/Wednesday evening`
  );
}
