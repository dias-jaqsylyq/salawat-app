import cron from "node-cron";
import { InlineKeyboard, type Bot } from "grammy";
import { config, formatReminderHhMm, isValidReminderTime } from "../config.js";
import {
  enqueueMessageDeletion,
  getHabitIdsLoggedInWeek,
  getUserHabitLogsForDate,
  getUserPersonalHabitLogsForDate,
  getUsersWithRemindersEnabled,
  listHabits,
  listPersonalHabits,
} from "../db/repository.js";
import { getCurrentWeekBounds, getUserTodayKey } from "../utils/challenge.js";
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

export interface UnloggedHabits {
  /** Daily room habits and the member's own, with no log for today. */
  today: string[];
  /** Weekly room habits with no log anywhere in the current week. */
  thisWeek: string[];
}

/**
 * What this user still has to log, split by the deadline they are actually up
 * against. getUsersWithRemindersEnabled never returns a roomless user, so there
 * is always a room to scope to.
 *
 * The two lists exist because the two nudges mean different things: a daily
 * habit missed tonight is gone at midnight, while a weekly one is merely not
 * done *yet* and may have days left. Telling a member on Tuesday that they
 * "still have to log" their weekly khatm in the same breath as tonight's Fajr
 * would make the urgent line cry wolf.
 *
 * Personal habits are mixed into `today` rather than listed apart: from the
 * member's side they are "things I meant to do today" like any other, and the
 * reminder is a private DM, so nothing about their private list leaks anywhere.
 * They are always daily, so they never reach `thisWeek`.
 */
function unloggedHabits(user: User, todayKey: string, now: Date): UnloggedHabits {
  const roomId = user.current_room_id ?? undefined;
  const activeHabits = listHabits({ activeOnly: true, roomId });
  const todayLogs = getUserHabitLogsForDate(user.id, todayKey);

  const today = activeHabits
    .filter((habit) => habit.period !== "weekly" && !todayLogs.has(habit.id))
    .map((habit) => habit.name);

  let thisWeek: string[] = [];
  if (roomId !== undefined) {
    const { weekStart, weekEnd } = getCurrentWeekBounds(now);
    const loggedThisWeek = getHabitIdsLoggedInWeek(user.id, roomId, weekStart, weekEnd);
    thisWeek = activeHabits
      .filter((habit) => habit.period === "weekly" && !loggedThisWeek.has(habit.id))
      .map((habit) => habit.name);

    const personalLogs = getUserPersonalHabitLogsForDate(user.id, todayKey);
    for (const habit of listPersonalHabits(user.id, roomId)) {
      if (!personalLogs.has(habit.id)) today.push(habit.name);
    }
  }

  return { today, thisWeek };
}

/** DM text for a user given what they have not logged yet. */
export function buildReminderMessage(unlogged: UnloggedHabits): string {
  const { today, thisWeek } = unlogged;
  if (today.length === 0 && thisWeek.length === 0) {
    return "✅ You're all caught up on today's habits. Great job!";
  }

  const lines: string[] = [];
  if (today.length > 0) {
    lines.push("🌙 Don't forget to log today's habits!", "", `Still to log: ${today.join(", ")}`);
  } else {
    // Everything due today is done — lead with that rather than opening on a
    // scolding line the member has already earned their way out of.
    lines.push("✅ Today's habits are all logged.");
  }

  if (thisWeek.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Still open this week: ${thisWeek.join(", ")}`);
  }
  return lines.join("\n");
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
        const text = buildReminderMessage(unloggedHabits(user, getUserTodayKey(user, now), now));
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
