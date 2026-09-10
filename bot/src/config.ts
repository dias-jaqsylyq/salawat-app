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
/** Max POST /api/register requests per telegram user per rolling minute. */
export const REGISTER_RATE_LIMIT_PER_MINUTE = 5;
/** Max PATCH /api/profile requests per telegram user per rolling minute. */
export const PROFILE_RATE_LIMIT_PER_MINUTE = 5;

const PLACEHOLDER_MINI_APP_URL = "https://example.com/REPLACE_WITH_VERCEL_URL";

export const isProduction = process.env.NODE_ENV === "production";

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
  // Prefer 3600 in production; default stays 24h for local/dev convenience.
  initDataMaxAgeSeconds: Number(process.env.INIT_DATA_MAX_AGE_SECONDS) || 86_400,
  /** Optional secret for GET /api/admin/export. Empty = endpoint returns 503. */
  adminExportSecret: process.env.ADMIN_EXPORT_SECRET ?? "",
  // No ADMIN_TELEGRAM_ID: with rooms there is no global admin to bootstrap —
  // admin status is granted by creating a room or being promoted inside one
  // (MULTI ROOM PRD §3a).
};
