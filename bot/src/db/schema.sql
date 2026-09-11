/**
 * One bot, many independent rooms (competitions). Everything room-scoped
 * carries room_id; rooms are isolated logically inside this one database,
 * never by separate bot instances (MULTI ROOM PRD §0).
 */
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Admin-chosen free text. NOT unique: two rooms may share a name, only id
  -- disambiguates them (PRD §3a).
  name TEXT NOT NULL,
  -- Stored in plain text, not hashed: the admin has to be able to read it back
  -- to share it, and it is embedded in a t.me/<bot>?start=<password> deep link
  -- (PRD §3, §3a) — a hash makes both impossible. It is a room invite code in
  -- the spirit of a Telegram invite link, not a personal secret. Case-sensitive
  -- (`ABC` != `abc`) via SQLite's default BINARY collation — never COLLATE NOCASE.
  -- UNIQUE so a join password resolves to exactly one room.
  password TEXT NOT NULL UNIQUE,
  -- 0 = flat habit list; 1 = every habit in this room carries one of
  -- IQ/SQ/PQ/EQ. Toggleable at any time (PRD §0).
  categories_enabled INTEGER NOT NULL DEFAULT 0,
  -- Historical record of who created the room. Never grants extra power —
  -- co-admins are fully equal and may even demote the owner (PRD §3a).
  -- Nullable so deleting that user doesn't take the room down with them.
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/**
 * Room-scoped admin status: the owner and every co-admin, flat and equal
 * (PRD §3a). Replaces the retired global `admins` table. Membership is per
 * room, so it is dropped the moment a user leaves for another room, and
 * last-admin protection is a COUNT(*) over one room_id.
 */
CREATE TABLE IF NOT EXISTS room_admins (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_room_admins_user_id ON room_admins(user_id);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  -- Chosen once at registration, not re-selectable later (PRD §0). An 'admin'
  -- is also an ordinary participant of the room they created.
  role TEXT NOT NULL DEFAULT 'participant' CHECK (role IN ('admin','participant')),
  -- At most one room at a time. NULL between leaving one room and entering the
  -- next; reminders pause while it is NULL (PRD §3a).
  current_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_time TEXT NOT NULL DEFAULT '20:00',
  -- Separate opt-in from the daily reminder, default off: a Sunday/Wednesday
  -- nudge about the coming fast. Collected at registration; the cron that acts
  -- on it lands with the rest of the pre-pivot task list.
  fasting_reminder_enabled INTEGER NOT NULL DEFAULT 0,
  fasting_reminder_time TEXT NOT NULL DEFAULT '20:00',
  -- IANA name (e.g. "Asia/Hong_Kong"), detected client-side in the Mini App
  -- (Intl.DateTimeFormat().resolvedOptions().timeZone). NULL until the user
  -- opens the Mini App at least once — everything that needs "today" for this
  -- user falls back to config.timezone until then. Per-user and unaffected by
  -- room membership (PRD §3a).
  timezone TEXT,
  -- Which shape the Progress screen draws streaks in: 'current' = one number
  -- per habit, 'weekly' = a seven-cell calendar-week row per habit. Purely a
  -- display preference — nothing is recomputed or cached when it changes.
  streak_display TEXT NOT NULL DEFAULT 'weekly'
    CHECK (streak_display IN ('current','weekly')),
  -- First day of the calendar week the weekly view draws, 0 = Sunday … 6 =
  -- Saturday. Default 1 (Monday).
  week_start_day INTEGER NOT NULL DEFAULT 1
    CHECK (week_start_day BETWEEN 0 AND 6),
  -- When this user joined the room they are in now (UTC, like created_at), or
  -- NULL while they are between rooms. Rewritten on every join, so the weekly
  -- view can grey out the days of this week that predate their membership
  -- instead of showing them as missed.
  room_joined_at TEXT,
  telegram_username TEXT,
  telegram_first_name TEXT,
  telegram_last_name TEXT,
  real_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_current_room_id ON users(current_room_id);

CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('quantity','binary')),
  points_weight INTEGER NOT NULL,
  -- Only meaningful while the room's categories_enabled = 1. Kept (not cleared)
  -- when categories are switched off, so nothing is lost — but a re-enable asks
  -- the admin to re-confirm rather than silently resurrecting it (PRD §0).
  -- "habit in a categories-enabled room always has one" is enforced in the
  -- application layer, not here (PRD §1).
  category TEXT CHECK (category IS NULL OR category IN ('IQ','SQ','PQ','EQ')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_habits_room_id ON habits(room_id);

CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  habit_id INTEGER NOT NULL REFERENCES habits(id),
  -- Denormalized from habits.room_id at write time (PRD §1): keeps leaderboard
  -- and progress queries a plain filter instead of a join, makes a kick's
  -- "delete this member's data for THIS room" a single DELETE, and lets a log
  -- keep pointing at the room it was earned in after the user switches rooms.
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,              -- TIMEZONE-local day, 'YYYY-MM-DD'
  value INTEGER NOT NULL,              -- quantity: entered number; binary: 1
  points_earned INTEGER NOT NULL,      -- frozen at log time, see computePoints
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, habit_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user_id ON habit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_id ON habit_logs(habit_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_room_id ON habit_logs(room_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_log_date ON habit_logs(log_date);

/**
 * In-progress /start signup — survives Railway redeploys; deleted on finalize.
 * Holds the answers of both registration branches (PRD §2): the admin one fills
 * room_name/categories_enabled and creates its room at the end, the participant
 * one resolves room_id from a password up front and joins that room.
 */
CREATE TABLE IF NOT EXISTS pending_registrations (
  telegram_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  -- Which branch this signup is on. NULL only at the very first step, before
  -- the admin-or-participant question is answered.
  role TEXT CHECK (role IS NULL OR role IN ('admin','participant')),
  real_name TEXT,
  nickname TEXT,
  -- Admin branch only: the room to create at finalize.
  room_name TEXT,
  categories_enabled INTEGER,
  -- Participant branch only: the room their password resolved to. Not a foreign
  -- key on purpose — a pending row is disposable, and a room deleted mid-signup
  -- should fail loudly at finalize rather than silently NULL this out.
  room_id INTEGER,
  reminder_enabled INTEGER,
  reminder_time TEXT,
  fasting_reminder_enabled INTEGER,
  fasting_reminder_time TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Retired with the move to multi-room (PRD §1, §3a): the global `admins` table
-- (replaced by room_admins) and `pending_admin_actions`, which only ever backed
-- the /deleteuser and /makeadmin YES-confirm flows, both now removed.
