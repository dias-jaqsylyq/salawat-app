# Salawat Challenge Bot

Backend for a month-long salawat counting challenge among a friend group during Mawlid month. **Registration happens in the Telegram bot** via `/start` (resumable chat flow). Logging, progress, leaderboard, settings, and admin live in the [Telegram Mini App](https://core.telegram.org/bots/webapps) frontend ([`salawat-miniapp`](https://github.com/dias-jaqsylyq/salawat-miniapp)), which talks to this repo's HTTP API.

## Architecture
One Node process runs two things side by side:
- A grammY bot using long polling (`/start` registration conversation, `/help`, daily + fasting reminder schedulers, sets the chat menu button to open the Mini App).
- An Express HTTP API (`/api/*`) that the Mini App frontend calls directly, authenticated via Telegram `initData` — no separate login system.

Both share the same SQLite database (`db/repository.ts`) and challenge-date logic (`utils/challenge.ts`).

## Data model (rooms)

One bot serves many independent **rooms** (competitions). Rooms are isolated by `room_id` inside this single database, not by separate bot instances. Full spec: `MULTI ROOM PRD.md`; the schema itself is `src/db/schema.sql`.

- **`rooms`** — `name` (free text, **not** unique), `password`, `categories_enabled`, `owner_user_id`, `created_at`.
  - The password is stored **in plain text** on purpose: an admin has to be able to read it back to share it, and it is embedded in a `t.me/<bot>?start=<password>` deep link. It is a room invite code, not a personal secret. Comparison is **case-sensitive** (`ABC` ≠ `abc`) and the column is `UNIQUE`, so one password resolves to exactly one room.
  - Format (`utils/roomPassword.ts`): 6–64 characters from `A-Za-z0-9_-`, either admin-typed or generated. The charset is Telegram's start-payload limit — anything outside it would produce a share deep link that silently drops the password.
  - `owner_user_id` is historical record-keeping ("who created this") and grants no power — co-admins are fully equal and may demote the owner.
- **`room_admins`** (`room_id`, `user_id`) — the room's owner and every co-admin, flat and equal. This **replaces the old global `admins` table**. Status is per room, so it is dropped the moment a user leaves for another room, and last-admin protection is a `COUNT(*)` over one `room_id`.
- **`users`** — gain `role` (`admin` | `participant`, chosen once at registration) and `current_room_id` (at most one room at a time; `NULL` between leaving one room and joining the next, which also pauses their reminders). Nickname uniqueness is **per room**, not global.
- **`habits`** — gain `room_id` and `category` (`IQ` / `SQ` / `PQ` / `EQ`, nullable). A habit in a room with `categories_enabled = 1` always carries a category and one in a room without categories never does — enforced in the application layer, not by the column. Turning categories off **keeps** the stored values; turning them back on asks the admin to re-confirm rather than silently reusing them.
- **`habit_logs`** — gain `room_id`, denormalized from the habit at write time, so leaderboard/progress queries are a filter rather than a join and a member's old logs stay attached to the room they were earned in after they move.

**Destructive migration.** On boot, a DB file from before the multi-room pivot (detected by a leftover `admins` table or a `habits` table with no `room_id`) is **wiped**: every app table is dropped and recreated from `schema.sql`, with no data migrated. A timestamped snapshot of the old file is written next to it as `salawat.pre-multiroom-<utc>.db` first. The check is idempotent and never touches an already-migrated database.

## Requirements
- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- `sqlite3` CLI on the host if you want to run `npm run backup`

## 1. Install dependencies
```bash
npm install
```

## 2. Configure environment
```bash
cp .env.example .env
```

Open `.env` and set:
- `BOT_TOKEN` — **your real bot token from BotFather.** Gitignored, never committed.
- `CHALLENGE_START_DATE` / `CHALLENGE_END_DATE` — informational Gregorian bounds of this year's Mawlid period, `YYYY-MM-DD` (start must be on or before end). They never gate registration, logging, streaks, or reminders; only Admin Mawlid results/CSV use them as a filter.
- `TIMEZONE`, `REMINDER_TIME`, `DB_PATH` — defaults: `Asia/Hong_Kong`, `20:00`, `./data/salawat.db`.
- `PORT` — API port (defaults to `3000` locally; Railway injects this automatically in production).
- `CORS_ORIGIN` — origin(s) allowed to call the API. Defaults to `*` (dev only). **In production (`NODE_ENV=production`) this must be set to the real Vercel domain** (not `*`) or the process refuses to start.
- `MINI_APP_URL` — the deployed Mini App's real HTTPS URL, used for the bot's chat menu button. If left as the placeholder, menu-button setup is skipped (process still boots).
- `MINI_APP_DEEP_LINK` — `t.me/salawat_challenge_bot/challenge` deep link used in the daily reminder's button. Works today independent of the Vercel deployment.
- `INIT_DATA_MAX_AGE_SECONDS` — how old a Telegram `initData` payload can be before it's rejected as stale (prefer `3600` in production; code default is 24h if unset).
- `ADMIN_EXPORT_SECRET` — optional. When set, enables `GET /api/admin/export?key=…` for prize-time CSV download.

There is no `ADMIN_TELEGRAM_ID`: with rooms there is no global admin to bootstrap. Admin status is room-scoped and granted by creating a room or by being promoted inside one — see [Data model](#data-model-rooms).

**Never commit `.env` or paste your bot token anywhere public.** If a token leaks, revoke it via `@BotFather` → `/revoke`.

### Public go-live checklist
Before sharing the invite beyond a tiny trusted group:

1. Railway **volume** mounted; `DB_PATH=/data/salawat.db`
2. `CORS_ORIGIN=https://<vercel-domain>` (not `*`); `NODE_ENV=production`
3. `MINI_APP_URL` + BotFather Web App URL = same HTTPS URL; redeploy bot
4. Vercel `VITE_API_URL` = Railway public API URL → **redeploy** the Mini App (Vite bakes env at build time)
5. Copy `salawat.backup.db` (or `npm run backup` output) **off** the Railway volume on a schedule
6. `INIT_DATA_MAX_AGE_SECONDS=3600`
7. Set `ADMIN_EXPORT_SECRET` to a long random string if you want CSV export at prize time
8. Confirm challenge dates / `TIMEZONE` / `MINI_APP_DEEP_LINK`

## 3. Run it
```bash
npm run dev      # development, auto-restarts on changes
# or
npm run build && npm start   # production
```

The bot uses long polling (no webhook needed), and the API listens on `PORT`. Data persists in the SQLite file at `DB_PATH` across restarts.

## HTTP API contract
All `/api/*` endpoints require a valid Telegram `initData` on **every** request, sent as:
```
Authorization: tma <initData>
```
Requests with a missing or invalid header get `401 { success: false, error: "missing_init_data" | "invalid_init_data" }`. This is the exact convention the `salawat-miniapp` frontend must use.

Unauthenticated:
- **GET /health** → `200 { ok: true }` (for Railway / uptime checks)

**POST /api/register** — disabled (signup is the bot `/start` conversation)
→ `403 { success: false, error: "register_via_bot" }`

**POST /api/log** — body `{ count: number }`
- `count`: integer, `1`…`10000` inclusive
- Rate limits: 30 requests/minute/user and 50_000 salawat/calendar day (challenge `TIMEZONE`)
→ `200 { success: true, newTotal: number, newTodayTotal: number }`
→ `400 { success: false, error: "invalid_count" }`
→ `403 { success: false, error: "not_registered" }`
→ `429 { success: false, error: "rate_limited" }`

**GET /api/progress**
→ `200 { registered: false, challengeStatus, challengeStartDate, challengeEndDate }` if not yet registered
→ `200 { registered: true, nickname, total, todayTotal, dailyGoal, streak, last7Days, daysLeft, needsRealName, challengeStatus, challengeStartDate, challengeEndDate }`
- `total`: all-time sum
- `todayTotal` / `newTodayTotal`: salawat logged so far on the current calendar day in `TIMEZONE` (not UTC midnight)
- `dailyGoal`: daily target (`users.goal`)
- `streak`: consecutive TIMEZONE days (walking backward from today) where that day is effectively met. Today uses live logs only (overrides ignored). Past days use a per-day override when set, otherwise `total ≥ dailyGoal`. Streak does not extend before the user's registration day.
- `last7Days`: array of 7 `{ date, total, metGoal, locked }` entries, oldest → newest, ending with today (`date` is `YYYY-MM-DD` in `TIMEZONE`). `total` is always from logs; `metGoal` for past days follows override when present. Days before the user's registration day have `locked: true` (not missed / not makeup-eligible).
- `needsRealName`: `true` when `users.real_name` is null/empty (legacy users); the Mini App shows a one-time prompt. The name itself is never returned.
- `challengeStatus`: `"not_started" | "active" | "ended"`

**PUT /api/day-override** — body `{ date: string, met: boolean }`
- Sets a per-day met/missed override for makeup (does **not** change logged salawat totals)
- `date` must be a past day in the visible last-7 window (`today-6` … `today-1` in `TIMEZONE`); today, future, and days before registration are rejected
- → `200 { success: true, streak, last7Days }`
- → `400 { success: false, error: "invalid_date" | "invalid_met" | "date_not_editable" }`
- → `403 { success: false, error: "not_registered" }`

**GET /api/leaderboard**
→ `200 { jamaatTotal, leaderboard: [{ nickname, total, rank, isYou }] }`
- `jamaatTotal`: active log sums plus contributions retained by users who reset without dropping from Jamaat; individual leaderboard rows show active personal totals only
- `isYou`: `true` for the authenticated requester's row (for Mini App “(You)” highlighting) — Telegram ids are not exposed
- Competition ranks (ties share a rank: 1, 1, 3)

**GET /api/profile**
→ `200 { nickname, dailyGoal, reminderEnabled, reminderTime, fastingReminderEnabled, fastingReminderTime }`
- `reminderTime`: effective `HH:mm` in challenge `TIMEZONE` (`users.reminder_time` if set, else global `REMINDER_TIME`)
- `fastingReminderEnabled`: default `false` (opt-in)
- `fastingReminderTime`: stored `HH:mm`, default `20:00`
→ `403 { success: false, error: "not_registered" }`

**PATCH /api/profile** — body (all fields optional; at least one required): `{ nickname?, dailyGoal?, reminderEnabled?, reminderTime?, realName?, fastingReminderEnabled?, fastingReminderTime? }`
- Same nickname / daily-goal / real-name rules as register
- `realName` is write-only (used by the one-time completion prompt); GET/PATCH responses never include it
- Nickname and real name must differ case-insensitively (new or existing values)
- `reminderEnabled`: boolean
- `reminderTime`: `HH:mm` (24h), or `null` to clear override and use global `REMINDER_TIME`
- `fastingReminderEnabled`: boolean
- `fastingReminderTime`: required `HH:mm` when present (`null` rejected)
- Rate limit: 5 requests/minute/user
→ `200` same shape as GET
→ `400 { success: false, error: "invalid_body" | "invalid_nickname" | "invalid_goal" | "invalid_real_name" | "nickname_matches_real_name" | "invalid_reminder_enabled" | "invalid_reminder_time" | "invalid_fasting_reminder_enabled" | "invalid_fasting_reminder_time" }`
→ `403 { success: false, error: "not_registered" }`
→ `409 { success: false, error: "nickname_taken" }`
→ `429 { success: false, error: "rate_limited" }`

**POST /api/reset-progress** — body `{ dropFromJamaat?: boolean }` (defaults `false`)
- Deletes the authenticated user's logs and day-goal overrides; keeps nickname, goal, Telegram profile, and reminder settings
- Starts a new personal progress epoch so pre-reset days are locked/not missed
- `dropFromJamaat: false`: moves the current net total into a retained all-time Jamaat counter, keeping `jamaatTotal` unchanged
- `dropFromJamaat: true`: clears active and previously retained contribution for that user
- Retained contribution affects unfiltered all-time Jamaat total only; Mawlid filtered totals/CSV remain based on timestamped active logs
→ `200 { success: true, dropFromJamaat, total: 0, deleted: { logs, dayGoalOverrides } }`
→ `400 invalid_drop_from_jamaat`
→ `403 not_registered`

**Reminders:** a minute cron in `TIMEZONE` messages each user whose `reminder_enabled` is on and whose effective reminder time matches the current `HH:mm`. Global `REMINDER_TIME` is the default when `reminder_time` is null. Sends **independent of** `CHALLENGE_START_DATE` / `CHALLENGE_END_DATE` (before start and after end included). Turn reminders off in Settings to stop DMs. Overlapping ticks are skipped while a send is in flight. No catch-up if the process was down during a user’s minute.

**Fasting reminders:** a separate minute cron (not shared with daily salawat reminders) DMs users with `fasting_reminder_enabled` on, only when the `TIMEZONE` weekday is Sunday or Wednesday and the user's `fasting_reminder_time` matches the current `HH:mm` (default `20:00`). Sunday copy frames Monday's fast; Wednesday copy frames Thursday's. The hadith rotates deterministically across three texts so consecutive fire days do not repeat. Opt-in (default off). Same no-catch-up / overlapping-tick rules.

**GET /api/is-admin**
→ `200 { isAdmin: boolean }` based on whether the authenticated Telegram id is an admin (owner or co-admin) **of the room they are currently in**. A user with no current room is never an admin.

The following Mini App admin routes require an authenticated Telegram id with room-scoped admin status:

- **GET /api/admin/stats** → `{ participantCount, mawlidStartDate, mawlidEndDate }`
- **GET /api/admin/leaderboard?period=all|mawlid** → live ranked totals `{ rank, nickname, realName, total }` for all logs or only the configured Mawlid period
- **GET /api/admin/export-csv?period=all|mawlid** → authenticated CSV download for the selected result period
- **POST /api/admin/broadcast** — JSON:
  - `{ type: "text", message }` supports non-nested `**bold**`, `*italic*`, `_italic_`
  - `{ type: "link", url, message? }` sends an optional caption plus previewable URL
  - `{ type: "file", fileUrl, message? }` sends an HTTPS document URL
- **POST /api/admin/broadcast-file** — multipart `file` (PDF, max 20 MB) and optional `message`; held in memory and forwarded as Telegram documents without disk persistence

Broadcast responses are `{ success, participantCount, sentCount, failedCount }`. Sends are sequential and error-tolerant: one failed DM does not stop later recipients. A concurrent request returns `409 broadcast_in_progress`.

**GET /api/admin/export?key=…&period=all|mawlid** (or header `X-Admin-Key`) — CSV of `rank,nickname,real_name,telegram_id,telegram_username,telegram_first_name,telegram_last_name,total,daily_goal`; defaults to all-time
- Requires `ADMIN_EXPORT_SECRET`; otherwise `503 export_disabled`
- Telegram profile name fields are stored from `initData.user` at registration and refreshed on later authenticated requests; existing users stay null until they open the app again
→ `401 unauthorized` if key wrong

**POST /api/admin/reset?key=…** (or header `X-Admin-Key`) — wipe all users, logs, and day overrides so everyone re-registers
- Body: `{ "confirm": "RESET" }` (required)
- Requires `ADMIN_EXPORT_SECRET`; otherwise `503 export_disabled`
→ `200 { success: true, deleted: { dayGoalOverrides, logs, users } }`
→ `400 confirm_required` / `401 unauthorized`

## Deploying (Railway)
This already assumes the service is on Railway per the original setup. To make the API publicly reachable for the Mini App:

1. **Settings → Networking → Generate Domain** on the service. Railway services aren't publicly reachable by default — this step is what gives you the `https://<service>.up.railway.app` HTTPS URL.
2. That URL is exactly what goes into the Mini App frontend's `VITE_API_URL`.
3. Build/start commands stay `npm install && npm run build` / `npm start` — same one service runs both the bot and the API, no second service needed.
4. Add the env vars (`CORS_ORIGIN`, `MINI_APP_URL`, `MINI_APP_DEEP_LINK`, `PORT` if you want to override it, `INIT_DATA_MAX_AGE_SECONDS` if you want to override it) alongside the existing ones in the service's Variables panel.
5. Once you know the real Vercel domain, update **both** `CORS_ORIGIN` and `MINI_APP_URL` in Railway and redeploy — the app reads them at boot, so nothing else needs to change. Leaving either as a placeholder means CORS will stay open (`*`) and/or the chat menu button will point at a dead URL.
6. **Attach a persistent volume** so the SQLite file survives redeploys:
   - Railway service → **Settings → Volumes** → Add Volume (e.g. mount path `/data`).
   - Set `DB_PATH=/data/salawat.db` in Variables.
   - Redeploy. Without a volume, every redeploy starts with an empty database.

### Backups
The process writes a rolling WAL-safe backup to `data/salawat.backup.db` shortly after boot and daily at 03:00 (challenge timezone) via better-sqlite3. Railway volumes are still not snapshotted for you — copy that file (or timestamped backups) off the volume if the data matters.

For an on-demand timestamped copy (requires `sqlite3` CLI):

```bash
npm run backup   # writes data/backups/salawat-<UTC timestamp>.db via sqlite3 .backup
```

### Small VPS
Same idea — `npm install && npm run build`, run under `pm2`, keep `.env` on the server. Expose `PORT` over HTTPS (e.g. via nginx + Let's Encrypt) so the Mini App can reach `/api/*`. Point `DB_PATH` at a durable disk path and run `npm run backup` on a cron.

## Bot commands
- `/start` — if already registered: menu-button nudge. If not: starts or **resumes** the signup conversation (full name → nickname → daily goal → salawat reminder opt-in/time → fasting reminder opt-in/time). Partial answers live in `pending_registrations` so Railway redeploys don't lose progress.
- `/help` — registered users get the menu nudge; unregistered users with a pending signup are re-prompted at their current step; others are told to send `/start`.

`/deleteuser` and `/makeadmin` are **removed**. Both were global, single-tenant user management; they are superseded by room-scoped kick and co-admin promote/demote. No global user-management command remains.

## Notes / v1 scope
Group-chat announcements, multi-timezone support, and manual count correction remain out of scope. Daily goals, streaks, and per-user reminder preferences are included via `/api/progress` and `/api/profile`. A secret-gated CSV export (`/api/admin/export`) is available for prize time. Signup is in the bot; logging, progress, leaderboard, and settings live in the Mini App — see the [`salawat-miniapp`](https://github.com/dias-jaqsylyq/salawat-miniapp) README for that side.
