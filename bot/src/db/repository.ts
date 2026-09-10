import { db } from "./client.js";
import { formatDateParts, parseDateKey, subtractOneCalendarDay } from "../utils/dates.js";
import type {
  AdminActionType,
  CreateUserReminders,
  ExportRow,
  Habit,
  HabitLog,
  HabitType,
  LeaderboardRow,
  PendingAdminAction,
  PendingRegistration,
  RegistrationStep,
  TelegramProfile,
  User,
} from "../types.js";

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
  habitLogsDeleted: number;
  pendingDeleted: boolean;
  adminDeleted: boolean;
}

/**
 * Full wipe for one Telegram id: habit logs, users row, pending signup, admin row.
 * After this, /start treats them as brand new.
 */
export function deleteUserCompletely(telegramId: number): DeleteUserCompletelyResult {
  const wipe = db.transaction(() => {
    const user = getUserByTelegramId(telegramId);
    let habitLogsDeleted = 0;
    let userDeleted = false;

    if (user) {
      habitLogsDeleted = db
        .prepare("DELETE FROM habit_logs WHERE user_id = ?")
        .run(user.id).changes;
      userDeleted = db.prepare("DELETE FROM users WHERE id = ?").run(user.id).changes > 0;
    }

    const pendingDeleted =
      db.prepare("DELETE FROM pending_registrations WHERE telegram_id = ?").run(telegramId)
        .changes > 0;
    const adminDeleted =
      db.prepare("DELETE FROM admins WHERE telegram_id = ?").run(telegramId).changes > 0;

    return {
      userDeleted,
      habitLogsDeleted,
      pendingDeleted,
      adminDeleted,
    };
  });
  return wipe();
}

