# Salawat Challenge Bot

Backend for a month-long salawat counting challenge among a friend group during Mawlid month. **Registration happens in the Telegram bot** via `/start` (resumable chat flow). Logging, progress, leaderboard, settings, and admin live in the [Telegram Mini App](https://core.telegram.org/bots/webapps) frontend ([`salawat-miniapp`](https://github.com/dias-jaqsylyq/salawat-miniapp)), which talks to this repo's HTTP API.

## Architecture
One Node process runs two things side by side:
- A grammY bot using long polling (`/start` registration conversation, `/help`, the daily reminder scheduler, sets the chat menu button to open the Mini App).
- An Express HTTP API (`/api/*`) that the Mini App frontend calls directly, authenticated via Telegram `initData` — no separate login system.

Both share the same SQLite database (`db/repository.ts`) and challenge-date logic (`utils/challenge.ts`).

## Data model (rooms)

One bot serves many independent **rooms** (competitions). Rooms are isolated by `room_id` inside this single database, not by separate bot instances. Full spec: `MULTI ROOM PRD.md`; the schema itself is `src/db/schema.sql`.

- **`rooms`** — `name` (free text, **not** unique), `password`, `categories_enabled`, `owner_user_id`, `created_at`.
  - The password is stored **in plain text** on purpose: an admin has to be able to read it back to share it, and it is embedded in a `t.me/<bot>?start=<password>` deep link. It is a room invite code, not a personal secret. Comparison is **case-sensitive** (`ABC` ≠ `abc`) and the column is `UNIQUE`, so one password resolves to exactly one room.
  - Format (`utils/roomPassword.ts`): 6–64 characters from `A-Za-z0-9_-`, either admin-typed or generated. The charset is Telegram's start-payload limit — anything outside it would produce a share deep link that silently drops the password.
  - `owner_user_id` is historical record-keeping ("who created this") and grants no power — co-admins are fully equal and may demote the owner.
- **`room_admins`** (`room_id`, `user_id`) — the room's owner and every co-admin, flat and equal. This **replaces the old global `admins` table**. Status is per room, so it is dropped the moment a user leaves for another room, and last-admin protection is a `COUNT(*)` over one `room_id`.
- **`users`** — gain `role` (`admin` | `participant`, chosen once at registration) and `current_room_id` (at most one room at a time; `NULL` between leaving one room and joining the next, which also pauses their reminders). Nickname uniqueness is **per room**, not global. `fasting_reminder_enabled` / `fasting_reminder_time` hold the separate, opt-in (default off) Sunday/Wednesday fasting nudge; `timezone` holds the IANA zone the Mini App detects. `streak_display` (`current` | `weekly`, default `weekly`) and `week_start_day` (`0` = Sunday … `6` = Saturday, default `1`) are display-only preferences for the Progress screen. `room_joined_at` records when the user entered the room they are in now (`NULL` between rooms), so the weekly view can grey out days that predate their membership instead of scoring them as missed.
- **`pending_registrations`** — holds a signup in progress, including which branch it is on: `role`, plus `room_name`/`categories_enabled` (admin branch) or `room_id` (participant branch, resolved from the password up front).
- **`habits`** — gain `room_id` and `category` (`IQ` / `SQ` / `PQ` / `EQ`, nullable). A habit in a room with `categories_enabled = 1` always carries a category and one in a room without categories never does — enforced in the application layer, not by the column. Turning categories off **keeps** the stored values; turning them back on asks the admin to re-confirm rather than silently reusing them.
- **`habit_logs`** — gain `room_id`, denormalized from the habit at write time, so leaderboard/progress queries are a filter rather than a join and a member's old logs stay attached to the room they were earned in after they move.

**Every "today" is the user's own.** `log_date`, the day Progress and the weekly grid draw, the day a streak walks back from, and the day the reminders ask about are all resolved through `getUserTimezone`/`getUserTodayKey` (`utils/challenge.ts`): the user's detected `timezone`, falling back to `TIMEZONE` until the Mini App has reported one, and falling back again if a stored zone stops being valid. Nothing is stored per-day beyond `log_date` itself, so changing timezone moves that user's "today" on the next request with nothing to recompute or invalidate — and moves nobody else's. Points already written keep the `log_date` they were written under; a zone change shifts the window, it does not relabel history.

**Destructive migration.** On boot, a DB file from before the multi-room pivot (detected by a leftover `admins` table or a `habits` table with no `room_id`) is **wiped**: every app table is dropped and recreated from `schema.sql`, with no data migrated. A timestamped snapshot of the old file is written next to it as `salawat.pre-multiroom-<utc>.db` first. The check is idempotent and never touches an already-migrated database.

**Additive migration.** A database created by an earlier multi-room deploy is then topped up in place: any column in `client.ts`'s `ADDED_COLUMNS` that the file is missing is added with `ALTER TABLE ADD COLUMN`. Nothing is dropped and no row is rewritten, so this is safe on a volume that already holds live rooms. Also idempotent, and a no-op on a fresh DB (which gets the columns from `schema.sql`). SQLite cannot add a `CHECK` constraint to an existing table, so on a migrated file the `pending_registrations.role`, `users.streak_display` and `users.week_start_day` checks live only in the application layer (`PATCH /api/profile` validates the latter two). One backfill runs alongside: `backfillRoomJoinedAt()` fills a `NULL` `room_joined_at` from `created_at` for members who predate the column — closest honest answer, exact for anyone who registered straight into the room they are still in. It only ever fills `NULL`s, so a real join timestamp is never overwritten, and a user between rooms keeps `NULL`.

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
- `INIT_DATA_MAX_AGE_SECONDS` — how old a Telegram `initData` payload can be before it's rejected as stale (replay protection). Defaults to `3600` (1h) when `NODE_ENV=production` and `86400` (24h) otherwise, so production is safe without setting it. A value that is set but not a positive whole number is a startup error rather than a silent fallback.
- `ADMIN_EXPORT_SECRET` — optional. When set, enables `GET /api/admin/export?key=…` for prize-time CSV download.

There is no `ADMIN_TELEGRAM_ID`: with rooms there is no global admin to bootstrap. Admin status is room-scoped and granted by creating a room or by being promoted inside one — see [Data model](#data-model-rooms).

**Never commit `.env` or paste your bot token anywhere public.** If a token leaks, revoke it via `@BotFather` → `/revoke`.

### Public go-live checklist
Before sharing the invite beyond a tiny trusted group:

1. Railway **volume** mounted; `DB_PATH=/data/salawat.db`
2. `CORS_ORIGIN=https://<vercel-domain>` (not `*`); `NODE_ENV=production`
3. `MINI_APP_URL` + BotFather Web App URL = same HTTPS URL; redeploy bot
4. Vercel `VITE_API_URL` = Railway public API URL → **redeploy** the Mini App (Vite bakes env at build time)
5. Copy `data/backups/` **off** the Railway volume on a schedule (manual step — see [Backups](#backups))
6. `INIT_DATA_MAX_AGE_SECONDS=3600` (optional — production already defaults to 1h)
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

**Everything below is room-scoped** (`api/roomScope.ts`). The client never passes a room identifier: each request is resolved to whatever room the caller is currently in, via `req.telegramId` → `users.current_room_id`. Two consequences worth stating explicitly:

- A route that reads another row by id (a habit, a member) also checks that row belongs to the **same** room. `requireAdmin` only proves the caller is an admin of *their own* room, never of the room an id happens to point at. A habit or member of another room answers exactly like one that does not exist (`404 habit_not_found` / `participant_not_found`), so the API never confirms that some other room's id is real.
- A registered user **between rooms** (`current_room_id IS NULL`, e.g. after leaving one) has nothing to scope to. Reads answer empty (`[]`, `room: null`, an empty leaderboard); writes answer `400 { success: false, error: "no_room" }`.

The two `ADMIN_EXPORT_SECRET`-gated routes at the end are the deliberate exception — there is no calling Telegram user behind the secret, so they stay global.

Unauthenticated:
- **GET /health** → `200 { ok: true }` (for Railway / uptime checks)

**POST /api/register** — disabled (signup is the bot `/start` conversation)
→ `403 { success: false, error: "register_via_bot" }`

**GET /api/habits** — active habits of the caller's room, for the logging screen
→ `200 [{ id, name, type: "quantity" | "binary", pointsWeight, category }]`
- `category` is echoed as stored; the client decides whether to group by it, from the room's `categoriesEnabled` (see `GET /api/progress`)
- `200 []` for a caller between rooms

**POST /api/habits/:id/log** — body `{ value?: number }`, upserts today's log
- `quantity`: `value` is an integer `0`…`10000`. `binary`: omit `value` or send `1`
- Always writes **the caller's own** today as `log_date` (their `timezone`, falling back to `TIMEZONE`), so a log is only editable the same day *they* made it — there is no way to reach a past day through this endpoint
- Not cumulative: a second call the same day overwrites `value`/`points_earned` rather than adding
- Points are computed from the habit's current weight and **frozen** on the row (`computePoints`), so a later weight change is never retroactive
- Rate limit: 30 requests/minute/user
→ `200 { success: true, habitId, value, points, logged: true }`
→ `400 invalid_habit_id | no_room | habit_inactive | invalid_value`
→ `403 not_registered` · `404 habit_not_found` · `429 rate_limited`

**DELETE /api/habits/:id/log** — removes today's log, if any
- Idempotent (no log today is still `200`), and allowed against a **deactivated** habit: it corrects an existing entry rather than logging new engagement
→ `200 { success: true, habitId, logged: false }` · same error shapes as POST minus `habit_inactive`

**GET /api/progress**
→ `200 { registered: false }` if not registered
→ `200 { registered: true, nickname, room, totalPoints, todayPoints, today, todayDate, streaks, streakDisplay, weekStartDay, needsRealName }`
- `room`: `{ id, name, categoriesEnabled }` — the name the Mini App shows in its header and the room's category mode; `null` for a caller between rooms
- `totalPoints`: all-time sum of `points_earned` **earned in this room**. A member who moved here from another room keeps their old logs but does not carry their old points in
- `todayPoints`: the same sum narrowed to `todayDate` — the caller's Today's Total. Summed from the stored `points_earned`, so a later weight change is not retroactive here either, and a habit deactivated since still counts: the points were earned while it was active. **Personal screen only** — the leaderboard has no equivalent, and no group/Jamaat total exists anywhere
- `today`: `[{ habitId, logged, value, points }]` for each active habit of the room
- `todayDate`: the `YYYY-MM-DD` the two above are measured over — the caller's own day, so it moves with their timezone
- `streaks`: `[{ habitId, streak }]` — consecutive days ending today (in the caller's own timezone) with a log row for that habit (`0` if today has none). Per habit, never combined
- `streakDisplay` / `weekStartDay`: the caller's display preferences, echoed so the Progress screen picks a streak shape once instead of rendering one and flipping
- `needsRealName`: `true` when `users.real_name` is null/empty; the name itself is never returned

**GET /api/progress/week** — the seven days of the caller's current calendar week, per active habit, for the weekly streak view
→ `200 { weekStart, weekStartDay, today, days: [7 × "YYYY-MM-DD"], habits: [{ habitId, name, days: [{ date, logged, locked, future }] }] }`
- A **calendar** week from the caller's own `week_start_day` (default Monday), not a rolling last-7-days window: the row seen on Wednesday covers the same dates it covered on Monday, with the rest of the week still ahead
- One **flat** list, one row per **active** habit — deactivated habits are absent, and rows are never grouped by category even in a categories-enabled room
- Cells carry **presence only**, never a count (`logged` is a lit or unlit flame; there is no "X of 7"). Two cell kinds are neither lit nor missed, so the UI can grey them out rather than score them: `locked` (the day precedes `room_joined_at` — joined mid-week) and `future` (has not happened yet in the caller's own timezone)
- **Read-only by construction**: there is no matching write endpoint, because the weekly view is not tappable. Logging stays today-only, through `POST /api/habits/:id/log` — day-override remains out of scope
- `{ habits: [] }` for a caller between rooms (the week itself is still returned); `403 not_registered` otherwise

**GET /api/leaderboard**
→ `200 { leaderboard: [{ nickname, totalPoints, rank, isYou }] }`
- Only the caller's room: its current members, ranked by the points they earned in it
- Competition ranks (ties share a rank: 1, 1, 3)
- `isYou`: `true` for the requester's row — Telegram ids are not exposed
- `{ leaderboard: [] }` for a caller between rooms

**GET /api/profile**
→ `200 { nickname, realName, reminderEnabled, reminderTime, fastingReminderEnabled, fastingReminderTime, timezone, streakDisplay, weekStartDay, room }`
- Self-scoped, so `realName` is the caller's own; public and other-user surfaces still hide it
- `reminderTime`: effective `HH:mm` (`users.reminder_time` if valid, else global `REMINDER_TIME`)
- `fastingReminderEnabled` / `fastingReminderTime`: the Sunday/Wednesday nudge, default **off** at `20:00`. Offered identically to every member of every room, admins included — it is a function of the bot, not a room setting, so there is no room-level switch for it
- `timezone`: IANA name detected in the Mini App, or `null` (everything that needs this user's "today" then falls back to `TIMEZONE`)
- `streakDisplay` (`current` | `weekly`, default `weekly`) and `weekStartDay` (`0` = Sunday … `6` = Saturday, default `1`): display-only preferences for the Progress screen's streak section
- `room`: `{ id, name, categoriesEnabled }` or `null`
→ `403 not_registered`

**PATCH /api/profile** — body (all optional; at least one required): `{ nickname?, reminderEnabled?, reminderTime?, fastingReminderEnabled?, fastingReminderTime?, realName?, timezone?, streakDisplay?, weekStartDay? }`
- **Nickname uniqueness is per room**, not global: the check is scoped to the caller's room, so the same nickname can exist in two rooms at once. A caller between rooms is checked globally — there is no room to collide within yet
- Nickname and real name must differ case-insensitively (new or existing values)
- `reminderTime`: `HH:mm` (24h), or `null` to fall back to global `REMINDER_TIME`
- `fastingReminderTime`: `HH:mm` (24h) — **not** nullable, unlike `reminderTime`: there is no global fasting default to fall back to, so the column always holds a concrete time. One time covers both fire days; there is no separate Sunday and Wednesday setting
- `timezone`: IANA name, or `null` to clear
- `streakDisplay` / `weekStartDay`: purely visual. Switching changes which shape the Progress screen draws and nothing else — no streak is recomputed, no value is cached or migrated, and the underlying logs are untouched
- Rate limit: 5 requests/minute/user
→ `200` same shape as GET
→ `400 invalid_body | invalid_nickname | invalid_real_name | nickname_matches_real_name | invalid_reminder_enabled | invalid_reminder_time | invalid_fasting_reminder_enabled | invalid_fasting_reminder_time | invalid_timezone | invalid_streak_display | invalid_week_start_day`
→ `403 not_registered` · `409 nickname_taken` · `429 rate_limited`

**POST /api/room/leave** — leave the room you are currently in
- **Non-destructive**, unlike a kick: habit logs stay in the database; membership and co-admin status are dropped. Afterwards the user has no room (reminders pause) until they join another one with its password, which happens in the bot
- Refused for a room's **last admin** — promote someone else first
→ `200 { success: true, leftRoomId }`
→ `400 no_room` · `403 not_registered` · `409 last_admin`

**Daily reminder** (`scheduler/reminder.ts`): a minute cron DMs each user whose `reminder_enabled` is on and whose effective reminder time matches the current `HH:mm` in **their own** timezone (`users.timezone`, falling back to `TIMEZONE`). The message lists the active habits of **their current room** they have not logged **on their own day** — the same day key their logs are written under, so someone pinged at 20:00 local is told about the day they can still log. Users with no current room are skipped entirely.

**Fasting reminder** (`scheduler/fastingReminder.ts`): a **separate, parallel** minute cron, deliberately not folded into the daily one — different opt-in, different schedule, unrelated content, and a failure in one must not silence the other. It DMs each user with `fasting_reminder_enabled` on, on **their own** Sunday or Wednesday evening at their `fasting_reminder_time` (one time covers both days). Sunday copy frames Monday's fast, Wednesday's frames Thursday's. The text is **pure text**: a nudge about tomorrow's fast, with no habit attached, nothing logged and no app link. The hadith rotates deterministically across three (`Sahih Muslim 1162e`, `Jami' at-Tirmidhi 747`, `Sunan an-Nasa'i 2360`) from the date alone — no stored counter, stable for every tick of one day, and never the same text two fire days running. Identical for every room, since it is a function of the bot rather than a room setting; users with no current room are skipped, same as the daily reminder.

Both schedulers skip overlapping ticks while a send is in flight, and neither catches up if the process was down during a user's minute.

**GET /api/is-admin**
→ `200 { isAdmin: boolean }` — whether the authenticated Telegram id is an admin (owner or co-admin) **of the room they are currently in**. A user with no current room is never an admin.

### Admin routes

All of the following require an authenticated Telegram id with admin status **in their own current room**, and act on that room only.

- **GET /api/admin/stats** → `{ participantCount }` — members of the caller's room
- **GET /api/admin/room** → `{ id, name, categoriesEnabled, password, inviteLink, participantCount }`
  - The password and its `t.me/<bot>?start=<password>` link are **admin-only** — they are absent from every participant-facing response. `inviteLink` is `null` until the bot knows its own username
- **PATCH /api/admin/room** — body `{ categoriesEnabled: boolean }`
  - Toggleable at any time, not only at room creation. Stored habit categories are left alone in **both** directions: switching off preserves them, switching back on does not silently resurrect them — the admin re-confirms each habit through `PATCH /api/admin/habits/:id`
  - → `400 invalid_categories_enabled`
- **POST /api/admin/room/password** — body `{ password? }`
  - With a password: the admin's own choice (6–64 chars of `A-Za-z0-9_-`, case-sensitive). Without: a generated replacement, retried on a UNIQUE collision. Retyping the room's current password is a no-op `200`
  - Only blocks **future** joins — everyone already in the room keeps their membership, no re-verification
  - → `400 invalid_password` · `409 password_taken` (another room already answers to it; which room is never revealed)
- **GET /api/admin/habits** → every habit of the caller's room, including inactive ones, as `{ id, name, type, pointsWeight, category, isActive, createdAt, updatedAt }`
- **POST /api/admin/habits** — body `{ name, type, pointsWeight, category? }`
- **PATCH /api/admin/habits/:id** — body `{ name?, pointsWeight?, isActive?, category? }`; non-destructive and reversible, so no YES-confirm
  - `category` follows the room's mode (the application-layer half of the invariant): required and one of `IQ`/`SQ`/`PQ`/`EQ` when the room has categories enabled, rejected when it does not
  - → `400 invalid_name | invalid_type | invalid_points_weight | invalid_is_active | invalid_body | category_required | invalid_category | category_not_allowed` · `404 habit_not_found`
- **GET /api/admin/leaderboard** → `{ leaderboard: [{ rank, nickname, realName, telegramId, totalPoints, isRoomAdmin, isYou }] }`
  - The caller's room only. Adds `realName`/`telegramId` for moderation beyond the public leaderboard, and `isRoomAdmin` because this screen is also where co-admins are promoted, demoted and kicked
- **POST /api/admin/participants/:telegramId/admin** — promote a member to co-admin; idempotent
- **DELETE /api/admin/participants/:telegramId/admin** — demote a co-admin (or the owner) back to plain participant
  - Co-admins are flat and equal: **any** of them may promote or demote **any** other, the room's original owner included. Demoting yourself is allowed
  - **Last-admin protection**: refused when it would leave the room with zero admins. The count and the delete run in one transaction, so two co-admins demoting each other at the same moment cannot both succeed
  - → `409 last_admin`
- **DELETE /api/admin/participants/:telegramId** — kick a member out of the room
  - **Destructive**, unlike a voluntary leave: every log they earned **in this room** is deleted, so a later rejoin starts from zero. Logs they earned in other rooms are untouched
  - The kicked member gets a bot DM. A failed DM is logged and does not undo the kick or fail the request
  - Not a ban — they can rejoin with the correct password
  - → `400 cannot_kick_self` (leaving is `POST /api/room/leave`) · `409 last_admin`
- Promote/demote/kick all → `400 invalid_telegram_id` · `404 participant_not_found` (including for anyone who is not a current member of *your* room)
- **GET /api/admin/export-csv** → CSV of the caller's room, filename `habit-tracker-<room-name>-<room-id>-<date>.csv`
  - The room name is reduced to ASCII for the `Content-Disposition` header (which is latin1); a name with no ASCII left falls back to `room-<id>`
- **POST /api/admin/broadcast** — JSON:
  - `{ type: "text", message }` supports non-nested `**bold**`, `*italic*`, `_italic_`
  - `{ type: "link", url, message? }` sends an optional caption plus previewable URL
  - `{ type: "file", fileUrl, message? }` sends an HTTPS document URL
- **POST /api/admin/broadcast-file** — multipart `file` (PDF, max 20 MB) and optional `message`; held in memory and forwarded as Telegram documents without disk persistence

Broadcasts reach **the caller's own room only**, never another one. Responses are `{ success, participantCount, sentCount, failedCount }`. Sends are sequential and error-tolerant: one failed DM does not stop later recipients. The in-flight lock is **per room**, so a concurrent send into the *same* room returns `409 broadcast_in_progress` while another room's admin is unaffected.

### Owner-only routes (not room-scoped)

These two are authenticated by `ADMIN_EXPORT_SECRET` rather than Telegram `initData`. There is no calling user behind the secret and therefore no "own room" to scope to — cross-room visibility belongs to the app owner via direct access, not to any in-product admin.

**GET /api/admin/export?key=…** (or header `X-Admin-Key`) — CSV of `rank,nickname,real_name,telegram_id,telegram_username,telegram_first_name,telegram_last_name,total_points` across **every** room
- Requires `ADMIN_EXPORT_SECRET`; otherwise `503 export_disabled`
- Telegram profile name fields are stored from `initData.user` at registration and refreshed on later authenticated requests
→ `401 unauthorized` if key wrong

**POST /api/admin/reset?key=…** (or header `X-Admin-Key`) — wipe **all** users and habit logs, across every room, so everyone re-registers. Habit definitions and rooms survive
- Body: `{ "confirm": "RESET" }` (required)
- Requires `ADMIN_EXPORT_SECRET`; otherwise `503 export_disabled`
→ `200 { success: true, deleted: { habitLogs, users } }`
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

The process writes WAL-safe backups via better-sqlite3 into `data/backups/`
(next to `DB_PATH`), named `salawat-<UTC timestamp>.db`:

- **daily at 03:00** in the challenge timezone, and
- **once shortly after boot** — but only if the newest existing backup is
  already at least 12 hours old.

The **7 most recent** are kept; older ones are pruned automatically.

Two details worth knowing, because both are deliberate:

- Backups are never overwritten, only added and pruned. A bad snapshot can
  therefore never destroy a good one.
- The boot-time backup is skipped while a recent backup exists. Without that,
  a service stuck in a restart loop would write seven backups of the broken
  state within a minute and rotate away exactly the history you need.

For an on-demand copy before something risky (requires the `sqlite3` CLI). It
writes into the same directory and prunes to the same depth:

```bash
npm run backup   # writes data/backups/salawat-<UTC timestamp>.db via sqlite3 .backup
```

#### Copy backups off the volume (manual)

Railway volumes are **not** snapshotted for you, and the backups live on the
same volume as the live database — so losing the volume loses both. Nothing in
the app does this for you; if the data matters, copy it off on a schedule:

```bash
railway run -- tar -czf - /data/backups > "salawat-backups-$(date -u +%Y%m%d).tar.gz"
```

#### Restoring from a backup

If something goes wrong in production, this is the whole procedure.

1. **Stop the bot** so nothing writes to the database while you work.
   Railway → your service → **Settings → pause the service** (or redeploy
   after step 4 — just don't leave it running).

2. **Pick which backup to restore.** They're on the volume in
   `/data/backups/`, newest last:

   ```bash
   ls -la /data/backups/
   ```

   The filename is the UTC time the backup was taken, so
   `salawat-20260911T030000Z.db` is 03:00 UTC on 11 September 2026. Pick the
   newest one from *before* the problem started — if bad data was written on
   Tuesday, a Wednesday backup already contains it.

3. **Move the damaged database aside** rather than deleting it. If the restore
   goes badly, this is your only way back, and it may still hold the most
   recent records:

   ```bash
   mv /data/salawat.db /data/salawat.db.broken
   mv /data/salawat.db-wal /data/salawat.db-wal.broken 2>/dev/null || true
   mv /data/salawat.db-shm /data/salawat.db-shm.broken 2>/dev/null || true
   ```

   The `-wal` and `-shm` files are SQLite's journal for the *old* database.
   Leaving them next to a restored file lets SQLite try to apply the old
   journal to it, which is how a clean restore gets corrupted — move all three.

4. **Copy** (don't move) the chosen backup into place, so the backup stays in
   the rotation:

   ```bash
   cp /data/backups/salawat-20260911T030000Z.db /data/salawat.db
   ```

5. **Start the bot.** The migrations that run at boot are idempotent and will
   not touch restored data.

6. **Check it worked** — open the Mini App and confirm the leaderboard and a
   couple of habit logs look right. Once you're satisfied, delete the
   `.broken` files.

**What you lose:** everything logged between the backup you restored and the
moment things broke — at most a day with the daily schedule. There is no way to
recover that from the backups themselves; if it matters, take a manual
`npm run backup` before any risky change.

**If someone was mid-registration** during the restore, their half-finished
signup may be gone. They just send `/start` again — partial answers live in
`pending_registrations` and are rebuilt from scratch, nothing else breaks.

### Small VPS
Same idea — `npm install && npm run build`, run under `pm2`, keep `.env` on the server. Expose `PORT` over HTTPS (e.g. via nginx + Let's Encrypt) so the Mini App can reach `/api/*`. Point `DB_PATH` at a durable disk path and run `npm run backup` on a cron.

## Bot commands
- `/start` — if already registered: a menu-button nudge naming the room they're in (so no separate "which room am I in" command is needed). If not: starts or **resumes** the signup conversation. Partial answers live in `pending_registrations` so Railway redeploys don't lose progress.
- `/start <password>` — a room's invite deep link (`t.me/<bot>?start=<password>`). For a **new** user with a valid password it skips the role and password questions and opens signup straight into that room. For an **already-registered** user the payload is ignored entirely — it never offers a room switch. An unknown password falls back to the normal first question.
- `/help` — registered users get the menu nudge; unregistered users with a pending signup are re-prompted at their current step; others are told to send `/start`.

### Registration flow (`registration/flow.ts`)

The first question is **Admin (create a room)** or **Participant (join with a password)** — chosen once, not re-selectable later. From there the conversation forks and rejoins on a shared reminder tail:

| Branch | Steps |
|---|---|
| Admin | `role` → `real_name` → `room_name` → `categories` (yes/no) → `nickname` → *shared tail* |
| Participant | `role` → `room_password` → `real_name` → `nickname` → *shared tail* |
| Shared tail | `reminder_opt_in` → [`reminder_time`] → `fasting_opt_in` → [`fasting_time`] |

- **Admin finish**: the account, the room, its `room_admins` owner row and the owner's `current_room_id` are written in **one transaction** (`createAdminWithRoom`) — a partial failure can never leave an admin with no room. The room password is generated (`generateRoomPassword`), retried on the `rooms.password` UNIQUE collision, then shown to the admin with an explicit "share this with your participants" message and the matching `t.me/<bot>?start=<password>` invite link. The bot's username comes from the running bot, not configuration.
- **Participant join**: the password is format-checked (`isValidRoomPassword`) before any DB lookup, then resolved with `getRoomByPassword` — **case-sensitive**, and a wrong password and a malformed one get the identical message, so nothing signals which guesses were close. Guesses are rate-limited per Telegram user (`ROOM_JOIN_RATE_LIMIT_PER_MINUTE`, via the same `allowRequest` helper the API uses).
- **Nickname uniqueness is per room**: a participant is checked against their resolved room only, so the same nickname can exist in two rooms. An admin's room does not exist yet at that step and is created empty, so nothing can collide there.
- The **fasting reminder** is a separate opt-in from the daily one (default off), collected here and changeable later in the Mini App's Settings. `scheduler/fastingReminder.ts` is what acts on it.
- All prompts and confirmations are sent as **HTML** with free text (nicknames, room names) escaped — Telegram's legacy Markdown parser 400s on an unmatched `_`/`*`, which would silently drop a confirmation for a nickname like `ali_2005`.

`/deleteuser` and `/makeadmin` are **removed**. Both were global, single-tenant user management; they are superseded by room-scoped kick and co-admin promote/demote. No global user-management command remains.

## Notes / v1 scope
Group-chat announcements and manual count correction remain out of scope; **per-user timezones are supported** and every "today" in the app is resolved in the caller's own zone. Streaks, the two streak display shapes, and per-user reminder preferences are served by `/api/progress`, `/api/progress/week` and `/api/profile`. There is **no group/Jamaat total** anywhere — each room's leaderboard is individual points only, and nothing aggregates across rooms. Backfilling past days (`day-override`) stays out of scope: only today is loggable, and the weekly view is read-only for exactly that reason. A secret-gated CSV export (`/api/admin/export`) is available for prize time. Signup is in the bot; logging, progress, leaderboard, and settings live in the Mini App — see the [`salawat-miniapp`](https://github.com/dias-jaqsylyq/salawat-miniapp) README for that side.
