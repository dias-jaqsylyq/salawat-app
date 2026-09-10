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
- **`users`** — gain `role` (`admin` | `participant`, chosen once at registration) and `current_room_id` (at most one room at a time; `NULL` between leaving one room and joining the next, which also pauses their reminders). Nickname uniqueness is **per room**, not global. `fasting_reminder_enabled` / `fasting_reminder_time` hold the separate, opt-in (default off) Sunday/Wednesday fasting nudge collected at signup — the cron that acts on them is not built yet.
- **`pending_registrations`** — holds a signup in progress, including which branch it is on: `role`, plus `room_name`/`categories_enabled` (admin branch) or `room_id` (participant branch, resolved from the password up front).
- **`habits`** — gain `room_id` and `category` (`IQ` / `SQ` / `PQ` / `EQ`, nullable). A habit in a room with `categories_enabled = 1` always carries a category and one in a room without categories never does — enforced in the application layer, not by the column. Turning categories off **keeps** the stored values; turning them back on asks the admin to re-confirm rather than silently reusing them.
- **`habit_logs`** — gain `room_id`, denormalized from the habit at write time, so leaderboard/progress queries are a filter rather than a join and a member's old logs stay attached to the room they were earned in after they move.

**Destructive migration.** On boot, a DB file from before the multi-room pivot (detected by a leftover `admins` table or a `habits` table with no `room_id`) is **wiped**: every app table is dropped and recreated from `schema.sql`, with no data migrated. A timestamped snapshot of the old file is written next to it as `salawat.pre-multiroom-<utc>.db` first. The check is idempotent and never touches an already-migrated database.

**Additive migration.** A database created by an earlier multi-room deploy is then topped up in place: any column in `client.ts`'s `ADDED_COLUMNS` that the file is missing is added with `ALTER TABLE ADD COLUMN`. Nothing is dropped and no row is rewritten, so this is safe on a volume that already holds live rooms. Also idempotent, and a no-op on a fresh DB (which gets the columns from `schema.sql`). SQLite cannot add a `CHECK` constraint to an existing table, so on a migrated file the `pending_registrations.role` check lives only in the application layer.

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
- Always writes today's `TIMEZONE`-local `log_date`, so a log is only editable the same day — there is no way to reach a past day through this endpoint
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
→ `200 { registered: true, nickname, room, totalPoints, today, streaks, needsRealName }`
- `room`: `{ id, name, categoriesEnabled }` — the name the Mini App shows in its header and the room's category mode; `null` for a caller between rooms
- `totalPoints`: all-time sum of `points_earned` **earned in this room**. A member who moved here from another room keeps their old logs but does not carry their old points in
- `today`: `[{ habitId, logged, value, points }]` for each active habit of the room
- `streaks`: `[{ habitId, streak }]` — consecutive `TIMEZONE` days ending today with a log row for that habit (`0` if today has none). Per habit, never combined
- `needsRealName`: `true` when `users.real_name` is null/empty; the name itself is never returned

**GET /api/leaderboard**
→ `200 { leaderboard: [{ nickname, totalPoints, rank, isYou }] }`
- Only the caller's room: its current members, ranked by the points they earned in it
- Competition ranks (ties share a rank: 1, 1, 3)
- `isYou`: `true` for the requester's row — Telegram ids are not exposed
- `{ leaderboard: [] }` for a caller between rooms

**GET /api/profile**
→ `200 { nickname, realName, reminderEnabled, reminderTime, timezone, room }`
- Self-scoped, so `realName` is the caller's own; public and other-user surfaces still hide it
- `reminderTime`: effective `HH:mm` (`users.reminder_time` if valid, else global `REMINDER_TIME`)
- `timezone`: IANA name detected in the Mini App, or `null` (reminders then fall back to `TIMEZONE`)
- `room`: `{ id, name, categoriesEnabled }` or `null`
→ `403 not_registered`

**PATCH /api/profile** — body (all optional; at least one required): `{ nickname?, reminderEnabled?, reminderTime?, realName?, timezone? }`
- **Nickname uniqueness is per room**, not global: the check is scoped to the caller's room, so the same nickname can exist in two rooms at once. A caller between rooms is checked globally — there is no room to collide within yet
- Nickname and real name must differ case-insensitively (new or existing values)
- `reminderTime`: `HH:mm` (24h), or `null` to fall back to global `REMINDER_TIME`
- `timezone`: IANA name, or `null` to clear
- Rate limit: 5 requests/minute/user
→ `200` same shape as GET
→ `400 invalid_body | invalid_nickname | invalid_real_name | nickname_matches_real_name | invalid_reminder_enabled | invalid_reminder_time | invalid_timezone`
→ `403 not_registered` · `409 nickname_taken` · `429 rate_limited`

**POST /api/room/leave** — leave the room you are currently in
- **Non-destructive**, unlike a kick: habit logs stay in the database; membership and co-admin status are dropped. Afterwards the user has no room (reminders pause) until they join another one with its password, which happens in the bot
- Refused for a room's **last admin** — promote someone else first
→ `200 { success: true, leftRoomId }`
→ `400 no_room` · `403 not_registered` · `409 last_admin`

**Reminders:** a minute cron in `TIMEZONE` DMs each user whose `reminder_enabled` is on and whose effective reminder time matches the current `HH:mm` in **their own** timezone (`users.timezone`, falling back to `TIMEZONE`). The message lists the active habits of **their current room** they have not logged today; users with no current room are skipped entirely. Overlapping ticks are skipped while a send is in flight, and there is no catch-up if the process was down during a user's minute. The separate opt-in fasting reminder is stored at signup but its cron is not built yet.

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
The process writes a rolling WAL-safe backup to `data/salawat.backup.db` shortly after boot and daily at 03:00 (challenge timezone) via better-sqlite3. Railway volumes are still not snapshotted for you — copy that file (or timestamped backups) off the volume if the data matters.

For an on-demand timestamped copy (requires `sqlite3` CLI):

```bash
npm run backup   # writes data/backups/salawat-<UTC timestamp>.db via sqlite3 .backup
```

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
- The **fasting reminder** is a separate opt-in from the daily one (default off). Signup stores it; the scheduler that sends it is not implemented yet.
- All prompts and confirmations are sent as **HTML** with free text (nicknames, room names) escaped — Telegram's legacy Markdown parser 400s on an unmatched `_`/`*`, which would silently drop a confirmation for a nickname like `ali_2005`.

`/deleteuser` and `/makeadmin` are **removed**. Both were global, single-tenant user management; they are superseded by room-scoped kick and co-admin promote/demote. No global user-management command remains.

## Notes / v1 scope
Group-chat announcements, multi-timezone support, and manual count correction remain out of scope. Daily goals, streaks, and per-user reminder preferences are included via `/api/progress` and `/api/profile`. A secret-gated CSV export (`/api/admin/export`) is available for prize time. Signup is in the bot; logging, progress, leaderboard, and settings live in the Mini App — see the [`salawat-miniapp`](https://github.com/dias-jaqsylyq/salawat-miniapp) README for that side.
