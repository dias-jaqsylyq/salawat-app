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
  /** User-typed legal name. Admin-only; never returned from public APIs. */
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
export type RegistrationStep =
  | "real_name"
  | "nickname"
  | "goal"
  | "reminder_opt_in"
  | "reminder_time"
  | "fasting_opt_in"
  | "fasting_time";

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

export interface DateParts {
  year: number;
  month: number;
  day: number;
}
