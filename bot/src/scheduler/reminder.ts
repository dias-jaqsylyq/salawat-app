import cron from "node-cron";
import { InlineKeyboard, type Bot } from "grammy";
import { config, formatReminderHhMm, isValidReminderTime } from "../config.js";
import { getUsersWithRemindersEnabled } from "../db/repository.js";
import type { MyContext } from "../context.js";
import type { User } from "../types.js";

const REMINDER_TEXT = "🌙 Don't forget today's salawat! Tap below to log it.";
const REMINDER_KEYBOARD = new InlineKeyboard().url("Log Salawat", config.miniAppDeepLink);

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

function effectiveReminderTime(user: User): string {
  if (user.reminder_time && isValidReminderTime(user.reminder_time)) {
    const [h, m] = user.reminder_time.split(":").map(Number);
    return formatReminderHhMm({ hour: h!, minute: m! });
  }
  return formatReminderHhMm(config.reminderTime);
}

export async function sendDueReminders(
  bot: Bot<MyContext>,
  now: Date = new Date()
) {
  if (sending) {
    console.warn("Skipping reminder tick — previous send still in flight");
    return;
  }

  sending = true;
  try {
    const nowHhMm = currentHhMmInTimezone(now);
    const users = getUsersWithRemindersEnabled();
    for (const user of users) {
      if (effectiveReminderTime(user) !== nowHhMm) continue;
      try {
        await bot.api.sendMessage(user.telegram_id, REMINDER_TEXT, {
          reply_markup: REMINDER_KEYBOARD,
        });
      } catch (err) {
        console.error(`Failed to send reminder to user ${user.telegram_id} (${user.nickname}):`, err);
      }
    }
  } finally {
    sending = false;
  }
}

export function startReminderScheduler(bot: Bot<MyContext>) {
  cron.schedule("* * * * *", () => void sendDueReminders(bot), {
    timezone: config.timezone,
  });

  const defaultTime = formatReminderHhMm(config.reminderTime);
  console.log(
    `Per-user reminder scheduler running every minute (${config.timezone}); default time ${defaultTime}`
  );
}
