import cron from "node-cron";
import { InlineKeyboard, type Bot } from "grammy";
import { config, formatReminderHhMm, isValidReminderTime } from "../config.js";
import { getUserHabitLogsForDate, getUsersWithRemindersEnabled, listHabits } from "../db/repository.js";
import { formatDateParts, getTodayInTimezone } from "../utils/challenge.js";
import type { MyContext } from "../context.js";
import type { User } from "../types.js";

const REMINDER_KEYBOARD = new InlineKeyboard().url("Open app", config.miniAppDeepLink);

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

function effectiveReminderTime(user: User): string {
  if (user.reminder_time && isValidReminderTime(user.reminder_time)) {
    const [h, m] = user.reminder_time.split(":").map(Number);
    return formatReminderHhMm({ hour: h!, minute: m! });
  }
  return formatReminderHhMm(config.reminderTime);
}

/**
 * Names of this user's active habits with no log row for `todayKey` yet —
 * only habits of the room they are currently in. getUsersWithRemindersEnabled
 * never returns a roomless user, so there is always a room to scope to.
 */
function unloggedHabitNames(user: User, todayKey: string): string[] {
  const activeHabits = listHabits({
    activeOnly: true,
    roomId: user.current_room_id ?? undefined,
  });
  const todayLogs = getUserHabitLogsForDate(user.id, todayKey);
  return activeHabits.filter((habit) => !todayLogs.has(habit.id)).map((habit) => habit.name);
}

/** DM text for a user given the active habits they haven't logged yet today. */
export function buildReminderMessage(unloggedHabitNames: string[]): string {
  if (unloggedHabitNames.length === 0) {
    return "✅ You're all caught up on today's habits. Great job!";
  }
  return [
    "🌙 Don't forget to log today's habits!",
    "",
    `Still to log: ${unloggedHabitNames.join(", ")}`,
  ].join("\n");
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
    // The day boundary for "what's still unlogged today" is always the app's
    // single canonical config.timezone (same as habit_logs/streaks/leaderboard
    // day-of) — a user's personal timezone only decides WHEN to ping them, not
    // which app-day their logs belong to.
    const todayKey = formatDateParts(getTodayInTimezone(config.timezone, now));
    const users = getUsersWithRemindersEnabled();
    for (const user of users) {
      let nowHhMm: string;
      try {
        nowHhMm = currentHhMmInTimezone(now, user.timezone ?? config.timezone);
      } catch (err) {
        console.error(
          `Invalid stored timezone "${user.timezone}" for user ${user.telegram_id} — skipping this tick:`,
          err
        );
        continue;
      }
      if (effectiveReminderTime(user) !== nowHhMm) continue;
      try {
        const text = buildReminderMessage(unloggedHabitNames(user, todayKey));
        await bot.api.sendMessage(user.telegram_id, text, {
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
