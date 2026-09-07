import { db } from "./client.js";
import type {
  AdminActionType,
  CreateUserReminders,
  ExportRow,
  LeaderboardRow,
  PendingAdminAction,
  PendingRegistration,
  RegistrationStep,
  TelegramProfile,
  User,
} from "../types.js";

export interface LogWindow {
  startUtc: string;
  endUtc: string;
}

export function getUserByTelegramId(telegramId: number): User | undefined {
  return db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId) as User | undefined;
}

/** Case-insensitive nickname lookup. */
export function getUserByNickname(nickname: string): User | undefined {
  return db
    .prepare("SELECT * FROM users WHERE LOWER(nickname) = LOWER(?) LIMIT 1")
    .get(nickname) as User | undefined;
}

/** Case-insensitive Telegram username lookup (`@` optional). */
export function getUserByTelegramUsername(username: string): User | undefined {
  const normalized = username.trim().replace(/^@/, "");
  if (!normalized) return undefined;
  return db
    .prepare(
      "SELECT * FROM users WHERE telegram_username IS NOT NULL AND LOWER(telegram_username) = LOWER(?) LIMIT 1"
    )
    .get(normalized) as User | undefined;
}

/** Case-insensitive nickname collision check (excludes an optional telegram_id). */
export function isNicknameTaken(nickname: string, excludeTelegramId?: number): boolean {
  const row = (
    excludeTelegramId === undefined
      ? db.prepare("SELECT 1 AS hit FROM users WHERE LOWER(nickname) = LOWER(?) LIMIT 1").get(nickname)
      : db
          .prepare(
            "SELECT 1 AS hit FROM users WHERE LOWER(nickname) = LOWER(?) AND telegram_id != ? LIMIT 1"
          )
          .get(nickname, excludeTelegramId)
  ) as { hit: number } | undefined;
  return row !== undefined;
}

export function isAdmin(telegramId: number): boolean {
  const row = db
    .prepare("SELECT 1 AS hit FROM admins WHERE telegram_id = ? LIMIT 1")
    .get(telegramId) as { hit: number } | undefined;
  return row !== undefined;
}

export function addAdmin(telegramId: number): void {
  db.prepare("INSERT OR IGNORE INTO admins (telegram_id) VALUES (?)").run(telegramId);
}

export function removeAdmin(telegramId: number): void {
  db.prepare("DELETE FROM admins WHERE telegram_id = ?").run(telegramId);
}

export function getPendingAdminAction(adminTelegramId: number): PendingAdminAction | undefined {
  return db
    .prepare("SELECT * FROM pending_admin_actions WHERE admin_telegram_id = ?")
    .get(adminTelegramId) as PendingAdminAction | undefined;
}

export function setPendingAdminAction(
  adminTelegramId: number,
  action: AdminActionType,
  targetTelegramId: number,
  targetLabel: string
): PendingAdminAction {
  db.prepare(
    `INSERT INTO pending_admin_actions (admin_telegram_id, action, target_telegram_id, target_label, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(admin_telegram_id) DO UPDATE SET
       action = excluded.action,
       target_telegram_id = excluded.target_telegram_id,
       target_label = excluded.target_label,
       created_at = excluded.created_at`
  ).run(adminTelegramId, action, targetTelegramId, targetLabel);

  return getPendingAdminAction(adminTelegramId) ?? (() => {
    throw new Error(`Failed to load pending admin action for ${adminTelegramId}`);
  })();
}

export function clearPendingAdminAction(adminTelegramId: number): void {
  db.prepare("DELETE FROM pending_admin_actions WHERE admin_telegram_id = ?").run(
    adminTelegramId
  );
}

export interface DeleteUserCompletelyResult {
  userDeleted: boolean;
  logsDeleted: number;
  dayGoalOverridesDeleted: number;
  pendingDeleted: boolean;
  adminDeleted: boolean;
}

/**
 * Full wipe for one Telegram id: overrides, logs, users row, pending signup, admin row.
 * After this, /start treats them as brand new.
 */
export function deleteUserCompletely(telegramId: number): DeleteUserCompletelyResult {
  const wipe = db.transaction(() => {
    const user = getUserByTelegramId(telegramId);
    let logsDeleted = 0;
    let dayGoalOverridesDeleted = 0;
    let userDeleted = false;

    if (user) {
      dayGoalOverridesDeleted = db
        .prepare("DELETE FROM day_goal_overrides WHERE user_id = ?")
        .run(user.id).changes;
      logsDeleted = db.prepare("DELETE FROM logs WHERE user_id = ?").run(user.id).changes;
      userDeleted = db.prepare("DELETE FROM users WHERE id = ?").run(user.id).changes > 0;
    }

    const pendingDeleted =
      db.prepare("DELETE FROM pending_registrations WHERE telegram_id = ?").run(telegramId)
        .changes > 0;
    const adminDeleted =
      db.prepare("DELETE FROM admins WHERE telegram_id = ?").run(telegramId).changes > 0;

    return {
      userDeleted,
      logsDeleted,
      dayGoalOverridesDeleted,
      pendingDeleted,
      adminDeleted,
    };
  });
  return wipe();
}

