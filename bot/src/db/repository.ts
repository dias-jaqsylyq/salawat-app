import { db } from "./client.js";
import { generateRoomPassword } from "../utils/roomPassword.js";
import { streakFromLoggedDays, streakFromLoggedWeeks } from "../utils/streak.js";
import { weekBoundsOfDateKey } from "../utils/dates.js";
import type {
  CreateUserReminders,
  ExportRow,
  Habit,
  HabitCategory,
  HabitLog,
  HabitPeriod,
  LeaderboardRow,
  PendingRegistration,
  PersonalHabit,
  PersonalHabitLog,
  RegistrationStep,
  Room,
  StreakDisplay,
  TelegramProfile,
  User,
  UserRole,
  WeeklyLeaderboardRow,
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

export interface NicknameScope {
  excludeTelegramId?: number;
  /**
   * Restrict the collision check to one room. Nickname uniqueness is per-room,
   * not global — the same nickname may exist in two rooms (PRD §3a). Omitted
   * means "across all rooms", which no room-scoped caller wants; it stays
   * available for checks made before a room is known (a roomless user editing
   * their profile).
   */
  roomId?: number;
}

/** Case-insensitive nickname collision check. */
export function isNicknameTaken(nickname: string, scope: NicknameScope = {}): boolean {
  const { excludeTelegramId, roomId } = scope;

  const conditions = ["LOWER(nickname) = LOWER(?)"];
  const params: (string | number)[] = [nickname];
  if (excludeTelegramId !== undefined) {
    conditions.push("telegram_id != ?");
    params.push(excludeTelegramId);
  }
  if (roomId !== undefined) {
    conditions.push("current_room_id = ?");
    params.push(roomId);
  }

  const row = db
    .prepare(`SELECT 1 AS hit FROM users WHERE ${conditions.join(" AND ")} LIMIT 1`)
    .get(...params) as { hit: number } | undefined;
  return row !== undefined;
}

/* ------------------------------------------------------------------ rooms */

/**
 * Create a room and its first admin in one transaction: the owner is inserted
 * into room_admins alongside it, so a room never exists with zero admins
 * (the invariant behind last-admin protection, PRD §3a).
 *
 * The caller must already exist as a user — users.current_room_id is set
 * separately (setUserCurrentRoom), keeping the users <-> rooms cycle to a
 * plain insert order rather than deferred foreign keys.
 */
export function createRoom(
  name: string,
  password: string,
  ownerUserId: number,
  categoriesEnabled = false
): Room {
  const create = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO rooms (name, password, categories_enabled, owner_user_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(name, password, categoriesEnabled ? 1 : 0, ownerUserId);
    const roomId = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO room_admins (room_id, user_id) VALUES (?, ?)").run(
      roomId,
      ownerUserId
    );
    return roomId;
  });

  const roomId = create();
  return getRoomById(roomId) ?? (() => {
    throw new Error(`Failed to load room just created (id ${roomId})`);
  })();
}

export function getRoomById(id: number): Room | undefined {
  return db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as Room | undefined;
}

/**
 * Resolve a join password to its room. Case-sensitive on purpose — `ABC` and
 * `abc` are different passwords (PRD §3a) — so this is a plain `=` comparison
 * under SQLite's default BINARY collation, never LOWER()/COLLATE NOCASE.
 */
export function getRoomByPassword(password: string): Room | undefined {
  return db.prepare("SELECT * FROM rooms WHERE password = ?").get(password) as Room | undefined;
}

/**
 * Point the room at a new password. Only blocks *future* joins — everyone who
 * already joined keeps their membership, no re-verification (PRD §3a).
 *
 * Throws on the rooms.password UNIQUE constraint when the chosen password is
 * already some other room's — see isRoomPasswordCollision.
 */
export function updateRoomPassword(roomId: number, password: string): Room {
  db.prepare("UPDATE rooms SET password = ? WHERE id = ?").run(password, roomId);
  return getRoomById(roomId) ?? (() => {
    throw new Error(`updateRoomPassword: room ${roomId} not found`);
  })();
}

/**
 * True for the one error a password write can legitimately produce: the chosen
 * password is already in use by another room. UNIQUE on rooms.password — not
 * the generator — is what guarantees a password resolves to exactly one room.
 */
export function isRoomPasswordCollision(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("UNIQUE constraint failed: rooms.password");
}

/**
 * Swap the room's password for a fresh random one, retrying the (vanishingly
 * unlikely) UNIQUE collision — same contract as room creation, since the admin
 * asked for "a new one", not for any particular string.
 */
export function regenerateRoomPassword(roomId: number): Room {
  for (let attempt = 1; ; attempt++) {
    try {
      return updateRoomPassword(roomId, generateRoomPassword());
    } catch (err) {
      if (!isRoomPasswordCollision(err) || attempt >= ROOM_PASSWORD_ATTEMPTS) throw err;
      console.warn(
        `regenerateRoomPassword: generated room password collided (attempt ${attempt}), retrying`
      );
    }
  }
}

/**
 * Flip the room's category mode. Habit categories already stored are left
 * untouched when switching off, so nothing is lost (PRD §0).
 */
export function setRoomCategoriesEnabled(roomId: number, enabled: boolean): Room {
  db.prepare("UPDATE rooms SET categories_enabled = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    roomId
  );
  return getRoomById(roomId) ?? (() => {
    throw new Error(`setRoomCategoriesEnabled: room ${roomId} not found`);
  })();
}

export interface DeleteRoomResult {
  deleted: boolean;
  /** Members who were still in the room and have just been left without one. */
  membersDetached: number;
}

/**
 * Delete a room and everything hanging off it.
 *
 * This exists for exactly one case: an admin who is the *only* member of their
 * room switching out of it (switchRoomWithKick), where leaving the room
 * standing would strand a room nobody can reach or run. Room deletion is
 * otherwise out of scope (MULTI ROOM PRD §6) — there is no general "delete my
 * room" action, and nothing else calls this.
 *
 * One DELETE does the whole job: room_admins, habits, habit_logs,
 * personal_habits and personal_habit_logs all cascade from rooms(id) with
 * foreign keys on (client.ts). Deliberately no hand-written child deletes — the
 * cascade stays the single source of truth, so a child table added later cannot
 * be silently forgotten here.
 *
 * room_joined_at is cleared by hand first: users.current_room_id is
 * ON DELETE SET NULL, but nothing nulls the stamp beside it, and a join date
 * with no room behind it confuses every weekly view that reads it.
 */
export function deleteRoom(roomId: number): DeleteRoomResult {
  const remove = db.transaction((): DeleteRoomResult => {
    const membersDetached = getParticipantCount(roomId);
    db.prepare("UPDATE users SET room_joined_at = NULL WHERE current_room_id = ?").run(roomId);
    const deleted = db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId).changes > 0;
    return { deleted, membersDetached };
  });
  return remove();
}

/* ---------------------------------------------------- room-scoped admins */

