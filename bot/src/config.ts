import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseReminderTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid REMINDER_TIME: "${value}" (expected HH:mm)`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid REMINDER_TIME: "${value}" (hour must be 0–23, minute 0–59)`);
  }
  return { hour, minute };
}

/** Format {hour, minute} as zero-padded HH:mm. */
export function formatReminderHhMm(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** True if value is a valid 24h HH:mm string. */
export function isValidReminderTime(value: string): boolean {
  try {
    parseReminderTime(value);
    return true;
  } catch {
    return false;
  }
}

/** Per-log quantity-habit value ceiling (friend-group sanity cap). */
export const MAX_HABIT_VALUE = 10_000;

/** Max POST /api/habits/:id/log requests per telegram user per rolling minute. */
export const HABIT_LOG_RATE_LIMIT_PER_MINUTE = 30;
/** Max PATCH /api/profile requests per telegram user per rolling minute. */
export const PROFILE_RATE_LIMIT_PER_MINUTE = 5;
/**
 * Max admin mutations (habit create/edit, room settings, password regeneration,
 * kick/promote/demote) per telegram user per rolling minute. Generous enough
 * that an admin setting a room up in one sitting never notices it, tight enough
 * that a runaway client cannot hammer the write paths.
 */
export const ADMIN_MUTATION_RATE_LIMIT_PER_MINUTE = 20;
/**
 * Max broadcasts per telegram user per rolling minute. Deliberately the
 * tightest limit in the file: every broadcast fans out one Telegram API call
 * per room member from the *bot's* account, so a loop here spends the bot's
 * global Telegram quota, not just this process's CPU. The per-room in-flight
 * lock in broadcastService only prevents concurrent sends, never a serial loop.
 */
export const BROADCAST_RATE_LIMIT_PER_MINUTE = 3;
/**
 * Max room-membership changes (leave) and full-room CSV exports per telegram
 * user per rolling minute. Both are cheap to call and expensive to serve.
 */
export const ROOM_ACTION_RATE_LIMIT_PER_MINUTE = 10;
/**
 * Max requests per client IP per rolling minute against the two
 * ADMIN_EXPORT_SECRET-gated endpoints (GET /api/admin/export,
 * POST /api/admin/reset).
 *
 * These are the only endpoints with no Telegram identity behind them, so the
 * per-user buckets above cannot apply — without this the shared secret can be
 * brute-forced at line speed.
 */
export const ADMIN_SECRET_RATE_LIMIT_PER_MINUTE = 10;
/**
 * Max room-password guesses per telegram user per rolling minute during /start
 * signup (PRD §2 — basic rate limiting, reusing the existing allowRequest
 * convention). Shares that helper's per-user bucket with the API limits above,
 * which costs nothing in practice: someone still typing a join password has no
 * room yet, so no Mini App call to compete with.
 */
export const ROOM_JOIN_RATE_LIMIT_PER_MINUTE = 5;

/**
 * How long a reminder DM stays in the chat before the message-cleanup cron
 * removes it. A reminder is worth nothing the morning after — the point is a
 * nudge at 20:00, not a permanent record — and a year of them makes the chat
 * unusable.
 *
 * Keep it well under Telegram's 48-hour deletion window: past that the Bot API
 * refuses outright and the message is stuck in the chat for good.
 */
export const DEFAULT_REMINDER_DELETE_AFTER_MINUTES = 60;

/**
 * Same strict parsing as parseInitDataMaxAge, and for the same reason: a typo
 * in the variable should stop the boot, not silently resolve to the default.
 */
export function parseReminderDeleteAfterMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REMINDER_DELETE_AFTER_MINUTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid REMINDER_DELETE_AFTER_MINUTES: "${raw}" (expected a positive whole number of minutes, e.g. 60)`
    );
  }
  return parsed;
}

/**
 * Queued deletions handled per cron tick. Bounds the burst after a long outage
 * so the backlog is worked through in batches instead of thousands of API calls
 * landing in one minute.
 */
export const MESSAGE_DELETION_BATCH_SIZE = 200;

const PLACEHOLDER_MINI_APP_URL = "https://example.com/REPLACE_WITH_VERCEL_URL";

export const isProduction = process.env.NODE_ENV === "production";

/** initData replay window when INIT_DATA_MAX_AGE_SECONDS is unset: 1h in production. */
const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = isProduction ? 3_600 : 86_400;

/**
 * Parse INIT_DATA_MAX_AGE_SECONDS into the replay window telegramAuth enforces.
 *
 * Unset falls back to DEFAULT_INIT_DATA_MAX_AGE_SECONDS — 1h in production, so
 * forgetting the variable on the host cannot silently leave a 24h replay window
 * open, and 24h in dev where a captured initData is reused all day.
 *
 * A value that is present but not a positive integer throws rather than falling
 * back: `Number("abc") || default` and `Number("0") || default` both used to
 * resolve to the default silently, which is exactly how a deployment ends up
 * running a window nobody chose.
 */
export function parseInitDataMaxAge(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INIT_DATA_MAX_AGE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid INIT_DATA_MAX_AGE_SECONDS: "${raw}" (expected a positive whole number of seconds, e.g. 3600)`
    );
  }
  return parsed;
}

const corsOrigin = process.env.CORS_ORIGIN ?? "*";
if (isProduction && (corsOrigin === "*" || corsOrigin.trim() === "")) {
  throw new Error(
    "CORS_ORIGIN must be set to your Mini App origin(s) in production (not *). Example: https://salawat-miniapp.vercel.app"
  );
}

const miniAppUrl = process.env.MINI_APP_URL ?? PLACEHOLDER_MINI_APP_URL;
const miniAppUrlIsPlaceholder =
  !process.env.MINI_APP_URL ||
  miniAppUrl.includes("REPLACE_WITH_VERCEL_URL") ||
  miniAppUrl.includes("example.com");

export const config = {
  botToken: required("BOT_TOKEN"),
  timezone: process.env.TIMEZONE ?? "Asia/Hong_Kong",
  reminderTime: parseReminderTime(process.env.REMINDER_TIME ?? "20:00"),
  dbPath: process.env.DB_PATH ?? "./data/salawat.db",

  // Mini App backend config
  port: Number(process.env.PORT) || 3000,
  corsOrigin,
  miniAppUrl,
  miniAppUrlIsPlaceholder,
  // t.me deep link used for the reminder's inline button (works without a real HTTPS Mini App URL).
  miniAppDeepLink: process.env.MINI_APP_DEEP_LINK ?? "https://t.me/salawat_challenge_bot/challenge",
  // Max age (seconds) a Telegram initData payload is accepted before being treated as stale/replayed.
  initDataMaxAgeSeconds: parseInitDataMaxAge(process.env.INIT_DATA_MAX_AGE_SECONDS),
  /** Minutes a reminder DM survives before the cleanup cron deletes it. */
  reminderDeleteAfterMinutes: parseReminderDeleteAfterMinutes(
    process.env.REMINDER_DELETE_AFTER_MINUTES
  ),
  /** Optional secret for GET /api/admin/export. Empty = endpoint returns 503. */
  adminExportSecret: process.env.ADMIN_EXPORT_SECRET ?? "",
  // No ADMIN_TELEGRAM_ID: with rooms there is no global admin to bootstrap —
  // admin status is granted by creating a room or being promoted inside one
  // (MULTI ROOM PRD §3a).
};
