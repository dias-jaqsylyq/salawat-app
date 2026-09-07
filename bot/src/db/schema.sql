CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  goal INTEGER NOT NULL,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_time TEXT,
  fasting_reminder_enabled INTEGER NOT NULL DEFAULT 0,
  fasting_reminder_time TEXT NOT NULL DEFAULT '20:00',
  telegram_username TEXT,
  telegram_first_name TEXT,
  telegram_last_name TEXT,
  real_name TEXT,
  retained_jamaat_total INTEGER NOT NULL DEFAULT 0,
  progress_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  count INTEGER NOT NULL,
  logged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id);

/** Per-day goal met/missed overrides (makeup) — does not change logged salawat. */
CREATE TABLE IF NOT EXISTS day_goal_overrides (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  met INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, day)
);

/** In-progress /start signup — survives Railway redeploys; deleted on finalize. */
CREATE TABLE IF NOT EXISTS pending_registrations (
  telegram_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  real_name TEXT,
  nickname TEXT,
  goal INTEGER,
  reminder_enabled INTEGER,
  reminder_time TEXT,
  fasting_reminder_enabled INTEGER,
  fasting_reminder_time TEXT,
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
