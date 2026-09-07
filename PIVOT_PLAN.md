# Habit Tracker Pivot — Technical Plan

> Full pivot of `salawat-bot` + `salawat-miniapp` from a single-metric (salawat count)
> Mawlid-window challenge into a **perpetual, multi-habit Habit Tracker** for a
> Muslim community. Fresh DB, no data migration from the old system. This doc is
> meant to be handed to a coding agent with direct repo access; it specifies
> data model, API, screens, and bot changes at a level that should map directly
> to implementation, using the existing conventions (TS/ESM, no ORM, no state
> library, Radix/Tailwind, `node:test`, README-as-spec).

## 0. Decisions locked in (do not re-litigate without checking with Dias)

- Fixed habit list, admin-defined. Members **do not** choose which habits to do —
  they log against whatever habits are currently active.
- Two habit types: `quantity` (numeric, e.g. Salawat count, Qur'an pages) and
  `binary` (done/not-done, e.g. fasted today, prayed Fajr in jamaat).
- Each habit has a **point weight**, set by admin.
- Points formula: `quantity` → `value * weight`; `binary` → flat `weight` when
  marked done. **Points are frozen at the moment of logging** — stored as a
  concrete number on the log row, never recomputed later.
- Admin can create/edit/deactivate habits **at any time**, mid-tracker:
  - Deactivating a habit: existing logs/points untouched, just no longer loggable.
  - Changing a habit's weight: applies to **future** logs only, past logs keep
    their already-frozen points.
- One log per habit per day per user, editable same day (upsert), not
  cumulative (unlike old salawat logging where every `POST /api/log` added to
  the day's total).
- Streaks are **per-habit**, not one combined streak.
- Perpetual tracker, no start/end date, no periodic (weekly/monthly) leaderboard
  reset — single all-time point total.
- Leaderboard: individual ranking + Jamaat (group) total, same principle as
  today, just now summing points across all habits instead of salawat count.
- One combined daily reminder ("don't forget to log today"), replacing the
  separate salawat-reminder and fasting-reminder crons.
- `reset-progress` feature is **removed entirely** — doesn't fit a perpetual
  tracker.
- `day-override` (backfill up to 6 days) is **removed for v1** — only today can
  be logged. Revisit later if requested.
- Registration flow (bot-only, real name collection, `pending_registrations`)
  stays as-is conceptually, just trimmed (see §4).
- Habit management UI lives in the Mini App's existing Admin tab, alongside
  broadcast/stats/export.
- Old Salawat Challenge data is **not migrated** — fresh tables, clean start.

## 1. Data model (`salawat-bot/src/db/schema.sql`)

Replace the challenge-specific tables. Keep `admins` and `pending_admin_actions`
unchanged (still needed for `/deleteuser`, `/makeadmin` YES-confirm pattern).

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_time TEXT NOT NULL DEFAULT '20:00',
  telegram_username TEXT,
  telegram_first_name TEXT,
  telegram_last_name TEXT,
  real_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Removed vs old schema: goal, fasting_reminder_*, retained_jamaat_total,
-- progress_started_at (all tied to the single-metric / reset-progress / fasting
-- concepts that no longer exist as first-class fields).

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
  points_earned INTEGER NOT NULL,      -- frozen at log time, see §2
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, habit_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user_id ON habit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_id ON habit_logs(habit_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_log_date ON habit_logs(log_date);

CREATE TABLE IF NOT EXISTS pending_registrations (
  telegram_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  real_name TEXT,
  nickname TEXT,
  reminder_enabled INTEGER,
  reminder_time TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- trimmed: no goal, no fasting_reminder_* steps

-- unchanged from current schema:
CREATE TABLE IF NOT EXISTS admins ( ... );
CREATE TABLE IF NOT EXISTS pending_admin_actions ( ... );
```

Dropped tables: `logs`, `day_goal_overrides`.

## 2. Points calculation (reuse in `db/repository.ts`)

```
function computePoints(habit, value):
  if habit.type == 'quantity': return value * habit.points_weight
  if habit.type == 'binary':   return habit.points_weight   // value is always 1
```

Called once, at write time, in the upsert for `habit_logs.points_earned`.
Never recompute from `habits.points_weight` when reading — always read the
stored `points_earned`. This is what makes weight changes non-retroactive.

User's all-time total = `SUM(points_earned) WHERE user_id = ?` (simple
aggregate query, no denormalized running total needed at this scale).

## 3. HTTP API changes (`salawat-bot/src/api/routes/`)

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/habits` | list active habits | `[{id, name, type, pointsWeight}]` — for the logging screen |
| `POST /api/habits/:id/log` | log today's value for a habit | body `{value}` (quantity: int; binary: omit or `1`); upserts on `(user_id, habit_id, today)`; computes & freezes `points_earned`; editable same day only (`log_date` must equal today per `TIMEZONE`) |
| `GET /api/progress` | today's + all-time state | `{totalPoints, jamaatTotal, today: [{habitId, logged, value, points}], streaks: [{habitId, streak}], needsRealName}` |
| `GET /api/leaderboard` | ranked list | same shape as today, ranked by `totalPoints`, ties share rank, `jamaatTotal` included |
| `GET /api/profile` / `PATCH /api/profile` | settings | nickname, realName, reminderEnabled, reminderTime — goal/fasting fields removed |
| `GET /api/admin/habits` | admin: list all habits (incl. inactive) | |
| `POST /api/admin/habits` | admin: create habit | `{name, type, pointsWeight}` |
| `PATCH /api/admin/habits/:id` | admin: edit habit | `{name?, pointsWeight?, isActive?}` — non-destructive, no YES-confirm needed (reversible) |
| `GET /api/admin/stats`, `/api/admin/leaderboard`, `/api/admin/export-csv`, `/api/admin/broadcast*`, `/api/admin/reset` | unchanged in shape, adjusted to new tables | `reset` (nuke-everything) stays as the one destructive/YES-confirmed admin action |

Removed: `PUT /api/day-override`, `POST /api/reset-progress`.

## 4. Bot changes (`salawat-bot/src/registration/flow.ts`, `commands/`)

`/start` signup flow trimmed to: **full name → nickname → reminder opt-in/time**.
Drop the daily-goal step and the fasting-reminder opt-in/time step (fasting is
now just an ordinary habit an admin can add, not a special onboarding
question). `/help`, `/deleteuser`, `/makeadmin` unchanged.

## 5. Reminders (`salawat-bot/src/scheduler/`)

Collapse `reminder.ts` + `fastingReminder.ts` into a single per-minute cron
that DMs each user with `reminder_enabled=1` at their `reminder_time`, with a
generic "log your habits today" message (not habit-specific). Delete
`fastingReminder.ts`.

## 6. Mini App screens (`salawat-miniapp/src/screens/`)

- **`LogHabitsScreen`** (replaces `LogSalawatScreen`): list of active habits
  for today — quantity habits show a number input, binary habits show a
  toggle/checkbox. Shows today's already-logged state, editable in place.
  Points-per-habit shown next to each.
- **`ProgressScreen`**: total points (all-time), Jamaat total, per-habit streak
  list. Drop the last-7-days makeup tracker (tied to removed `day-override`).
- **`LeaderboardScreen`**: unchanged shape, ranked by total points.
- **`SettingsScreen`**: nickname, real name, single reminder toggle/time. Drop
  goal field, drop fasting-reminder controls, drop `ResetProgressDangerZone`
  (delete that component).
- **`AdminScreen`**: add a "Habits" section — list with active/inactive
  toggle, create-habit form (name, type, weight), edit weight/name. Keep
  broadcast, live leaderboard, CSV export as-is.

## 7. Explicitly out of scope for the first prototype

- `day-override` / backfill logging for past days.
- `reset-progress`.
- Per-habit individual reminder times (one global reminder only).
- Periodic leaderboard resets (decided: perpetual all-time total, permanently).
- Migrating old Salawat Challenge data.

## 8. Suggested build order

1. New `schema.sql` + repository functions (`habits`, `habit_logs`, points calc).
2. `GET/POST` habit endpoints + admin habit CRUD endpoints.
3. Trim registration flow + profile endpoints.
4. `LogHabitsScreen` + `ProgressScreen` (core daily loop).
5. `LeaderboardScreen` (mostly reuse existing component, change data source).
6. `AdminScreen` habit management section.
7. Collapse reminder crons.
8. Remove dead code: `day-override` route/screen, `reset-progress` route/component,
   `fastingReminder.ts`, `retained_jamaat_total`/`progress_started_at` fields.
9. Update both READMEs to match (per the "README-as-spec" convention).