export function createUser(
  telegramId: number,
  nickname: string,
  goal: number,
  profile: TelegramProfile = {
    telegramUsername: null,
    telegramFirstName: null,
    telegramLastName: null,
  },
  realName: string | null = null,
  reminders?: CreateUserReminders
): User {
  const reminderEnabled = reminders ? (reminders.reminderEnabled ? 1 : 0) : 1;
  const reminderTime = reminders ? reminders.reminderTime : null;
  const fastingReminderEnabled = reminders ? (reminders.fastingReminderEnabled ? 1 : 0) : 0;
  const fastingReminderTime = reminders?.fastingReminderTime ?? "20:00";

  const result = db
    .prepare(
      `INSERT INTO users (
         telegram_id, nickname, goal,
         telegram_username, telegram_first_name, telegram_last_name,
         real_name,
         reminder_enabled, reminder_time,
         fasting_reminder_enabled, fasting_reminder_time
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      telegramId,
      nickname,
      goal,
      profile.telegramUsername,
      profile.telegramFirstName,
      profile.telegramLastName,
      realName,
      reminderEnabled,
      reminderTime,
      fastingReminderEnabled,
      fastingReminderTime
    );
  return getUserByTelegramId(telegramId) ?? (() => {
    throw new Error(`Failed to load user just created (rowid ${result.lastInsertRowid})`);
  })();
}

export function getPendingRegistration(telegramId: number): PendingRegistration | undefined {
  return db
    .prepare("SELECT * FROM pending_registrations WHERE telegram_id = ?")
    .get(telegramId) as PendingRegistration | undefined;
}

/** Start or keep an existing pending row at step real_name. */
export function ensurePendingRegistration(telegramId: number): PendingRegistration {
  const existing = getPendingRegistration(telegramId);
  if (existing) return existing;

  db.prepare(
    `INSERT INTO pending_registrations (telegram_id, step, updated_at)
     VALUES (?, 'real_name', datetime('now'))`
  ).run(telegramId);

  return getPendingRegistration(telegramId) ?? (() => {
    throw new Error(`Failed to create pending registration for ${telegramId}`);
  })();
}

export function updatePendingRegistration(
  telegramId: number,
  patch: Partial<{
    step: RegistrationStep;
    real_name: string | null;
    nickname: string | null;
    goal: number | null;
    reminder_enabled: number | null;
    reminder_time: string | null;
    fasting_reminder_enabled: number | null;
    fasting_reminder_time: string | null;
  }>
): PendingRegistration {
  const current = getPendingRegistration(telegramId);
  if (!current) {
    throw new Error(`updatePendingRegistration: no pending row for ${telegramId}`);
  }

  db.prepare(
    `UPDATE pending_registrations
     SET step = ?,
         real_name = ?,
         nickname = ?,
         goal = ?,
         reminder_enabled = ?,
         reminder_time = ?,
         fasting_reminder_enabled = ?,
         fasting_reminder_time = ?,
         updated_at = datetime('now')
     WHERE telegram_id = ?`
  ).run(
    patch.step ?? current.step,
    patch.real_name !== undefined ? patch.real_name : current.real_name,
    patch.nickname !== undefined ? patch.nickname : current.nickname,
    patch.goal !== undefined ? patch.goal : current.goal,
    patch.reminder_enabled !== undefined ? patch.reminder_enabled : current.reminder_enabled,
    patch.reminder_time !== undefined ? patch.reminder_time : current.reminder_time,
    patch.fasting_reminder_enabled !== undefined
      ? patch.fasting_reminder_enabled
      : current.fasting_reminder_enabled,
    patch.fasting_reminder_time !== undefined
      ? patch.fasting_reminder_time
      : current.fasting_reminder_time,
    telegramId
  );

  return getPendingRegistration(telegramId) ?? (() => {
    throw new Error(`Failed to reload pending registration for ${telegramId}`);
  })();
}

export function deletePendingRegistration(telegramId: number): void {
  db.prepare("DELETE FROM pending_registrations WHERE telegram_id = ?").run(telegramId);
}

/** Refresh Telegram profile fields if the user is already registered; no-op otherwise. */
export function updateTelegramProfileIfRegistered(
  telegramId: number,
  profile: TelegramProfile
): void {
  db.prepare(
    `UPDATE users
     SET telegram_username = ?,
         telegram_first_name = ?,
         telegram_last_name = ?
     WHERE telegram_id = ?`
  ).run(
    profile.telegramUsername,
    profile.telegramFirstName,
    profile.telegramLastName,
    telegramId
  );
}

export function addLog(userId: number, count: number): void {
  db.prepare("INSERT INTO logs (user_id, count) VALUES (?, ?)").run(userId, count);
}

export function getUserTotal(userId: number): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(count), 0) AS total FROM logs WHERE user_id = ?")
    .get(userId) as { total: number };
  return row.total;
}

/** Sum of logs for a user in the half-open UTC window [startUtc, endUtc). */
export function getUserTodayTotal(userId: number, startUtc: string, endUtc: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(count), 0) AS total
       FROM logs
       WHERE user_id = ? AND logged_at >= ? AND logged_at < ?`
    )
    .get(userId, startUtc, endUtc) as { total: number };
  return row.total;
}