/** True when this user is an admin (owner or co-admin) of that specific room. */
export function isRoomAdmin(userId: number, roomId: number): boolean {
  const row = db
    .prepare("SELECT 1 AS hit FROM room_admins WHERE room_id = ? AND user_id = ? LIMIT 1")
    .get(roomId, userId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * True when this Telegram user is an admin of the room they are currently in.
 * Admin status never carries across rooms (PRD §3a), so a user with no current
 * room is never an admin of anything.
 */
export function isRoomAdminByTelegramId(telegramId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit
       FROM users u
       JOIN room_admins ra ON ra.user_id = u.id AND ra.room_id = u.current_room_id
       WHERE u.telegram_id = ?
       LIMIT 1`
    )
    .get(telegramId) as { hit: number } | undefined;
  return row !== undefined;
}

/** Promote a participant to co-admin of a room. Idempotent. */
export function addRoomAdmin(roomId: number, userId: number): void {
  db.prepare("INSERT OR IGNORE INTO room_admins (room_id, user_id) VALUES (?, ?)").run(
    roomId,
    userId
  );
}

/**
 * Demote a room admin back to plain participant. Idempotent.
 * Callers must enforce last-admin protection (PRD §3a) via countRoomAdmins —
 * this function itself will happily empty the room, which is what makes it
 * reusable for the kick path, where the room is being left behind anyway.
 */
export function removeRoomAdmin(roomId: number, userId: number): void {
  db.prepare("DELETE FROM room_admins WHERE room_id = ? AND user_id = ?").run(roomId, userId);
}

/** User ids of every admin of a room, oldest first. */
export function listRoomAdminUserIds(roomId: number): number[] {
  const rows = db
    .prepare("SELECT user_id FROM room_admins WHERE room_id = ? ORDER BY created_at ASC, user_id ASC")
    .all(roomId) as { user_id: number }[];
  return rows.map((row) => row.user_id);
}

/**
 * True when this user is the room's only admin *and* other members are still in
 * it — the one shape where leaving has to be refused, since it would leave a
 * populated room with nobody able to run it (PRD §3a).
 *
 * A read-only pre-check, for callers that must refuse before asking the user
 * anything else. switchRoomWithKick re-checks the same thing inside its own
 * transaction, and that one is the source of truth.
 */
export function isLastAdminWithMembers(userId: number, roomId: number): boolean {
  return (
    isRoomAdmin(userId, roomId) &&
    getParticipantCount(roomId) > 1 &&
    countRoomAdmins(roomId) <= 1
  );
}

/** How many admins a room has — the input to last-admin protection (PRD §3a). */
export function countRoomAdmins(roomId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM room_admins WHERE room_id = ?")
    .get(roomId) as { count: number };
  return row.count;
}

/**
 * `demoted` is false either because the user was not an admin of that room at
 * all, or because they were its last one — `lastAdmin` separates the two so the
 * caller can answer 409 vs. a no-op 200.
 */
export interface DemoteRoomAdminResult {
  demoted: boolean;
  lastAdmin: boolean;
}

/**
 * Demote a room admin back to plain participant, refusing to empty the room
 * (last-admin protection, PRD §3a).
 *
 * The count and the delete run in one transaction on purpose: two co-admins
 * demoting each other at the same moment must not both read "2 admins" and both
 * delete. Prefer this over a bare removeRoomAdmin anywhere the room is meant to
 * keep working afterwards.
 */
export function demoteRoomAdmin(roomId: number, userId: number): DemoteRoomAdminResult {
  const demote = db.transaction((): DemoteRoomAdminResult => {
    if (!isRoomAdmin(userId, roomId)) {
      return { demoted: false, lastAdmin: false };
    }
    if (countRoomAdmins(roomId) <= 1) {
      return { demoted: false, lastAdmin: true };
    }
    removeRoomAdmin(roomId, userId);
    return { demoted: true, lastAdmin: false };
  });
  return demote();
}

export interface LeaveRoomResult {
  left: boolean;
  /** True when the leave was refused because they are the room's only admin. */
  lastAdmin: boolean;
  /** The room they left (or are still in, when refused); null if they had none. */
  roomId: number | null;
}

/**
 * A member leaving their room voluntarily (PRD §0/§3a): membership is detached,
 * co-admin status is stripped, and their habit_logs are kept — a voluntary
 * leave is not destructive, unlike a kick (kickUserFromRoom).
 *
 * Refused when they are the room's last admin: promote someone else first
 * (PRD §3a). Checked inside the transaction for the same race reason as
 * demoteRoomAdmin.
 */
export function leaveCurrentRoom(userId: number): LeaveRoomResult {
  const leave = db.transaction((): LeaveRoomResult => {
    const row = db.prepare("SELECT current_room_id FROM users WHERE id = ?").get(userId) as
      | { current_room_id: number | null }
      | undefined;
    if (!row) {
      throw new Error(`leaveCurrentRoom: user ${userId} not found`);
    }
    const roomId = row.current_room_id;
    if (roomId === null) {
      return { left: false, lastAdmin: false, roomId: null };
    }
    if (isRoomAdmin(userId, roomId) && countRoomAdmins(roomId) <= 1) {
      return { left: false, lastAdmin: true, roomId };
    }
    setUserCurrentRoom(userId, null);
    return { left: true, lastAdmin: false, roomId };
  });
  return leave();
}

export interface KickUserFromRoomResult {
  kicked: boolean;
  /** True when the kick was refused because the target is the room's only admin. */
  lastAdmin: boolean;
  habitLogsDeleted: number;
  wasRoomAdmin: boolean;
}

/**
 * Kick a member out of a room (PRD §3a). Destructive, unlike a voluntary leave:
 * every habit_logs row they earned *in this room* is deleted, so a later rejoin
 * with the same password starts from zero. Logs they earned in other rooms are
 * untouched — that is what habit_logs.room_id is for.
 *
 * Refused for the room's last admin, so a kick can never leave a room
 * admin-less; the caller separately blocks kicking yourself.
 */
export function kickUserFromRoom(userId: number, roomId: number): KickUserFromRoomResult {
  const kick = db.transaction((): KickUserFromRoomResult => {
    const row = db.prepare("SELECT current_room_id FROM users WHERE id = ?").get(userId) as
      | { current_room_id: number | null }
      | undefined;
    if (!row || row.current_room_id !== roomId) {
      return { kicked: false, lastAdmin: false, habitLogsDeleted: 0, wasRoomAdmin: false };
    }

    const wasRoomAdmin = isRoomAdmin(userId, roomId);
    if (wasRoomAdmin && countRoomAdmins(roomId) <= 1) {
      return { kicked: false, lastAdmin: true, habitLogsDeleted: 0, wasRoomAdmin };
    }

    const habitLogsDeleted = db
      .prepare("DELETE FROM habit_logs WHERE user_id = ? AND room_id = ?")
      .run(userId, roomId).changes;
    // Also drops their room_admins row for this room.
    setUserCurrentRoom(userId, null);

    return { kicked: true, lastAdmin: false, habitLogsDeleted, wasRoomAdmin };
  });
  return kick();
}

/**
 * Move a user into a room, or out of every room (roomId = null).
 * Leaving always strips co-admin status of the room being left: it does not
 * transfer, and a returning user comes back as a plain participant (PRD §3a).
 * It also deletes the personal habits they kept in that room — those are scoped
 * to the membership and never follow someone into the next room.
 * Their habit_logs are left intact — history stays queryable, and nothing needs
 * deleting on a voluntary leave (PRD §1).
 *
 * room_joined_at tracks membership in step: stamped on a real move into a room,
 * cleared on the way out, and deliberately *not* refreshed when the call names
 * the room the user is already in — re-running a no-op move must not look like
 * a fresh join to the weekly view.
 */
export function setUserCurrentRoom(userId: number, roomId: number | null): void {
  const move = db.transaction(() => {
    const current = db.prepare("SELECT current_room_id FROM users WHERE id = ?").get(userId) as
      | { current_room_id: number | null }
      | undefined;
    if (!current) {
      throw new Error(`setUserCurrentRoom: user ${userId} not found`);
    }
    if (current.current_room_id !== null && current.current_room_id !== roomId) {
      removeRoomAdmin(current.current_room_id, userId);
      // Personal habits belong to the membership, not to the person: leaving,
      // being kicked and moving rooms all pass through here, so this one delete
      // covers every way out. Their logs go with them (ON DELETE CASCADE).
      db.prepare("DELETE FROM personal_habits WHERE user_id = ? AND room_id = ?").run(
        userId,
        current.current_room_id
      );
    }
    if (roomId === null) {
      db.prepare(
        "UPDATE users SET current_room_id = NULL, room_joined_at = NULL WHERE id = ?"
      ).run(userId);
    } else if (current.current_room_id === roomId) {
      db.prepare(
        `UPDATE users SET current_room_id = ?, room_joined_at = COALESCE(room_joined_at, datetime('now'))
         WHERE id = ?`
      ).run(roomId, userId);
    } else {
      db.prepare(
        "UPDATE users SET current_room_id = ?, room_joined_at = datetime('now') WHERE id = ?"
      ).run(roomId, userId);
    }
  });
  move();
}

export interface SwitchRoomResult {
  switched: boolean;
  /** Refused: they are the old room's last admin and other members remain. */
  lastAdmin: boolean;
  /** Refused: the room they are joining no longer exists. */
  targetMissing: boolean;
  /** No-op: they were already in that room. */
  alreadyThere: boolean;
  /** The room they were in, or null if they were between rooms. */
  oldRoomId: number | null;
  /** The old room was deleted — they were an admin and its only member. */
  oldRoomDeleted: boolean;
  habitLogsDeleted: number;
}

/**
 * Move a user out of whatever room they are in and into another one, in a
 * single transaction. Backs the deep-link room switch.
 *
 * Destructive on the way out, deliberately: the habit_logs they earned in the
 * old room are deleted, as in a kick (kickUserFromRoom) and unlike a voluntary
 * leave. A switch is not a pause — nothing of theirs is coming back to that
 * room, and leaving their rows behind would keep them on its leaderboard.
 * Personal habits and co-admin status go the same way, via setUserCurrentRoom.
 *
 * Nothing else on the users row is touched: nickname, real name and reminder
 * settings follow the person, not the membership. Freeing up the nickname in
 * the target room is the caller's job — uniqueness there is per-room and lives
 * in application code only (isNicknameTaken).
 *
 * Refused for the last admin of a room that still has other people in it, the
 * same guard leave and kick apply. An admin who is the room's *only* member is
 * the deliberate exception: rather than trapping them, the empty room is
 * deleted behind them (deleteRoom).
 *
 * A user with no current room is the degenerate case and is simply moved in —
 * that is how someone who left a room gets back into one at all.
 */
export function switchRoomWithKick(userId: number, targetRoomId: number): SwitchRoomResult {
  const refused = {
    switched: false,
    lastAdmin: false,
    targetMissing: false,
    alreadyThere: false,
    oldRoomDeleted: false,
    habitLogsDeleted: 0,
  };

  const move = db.transaction((): SwitchRoomResult => {
    const row = db.prepare("SELECT current_room_id FROM users WHERE id = ?").get(userId) as
      | { current_room_id: number | null }
      | undefined;
    if (!row) {
      throw new Error(`switchRoomWithKick: user ${userId} not found`);
    }
    const oldRoomId = row.current_room_id;

    // Both checked before anything is written: the question that led here may
    // be minutes old, and neither case is an error worth throwing over.
    if (!getRoomById(targetRoomId)) {
      return { ...refused, targetMissing: true, oldRoomId };
    }
    if (oldRoomId === targetRoomId) {
      return { ...refused, alreadyThere: true, oldRoomId };
    }

    let habitLogsDeleted = 0;
    let deleteOldRoom = false;
    if (oldRoomId !== null) {
      const wasAdmin = isRoomAdmin(userId, oldRoomId);
      const members = getParticipantCount(oldRoomId);
      // Order matters: an admin alone in their room is its last admin too, and
      // that case deletes the room rather than refusing the move.
      if (wasAdmin && members > 1 && countRoomAdmins(oldRoomId) <= 1) {
        return { ...refused, lastAdmin: true, oldRoomId };
      }
      deleteOldRoom = wasAdmin && members === 1;
      habitLogsDeleted = db
        .prepare("DELETE FROM habit_logs WHERE user_id = ? AND room_id = ?")
        .run(userId, oldRoomId).changes;
    }

    // Drops the old room_admins row and the personal habits kept in that room,
    // and stamps room_joined_at for the new one.
    setUserCurrentRoom(userId, targetRoomId);

    // After the move, so the room is already empty by the time it goes and its
    // ON DELETE SET NULL on users.current_room_id has nobody left to touch.
    if (deleteOldRoom && oldRoomId !== null) {
      deleteRoom(oldRoomId);
    }

    return {
      switched: true,
      lastAdmin: false,
      targetMissing: false,
      alreadyThere: false,
      oldRoomId,
      oldRoomDeleted: deleteOldRoom,
      habitLogsDeleted,
    };
  });
  return move();
}

export interface DeleteUserCompletelyResult {
  userDeleted: boolean;
  habitLogsDeleted: number;
  pendingDeleted: boolean;
  /** room_admins rows removed — one per room where they were owner or co-admin. */
  roomAdminRowsDeleted: number;
}

/**
 * Full wipe for one Telegram id: habit logs, room-admin status, users row,
 * pending signup. After this, /start treats them as brand new. Rooms they
 * created survive with owner_user_id NULLed (schema.sql) — a room is never
 * deleted as a side effect of removing a person.
 */
export function deleteUserCompletely(telegramId: number): DeleteUserCompletelyResult {
  const wipe = db.transaction(() => {
    const user = getUserByTelegramId(telegramId);
    let habitLogsDeleted = 0;
    let roomAdminRowsDeleted = 0;
    let userDeleted = false;

    if (user) {
      habitLogsDeleted = db
        .prepare("DELETE FROM habit_logs WHERE user_id = ?")
        .run(user.id).changes;
      // Cascades to personal_habit_logs.
      db.prepare("DELETE FROM personal_habits WHERE user_id = ?").run(user.id);
      roomAdminRowsDeleted = db
        .prepare("DELETE FROM room_admins WHERE user_id = ?")
        .run(user.id).changes;
      userDeleted = db.prepare("DELETE FROM users WHERE id = ?").run(user.id).changes > 0;
    }

    const pendingDeleted =
      db.prepare("DELETE FROM pending_registrations WHERE telegram_id = ?").run(telegramId)
        .changes > 0;
    db.prepare("DELETE FROM registration_messages WHERE telegram_id = ?").run(telegramId);

    return {
      userDeleted,
      habitLogsDeleted,
      pendingDeleted,
      roomAdminRowsDeleted,
    };
  });
  return wipe();
}

/** Room placement chosen at registration. Omitted = plain participant, no room yet. */
export interface CreateUserMembership {
  role?: UserRole;
  /**
   * NULL for an admin who has not created their room yet (the room needs the
   * user row to exist first) and for a participant mid-join.
   */
  currentRoomId?: number | null;
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
  reminders?: CreateUserReminders,
  membership: CreateUserMembership = {}
): User {
  const reminderEnabled = reminders ? (reminders.reminderEnabled ? 1 : 0) : 1;
  const reminderTime = reminders?.reminderTime ?? "20:00";
  const fastingReminderEnabled = reminders?.fastingReminderEnabled ? 1 : 0;
  const fastingReminderTime = reminders?.fastingReminderTime ?? "20:00";
  const role: UserRole = membership.role ?? "participant";
  const currentRoomId = membership.currentRoomId ?? null;

  const result = db
    .prepare(
      `INSERT INTO users (
         telegram_id, nickname,
         role, current_room_id,
         room_joined_at,
         telegram_username, telegram_first_name, telegram_last_name,
         real_name,
         reminder_enabled, reminder_time,
         fasting_reminder_enabled, fasting_reminder_time
       ) VALUES (
         ?, ?, ?, ?,
         CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
         ?, ?, ?, ?, ?, ?, ?, ?
       )`
    )
    .run(
      telegramId,
      nickname,
      role,
      currentRoomId,
      // A participant joins their room the moment the row is created; an admin's
      // row is born roomless and gets stamped by setUserCurrentRoom once the
      // room it owns exists. Same clock as created_at, deliberately.
      currentRoomId,
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

/**
 * Overwrite an existing users row with a fresh set of signup answers.
 *
 * Backs re-registration: someone who left their room and ran the whole signup
 * conversation again from a bare /start (start.ts). They answered every
 * question from scratch, so every answer is written from scratch — nothing is
 * carried over from the registration this replaces.
 *
 * Only the columns a signup actually asks about. Deliberately untouched:
 *   • current_room_id / room_joined_at — setUserCurrentRoom owns those, and it
 *     is the only thing that keeps the two in step.
 *   • timezone, streak_display, week_start_day — Mini App settings, never asked
 *     here, and silently resetting them would rearrange the app under someone
 *     who only wanted a new room.
 *   • id and created_at — this is the same account, with the same history
 *     hanging off it (habit_logs point at users.id).
 *
 * role is rewritten because the role question is asked again. Safe despite the
 * PRD calling it chosen-once: users.role is written at registration and read
 * nowhere — not for authorization (that is room_admins, via isRoomAdmin), not
 * by the API, not by the Mini App.
 */
export function applyRegistrationAnswers(
  telegramId: number,
  nickname: string,
  profile: TelegramProfile,
  realName: string | null,
  reminders: CreateUserReminders,
  role: UserRole
): User {
  db.prepare(
    `UPDATE users
     SET nickname = ?, role = ?,
         telegram_username = ?, telegram_first_name = ?, telegram_last_name = ?,
         real_name = ?,
         reminder_enabled = ?, reminder_time = ?,
         fasting_reminder_enabled = ?, fasting_reminder_time = ?
     WHERE telegram_id = ?`
  ).run(
    nickname,
    role,
    profile.telegramUsername,
    profile.telegramFirstName,
    profile.telegramLastName,
    realName,
    reminders.reminderEnabled ? 1 : 0,
    reminders.reminderTime,
    reminders.fastingReminderEnabled ? 1 : 0,
    reminders.fastingReminderTime,
    telegramId
  );
  return getUserByTelegramId(telegramId) ?? (() => {
    throw new Error(`applyRegistrationAnswers: user ${telegramId} not found`);
  })();
}

/**
 * Save a finished signup against this Telegram id, whether or not one has ever
 * been saved before: a new row for a first registration, an overwrite of the
 * existing one for someone registering again after leaving their room.
 *
 * The one entry point both finalize branches use, which is what keeps the
 * second case from hitting UNIQUE(users.telegram_id) — a collision that used to
 * be the only way this could fail, and is now not reachable from either.
 *
 * Refuses outright for an existing user who is still in a room. Registration is
 * not a way to move rooms: the setUserCurrentRoom below would quietly strip
 * their co-admin status and delete the personal habits they keep in that room.
 * Moving rooms is switchRoomWithKick, behind an explicit yes. finalizeRegistration
 * checks the same thing before it gets here; this is the lock on the door the
 * damage would actually come through.
 */
export function registerUser(
  telegramId: number,
  nickname: string,
  profile: TelegramProfile,
  realName: string | null,
  reminders: CreateUserReminders,
  membership: CreateUserMembership = {}
): User {
  const existing = getUserByTelegramId(telegramId);
  if (!existing) {
    return createUser(telegramId, nickname, profile, realName, reminders, membership);
  }
  if (existing.current_room_id !== null) {
    throw new Error(
      `registerUser: user ${telegramId} is already in room ${existing.current_room_id} — ` +
        `registration cannot move someone between rooms`
    );
  }

  const save = db.transaction((): User => {
    const user = applyRegistrationAnswers(
      telegramId,
      nickname,
      profile,
      realName,
      reminders,
      membership.role ?? "participant"
    );
    // Through setUserCurrentRoom rather than the UPDATE above so room_joined_at
    // is stamped by the one function that knows when it should be.
    setUserCurrentRoom(user.id, membership.currentRoomId ?? null);
    return getUserByTelegramId(telegramId)!;
  });
  return save();
}

export interface AdminWithRoom {
  user: User;
  room: Room;
}

/** How many fresh passwords to try before giving up on a UNIQUE collision. */
const ROOM_PASSWORD_ATTEMPTS = 5;

/**
 * Register an admin and the one room they are creating, atomically (PRD §2,
 * admin path): the users row, the room, its room_admins owner row, and the
 * owner's current_room_id either all land or none do.
 *
 * Without the transaction a failure between the three writes leaves an admin
 * with no room — an account that can never finish registering, since /start
 * would then see them as already registered.
 *
 * The password is generated here rather than passed in because a UNIQUE
 * collision on rooms.password can only be resolved by retrying the whole
 * insert with a different one (the column, not the generator, is what
 * guarantees a password resolves to exactly one room).
 */
export function createAdminWithRoom(
  telegramId: number,
  nickname: string,
  profile: TelegramProfile,
  realName: string | null,
  reminders: CreateUserReminders,
  room: { name: string; categoriesEnabled: boolean }
): AdminWithRoom {
  const register = db.transaction((password: string) => {
    // registerUser, not createUser: an admin registering again after leaving
    // their room already has a users row, and everything below this line works
    // the same either way.
    const user = registerUser(telegramId, nickname, profile, realName, reminders, {
      role: "admin",
      // The room does not exist yet — it needs this user's id as its owner.
      currentRoomId: null,
    });
    const created = createRoom(room.name, password, user.id, room.categoriesEnabled);
    setUserCurrentRoom(user.id, created.id);
    return created.id;
  });

  for (let attempt = 1; ; attempt++) {
    const password = generateRoomPassword();
    try {
      const roomId = register(password);
      const user = getUserByTelegramId(telegramId);
      const created = getRoomById(roomId);
      if (!user || !created) {
        throw new Error(`createAdminWithRoom: failed to reload user/room just created`);
      }
      return { user, room: created };
    } catch (err) {
      if (!isRoomPasswordCollision(err) || attempt >= ROOM_PASSWORD_ATTEMPTS) throw err;
      console.warn(
        `createAdminWithRoom: generated room password collided (attempt ${attempt}), retrying`
      );
    }
  }
}

export function getPendingRegistration(telegramId: number): PendingRegistration | undefined {
  return db
    .prepare("SELECT * FROM pending_registrations WHERE telegram_id = ?")
    .get(telegramId) as PendingRegistration | undefined;
}

/**
 * Start a signup at the admin-or-participant question, or resume the existing
 * one at whatever step it reached (PRD §2).
 */
export function ensurePendingRegistration(telegramId: number): PendingRegistration {
  const existing = getPendingRegistration(telegramId);
  if (existing) return existing;

  db.prepare(
    `INSERT INTO pending_registrations (telegram_id, step, updated_at)
     VALUES (?, 'role', datetime('now'))`
  ).run(telegramId);

  return getPendingRegistration(telegramId) ?? (() => {
    throw new Error(`Failed to create pending registration for ${telegramId}`);
  })();
}

/**
 * Start a participant signup with the room already resolved, for someone who
 * arrived through a room's `t.me/<bot>?start=<password>` deep link (PRD §3a):
 * the role and password questions are answered by the link itself, so the
 * conversation opens at real_name.
 *
 * Any half-finished pending row is replaced — following an invite link is an
 * unambiguous "I want to join *this* room", which overrides whatever the
 * previous, unfinished attempt was heading toward.
 */
export function startPendingRegistrationForRoom(
  telegramId: number,
  roomId: number
): PendingRegistration {
  const seed = db.transaction(() => {
    db.prepare("DELETE FROM pending_registrations WHERE telegram_id = ?").run(telegramId);
    db.prepare(
      `INSERT INTO pending_registrations (telegram_id, step, role, room_id, updated_at)
       VALUES (?, 'real_name', 'participant', ?, datetime('now'))`
    ).run(telegramId, roomId);
  });
  seed();

  return getPendingRegistration(telegramId) ?? (() => {
    throw new Error(`Failed to create pending registration for ${telegramId}`);
  })();
}

export function updatePendingRegistration(
  telegramId: number,
  patch: Partial<{
    step: RegistrationStep;
    role: UserRole | null;
    real_name: string | null;
    nickname: string | null;
    room_name: string | null;
    categories_enabled: number | null;
    room_id: number | null;
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
         role = ?,
         real_name = ?,
         nickname = ?,
         room_name = ?,
         categories_enabled = ?,
         room_id = ?,
         reminder_enabled = ?,
         reminder_time = ?,
         fasting_reminder_enabled = ?,
         fasting_reminder_time = ?,
         updated_at = datetime('now')
     WHERE telegram_id = ?`
  ).run(
    patch.step ?? current.step,
    patch.role !== undefined ? patch.role : current.role,
    patch.real_name !== undefined ? patch.real_name : current.real_name,
    patch.nickname !== undefined ? patch.nickname : current.nickname,
    patch.room_name !== undefined ? patch.room_name : current.room_name,
    patch.categories_enabled !== undefined
      ? patch.categories_enabled
      : current.categories_enabled,
    patch.room_id !== undefined ? patch.room_id : current.room_id,
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

/**
 * Remember one message of an in-progress signup — a question we asked or an
 * answer they sent — so finalizeRegistration can sweep the whole exchange away.
 * INSERT OR IGNORE: re-recording the same id is a no-op, never an error.
 */
export function recordRegistrationMessage(telegramId: number, messageId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO registration_messages (telegram_id, message_id) VALUES (?, ?)"
  ).run(telegramId, messageId);
}

/** Every message id recorded for this signup, oldest first. */
export function listRegistrationMessageIds(telegramId: number): number[] {
  const rows = db
    .prepare(
      "SELECT message_id FROM registration_messages WHERE telegram_id = ? ORDER BY message_id ASC"
    )
    .all(telegramId) as { message_id: number }[];
  return rows.map((row) => row.message_id);
}

export function clearRegistrationMessages(telegramId: number): void {
  db.prepare("DELETE FROM registration_messages WHERE telegram_id = ?").run(telegramId);
}

/**
 * Queue a sent message for deletion `delayMinutes` from now. Same (chat,
 * message) queued twice keeps the earlier deadline rather than erroring — a
 * message can only be deleted once anyway.
 */
export function enqueueMessageDeletion(
  chatId: number,
  messageId: number,
  delayMinutes: number
): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_message_deletions (chat_id, message_id, delete_at)
     VALUES (?, ?, datetime('now', ?))`
  ).run(chatId, messageId, `+${delayMinutes} minutes`);
}

export interface ScheduledMessageDeletion {
  id: number;
  chat_id: number;
  message_id: number;
  delete_at: string;
}

/**
 * Rows whose deadline has passed, oldest first. Capped per call so a tick that
 * follows a long outage works through the backlog in batches instead of firing
 * thousands of API calls at once.
 */
export function listDueMessageDeletions(limit: number): ScheduledMessageDeletion[] {
  return db
    .prepare(
      `SELECT id, chat_id, message_id, delete_at
       FROM scheduled_message_deletions
       WHERE delete_at <= datetime('now')
       ORDER BY delete_at ASC
       LIMIT ?`
    )
    .all(limit) as ScheduledMessageDeletion[];
}

/**
 * Drop one queued deletion. Called whether or not Telegram accepted the delete:
 * a message we can never delete (older than 48 hours, already gone) must not be
 * retried every minute forever.
 */
export function deleteScheduledMessageDeletion(id: number): void {
  db.prepare("DELETE FROM scheduled_message_deletions WHERE id = ?").run(id);
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

/**
 * Every user, or just one room's members.
 *
 * The room filter is optional throughout this file. Every Mini App route passes
 * a roomId — a request is only ever about the caller's own room (PRD §3). The
 * roomId-less form is for the two callers that legitimately span rooms: the
 * reminder cron (which walks every room's members) and the owner-only,
 * secret-gated export/reset routes, which have no calling user and therefore no
 * room to scope to (PRD §3a — cross-room visibility is a DB-access affair, not
 * a product feature).
 */
export function getAllUsers(roomId?: number): User[] {
  if (roomId === undefined) {
    return db.prepare("SELECT * FROM users").all() as User[];
  }
  return db.prepare("SELECT * FROM users WHERE current_room_id = ?").all(roomId) as User[];
}

export function getParticipantCount(roomId?: number): number {
  const row = (
    roomId === undefined
      ? db.prepare("SELECT COUNT(*) AS count FROM users").get()
      : db.prepare("SELECT COUNT(*) AS count FROM users WHERE current_room_id = ?").get(roomId)
  ) as { count: number };
  return row.count;
}

/**
 * Users who opted into daily reminders. Anyone with no current room is skipped:
 * reminders pause while a user is between rooms, with nothing to log against
 * (PRD §3a).
 */
export function getUsersWithRemindersEnabled(roomId?: number): User[] {
  if (roomId === undefined) {
    return db
      .prepare("SELECT * FROM users WHERE reminder_enabled = 1 AND current_room_id IS NOT NULL")
      .all() as User[];
  }
  return db
    .prepare("SELECT * FROM users WHERE reminder_enabled = 1 AND current_room_id = ?")
    .all(roomId) as User[];
}

/**
 * Users who opted into the Sunday/Wednesday fasting nudge. Room-scoped the same
 * way as the daily reminder even though the message itself is room-agnostic: a
 * user between rooms gets no reminder DMs at all (PRD §3a).
 */
export function getUsersWithFastingRemindersEnabled(): User[] {
  return db
    .prepare(
      "SELECT * FROM users WHERE fasting_reminder_enabled = 1 AND current_room_id IS NOT NULL"
    )
    .all() as User[];
}

/**
 * Every current room member, with no opt-in filter — the weekly backfill-window
 * nudge (BACKFILL PRD) is not opt-out like the daily reminder, so it is not
 * gated by reminder_enabled. Room-scoped for the same reason as the other two:
 * a user between rooms has no habits to check.
 */
export function getAllRoomMembers(): User[] {
  return db.prepare("SELECT * FROM users WHERE current_room_id IS NOT NULL").all() as User[];
}

export interface UserProfileUpdate {
  nickname?: string;
  reminderEnabled?: boolean;
  reminderTime?: string;
  fastingReminderEnabled?: boolean;
  fastingReminderTime?: string;
  realName?: string;
  /** undefined = leave unchanged; null = reset to unset (fall back to config.timezone). */
  timezone?: string | null;
  streakDisplay?: StreakDisplay;
  /** 0 = Sunday … 6 = Saturday. */
  weekStartDay?: number;
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
  const fastingReminderEnabled =
    update.fastingReminderEnabled !== undefined
      ? (update.fastingReminderEnabled ? 1 : 0)
      : user.fasting_reminder_enabled;
  const fastingReminderTime = update.fastingReminderTime ?? user.fasting_reminder_time;
  const realName = update.realName !== undefined ? update.realName : user.real_name;
  const timezone = update.timezone !== undefined ? update.timezone : user.timezone;
  const streakDisplay = update.streakDisplay ?? user.streak_display;
  const weekStartDay = update.weekStartDay ?? user.week_start_day;

  db.prepare(
    `UPDATE users
     SET nickname = ?, reminder_enabled = ?, reminder_time = ?,
         fasting_reminder_enabled = ?, fasting_reminder_time = ?,
         real_name = ?, timezone = ?,
         streak_display = ?, week_start_day = ?
     WHERE telegram_id = ?`
  ).run(
    nickname,
    reminderEnabled,
    reminderTime,
    fastingReminderEnabled,
    fastingReminderTime,
    realName,
    timezone,
    streakDisplay,
    weekStartDay,
    telegramId
  );

  return getUserByTelegramId(telegramId) ?? (() => {
    throw new Error(`Failed to reload user ${telegramId} after profile update`);
  })();
}

/**
 * Delete all habit logs and users so participants must re-register. Habit
 * definitions are untouched.
 *
 * Global, across every room, by design: its only caller is POST
 * /api/admin/reset, which is authenticated by ADMIN_EXPORT_SECRET rather than
 * Telegram initData. There is no calling user behind that secret and so no
 * "own room" to scope to — it is the app owner's nuke, not an in-product admin
 * action (PRD §3a).
 */
export function resetAllChallengeData(): {
  habitLogs: number;
  users: number;
} {
  const wipe = db.transaction(() => {
    const habitLogs = db.prepare("DELETE FROM habit_logs").run().changes;
    db.prepare("DELETE FROM personal_habits").run();
    const users = db.prepare("DELETE FROM users").run().changes;
    // Bookkeeping for messages that belonged to the users just wiped — the ids
    // are meaningless without them.
    db.prepare("DELETE FROM registration_messages").run();
    db.prepare("DELETE FROM scheduled_message_deletions").run();
    return { habitLogs, users };
  });
  return wipe();
}

/**
 * What one log row is worth: the habit's flat points_weight, unless a weekly
 * habit has already banked this week somewhere else, in which case 0.
 *
 * Called once at write time in upsertHabitLog and frozen into
 * habit_logs.points_earned — never recompute from habits.points_weight when
 * reading, so weight changes aren't retroactive.
 *
 * `weekAlreadyBanked` is what makes "at most once a week" true: a daily habit
 * always passes false, and for a weekly one upsertHabitLog passes true only
 * when some *other* day of the same week already carries the weight.
 */
export function computePoints(
  habit: { period: HabitPeriod; points_weight: number },
  weekAlreadyBanked = false
): number {
  if (habit.period === "weekly" && weekAlreadyBanked) return 0;
  return habit.points_weight;
}

/**
 * The row of this habit's week that currently carries the points, if any.
 * At most one exists — that is the invariant upsertHabitLog and deleteHabitLog
 * maintain between them.
 */
function weekCarrierRow(
  userId: number,
  habitId: number,
  logDate: string
): HabitLog | undefined {
  const { weekStart, weekEnd } = weekBoundsOfDateKey(logDate);
  return db
    .prepare(
      `SELECT * FROM habit_logs
       WHERE user_id = ? AND habit_id = ? AND log_date BETWEEN ? AND ?
         AND points_earned > 0
       LIMIT 1`
    )
    .get(userId, habitId, weekStart, weekEnd) as HabitLog | undefined;
}

export function getHabitById(id: number): Habit | undefined {
  return db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as Habit | undefined;
}

/**
 * Create a habit inside one room. `category` must be set when the room has
 * categories enabled and left null when it does not — that pairing is an
 * application-layer invariant (PRD §1); the column itself only checks the value
 * is one of IQ/SQ/PQ/EQ.
 */
export function createHabit(
  roomId: number,
  name: string,
  pointsWeight: number,
  category: HabitCategory | null = null,
  period: HabitPeriod = "daily",
  description: string | null = null
): Habit {
  const result = db
    .prepare(
      `INSERT INTO habits (room_id, name, description, period, points_weight, category)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(roomId, name, description, period, pointsWeight, category);
  return getHabitById(Number(result.lastInsertRowid)) ?? (() => {
    throw new Error(`Failed to load habit just created (rowid ${result.lastInsertRowid})`);
  })();
}

/**
 * No `period` here on purpose, and none accepted by PATCH /api/admin/habits:
 * points_earned rows are frozen under whichever rule was in force when they
 * were written, so flipping daily→weekly would leave a week holding seven
 * daily awards that the new rule says should have been one. Changing the
 * cadence means deactivating the habit and creating its replacement.
 */
export function updateHabit(
  id: number,
  patch: Partial<{
    name: string;
    /** null clears the goal line; undefined leaves it alone. */
    description: string | null;
    pointsWeight: number;
    isActive: boolean;
    /** null clears the category (a room that turned categories off). */
    category: HabitCategory | null;
  }>
): Habit {
  const current = getHabitById(id);
  if (!current) {
    throw new Error(`updateHabit: habit ${id} not found`);
  }

  const name = patch.name ?? current.name;
  const description = patch.description !== undefined ? patch.description : current.description;
  const pointsWeight = patch.pointsWeight ?? current.points_weight;
  const isActive = patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : current.is_active;
  const category = patch.category !== undefined ? patch.category : current.category;

  db.prepare(
    `UPDATE habits
     SET name = ?, description = ?, points_weight = ?, is_active = ?, category = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(name, description, pointsWeight, isActive, category, id);

  return getHabitById(id) ?? (() => {
    throw new Error(`Failed to reload habit ${id} after update`);
  })();
}

export function listHabits(options: { activeOnly?: boolean; roomId?: number } = {}): Habit[] {
  const conditions: string[] = [];
  const params: number[] = [];
  if (options.activeOnly) conditions.push("is_active = 1");
  if (options.roomId !== undefined) {
    conditions.push("room_id = ?");
    params.push(options.roomId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM habits ${where} ORDER BY id ASC`).all(...params) as Habit[];
}

export function deactivateHabit(id: number): Habit {
  return updateHabit(id, { isActive: false });
}

/**
 * Mark a habit done on one TIMEZONE-local day (YYYY-MM-DD).
 *
 * Not cumulative: a second call for the same (user, habit, logDate) rewrites the
 * row rather than adding to it. Points are computed fresh from the habit's
 * current weight at the moment of this call and then frozen — a later
 * habits.points_weight change never touches an already-written row.
 *
 * A weekly habit keeps one extra promise: across the Monday-Sunday week
 * containing logDate, exactly one row carries the weight and every other row
 * carries 0. Marking Monday banks the points; marking Wednesday as well writes
 * a second row worth nothing, because the week is already paid for. The whole
 * check-and-write runs in one transaction, so two taps racing each other cannot
 * both decide the week is unbanked and award it twice.
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

  const write = db.transaction(() => {
    const carrier = habit.period === "weekly" ? weekCarrierRow(userId, habitId, logDate) : undefined;
    // Re-marking the day that already carries the week keeps it carrying: only
    // some *other* day holding the points makes this row worth 0.
    const weekAlreadyBanked = carrier !== undefined && carrier.log_date !== logDate;
    const pointsEarned = computePoints(habit, weekAlreadyBanked);

    db.prepare(
      `INSERT INTO habit_logs (user_id, habit_id, room_id, log_date, value, points_earned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id, habit_id, log_date) DO UPDATE SET
         value = excluded.value,
         points_earned = excluded.points_earned,
         updated_at = excluded.updated_at`
    ).run(userId, habitId, habit.room_id, logDate, value, pointsEarned);

    return db
      .prepare(
        "SELECT * FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?"
      )
      .get(userId, habitId, logDate) as HabitLog;
  });

  return write();
}

/**
 * Delete this user's log for a habit on one day, if any. Idempotent — a no-op
 * when no such row exists. Deleting (rather than zeroing value/points_earned in
 * place) is what makes the day disappear from getHabitStreak and
 * getUserHabitLogsForDate, both of which key off row presence, not value.
 *
 * For a weekly habit, deleting the row that carries the week hands the points to
 * the earliest day of that week still marked, instead of letting them evaporate:
 * a member who marked Monday and Wednesday and then unmarks Monday has still
 * done the habit this week, and their leaderboard total must not move. The week
 * only loses its points when its last marked day goes.
 *
 * The handover passes on the *deleted row's* points_earned rather than the
 * habit's current weight, so an admin's later weight change stays non-retroactive
 * here as everywhere else.
 */
export function deleteHabitLog(userId: number, habitId: number, logDate: string): void {
  const remove = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?")
      .get(userId, habitId, logDate) as HabitLog | undefined;
    if (!row) return;

    db.prepare("DELETE FROM habit_logs WHERE id = ?").run(row.id);
    if (row.points_earned <= 0) return;

    const habit = getHabitById(habitId);
    if (habit?.period !== "weekly") return;

    const { weekStart, weekEnd } = weekBoundsOfDateKey(logDate);
    const successor = db
      .prepare(
        `SELECT id FROM habit_logs
         WHERE user_id = ? AND habit_id = ? AND log_date BETWEEN ? AND ?
         ORDER BY log_date ASC, id ASC
         LIMIT 1`
      )
      .get(userId, habitId, weekStart, weekEnd) as { id: number } | undefined;
    if (!successor) return;

    db.prepare(
      "UPDATE habit_logs SET points_earned = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(row.points_earned, successor.id);
  });
  remove();
}

