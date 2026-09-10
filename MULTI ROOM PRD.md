# Multi-Room Habit Tracker — PRD

> Pivot from a single-competition Habit Tracker into a **multi-tenant
> platform**: one Telegram bot serving many independent rooms
> (competitions), each with its own admin, participants, habits,
> categories, and leaderboard. This doc is meant to be handed to a coding
> agent with direct repo access, in the same spirit as `PIVOT_PLAN.md`.
> Fresh start: **no migration of existing data** — current room/users/
> habits/logs are wiped when this ships.

## 0. Decisions locked in

- **One bot, many rooms.** Single Telegram bot instance (`@salawat_challenge_bot`
  or renamed later) serves all rooms. Rooms are logically isolated inside
  one database (`room_id` foreign key on everything room-scoped), not
  separate bot instances.
- **One role per account, chosen once at registration:** `admin` or
  `participant`. Not re-selectable later without an explicit account
  reset (out of scope for v1 — no "change role" flow).
- **Admin = exactly one room.** An admin creates exactly one room at
  registration (name + auto-generated password) and cannot create a
  second one. The admin is automatically also a **participant of their
  own room** — same logging/progress/leaderboard experience as any
  participant, plus admin-only screens layered on top.
- **Co-admins.** The room's main admin can promote any participant in
  their room to co-admin. Co-admins have **full, equal power** to the
  main admin within that room (manage habits, categories, broadcasts,
  promote/demote other co-admins, room password). No permission tiers
  in v1.
- **Room password** is auto-generated at room creation, **admin can
  regenerate it later** (same mental model as a Telegram group invite
  link — old password stops working once regenerated).
- **Room discovery is password-only.** No public room list or search
  anywhere in the bot or Mini App. A participant must be given the
  password out-of-band (by the admin, e.g. shared in their own Telegram
  group/chat).
- **Participants can switch rooms.** A participant can leave their
  current room and join a different one via that room's password.
  Leaving a room: their habit logs for that room stop counting toward
  it (exact data-retention behavior — delete vs. archive — is an
  implementation decision, default to **archive/keep for history,
  simply detach from active room membership** unless a cleaner delete
  is trivially cheap).
- **Habit categories are a per-room binary toggle**, not per-habit free
  text: **categories ON** (fixed set `IQ` / `SQ` / `PQ` / `EQ`, every
  habit in this room must have exactly one of these four) or
  **categories OFF** (habits are a flat list, no grouping). This
  replaces the earlier "categories are always on, globally fixed" idea
  from the previous task list. **Toggleable at any time after room
  creation**, not just at creation (admin-only action, e.g. in
  AdminScreen). When turned OFF, each habit's `category` value is
  **preserved in the database**, just not used for grouping. When
  turned back ON, previously-assigned categories are **not
  automatically re-applied to the UI** — the admin must review/confirm
  each habit's category again (simplest correct behavior: don't try to
  silently resurrect stale category assignments the admin may have
  forgotten about; treat re-enabling as "please re-confirm your habit
  categories," even though the old values are still sitting in the
  column and could be used as a pre-fill suggestion).
- **No Jamaat (group) total anywhere** — already decided in the prior
  task list, still holds. Each room's leaderboard is individual points
  only.
- **Fresh start.** Existing `users`/`habits`/`habit_logs`/`admins` data
  is wiped, not migrated into a "default room." The single admin
  currently running the live competition will re-register as the admin
  of a new room after this ships.

## 1. Data model changes

New table `rooms`:
- `id`, `name` (admin-chosen, free text), `password_hash` (or plaintext
  if the existing password-check patterns in this codebase already
  store things that way — match whatever convention `admins`/auth
  already use), `categories_enabled` (boolean), `created_at`,
  `owner_user_id` (the room's original creating admin — distinct from
  the co-admin list, so "who created this" is always knowable even
  after co-admins are added/removed).

Every room-scoped table needs `room_id`:
- `habits` — add `room_id`, add `category` (nullable, one of
  `IQ`/`SQ`/`PQ`/`EQ`, only meaningful when the room's
  `categories_enabled = true`; enforce at the application layer that a
  habit in a categories-enabled room always has a category, and a habit
  in a categories-disabled room never does).