export function createUser(
  telegramId: number,
  nickname: string,
  profile: TelegramProfile = {
    telegramUsername: null,
    telegramFirstName: null,
    telegramLastName: null,
  },
  realName: string | null = null,
  reminders?: CreateUserReminders
): User {
  const reminderEnabled = reminders ? (reminders.reminderEnabled ? 1 : 0) : 1;
  const reminderTime = reminders?.reminderTime ?? "20:00";

  const result = db
    .prepare(
      `INSERT INTO users (
         telegram_id, nickname,
         telegram_username, telegram_first_name, telegram_last_name,
         real_name,
         reminder_enabled, reminder_time
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      telegramId,
      nickname,
      profile.telegramUsername,
      profile.telegramFirstName,
      profile.telegramLastName,
      realName,
      reminderEnabled,
      reminderTime
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
    reminder_enabled: number | null;
    reminder_time: string | null;
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
         reminder_enabled = ?,
         reminder_time = ?,
         updated_at = datetime('now')
     WHERE telegram_id = ?`
  ).run(
    patch.step ?? current.step,
    patch.real_name !== undefined ? patch.real_name : current.real_name,
    patch.nickname !== undefined ? patch.nickname : current.nickname,
    patch.reminder_enabled !== undefined ? patch.reminder_enabled : current.reminder_enabled,
    patch.reminder_time !== undefined ? patch.reminder_time : current.reminder_time,
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

export interface UserProfileUpdate {
  nickname?: string;
  reminderEnabled?: boolean;
  reminderTime?: string;
  realName?: string;
  /** undefined = leave unchanged; null = reset to unset (fall back to config.timezone). */
  timezone?: string | null;
}

export function updateUserProfile(telegramId: number, update: UserProfileUpdate): User {
  const user = getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error(`updateUserProfile: user ${telegramId} not found`);
  }

  const nickname = update.nickname ?? user.nickname;
  const reminderEnabled =
    update.reminderEnabled !== undefined ? (update.reminderEnabled ? 1 : 0) : user.reminder_enabled;
  const reminderTime = update.reminderTime ?? user.reminder_time;
  const realName = update.realName !== undefined ? update.realName : user.real_name;
  const timezone = update.timezone !== undefined ? update.timezone : user.timezone;

  db.prepare(
    `UPDATE users
     SET nickname = ?, reminder_enabled = ?, reminder_time = ?, real_name = ?, timezone = ?
     WHERE telegram_id = ?`
  ).run(nickname, reminderEnabled, reminderTime, realName, timezone, telegramId);

  return getUserByTelegramId(telegramId) ?? (() => {
    throw new Error(`Failed to reload user ${telegramId} after profile update`);
  })();
}

/** Delete all habit logs and users so participants must re-register. Habit definitions are untouched. */
export function resetAllChallengeData(): {
  habitLogs: number;
  users: number;
} {
  const wipe = db.transaction(() => {
    const habitLogs = db.prepare("DELETE FROM habit_logs").run().changes;
    const users = db.prepare("DELETE FROM users").run().changes;
    return { habitLogs, users };
  });
  return wipe();
}

/**
 * quantity → value * points_weight; binary → flat points_weight (value is always 1).
 * Called once at write time in upsertHabitLog and frozen into habit_logs.points_earned —
 * never recompute from habits.points_weight when reading, so weight changes aren't retroactive.
 */
export function computePoints(
  habit: { type: HabitType; points_weight: number },
  value: number
): number {
  if (habit.type === "quantity") return value * habit.points_weight;
  return habit.points_weight;
}

export function getHabitById(id: number): Habit | undefined {
  return db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as Habit | undefined;
}

export function createHabit(name: string, type: HabitType, pointsWeight: number): Habit {
  const result = db
    .prepare(
      `INSERT INTO habits (name, type, points_weight) VALUES (?, ?, ?)`
    )
    .run(name, type, pointsWeight);
  return getHabitById(Number(result.lastInsertRowid)) ?? (() => {
    throw new Error(`Failed to load habit just created (rowid ${result.lastInsertRowid})`);
  })();
}

export function updateHabit(
  id: number,
  patch: Partial<{ name: string; pointsWeight: number; isActive: boolean }>
): Habit {
  const current = getHabitById(id);
  if (!current) {
    throw new Error(`updateHabit: habit ${id} not found`);
  }

  const name = patch.name ?? current.name;
  const pointsWeight = patch.pointsWeight ?? current.points_weight;
  const isActive = patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : current.is_active;

  db.prepare(
    `UPDATE habits
     SET name = ?, points_weight = ?, is_active = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(name, pointsWeight, isActive, id);

  return getHabitById(id) ?? (() => {
    throw new Error(`Failed to reload habit ${id} after update`);
  })();
}

export function listHabits(options: { activeOnly?: boolean } = {}): Habit[] {
  if (options.activeOnly) {
    return db
      .prepare("SELECT * FROM habits WHERE is_active = 1 ORDER BY id ASC")
      .all() as Habit[];
  }
  return db.prepare("SELECT * FROM habits ORDER BY id ASC").all() as Habit[];
}

export function deactivateHabit(id: number): Habit {
  return updateHabit(id, { isActive: false });
}

/**
 * Upsert a user's log for a habit on a given TIMEZONE-local day (YYYY-MM-DD).
 * Not cumulative: a second call for the same (user, habit, logDate) overwrites
 * value/points_earned rather than adding to them. Points are computed fresh from
 * the habit's current weight/type at the moment of this call and then frozen —
 * a later habits.points_weight change never touches an already-written row.
 */
export function upsertHabitLog(
  userId: number,
  habitId: number,
  value: number,
  logDate: string
): HabitLog {
  const habit = getHabitById(habitId);
  if (!habit) {
    throw new Error(`upsertHabitLog: habit ${habitId} not found`);
  }
  const pointsEarned = computePoints(habit, value);

  db.prepare(
    `INSERT INTO habit_logs (user_id, habit_id, log_date, value, points_earned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id, habit_id, log_date) DO UPDATE SET
       value = excluded.value,
       points_earned = excluded.points_earned,
       updated_at = excluded.updated_at`
  ).run(userId, habitId, logDate, value, pointsEarned);

  return db
    .prepare(
      "SELECT * FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?"
    )
    .get(userId, habitId, logDate) as HabitLog;
}

/**
 * Delete this user's TIMEZONE-local-today log for a habit, if any. Idempotent —
 * a no-op when no such row exists. Deleting (rather than zeroing value/points_earned
 * in place) is what makes the day disappear from getHabitStreak and
 * getUserHabitLogsForDate, both of which key off row presence, not value.
 */
export function deleteHabitLog(userId: number, habitId: number, logDate: string): void {
  db.prepare(
    "DELETE FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?"
  ).run(userId, habitId, logDate);
}

export function getUserTotalPoints(userId: number): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(points_earned), 0) AS total FROM habit_logs WHERE user_id = ?")
    .get(userId) as { total: number };
  return row.total;
}

/**
 * Consecutive days (walking backward from asOfDate, inclusive) that have a
 * habit_logs row for this (user, habit). Returns 0 if asOfDate itself has no log.
 */
export function getHabitStreak(userId: number, habitId: number, asOfDate: string): number {
  const rows = db
    .prepare("SELECT log_date FROM habit_logs WHERE user_id = ? AND habit_id = ?")
    .all(userId, habitId) as { log_date: string }[];
  const loggedDays = new Set(rows.map((r) => r.log_date));

  let streak = 0;
  let cursor = asOfDate;
  while (loggedDays.has(cursor)) {
    streak++;
    cursor = formatDateParts(subtractOneCalendarDay(parseDateKey(cursor)));
  }
  return streak;
}

/**
 * All-time, perpetual leaderboard: one row per user (including users with no
 * logs at all, at total 0), ranked by total points descending. No date
 * window — the tracker has no periodic resets (PIVOT_PLAN §0).
 */
export function getLeaderboard(): LeaderboardRow[] {
  return db
    .prepare(
      `SELECT u.id AS user_id,
              u.telegram_id AS telegram_id,
              u.nickname AS nickname,
              u.real_name AS real_name,
              COALESCE(SUM(hl.points_earned), 0) AS total
       FROM users u
       LEFT JOIN habit_logs hl ON hl.user_id = u.id
       GROUP BY u.id
       ORDER BY total DESC, u.nickname ASC`
    )
    .all() as LeaderboardRow[];
}

/** Same ranking as getLeaderboard, plus raw Telegram identity fields, for the admin CSV export. */
export function getExportRows(): ExportRow[] {
  return db
    .prepare(
      `SELECT u.id AS user_id,
              u.telegram_id AS telegram_id,
              u.nickname AS nickname,
              u.real_name AS real_name,
              u.telegram_username AS telegram_username,
              u.telegram_first_name AS telegram_first_name,
              u.telegram_last_name AS telegram_last_name,
              COALESCE(SUM(hl.points_earned), 0) AS total
       FROM users u
       LEFT JOIN habit_logs hl ON hl.user_id = u.id
       GROUP BY u.id
       ORDER BY total DESC, u.nickname ASC`
    )
    .all() as ExportRow[];
}

/** This user's habit_logs rows for one TIMEZONE-local day, keyed by habit_id. */
export function getUserHabitLogsForDate(userId: number, date: string): Map<number, HabitLog> {
  const rows = db
    .prepare("SELECT * FROM habit_logs WHERE user_id = ? AND log_date = ?")
    .all(userId, date) as HabitLog[];
  return new Map(rows.map((row) => [row.habit_id, row]));
}
