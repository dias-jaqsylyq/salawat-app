export interface User {
  id: number;
  telegram_id: number;
  nickname: string;
  goal: number;
  /** SQLite 0/1; default 1 (reminders on). */
  reminder_enabled: number;
  /** HH:mm override in challenge TIMEZONE, or null to use global REMINDER_TIME. */
  reminder_time: string | null;
  /** SQLite 0/1; default 0 (fasting reminders off). */
  fasting_reminder_enabled: number;
  /** HH:mm in challenge TIMEZONE; default 20:00. */
  fasting_reminder_time: string;
  /** From Telegram initData.user — admin export only, never public API. */
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  /** User-typed legal name. Admin-only; never returned from public APIs. */
  real_name: string | null;
  /** Prior net logs retained only in the unfiltered Jamaat total after a soft reset. */
  retained_jamaat_total: number;
  /** Current personal-progress epoch; null means original registration time. */
  progress_started_at: string | null;
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
  reminderTime: string | null;
  fastingReminderEnabled: boolean;
  fastingReminderTime: string;
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
  goal: number | null;
  reminder_enabled: number | null;
  reminder_time: string | null;
  fasting_reminder_enabled: number | null;
  fasting_reminder_time: string | null;
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

export interface LogEntry {
  id: number;
  user_id: number;
  count: number;
  logged_at: string;
}

export interface LeaderboardRow {
  nickname: string;
  real_name: string | null;
  total: number;
  telegram_id: number;
}

export interface ExportRow {
  nickname: string;
  real_name: string | null;
  telegram_id: number;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  goal: number;
  total: number;
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}
