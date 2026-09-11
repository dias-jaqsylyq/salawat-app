# Habit Tracker — Mini App

Telegram Mini App frontend for the multi-room habit tracker. One bot serves many independent rooms (competitions); every screen here is scoped to whatever room the caller is currently in — the client never passes a room identifier, the backend resolves it from `initData`. Registration itself stays in the bot chat (it needs the admin/participant branch and the room password). Talks to the [`salawat-bot`](https://github.com/dias-jaqsylyq/salawat-bot) backend's HTTP API over HTTPS, authenticated via Telegram `initData` — no separate login.

## Stack
React + TypeScript + Vite, Tailwind CSS, raw `window.Telegram.WebApp` (no SDK dependency — the app only needs the `initData` string plus basic `ready()`/`expand()` bootstrapping).

## 1. Install
```bash
npm install
```

## 2. Configure the API URL
```bash
cp .env.example .env
```
Set `VITE_API_URL` to the `salawat-bot` backend's public Railway URL (Railway → your service → Settings → Networking → Public Domain), e.g. `https://salawat-bot-production.up.railway.app`.

**Important:** Vite bakes `VITE_API_URL` into the build at build time — it is not read at runtime like the backend's env vars. Changing it always requires a new build/deploy, not just an env var edit.

### Local dev without opening Telegram every time
`window.Telegram.WebApp` (and its `initData`) only exists inside a real Telegram WebView. Running `npm run dev` in a plain browser still renders the UI (there's a dev-only fallback so the app doesn't crash), but every API call will `401` since there's no real signed `initData`.

To test against the real backend from a normal browser: open the deployed Mini App once for real inside Telegram, log `window.Telegram.WebApp.initData` to the console, and paste it into `VITE_DEV_INIT_DATA` in `.env`. It's valid for ~24h (`INIT_DATA_MAX_AGE_SECONDS` on the backend), then needs recapturing.

## 3. Run
```bash
npm run dev       # local dev server
npm run build      # production build → dist/
npm run preview     # preview the production build locally
```

## Deploying to Vercel
1. Push this repo to GitHub, import it into Vercel.
2. Framework preset: **Vite** (auto-detected). Build command `npm run build`, output directory `dist` — Vercel's defaults already match, nothing to change.
3. Project Settings → Environment Variables → add `VITE_API_URL` with the real Railway backend URL. Redeploy after setting it (or it won't be in the build).
4. Once deployed, register the resulting `https://<your-app>.vercel.app` URL as the bot's Web App URL in **BotFather** (`/myapps` → your app → Edit Web App URL). This is what makes `t.me/salawat_challenge_bot/challenge` actually open your deployed app.
5. Set that same URL as `MINI_APP_URL` in the `salawat-bot` Railway service's env vars (currently a placeholder there) and redeploy it, so the bot's chat menu button opens the real app too.

## Structure
- `src/telegram/` — `window.Telegram.WebApp` bootstrapping (`useTelegram` hook) and ambient types.
- `src/api/` — fetch client (attaches `Authorization: tma <initData>` to every request), response types mirroring the backend contract exactly, and the error-code → copy map.
- `src/screens/` — registration gate (directs users to bot `/start`), real-name completion prompt, no-room screen (registered but between rooms), Log Habits, Progress (with Settings), Leaderboard, Admin.
- `src/components/` — `TabBar`, `StreakBadge`, `WeeklyStreakGrid`, `VirtueReminder`, and the admin sections: `AdminHabits`, `AdminResults` (leaderboard + member management), `AdminParticipantRow`, `AdminRoom`.
- `src/lib/` — habit categories (order, labels, `lucide-react` icons, grouping), clipboard copy with a WebView fallback, hijri date, haptics, real-name validation.
- `App.tsx` — checks `GET /api/progress` on load to decide registration gate, real-name prompt (`needsRealName`), no-room state (`room: null`), or main app; holds tab state, shared progress/habits, and room-scoped admin status.

## Notes / v1 scope
**Rooms.** `GET /api/progress` and `GET /api/profile` carry `room: {id, name, categoriesEnabled} | null`. The room name is shown on the Progress header and in Settings. `room: null` means the user is registered but between rooms — the app renders a dedicated screen instead of an empty day, since joining a room needs a password and happens in the bot. Settings has **Leave room** (`POST /api/room/leave`), which keeps the user's logs but detaches them from the room; the server refuses it for a room's last admin (`last_admin`).

**Categories.** When the room has `categoriesEnabled`, the Log screen groups habits by `category` in `SQ → IQ → EQ → PQ` order with fixed `lucide-react` icons, and habits with no category yet fall into a trailing "Uncategorized" group — a room that re-enables categories keeps its old values hidden until an admin re-confirms each habit. With categories off, the list is flat.

**Today's total.** Progress shows *Today* beside *All-time*, both from `GET /api/progress` (`todayPoints` / `totalPoints`). "Today" is the viewer's own calendar day, so it shifts as soon as their timezone does. This is a **personal** figure: the Leaderboard has no counterpart to it, and no group/Jamaat total exists anywhere in the app.

**Streak display.** Settings offers two shapes, saved with the rest of the form rather than toggled live on Progress: *Current* keeps the per-habit `StreakBadge` counts, *Weekly* (the default) draws `WeeklyStreakGrid` from `GET /api/progress/week`. The weekly view is a **flat** list — one row per **active** habit, never grouped by category even in a categories-enabled room — of the seven days of the current calendar week, starting on the day chosen in Settings (default Monday). Each cell is a lit or unlit flame with **no "X of 7" counter**; today's cell is ringed but, like every other cell, is **not tappable** — logging stays on the Log tab, for today only. Days before the member joined the room, and days still ahead this week, are greyed out rather than shown as missed. Switching shapes is purely visual: it recomputes and caches nothing, and at most costs the one extra request the weekly view makes.

**Fasting reminder.** A Settings opt-in (default off) with one time covering both evenings, offered identically to every member of every room — admins included. It is a bot-wide function, not a room setting, and there is no room-level switch for it. The bot's text is a pure nudge about Monday's or Thursday's fast; nothing is logged and no habit is attached.

**Timezone.** Detected once per app open via `Intl.DateTimeFormat().resolvedOptions().timeZone` and pushed to `PATCH /api/profile`, best-effort and silent. It is what both reminders fire by and what every "today" in the app is measured in, falling back to the server's `TIMEZONE` until the first successful detection.

**Admin tab** (rendered only for admins/co-admins of the current room, and re-resolved whenever the room changes; opens on **Habits**): *Posts* (text/link/PDF broadcasts, room-scoped), *Board* (live leaderboard, CSV download, and per-member Make co-admin / Demote / Kick — kicking is destructive and DMs the member), *Habits* (create/edit/deactivate, with a required category picker when the room uses categories), *Room* (password display, regenerate or set your own, `t.me/<bot>?start=<password>` invite link with Copy/Share, and the categories toggle).

Offline support, group-chat leaderboard embedding, room switching from the Mini App (bot-only by design), and any cross-room view are out of scope.
