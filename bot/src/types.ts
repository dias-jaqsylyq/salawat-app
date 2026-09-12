/** Room-scoped habit category — only used while the room has categories enabled. */
export type HabitCategory = "IQ" | "SQ" | "PQ" | "EQ";

export const HABIT_CATEGORIES: readonly HabitCategory[] = ["IQ", "SQ", "PQ", "EQ"] as const;

/** Chosen once at registration and never re-selectable (MULTI ROOM PRD §0). */
export type UserRole = "admin" | "participant";

/**
 * How the Progress screen draws streaks: 'current' = one number per habit,
 * 'weekly' = a seven-cell calendar-week row per habit. Purely a display
 * preference — switching it recomputes and caches nothing.
 */
export type StreakDisplay = "current" | "weekly";

export const STREAK_DISPLAYS: readonly StreakDisplay[] = ["current", "weekly"] as const;

/**
 * One independent competition. Rooms are isolated by room_id inside this one
 * database — never separate bot instances (MULTI ROOM PRD §0).
 */
export interface Room {
  id: number;
  /** Free text, not unique across rooms — only id disambiguates them. */
  name: string;
  /**
   * Plain text, case-sensitive room invite code. Stored readable because the
   * admin must be able to show and re-share it (PRD §3, §3a).
   */
  password: string;
  /** SQLite 0/1; default 0. When 1, every habit here carries a HabitCategory. */
  categories_enabled: number;
  /**
   * Who originally created the room. Historical record only — it grants no
   * power over co-admins (PRD §3a). NULL if that user was deleted.
   */
  owner_user_id: number | null;
  created_at: string;
}

/** Room-scoped admin status (owner + co-admins, all equal) — replaces the retired global `admins` table. */
export interface RoomAdmin {
  room_id: number;
  user_id: number;
  created_at: string;
}

export interface User {
  id: number;
  telegram_id: number;
  nickname: string;
  /** 'admin' users are also ordinary participants of the room they created. */
  role: UserRole;
  /**
   * At most one room at a time. NULL only between leaving one room and joining
   * the next — reminders pause while it is NULL (PRD §3a).
   */
  current_room_id: number | null;
  /** SQLite 0/1; default 1 (reminders on). */
  reminder_enabled: number;
  /** HH:mm in TIMEZONE; default '20:00'. */
  reminder_time: string;
  /**
   * SQLite 0/1; default 0. Opt-in, separate from the daily reminder: a
   * Sunday/Wednesday nudge about the coming fast (PRD §2).
   */
  fasting_reminder_enabled: number;
  /** HH:mm in TIMEZONE; default '20:00'. */
  fasting_reminder_time: string;
  /**
   * IANA name detected client-side in the Mini App. NULL until the user opens
   * it at least once — everything that needs this user's "today" falls back to
   * config.timezone until then (see getUserTimezone).
   */
  timezone: string | null;
  /** Display-only: which shape the Progress screen draws streaks in. */
  streak_display: StreakDisplay;
  /** First day of the weekly view's calendar week, 0 = Sunday … 6 = Saturday. */
  week_start_day: number;
  /**
   * When this user joined the room they are in now (UTC text, like created_at),
   * or NULL between rooms. The weekly view greys out this week's days that
   * predate it rather than showing them as missed.
   */
  room_joined_at: string | null;
  /** From Telegram initData.user — admin export only, never public API. */
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  /**
   * User-typed legal name. Never returned from public/other-user APIs
   * (leaderboard, export) or admin-scoped-to-others endpoints — only from
   * self-scoped GET/PATCH /api/profile (to the owner) and admin
   * leaderboard/CSV (to admins, for prize/moderation use).
   */
  real_name: string | null;
  created_at: string;
}

/** Telegram profile fields parsed from initData.user. */
export interface TelegramProfile {
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
}

/** Reminder preferences collected during bot /start signup. */
export interface CreateUserReminders {
  reminderEnabled: boolean;
  reminderTime: string;
  /** Defaults to off when omitted — the fasting nudge is strictly opt-in. */
  fastingReminderEnabled?: boolean;
  fastingReminderTime?: string;
}

/**
 * Steps for the persistent /start registration conversation (PRD §2).
 *
 * `role` is the new first question; from there the conversation forks —
 *   admin:       real_name -> room_name -> categories -> nickname -> ...
 *   participant: room_password -> real_name -> nickname -> ...
 * — and rejoins on a shared reminder tail:
 *   reminder_opt_in -> [reminder_time] -> fasting_opt_in -> [fasting_time].
 */
export type RegistrationStep =
  | "role"
  | "room_password"
  | "real_name"
  | "room_name"
  | "categories"
  | "nickname"
  | "reminder_opt_in"
  | "reminder_time"
  | "fasting_opt_in"
  | "fasting_time";

export interface PendingRegistration {
  telegram_id: number;
  step: RegistrationStep;
  /** NULL only before the admin-or-participant question is answered. */
  role: UserRole | null;
  real_name: string | null;
  nickname: string | null;
  /** Admin branch only: the room created at finalize. */
  room_name: string | null;
  /** Admin branch only: SQLite 0/1 answer to the categories question. */
  categories_enabled: number | null;
  /** Participant branch only: the room their password resolved to. */
  room_id: number | null;
  reminder_enabled: number | null;
  reminder_time: string | null;
  fasting_reminder_enabled: number | null;
  fasting_reminder_time: string | null;
  updated_at: string;
}

export type HabitType = "quantity" | "binary";

export interface Habit {
  id: number;
  room_id: number;
  name: string;
  type: HabitType;
  points_weight: number;
  /**
   * NULL in a room with categories disabled. Preserved (not cleared) when a room
   * turns categories off, but a re-enable asks the admin to re-confirm rather
   * than silently reusing it (PRD §0).
   */
  category: HabitCategory | null;
  /** SQLite 0/1; default 1 (active). */
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface HabitLog {
  id: number;
  user_id: number;
  habit_id: number;
  /** Denormalized from the habit at write time — see schema.sql. */
  room_id: number;
  /** TIMEZONE-local day, 'YYYY-MM-DD'. */
  log_date: string;
  /** quantity: entered number; binary: 1. */
  value: number;
  /** Frozen at log time via computePoints — never recomputed on read. */
  points_earned: number;
  created_at: string;
  updated_at: string;
}

/**
 * A member's own habit, private to them and scoped to the room they are in.
 *
 * No points_weight: personal habits are tracking only and never reach a total,
 * a leaderboard or an export. No is_active either — the owner deletes rather
 * than deactivates, since there is no admin whose history needs protecting.
 */
export interface PersonalHabit {
  id: number;
  user_id: number;
  room_id: number;
  name: string;
  type: HabitType;
  /** NULL in a room with categories disabled; required when they are enabled. */
  category: HabitCategory | null;
  created_at: string;
  updated_at: string;
}

/** Done-or-not for one personal habit on one of the owner's local days. */
export interface PersonalHabitLog {
  id: number;
  user_id: number;
  personal_habit_id: number;
  room_id: number;
  log_date: string;
  value: number;
  created_at: string;
  updated_at: string;
}

/** One row of the all-time, perpetual leaderboard (getLeaderboard). */
export interface LeaderboardRow {
  user_id: number;
  telegram_id: number;
  nickname: string;
  real_name: string | null;
  /** Sum of points_earned across all habits, all time. */
  total: number;
}

/** One row of the admin CSV export (getExportRows) — same as LeaderboardRow plus raw Telegram identity fields. */
export interface ExportRow extends LeaderboardRow {
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}