/** Individual log counts at/after startUtc (for TIMEZONE day bucketing). */
export function getUserLogsSince(
  userId: number,
  startUtc: string
): { logged_at: string; count: number }[] {
  return db
    .prepare(
      `SELECT logged_at, count
       FROM logs
       WHERE user_id = ? AND logged_at >= ?
       ORDER BY logged_at ASC`
    )
    .all(userId, startUtc) as { logged_at: string; count: number }[];
}

/** Day goal overrides in [fromDay, toDay] inclusive (YYYY-MM-DD keys). */
export function getDayOverrides(
  userId: number,
  fromDay: string,
  toDay: string
): Map<string, boolean> {
  const rows = db
    .prepare(
      `SELECT day, met
       FROM day_goal_overrides
       WHERE user_id = ? AND day >= ? AND day <= ?`
    )
    .all(userId, fromDay, toDay) as { day: string; met: number }[];
  const map = new Map<string, boolean>();
  for (const row of rows) {
    map.set(row.day, row.met === 1);
  }
  return map;
}

/** Upsert a per-day met/missed override (does not change logs). */
export function upsertDayOverride(userId: number, day: string, met: boolean): void {
  db.prepare(
    `INSERT INTO day_goal_overrides (user_id, day, met, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, day) DO UPDATE SET
       met = excluded.met,
       updated_at = excluded.updated_at`
  ).run(userId, day, met ? 1 : 0);
}

export function getLeaderboard(window?: LogWindow): LeaderboardRow[] {
  const dateJoin = window
    ? "AND l.logged_at >= ? AND l.logged_at < ?"
    : "";
  return db
    .prepare(
      `SELECT u.nickname AS nickname,
              u.real_name AS real_name,
              u.telegram_id AS telegram_id,
              COALESCE(SUM(l.count), 0) AS total
       FROM users u
       LEFT JOIN logs l ON l.user_id = u.id ${dateJoin}
       GROUP BY u.id
       ORDER BY total DESC, u.nickname ASC`
    )
    .all(...(window ? [window.startUtc, window.endUtc] : [])) as LeaderboardRow[];
}

/** Sum all logs, optionally restricted to a UTC half-open window. */
export function getJamaatTotal(window?: LogWindow): number {
  if (!window) {
    const row = db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(count), 0) FROM logs) +
           (SELECT COALESCE(SUM(retained_jamaat_total), 0) FROM users) AS total`
      )
      .get() as { total: number };
    return row.total;
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(count), 0) AS total
       FROM logs
       WHERE logged_at >= ? AND logged_at < ?`
    )
    .get(window.startUtc, window.endUtc) as { total: number };
  return row.total;
}

export function getAllUsers(): User[] {
  return db.prepare("SELECT * FROM users").all() as User[];
}

export function getParticipantCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count;
}

/** Users who opted into daily reminders. */
export function getUsersWithRemindersEnabled(): User[] {
  return db
    .prepare("SELECT * FROM users WHERE reminder_enabled = 1")
    .all() as User[];
}

/** Users who opted into Sunday/Wednesday fasting reminders. */
export function getUsersWithFastingRemindersEnabled(): User[] {
  return db
    .prepare("SELECT * FROM users WHERE fasting_reminder_enabled = 1")
    .all() as User[];
}

