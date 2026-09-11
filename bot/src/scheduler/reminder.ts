import cron from "node-cron";
import { InlineKeyboard, type Bot } from "grammy";
import { config, formatReminderHhMm, isValidReminderTime } from "../config.js";
import {
  enqueueMessageDeletion,
  getUserHabitLogsForDate,
  getUserPersonalHabitLogsForDate,
  getUsersWithRemindersEnabled,
  listHabits,
  listPersonalHabits,
} from "../db/repository.js";
import { getUserTodayKey } from "../utils/challenge.js";
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
 * Names of everything this user still has to log today — the room's active
 * habits and their own personal ones, in one list. getUsersWithRemindersEnabled
 * never returns a roomless user, so there is always a room to scope to.
 *
 * The personal ones are mixed in rather than listed apart: from the member's
 * side both are "things I meant to do today", and the reminder is a private DM
 * to them, so nothing about their private list leaks anywhere.
 */
function unloggedHabitNames(user: User, todayKey: string): string[] {
  const roomId = user.current_room_id ?? undefined;
  const activeHabits = listHabits({ activeOnly: true, roomId });
  const todayLogs = getUserHabitLogsForDate(user.id, todayKey);
  const names = activeHabits
    .filter((habit) => !todayLogs.has(habit.id))
    .map((habit) => habit.name);

  if (roomId !== undefined) {
    const personalLogs = getUserPersonalHabitLogsForDate(user.id, todayKey);
    for (const habit of listPersonalHabits(user.id, roomId)) {
      if (!personalLogs.has(habit.id)) names.push(habit.name);
    }
  }
  return names;
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
        // "Still unlogged today" is asked in the user's own day, the same one
        // their logs are written under — so someone pinged at 20:00 local is
        // told about the day they are actually still able to log.
        const text = buildReminderMessage(unloggedHabitNames(user, getUserTodayKey(user, now)));
        const sent = await bot.api.sendMessage(user.telegram_id, text, {
          reply_markup: REMINDER_KEYBOARD,
        });
        // Tonight's nudge is worthless tomorrow: queue it for deletion rather
        // than letting a year of reminders pile up in the chat.
        enqueueMessageDeletion(
          user.telegram_id,
          sent.message_id,
          config.reminderDeleteAfterMinutes
        );
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
