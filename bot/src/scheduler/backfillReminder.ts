import cron from "node-cron";
import { InlineKeyboard, type Bot } from "grammy";
import { config, formatReminderHhMm, isValidReminderTime } from "../config.js";
import { broadcastUsers } from "../api/broadcastService.js";
import { enqueueMessageDeletion, getAllRoomMembers } from "../db/repository.js";
import type { MyContext } from "../context.js";
import type { User } from "../types.js";
import { getUserTimezone, getUserToday } from "../utils/challenge.js";
import { weekdayOfDate } from "../utils/dates.js";

const REMINDER_KEYBOARD = new InlineKeyboard().url("Open app", config.miniAppDeepLink);

/**
 * Deliberately generic (BACKFILL PRD): no per-habit detail, unlike the daily
 * reminder's "still to log" list — this is a once-a-week heads-up that the
 * window is closing, not a status report.
 */
export const BACKFILL_REMINDER_TEXT =
  "Reminder: check all your habits for this week — starting next week, you won't be able to change them.";

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

/** Same field, same default and same validity rule as the daily reminder — see reminder.ts. */
function effectiveReminderTime(user: User): string {
  if (user.reminder_time && isValidReminderTime(user.reminder_time)) {
    const [h, m] = user.reminder_time.split(":").map(Number);
    return formatReminderHhMm({ hour: h!, minute: m! });
  }
  return formatReminderHhMm(config.reminderTime);
}

/**
 * One evening send a week, entirely in each recipient's own timezone: whether
 * it is their Sunday and whether their chosen reminder_time has come. Two
 * members in different zones can be on different weekdays at the same instant
 * (see getCurrentWeekBounds), so "Sunday" is never decided by TIMEZONE alone —
 * same reasoning as the fasting reminder's own Sunday/Wednesday check.
 *
 * Every current room member gets this one, reminder_enabled or not: the daily
 * nudge is opt-out, this one about the closing backfill window is not
 * (BACKFILL PRD).
 */
export async function sendDueBackfillReminders(
  bot: Bot<MyContext>,
  now: Date = new Date()
): Promise<void> {
  if (sending) {
    console.warn("Skipping backfill reminder tick — previous send still in flight");
    return;
  }

  sending = true;
  try {
    const dueUsers = getAllRoomMembers().filter((user) => {
      // getUserToday/getUserTimezone already fall back to TIMEZONE on a
      // corrupted stored zone, so neither call here can throw.
      const today = getUserToday(user, now);
      if (weekdayOfDate(today) !== 0) return false; // Sunday only
      return effectiveReminderTime(user) === currentHhMmInTimezone(now, getUserTimezone(user));
    });
    if (dueUsers.length === 0) return;

    await broadcastUsers(dueUsers, async (user) => {
      const sent = await bot.api.sendMessage(user.telegram_id, BACKFILL_REMINDER_TEXT, {
        reply_markup: REMINDER_KEYBOARD,
      });
      // Same short shelf life as the other two reminders — see reminder.ts.
      enqueueMessageDeletion(user.telegram_id, sent.message_id, config.reminderDeleteAfterMinutes);
    });
  } finally {
    sending = false;
  }
}

/**
 * Its own cron, parallel to the daily and fasting reminders rather than folded
 * into either: different opt-in (none), different schedule (Sunday only) and
 * unrelated content, and a failure here must not silence the other two.
 */
export function startBackfillReminderScheduler(bot: Bot<MyContext>): void {
  cron.schedule("* * * * *", () => void sendDueBackfillReminders(bot), {
    timezone: config.timezone,
  });
  console.log(
    `Weekly backfill-window reminder scheduler running every minute (ticks in ${config.timezone}); ` +
      `fires on each user's own Sunday evening`
  );
}
