import { db } from "./client.js";
import { formatDateParts, parseDateKey, subtractOneCalendarDay } from "../utils/dates.js";
import { generateRoomPassword } from "../utils/roomPassword.js";
import type {
  CreateUserReminders,
  ExportRow,
  Habit,
  HabitCategory,
  HabitLog,
  HabitType,
  LeaderboardRow,
  PendingRegistration,
  RegistrationStep,
  Room,
  StreakDisplay,
  TelegramProfile,
  User,
  UserRole,
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
    const user = createUser(telegramId, nickname, profile, realName, reminders, {
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

/**
 * Create a habit inside one room. `category` must be set when the room has
 * categories enabled and left null when it does not — that pairing is an
 * application-layer invariant (PRD §1); the column itself only checks the value
 * is one of IQ/SQ/PQ/EQ.
 */
export function createHabit(
  roomId: number,
  name: string,
  type: HabitType,
  pointsWeight: number,
  category: HabitCategory | null = null
): Habit {
  const result = db
    .prepare(
      `INSERT INTO habits (room_id, name, type, points_weight, category) VALUES (?, ?, ?, ?, ?)`
    )
    .run(roomId, name, type, pointsWeight, category);
  return getHabitById(Number(result.lastInsertRowid)) ?? (() => {
    throw new Error(`Failed to load habit just created (rowid ${result.lastInsertRowid})`);
  })();
}

export function updateHabit(
  id: number,
  patch: Partial<{
    name: string;
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
  const pointsWeight = patch.pointsWeight ?? current.points_weight;
  const isActive = patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : current.is_active;
  const category = patch.category !== undefined ? patch.category : current.category;

  db.prepare(
    `UPDATE habits
     SET name = ?, points_weight = ?, is_active = ?, category = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(name, pointsWeight, isActive, category, id);

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
 * Rank one room's members (or, with no roomId, everyone) by all-time points.
 *
 * Scoping a room filters on both sides: only its current members are listed,
 * and only points they earned *in that room* count — a member who moved here
 * from another room keeps their old logs (PRD §1) but does not carry the points
 * into this leaderboard.
 */
function leaderboardQuery(extraColumns: string, roomId: number | undefined): unknown[] {
  const columns = `u.id AS user_id,
              u.telegram_id AS telegram_id,
              u.nickname AS nickname,
              u.real_name AS real_name,${extraColumns}
              COALESCE(SUM(hl.points_earned), 0) AS total`;

  if (roomId === undefined) {
    return db
      .prepare(
        `SELECT ${columns}
         FROM users u
         LEFT JOIN habit_logs hl ON hl.user_id = u.id
         GROUP BY u.id
         ORDER BY total DESC, u.nickname ASC`
      )
      .all();
  }
  return db
    .prepare(
      `SELECT ${columns}
       FROM users u
       LEFT JOIN habit_logs hl ON hl.user_id = u.id AND hl.room_id = ?
       WHERE u.current_room_id = ?
       GROUP BY u.id
       ORDER BY total DESC, u.nickname ASC`
    )
    .all(roomId, roomId);
}

/**
 * All-time, perpetual leaderboard: one row per user (including users with no
 * logs at all, at total 0), ranked by total points descending. No date
 * window — the tracker has no periodic resets (PIVOT_PLAN §0).
 */
export function getLeaderboard(roomId?: number): LeaderboardRow[] {
  return leaderboardQuery("", roomId) as LeaderboardRow[];
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
