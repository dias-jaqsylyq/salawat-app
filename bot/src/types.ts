export interface User {
  id: number;
  telegram_id: number;
  nickname: string;
  /** SQLite 0/1; default 1 (reminders on). */
  reminder_enabled: number;
  /** HH:mm in TIMEZONE; default '20:00'. */
  reminder_time: string;
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
}

/** Steps for the persistent /start registration conversation. */
export type RegistrationStep = "real_name" | "nickname" | "reminder_opt_in" | "reminder_time";

export interface PendingRegistration {
  telegram_id: number;
  step: RegistrationStep;
  real_name: string | null;
  nickname: string | null;
  reminder_enabled: number | null;
  reminder_time: string | null;
  updated_at: string;
}

export type AdminActionType = "delete_user" | "make_admin";

export interface PendingAdminAction {
  admin_telegram_id: number;
  action: AdminActionType;
  target_telegram_id: number;
  target_label: string;
  created_at: string;
}

export type HabitType = "quantity" | "binary";

export interface Habit {
  id: number;
  name: string;
  type: HabitType;
  points_weight: number;
  /** SQLite 0/1; default 1 (active). */
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface HabitLog {
  id: number;
  user_id: number;
  habit_id: number;
  /** TIMEZONE-local day, 'YYYY-MM-DD'. */
  log_date: string;
  /** quantity: entered number; binary: 1. */
  value: number;
  /** Frozen at log time via computePoints — never recomputed on read. */
  points_earned: number;
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