export function getUserTotalPoints(userId: number, roomId?: number): number {
  const row = (
    roomId === undefined
      ? db
          .prepare(
            "SELECT COALESCE(SUM(points_earned), 0) AS total FROM habit_logs WHERE user_id = ?"
          )
          .get(userId)
      : db
          .prepare(
            "SELECT COALESCE(SUM(points_earned), 0) AS total FROM habit_logs WHERE user_id = ? AND room_id = ?"
          )
          .get(userId, roomId)
  ) as { total: number };
  return row.total;
}

/**
 * Points this user earned in one room on one calendar day.
 *
 * The date is the caller's *own* day key (getUserTodayKey), the same one every
 * write lands on — so this shifts the moment they change timezone, with nothing
 * stored or cached to invalidate.
 */
export function getUserPointsForDate(userId: number, roomId: number, date: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(points_earned), 0) AS total
       FROM habit_logs
       WHERE user_id = ? AND room_id = ? AND log_date = ?`
    )
    .get(userId, roomId, date) as { total: number };
  return row.total;
}

/**
 * Which days in [fromDate, toDate] this user has a log row on, per habit —
 * presence only, since the weekly view draws a lit or unlit cell and never a
 * count. One query for the whole grid; habits with no logs in the window are
 * simply absent from the map.
 */
export function getHabitLogDatesInRange(
  userId: number,
  roomId: number,
  fromDate: string,
  toDate: string
): Map<number, Set<string>> {
  const rows = db
    .prepare(
      `SELECT habit_id, log_date FROM habit_logs
       WHERE user_id = ? AND room_id = ? AND log_date >= ? AND log_date <= ?`
    )
    .all(userId, roomId, fromDate, toDate) as { habit_id: number; log_date: string }[];

  const byHabit = new Map<number, Set<string>>();
  for (const row of rows) {
    const dates = byHabit.get(row.habit_id) ?? new Set<string>();
    dates.add(row.log_date);
    byHabit.set(row.habit_id, dates);
  }
  return byHabit;
}

/**
 * Consecutive days (walking backward from asOfDate, inclusive) that have a
 * habit_logs row for this (user, habit). Returns 0 if asOfDate itself has no log.
 */
export function getHabitStreak(userId: number, habitId: number, asOfDate: string): number {
  const rows = db
    .prepare("SELECT log_date FROM habit_logs WHERE user_id = ? AND habit_id = ?")
    .all(userId, habitId) as { log_date: string }[];
  return streakFromLoggedDays(new Set(rows.map((r) => r.log_date)), asOfDate);
}

/**
 * Consecutive weeks a weekly habit was marked in, as of the week starting at
 * `currentWeekStart`. Counted in *weeks*, not days — the client labels it
 * "weeks" so it can never be read as a day count.
 *
 * Every marked day collapses to the Monday of its week before counting, so
 * marking three days of one week is still one week of streak.
 */
export function getWeeklyHabitStreak(
  userId: number,
  habitId: number,
  currentWeekStart: string
): number {
  const rows = db
    .prepare("SELECT log_date FROM habit_logs WHERE user_id = ? AND habit_id = ?")
    .all(userId, habitId) as { log_date: string }[];
  const metWeeks = new Set(rows.map((r) => weekBoundsOfDateKey(r.log_date).weekStart));
  return streakFromLoggedWeeks(metWeeks, currentWeekStart);
}

/**
 * How many days of one week this habit is marked on. The number the weekly
 * streak view puts on a weekly habit's badge: normally 0 or 1, more when the
 * member marked it on several days, and never a points figure — only the first
 * of those days is actually worth anything (see upsertHabitLog).
 */
export function getWeeklyHabitLogCount(
  userId: number,
  habitId: number,
  weekStart: string,
  weekEnd: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM habit_logs
       WHERE user_id = ? AND habit_id = ? AND log_date BETWEEN ? AND ?`
    )
    .get(userId, habitId, weekStart, weekEnd) as { n: number };
  return row.n;
}