- `habit_logs` — inherits room scoping transitively through `habit_id`,
  but consider whether direct `room_id` denormalization is worth it for
  query simplicity (leaderboard/progress queries will otherwise need a
  join through `habits`).
- `users` — a user belongs to **at most one room at a time**
  (`current_room_id`, nullable — null only in the brief window between
  choosing "participant" and successfully entering a password). Track
  role (`admin` | `participant`) and, separately, whether they are a
  co-admin of their current room (a room-scoped flag/join table, not a
  global `admins` table anymore — the existing `admins` table from the
  old single-tenant model is retired in favor of room-scoped admin
  status).
- Room membership history (for the "leave and rejoin a different room"
  case) — decide whether past-room logs stay queryable (e.g. for a
  user's own history) or are cut off entirely once they leave; default
  to keeping the historical `habit_logs` rows intact (they still point
  at a real `habit_id` in a real room) and simply updating
  `current_room_id`, so nothing needs deleting on leave.

## 2. Registration flow (bot, `/start`)

New first step, before anything else: **"Are you setting up a new
competition (Admin) or joining one (Participant)?"**

**Admin path:**
1. Real name (unchanged from current flow).
2. Room name.
3. Categories on/off (yes/no prompt).
4. Nickname, reminder opt-in/time, fasting-reminder opt-in/time
   (unchanged from current flow, per the earlier task list — these
   apply to the admin as a participant of their own room).
5. Room is created, password generated, shown to the admin with an
   explicit "share this with your participants" message.

**Participant path:**
1. Room password (validate against `rooms.password_hash`; wrong
   password → re-prompt, no attempt limit specified — add basic rate
   limiting consistent with existing `allowRequest` patterns).
2. Real name, nickname, reminder opt-in/time, fasting-reminder
   opt-in/time (unchanged) — same as today, just now scoped to whatever
   room the password resolved to.

**Switching rooms** (existing participant, not part of initial
registration): a new bot command or Settings-screen action —
"Leave current room" → prompts for a new room password → re-validates
nickname uniqueness **within the new room** (nickname uniqueness is
now room-scoped, not global) → updates `current_room_id`.

## 3. Mini App changes

Every screen that currently shows global data becomes room-scoped by
construction (the API already resolves the user from `telegramId`, and
the user now carries `current_room_id` — so `GET /api/progress`,
`GET /api/habits`, `GET /api/leaderboard`, etc. all filter by the
caller's current room without the client needing to pass a room
identifier explicitly).

- **LogHabitsScreen** — if the room has `categories_enabled`, group by
  category (order `SQ → IQ → EQ → PQ`, icons via `lucide-react`, per
  the earlier task list); if disabled, flat list as today.
- **AdminScreen** — becomes meaningful only for admins/co-admins of a
  room; a `participant`-role user never sees this tab at all (not just
  hidden content — the tab itself shouldn't render). Habits tab default,
  no separate Results tab, Leaderboard tab folds in co-admin management
  (promote/demote participants to co-admin — **not** a global
  admin-management feature anymore, room-scoped) and CSV download, per
  the earlier task list — all of that still applies, just re-scoped to
  "within this admin's one room" instead of "globally."
- **Settings** — add "Leave room" action (see §2), keep everything else
  from the earlier task list (real name, streak display type, week
  start day, fasting reminder, timezone auto-detect).
- New: room password display/regenerate control, visible to
  admin/co-admins only (e.g. a small section in AdminScreen or
  Settings — pick whichever fits the existing layout better).

## 3a. Room governance edge cases (co-admins, password, broadcasts)

- **Kicking participants**: admin/co-admin can remove ("kick") a
  participant directly from the room's Leaderboard screen (no separate
  Members list needed). On kick: **all of that participant's data for
  this room is deleted** (not archived/detached like a voluntary leave —
  kick is destructive). The kicked user **receives a bot message**
  informing them they were removed. They **can rejoin the same room
  later** with the correct password (kick is not a permanent ban) — if
  they do, they start fresh (no data survives from before the kick).
- **Room name is shown to participants** in the Mini App (header or
  Settings — pick whichever fits existing layout) and again whenever an
  already-registered user sends `/start` (e.g. "You're already
  registered in **{room name}** — open the app below").
- **Room switching UI location** (bot-only vs. also in Mini App
  Settings): left to implementation's judgment — no strong preference
  from the user. Default to bot-only, matching the existing
  registration flow's pattern, unless it's trivially easy to also
  surface in Settings.
- **Nickname uniqueness is per-room**, not global — the same nickname
  string can exist in two different rooms simultaneously.
- **Room names are not unique** — two different rooms can share the
  exact same name; only `room.id` disambiguates them internally.
- **Any co-admin can promote other participants to co-admin** — not
  restricted to the room's original owner. Fully flat/egalitarian model:
  **any co-admin (including a non-owner co-admin) can also demote the
  room's original owner back to plain participant.** `owner_user_id` is
  purely historical record-keeping ("who originally created this room"),
  never used to grant extra protection or extra power.
- **Co-admin status does not transfer between rooms.** If a co-admin
  leaves their room and joins a different one, their co-admin status is
  stripped immediately on leave — they enter the new room as a plain
  participant, same as anyone else.
- **Last-admin protection**: a co-admin (or the owner) **cannot leave
  the room or demote themselves** if doing so would leave the room with
  zero admins/co-admins. Block the action with a clear error — promote
  someone else first. (Two co-admins mutually demoting each other in
  the same moment is a race condition worth a unique-constraint-style
  guard at the DB layer, not just a UI check.)
- **Room password regeneration** only blocks *future* join attempts
  with the old password — participants who already joined keep their
  membership untouched, no re-verification needed.
- **Password format**: admin's choice at room creation (and on
  regenerate) — either type a custom password (**minimum 6
  characters**, case-sensitive — `ABC` ≠ `abc`), or tap "generate" for
  a random one.
- **Broadcasts are room-scoped** — an admin/co-admin's broadcast reaches
  only their own room's participants, never other rooms.
- **No super-admin screen.** The app owner (Dias) has no special
  in-product view across rooms — cross-room visibility, if ever needed,
  happens via direct database access, not a product feature.
- **No "room info/stats" screen for admins** — the Leaderboard already
  covers what's needed; no separate dashboard with member count/
  creation date/etc.
- **Habits are admin-only to create/edit**, same as the existing
  single-tenant model — participants cannot propose or suggest new
  habits; weights are set exclusively by admins/co-admins.
- **Category icons are a fixed global set** (`IQ`/`SQ`/`PQ`/`EQ`), the
  same icons in every room — not customizable per room.
- **Timezone remains fully per-user**, independent of which room
  someone is in — auto-detected via browser, freely changeable,
  unaffected by room membership or room switching (per the earlier
  task list's timezone auto-detect feature, unchanged by this PRD).
- **Reminders pause while a user has no current room** (the brief
  window between leaving one room and joining another) — no reminder
  DMs sent with nothing to log against.
- **CSV export filename includes the room name** (sanitized to a safe
  filename — implementation detail), so admins juggling exports don't
  need to guess which file is which room.
- **Deep-link password sharing**: room password sharing generates a
  Telegram deep link (`t.me/<bot_username>?start=<password>`), same
  pattern as Telegram group invite links — following it pre-fills the
  password and skips straight to the participant registration flow for
  a **brand-new user**. If an **already-registered** user follows
  someone else's room deep link, the bot **ignores the deep-link
  payload entirely** and just shows the normal "you're already
  registered in {room name}" message (§3a) — it does **not** offer to
  switch rooms via deep link (switching rooms, if ever surfaced, stays
  a deliberate explicit action, not a side-effect of clicking a link).
- **Legacy global commands retired**: `/deleteuser` and `/makeadmin`
  (from the pre-multi-room single-tenant era) are **removed entirely**,
  fully superseded by the new room-scoped kick (§3a) and co-admin
  promote/demote (§3a) actions. No global user-management commands
  remain.
- **No pending-registration visibility for admins** — an admin cannot
  see who started but didn't finish joining their room; unfinished
  `pending_registrations` rows are invisible to them, same as today.
- **No permanent ban mechanism** — confirmed, a simple kick (§3a,
  destructive but rejoinable) is sufficient; no separate "banned users"
  list blocking rejoin.
- **No advance warning broadcast** before the data wipe/launch — not
  required, ship without notifying current test users first.
- **No dedicated "which room am I in" command** — `/start`'s
  already-registered response (§3a) and the Mini App header/Settings
  display (§3a) are sufficient; no separate `/myroom` command needed.

## 4. Relationship to the previously-agreed 8-task list

This PRD **supersedes** two items from the earlier (pre-multi-room)
task list and leaves the rest intact, just re-scoped to "per room":

- Superseded: "fixed global admin list with Set/Remove admin buttons in
  Leaderboard" → replaced by room-scoped co-admin promotion (§3 above).
- Superseded: "categories always on, globally fixed IQ/SQ/PQ/EQ" →
  replaced by the per-room on/off toggle (§0/§1 above).
- Unchanged, still apply exactly as previously specified: Today's Total,
  removing Jamaat Total (trivially — it's gone, and the new model never
  reintroduces a cross-room or cross-user group total), two streak
  display types (current/weekly, weekly = calendar week from a
  configurable start day, per-user Settings preference, no live toggle),
  Download button + CSV export, Habits-tab-default / no-Results-tab
  admin layout, fasting reminder as a separate opt-in with the
  pre-pivot Sunday/Wednesday text, and browser-based timezone
  auto-detection with `config.timezone` fallback.

## 5. Suggested build order

**Confirmed with the user**: build multi-room first, as its own
complete phase (all steps below), merged and stable, **before**
starting any of the previously-agreed 8 tasks from the prior task list
— not in parallel. This avoids two sessions/branches fighting over the
same files (registration flow, AdminScreen, schema) at once.

**Confirmed with the user**: current production data (test habits, the
single existing admin account) will be **fully wiped**, not preserved
in any form — this is disposable test data, not real competition
history.

Given the scale (this is a bigger structural change than the original
habits/habit_logs pivot), recommend building in this sequence, each as
its own PR:

1. **Data model**: `rooms` table, `room_id`/`category`/
   `categories_enabled` additions, retire the old global `admins` table
   in favor of room-scoped co-admin status, wipe existing data (this is
   a destructive migration — confirm explicitly before running it on
   the Railway volume, same caution as the recent stale-column
   migration incident).
2. **Registration flow rewrite** (bot): admin-vs-participant branch,
   room creation, password join flow, room switching.
3. **Backend API**: room-scoping on every existing route (progress,
   habits, leaderboard, profile), new room-management endpoints
   (create implicitly via registration, regenerate password, co-admin
   promote/demote, leave room).
4. **Mini App**: category grouping toggle, admin tab restructure with
   room-scoped co-admin management, leave-room in Settings, password
   display/regenerate UI.
5. Fold in the remaining previously-agreed items (Today's Total, streak
   display types, fasting reminder, timezone auto-detect) — these are
   largely orthogonal to the room work and can land before, after, or
   interleaved, per the earlier task list's own sequencing notes.

## 6. Explicitly out of scope for v1

- Changing role after registration (admin → participant or vice versa).
- An admin owning more than one room.
- Permission tiers between main admin and co-admins (all co-admins are
  full-power in v1, including demoting the original owner — see §3a).
- Public room listing/search/discovery.
- Room deletion flow (what happens if the last admin wants to shut down
  a room entirely, as opposed to the last-admin-protection case in §3a
  which only covers *leaving/self-demoting*) — not specified, raise
  with the user if it comes up during implementation rather than
  guessing.
- Rate-limit specifics for wrong-password attempts on room join beyond
  reusing existing `allowRequest` conventions.
- A cap on room size (number of participants) or total number of rooms
  system-wide — no limit specified, treat as unbounded for v1.
- In-product super-admin/cross-room visibility for the app owner (see
  §3a — DB access only).
- Separate "Members" list screen and "room info/stats" dashboard for
  admins — confirmed not needed, Leaderboard covers it.
- Participant-proposed habits — confirmed admin/co-admin-only, no
  participant suggestion mechanism.
- Permanent bans — kicked participants can always rejoin with the
  correct password (see §3a).
