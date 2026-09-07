# Salawat Challenge — Mini App

Telegram Mini App frontend for the Salawat Challenge. Fully replaces the bot's chat commands: registration, logging salawat, progress, and the leaderboard all happen here. Talks to the [`salawat-bot`](https://github.com/dias-jaqsylyq/salawat-bot) backend's HTTP API over HTTPS, authenticated via Telegram `initData` — no separate login.

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
- `src/api/` — fetch client (attaches `Authorization: tma <initData>` to every request) and response types mirroring the backend contract exactly.
- `src/screens/` — Incomplete-registration gate (directs users to bot `/start`), optional real-name completion prompt for legacy users, Log Salawat, My Progress (with Settings), Leaderboard, Admin.
- `src/components/` — `TabBar`, `ProgressBar` (visual width clamped to 100%, numeric label uncapped).
- `App.tsx` — checks `GET /api/progress` on load to decide registration-gate, real-name prompt (`needsRealName`), or main app; holds the tab state and shared progress data.

## Notes / v1 scope
Offline support, group-chat leaderboard embedding, and animations beyond the progress bar are intentionally out of scope (see the spec). Registration, logging, streaks, and reminders run indefinitely; challenge dates are informational except for the Admin-only Mawlid results filter. The Telegram-ID-protected Admin tab supports participant-wide text/link/PDF broadcasts plus live All-time/Mawlid leaderboards and CSV downloads. Settings includes a typed-confirmation progress reset that preserves profile/reminders and can optionally remove the user's retained all-time Jamaat contribution. Settings also has an opt-in Fasting Reminders toggle (Sunday/Wednesday, independent of the daily salawat reminder). Apply `upstream-patches/salawat-bot-fasting-reminders.patch` on `salawat-bot` for the matching scheduler and profile fields. Registration requires a private real name (admin-only; other participants only see the nickname). Existing users without one see a one-time blocking prompt driven by `needsRealName` on `GET /api/progress`. Daily goals and streaks are shown on the Progress screen (backed by `GET /api/progress`). Past days in the last-7 tracker can be toggled as makeup via `PUT /api/day-override` (does not change logged salawat totals). Apply `upstream-patches/salawat-bot-required-real-name.patch` on `salawat-bot` for the matching API.