/** Which habits of this room the user has a log for anywhere in [weekStart, weekEnd]. */
export function getHabitIdsLoggedInWeek(
  userId: number,
  roomId: number,
  weekStart: string,
  weekEnd: string
): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT habit_id FROM habit_logs
       WHERE user_id = ? AND room_id = ? AND log_date BETWEEN ? AND ?`
    )
    .all(userId, roomId, weekStart, weekEnd) as { habit_id: number }[];
  return new Set(rows.map((r) => r.habit_id));
}

/* ------------------------------------------------------------------------- *
 * Personal habits
 *
 * A member's own private list, kept entirely apart from `habits`/`habit_logs`.
 * Nothing here computes or stores points, and nothing above reads these tables,
 * which is what makes "invisible to the admin" and "never affects the ranking"
 * properties of the schema rather than of every query remembering a filter.
 * ------------------------------------------------------------------------- */

export function getPersonalHabitById(id: number): PersonalHabit | undefined {
  return db.prepare("SELECT * FROM personal_habits WHERE id = ?").get(id) as
    | PersonalHabit
    | undefined;
}

/** This member's personal habits in this room, oldest first. */
export function listPersonalHabits(userId: number, roomId: number): PersonalHabit[] {
  return db
    .prepare("SELECT * FROM personal_habits WHERE user_id = ? AND room_id = ? ORDER BY id ASC")
    .all(userId, roomId) as PersonalHabit[];
}

export function countPersonalHabits(userId: number, roomId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM personal_habits WHERE user_id = ? AND room_id = ?")
    .get(userId, roomId) as { n: number };
  return row.n;
}

export function createPersonalHabit(
  userId: number,
  roomId: number,
  name: string,
  category: HabitCategory | null
): PersonalHabit {
  const result = db
    .prepare(
      `INSERT INTO personal_habits (user_id, room_id, name, category)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, roomId, name, category);
  return getPersonalHabitById(Number(result.lastInsertRowid))!;
}

