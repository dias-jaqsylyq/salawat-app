CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_time TEXT NOT NULL DEFAULT '20:00',
  -- IANA name (e.g. "Asia/Hong_Kong"), detected client-side in the Mini App
  -- (Intl.DateTimeFormat().resolvedOptions().timeZone). NULL until the user
  -- opens the Mini App at least once — reminders fall back to config.timezone.
  timezone TEXT,
  telegram_username TEXT,
  telegram_first_name TEXT,
  telegram_last_name TEXT,
  real_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('quantity','binary')),
  points_weight INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  habit_id INTEGER NOT NULL REFERENCES habits(id),
  log_date TEXT NOT NULL,              -- TIMEZONE-local day, 'YYYY-MM-DD'
  value INTEGER NOT NULL,              -- quantity: entered number; binary: 1
  points_earned INTEGER NOT NULL,      -- frozen at log time, see computePoints
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, habit_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user_id ON habit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_id ON habit_logs(habit_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_log_date ON habit_logs(log_date);

/** In-progress /start signup — survives Railway redeploys; deleted on finalize. */
CREATE TABLE IF NOT EXISTS pending_registrations (
  telegram_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  real_name TEXT,
  nickname TEXT,
  reminder_enabled INTEGER,
  reminder_time TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/** Telegram ids with full Mini App + bot admin powers. Seeded from ADMIN_TELEGRAM_ID. */
CREATE TABLE IF NOT EXISTS admins (
  telegram_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/** One pending YES-confirm admin bot action per admin. */
CREATE TABLE IF NOT EXISTS pending_admin_actions (
  admin_telegram_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  target_telegram_id INTEGER NOT NULL,
  target_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