export interface UserProfileUpdate {
  nickname?: string;
  goal?: number;
  reminderEnabled?: boolean;
  /** HH:mm override, or null to clear back to global default. */
  reminderTime?: string | null;
  realName?: string;
  fastingReminderEnabled?: boolean;
  fastingReminderTime?: string;
}

export function updateUserProfile(telegramId: number, update: UserProfileUpdate): User {
  const user = getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error(`updateUserProfile: user ${telegramId} not found`);
  }

  const nickname = update.nickname ?? user.nickname;
  const goal = update.goal ?? user.goal;
  const reminderEnabled =
    update.reminderEnabled !== undefined ? (update.reminderEnabled ? 1 : 0) : user.reminder_enabled;
  const reminderTime =
    update.reminderTime !== undefined ? update.reminderTime : user.reminder_time;
  const realName = update.realName !== undefined ? update.realName : user.real_name;
  const fastingReminderEnabled =
    update.fastingReminderEnabled !== undefined
      ? (update.fastingReminderEnabled ? 1 : 0)
      : user.fasting_reminder_enabled;
  const fastingReminderTime =
    update.fastingReminderTime !== undefined
      ? update.fastingReminderTime
      : user.fasting_reminder_time;

  db.prepare(
    `UPDATE users
     SET nickname = ?, goal = ?, reminder_enabled = ?, reminder_time = ?, real_name = ?,
         fasting_reminder_enabled = ?, fasting_reminder_time = ?
     WHERE telegram_id = ?`
  ).run(
    nickname,
    goal,
    reminderEnabled,
    reminderTime,
    realName,
    fastingReminderEnabled,
    fastingReminderTime,
    telegramId
  );

  return getUserByTelegramId(telegramId) ?? (() => {
    throw new Error(`Failed to reload user ${telegramId} after profile update`);
  })();
}

export interface ResetUserProgressResult {
  logsDeleted: number;
  dayGoalOverridesDeleted: number;
  retainedJamaatTotal: number;
}

/**
 * Clear one user's active progress without deleting their profile.
 * A soft reset moves the current net log sum into the all-time Jamaat carry;
 * a hard drop clears both active logs and all prior retained contribution.
 */
export function resetUserProgress(
  telegramId: number,
  dropFromJamaat: boolean
): ResetUserProgressResult | undefined {
  const reset = db.transaction(() => {
    const user = getUserByTelegramId(telegramId);
    if (!user) return undefined;

    const currentTotal = getUserTotal(user.id);
    const retainedJamaatTotal = dropFromJamaat
      ? 0
      : user.retained_jamaat_total + currentTotal;
    const dayGoalOverridesDeleted = db
      .prepare("DELETE FROM day_goal_overrides WHERE user_id = ?")
      .run(user.id).changes;
    const logsDeleted = db
      .prepare("DELETE FROM logs WHERE user_id = ?")
      .run(user.id).changes;
    db.prepare(
      `UPDATE users
       SET retained_jamaat_total = ?,
           progress_started_at = datetime('now')
       WHERE id = ?`
    ).run(retainedJamaatTotal, user.id);

    return {
      logsDeleted,
      dayGoalOverridesDeleted,
      retainedJamaatTotal,
    };
  });
  return reset();
}

/** Delete all challenge data so participants must re-register. Returns row counts removed. */
export function resetAllChallengeData(): {
  dayGoalOverrides: number;
  logs: number;
  users: number;
} {
  const wipe = db.transaction(() => {
    const dayGoalOverrides = db.prepare("DELETE FROM day_goal_overrides").run().changes;
    const logs = db.prepare("DELETE FROM logs").run().changes;
    const users = db.prepare("DELETE FROM users").run().changes;
    return { dayGoalOverrides, logs, users };
  });
  return wipe();
}

/** Full leaderboard rows for admin CSV export (includes telegram_id + goal + profile). */
export function getExportRows(window?: LogWindow): ExportRow[] {
  const dateJoin = window
    ? "AND l.logged_at >= ? AND l.logged_at < ?"
    : "";
  return db
    .prepare(
      `SELECT u.nickname AS nickname,
              u.real_name AS real_name,
              u.telegram_id AS telegram_id,
              u.telegram_username AS telegram_username,
              u.telegram_first_name AS telegram_first_name,
              u.telegram_last_name AS telegram_last_name,
              u.goal AS goal,
              COALESCE(SUM(l.count), 0) AS total
       FROM users u
       LEFT JOIN logs l ON l.user_id = u.id ${dateJoin}
       GROUP BY u.id
       ORDER BY total DESC, u.nickname ASC`
    )
    .all(...(window ? [window.startUtc, window.endUtc] : [])) as ExportRow[];
}