export interface PersonalHabitUpdate {
  name?: string;
  /** undefined leaves it alone; null clears it (categories off). */
  category?: HabitCategory | null;
}

/**
 * Read-modify-write, matching updateHabit. There is no period to change: a
 * personal habit is always a daily done-or-not.
 */
export function updatePersonalHabit(id: number, update: PersonalHabitUpdate): PersonalHabit {
  const current = getPersonalHabitById(id);
  if (!current) throw new Error(`updatePersonalHabit: habit ${id} not found`);

  db.prepare(
    `UPDATE personal_habits
     SET name = ?, category = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    update.name ?? current.name,
    update.category === undefined ? current.category : update.category,
    id
  );
  return getPersonalHabitById(id)!;
}

/** Delete a personal habit; its logs go with it (ON DELETE CASCADE). */
export function deletePersonalHabit(id: number): void {
  db.prepare("DELETE FROM personal_habits WHERE id = ?").run(id);
}

/** Upsert the owner's local-today value. No points are computed or stored. */
export function upsertPersonalHabitLog(
  personalHabitId: number,
  value: number,
  logDate: string
): PersonalHabitLog {
  const habit = getPersonalHabitById(personalHabitId);
  if (!habit) throw new Error(`upsertPersonalHabitLog: habit ${personalHabitId} not found`);

  db.prepare(
    `INSERT INTO personal_habit_logs
       (user_id, personal_habit_id, room_id, log_date, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id, personal_habit_id, log_date) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(habit.user_id, personalHabitId, habit.room_id, logDate, value);

  return db
    .prepare(
      `SELECT * FROM personal_habit_logs
       WHERE user_id = ? AND personal_habit_id = ? AND log_date = ?`
    )
    .get(habit.user_id, personalHabitId, logDate) as PersonalHabitLog;
}

/** Idempotent, and a hard delete for the same reason as deleteHabitLog. */
export function deletePersonalHabitLog(
  userId: number,
  personalHabitId: number,
  logDate: string
): void {
  db.prepare(
    `DELETE FROM personal_habit_logs
     WHERE user_id = ? AND personal_habit_id = ? AND log_date = ?`
  ).run(userId, personalHabitId, logDate);
}

/** This member's personal logs for one day, keyed by personal habit id. */
export function getUserPersonalHabitLogsForDate(
  userId: number,
  date: string
): Map<number, PersonalHabitLog> {
  const rows = db
    .prepare("SELECT * FROM personal_habit_logs WHERE user_id = ? AND log_date = ?")
    .all(userId, date) as PersonalHabitLog[];
  return new Map(rows.map((row) => [row.personal_habit_id, row]));
}

/** Same shape and purpose as getHabitStreak, over the personal log table. */
export function getPersonalHabitStreak(
  userId: number,
  personalHabitId: number,
  asOfDate: string
): number {
  const rows = db
    .prepare(
      "SELECT log_date FROM personal_habit_logs WHERE user_id = ? AND personal_habit_id = ?"
    )
    .all(userId, personalHabitId) as { log_date: string }[];
  return streakFromLoggedDays(new Set(rows.map((r) => r.log_date)), asOfDate);
}

/** Same shape and purpose as getHabitLogDatesInRange, for the weekly grid. */
export function getPersonalHabitLogDatesInRange(
  userId: number,
  roomId: number,
  fromDate: string,
  toDate: string
): Map<number, Set<string>> {
  const rows = db
    .prepare(
      `SELECT personal_habit_id, log_date FROM personal_habit_logs
       WHERE user_id = ? AND room_id = ? AND log_date >= ? AND log_date <= ?`
    )
    .all(userId, roomId, fromDate, toDate) as {
    personal_habit_id: number;
    log_date: string;
  }[];

  const byHabit = new Map<number, Set<string>>();
  for (const row of rows) {
    const dates = byHabit.get(row.personal_habit_id) ?? new Set<string>();
    dates.add(row.log_date);
    byHabit.set(row.personal_habit_id, dates);
  }
  return byHabit;
}

/**
 * Rank one room's members (or, with no roomId, everyone) by all-time points.
 *
 * Scoping a room filters on both sides: only its current members are listed,
 * and only points they earned *in that room* count — a member who moved here
 * from another room keeps their old logs (PRD §1) but does not carry the points
 * into this leaderboard.
 */
function leaderboardQuery(
  extraColumns: string,
  roomId: number | undefined,
  /** Inclusive YYYY-MM-DD window on log_date, or undefined for all time. */
  window?: { from: string; to: string }
): unknown[] {
  const columns = `u.id AS user_id,
              u.telegram_id AS telegram_id,
              u.nickname AS nickname,
              u.real_name AS real_name,${extraColumns}
              COALESCE(SUM(hl.points_earned), 0) AS total`;

  // The date window belongs in the JOIN's ON clause, never in WHERE: in WHERE it
  // would turn the LEFT JOIN into an inner one and drop every member who scored
  // nothing this week — and the whole point of the weekly board is that it shows
  // the room's full roster in rank order, zeroes included.
  const windowOn = window ? " AND hl.log_date BETWEEN ? AND ?" : "";
  const windowParams = window ? [window.from, window.to] : [];

  if (roomId === undefined) {
    return db
      .prepare(
        `SELECT ${columns}
         FROM users u
         LEFT JOIN habit_logs hl ON hl.user_id = u.id${windowOn}
         GROUP BY u.id
         ORDER BY total DESC, u.nickname ASC`
      )
      .all(...windowParams);
  }
  return db
    .prepare(
      `SELECT ${columns}
       FROM users u
       LEFT JOIN habit_logs hl ON hl.user_id = u.id AND hl.room_id = ?${windowOn}
       WHERE u.current_room_id = ?
       GROUP BY u.id
       ORDER BY total DESC, u.nickname ASC`
    )
    .all(roomId, ...windowParams, roomId);
}

/**
 * All-time, perpetual leaderboard: one row per user (including users with no
 * logs at all, at total 0), ranked by total points descending. No date
 * window — the tracker has no periodic resets (PIVOT_PLAN §0).
 */
export function getLeaderboard(roomId?: number): LeaderboardRow[] {
  return leaderboardQuery("", roomId) as LeaderboardRow[];
}

/**
 * The same board over one Monday-Sunday week: every current member of the room
 * in rank order, with the points they earned inside [weekStart, weekEnd] — daily
 * and weekly habits together, since a weekly habit's points sit on the single
 * log_date that banked them.
 *
 * There is nothing to reset on Monday and nothing cached to invalidate: moving
 * the window is the reset.
 */
export function getWeeklyLeaderboard(
  roomId: number,
  weekStart: string,
  weekEnd: string
): WeeklyLeaderboardRow[] {
  return leaderboardQuery("", roomId, {
    from: weekStart,
    to: weekEnd,
  }) as WeeklyLeaderboardRow[];
}

/** Same ranking as getLeaderboard, plus raw Telegram identity fields, for the admin CSV export. */
export function getExportRows(roomId?: number): ExportRow[] {
  return leaderboardQuery(
    `
              u.telegram_username AS telegram_username,
              u.telegram_first_name AS telegram_first_name,
              u.telegram_last_name AS telegram_last_name,`,
    roomId
  ) as ExportRow[];
}

/** This user's habit_logs rows for one TIMEZONE-local day, keyed by habit_id. */
export function getUserHabitLogsForDate(userId: number, date: string): Map<number, HabitLog> {
  const rows = db
    .prepare("SELECT * FROM habit_logs WHERE user_id = ? AND log_date = ?")
    .all(userId, date) as HabitLog[];
  return new Map(rows.map((row) => [row.habit_id, row]));
}
