# SMK TV — Troubleshooting Guide

> One-stop "symptom → cause → fix" reference. When something breaks, find your symptom below.
> Every entry names the exact file(s) involved so you can jump straight to the code.
> Companion docs: [FEATURES-REPORT.md](FEATURES-REPORT.md) (what each feature is), [live-tv-controller-react/PROJECT.md](live-tv-controller-react/PROJECT.md) (deep architecture), [COMMANDS.md](COMMANDS.md) (ops commands).

---

## Quick Index

| Area | Jump to |
|---|---|
| App won't start / ports busy | [§1](#1-startup--ports) |
| Building the EXE fails or exe misbehaves | [§2](#2-exe-build--packaging) |
| Push notifications | [§3](#3-push-notifications-fcm) |
| Public tunnel / phone setup page | [§4](#4-tunnel--remote-setup) |
| YouTube data (monitors, Katha, descriptions) | [§5](#5-youtube-data-live-tv-api) |
| Scheduler triggers | [§6](#6-scheduler) |
| OBS connection & players | [§7](#7-obs--players) |
| Settings / backup / import | [§8](#8-settings-backup--import) |
| HTTPS / SSL certificate | [§9](#9-https--ssl) |

---

## 1. Startup & Ports

### Port map (memorize this)

| Port | What | Defined in |
|---|---|---|
| 3000 | `live-tv-api` YouTube data service | `.env` `API_PORT`, `live-tv-api/server.js` |
| 3004 | Browser-facing UI — Vite in dev, Express in production/EXE | `.env` `VITE_DEV_PORT` / `CONTROLLER_PORT` |
| 3005 | Express API in **dev only** (Vite proxies `/api`, `/videos`, `/ws` to it) | `.env` `CONTROLLER_DEV_PORT`, `server.cjs:33` |
| 3443 | HTTPS server for phone notification setup | `.env` `HTTPS_PORT`, `server.cjs` |
| 4455 | OBS Studio's own WebSocket server | OBS settings; client in `src/context/OBSContext.jsx` |

### "EADDRINUSE" / port already in use

Something is still holding the port. Fix:

```bash
node smk.cjs stop          # stops PM2 + frees all project ports
```

If that doesn't clear it, kill by port manually (see COMMANDS.md → "Stop Everything").

### UI loads but every API call fails (dev mode)

The Vite dev server (3004) is up but the Express API (3005) isn't. `node smk.cjs dev` starts both; if you started Vite by hand, also run `npm run dev:api` inside `live-tv-controller-react/`.

### Every player breaks at once — console flooded with "Unexpected end of JSON input"

**Fixed July 2026.** This meant the whole `server.cjs` process had crashed, not just one feature. Cause: the background HTTPS server (port 3443, phone-setup page) called `.listen()` with no `'error'` handler — if another already-running instance (e.g. the packaged exe) already held port 3443, the resulting unhandled `EADDRINUSE` **event** threw and killed the entire Node process, taking the API server (3005) and WebSocket down with it. Vite (3004) stayed up and returned its own body-less proxy-error 500 for every API call it could no longer reach, which is what surfaced client-side as `SyntaxError: Unexpected end of JSON input` from `state-api.js`/`scheduler-api.js`/`logger.js`, plus Scheduler/Katha Monitor WebSocket errors.

Now handled two ways in `server.cjs`: (1) the HTTPS listen call has a proper error handler and degrades to HTTP-only with a warning instead of crashing, and (2) a process-wide `uncaughtException`/`unhandledRejection` safety net (matching the one already in `live-tv-api/server.js`) keeps the process alive even if some *other* unhandled error shows up elsewhere in the file. If you still see this symptom, check the server console for `[FATAL] Uncaught exception` — it'll now tell you what crashed instead of just going silent.

---

## 2. EXE Build & Packaging

The EXE is built by root `build.cjs` (`npm run build:exe` or `node smk.cjs exe`). Steps: sync `.env` → build React UI → esbuild-bundle `live-tv-api` to CJS → `pkg` everything → move to `windows/exe/SMK TV <N>.exe`.

### Build fails with EBUSY / EPERM moving the exe

OneDrive sync or antivirus is holding the freshly-written exe. `build.cjs` already retries the move 5× and falls back to copy+delete (`build.cjs:84`). If it still fails: pause OneDrive sync, or close a running old exe, then rebuild.

### Exe runs, but push notifications / tunnel silently don't work

The packaged exe reads its environment from **`.env` next to `process.execPath`** (i.e. `windows/exe/.env`), *not* the repo root `.env`. Two separate mechanisms keep that file present:

- `build.cjs` copies the root `.env` into `windows/exe/.env` on every build — helps on the **build machine only**.
- `.env` is also staged into `bundled-bin/` and embedded **inside** the exe, then unpacked next to it on first run by `bundled-sidecars.cjs` — this is what makes a bare exe work on **another PC**. Same mechanism as `yt-dlp.exe` / `cloudflared.exe`.

An existing `.env` next to the exe is never overwritten, so a per-PC override survives upgrades. If you edit the root `.env` **after** building, rebuild (or edit `windows/exe/.env` too).

> The embedded `.env` carries the Firebase service-account private key, and `cookies.txt` carries a live YouTube session. **Treat the exe itself as a secret** — only hand it to machines you trust.

### "It works on my PC but not the other one"

Run **`windows\Setup SMK TV.bat`** on the failing machine. It checks every dependency (bundled payload, `.env` + all three `FIREBASE_*` keys, Node.js ≥20, PO-Token provider, plus a live `/api/notifications/status` probe) and prints exactly what's missing. `.\setup.ps1 -CheckOnly` reports without changing anything.

Historical cause: exe builds up to and including **#57** carried neither `.env` nor `cloudflared.exe`, so a copied exe booted with `Notifications: ❌ NOT ready — Missing env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY` and dropped every push with `[NotificationService] Not ready — skipping`. Everything else (UI, scheduler, players, recording) worked normally, which is why it read as "notifications are broken" rather than "this install has no credentials".

### A fix to a file in `public/` (setup.html, DelayLive.html, players…) doesn't show up in the exe

The exe serves `public/` files from memory via the generated module `live-tv-controller-react/public-assets.cjs`, because `pkg`'s asset globbing is unreliable. That module is regenerated by `generate-public-assets.cjs`, which runs as part of `npm run build:exe`. So: **any `public/` change requires a rebuild** — a running exe never reads the repo files.

### Exe crashes on start with a missing-module error

`pkg` only bundles what it can statically see. Dynamically-required packages must be listed under `pkg.scripts` / `pkg.assets` in `live-tv-controller-react/package.json` (firebase-admin, google-auth-library etc. are already listed). If you add a new server-side dependency that's loaded dynamically, add it there.

### firebase-admin version

Pinned to **`^12.7.0`** (not 14.x) — newer majors broke under `pkg` packaging. Don't bump it without testing an exe build end-to-end.

---

## 3. Push Notifications (FCM)

**Files:** `notification-service.cjs`, `token-store.cjs`, `public/firebase-messaging-sw.js`, `public/setup.html`, `src/components/NotificationSettings.jsx`

### Quick diagnosis

```
GET http://localhost:3004/api/notifications/status
```
Tells you whether Firebase Admin initialized and how many devices are registered.

### "Firebase not initialized" / no notifications ever sent

The three Firebase Admin env vars are missing or malformed in `.env`: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (the private key must keep its `\n` escapes, wrapped in quotes). Running the exe? See [§2 — exe env drift](#exe-runs-but-push-notifications--tunnel-silently-dont-work).

Fastest check on any machine: run `windows\Setup SMK TV.bat`, or read the startup banner — it prints `Notifications: ✅ ready` / `❌ NOT ready — <reason>` on every boot, and `server.cjs` logs `[Env] No FIREBASE_* credentials loaded (looked in …)` when the file itself never turned up.

### What the notification feature actually depends on

| Layer | Dependency | Ships how |
|---|---|---|
| Server push | `firebase-admin` ^12.7.0 (+ `google-auth-library`, `gtoken`, `gaxios`) | inside the exe (listed in `pkg.scripts`) |
| Credentials | `FIREBASE_PROJECT_ID` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` | `.env`, embedded in `bundled-bin/` |
| Browser SDK | `firebase` ^12.15.0 (`firebase/app`, `firebase/messaging`) | compiled into `dist/` at build time |
| Browser config | `VITE_FIREBASE_*` incl. `VITE_FIREBASE_VAPID_KEY` | baked into `dist/` at build time — editing `.env` on the target PC does **not** change these |
| Delivery | `public/firebase-messaging-sw.js` (plain Web Push SW, no CDN) | `public-assets.cjs`, inside the exe |
| Secure context | `selfsigned` → LAN HTTPS on 3443 | inside the exe |
| Remote pairing | `cloudflared` ^0.7.1 + `cloudflared.exe` | embedded in `bundled-bin/` |
| QR pairing | `qrcode` ^1.5.4 | inside the exe |
| Transport | `express`, `ws` | inside the exe |

Nothing here needs a runtime installed on the target PC — the exe carries its own Node.js 20. (Node.js on PATH is only needed by the separate PO-Token provider, which has nothing to do with notifications.)

### Notifications work on one PC but not another, and credentials check out

Device registrations are **per install**: each app folder has its own `data/fcm-tokens.json`. A phone paired against the first PC is unknown to the second one — `/api/notifications/status` will report `ready: true` with `activeDevices: 0`. Re-scan the QR from the second install's Notifications panel.

### Test notification says it failed with an FCM error

This is working as intended (fixed in July 2026): `notification-service.cjs` `sendTest()` now **throws** when FCM rejects the token instead of reporting success, and the error includes FCM's real message (e.g. `app/invalid-credential` plus the underlying cause). Common causes:
- **`app/invalid-credential`** — wrong/rotated service-account key in `.env`. Regenerate a private key in Firebase Console → Service Accounts.
- **`messaging/registration-token-not-registered`** — the device token expired or the user cleared site data. Re-register the phone via `/setup`. The service auto-prunes such tokens on normal sends.

### Phone got a "did not run" notification for a schedule

`⚠ <Schedule> did not run` is the **confirm-before-notify** flow doing its job. For `show`/`hide` schedules the server holds the push until the frontend confirms OBS actually applied the change (`server.cjs` → `awaitTriggerConfirmation`, 130 s timeout). You get the failure variant when:
- No browser tab with the controller UI was open (nothing could talk to OBS) — the notification body says "No confirmation from the app within 130s".
- OBS was disconnected or the source name wasn't found — the body carries the exact reason reported by `Scheduler.jsx`.
- The trigger was skipped because the Live Player was active (deliberate guard in `Scheduler.jsx`).

Success pushes for show/hide only fire after OBS's own `RequestResponse` confirmed the change (`OBSContext.jsx` → `setSourceVisibilityConfirmed`). Non-OBS actions (`katha_refresh`, `katha_player`, `local_player_*`) still notify immediately — they have no confirmation path.

### Deleting a device from the in-app list does nothing

Fixed: `NotificationSettings.jsx` now deletes by `deviceId` (the devices API intentionally never exposes raw tokens), and only removes the row after the server confirms. `DELETE /api/notifications/register` accepts `{ token }` **or** `{ deviceId }`.

### Notifications work on PC but not on the phone

Web Push needs a secure context. The phone must have opened `/setup` over **HTTPS** — either the tunnel URL (trusted cert) or `https://<lan-ip>:3443/setup` (self-signed; the phone must accept the warning). Also check: Android Settings → Apps → Chrome → Notifications ON, and Chrome → Site settings → Notifications → allowed for the site.

---

## 4. Tunnel & Remote Setup

**File:** `tunnel-manager.cjs` (localtunnel wrapper)

### Tunnel URL opens to a 502/503 or "offline" page while the app says "Tunnel active"

Known localtunnel free-tier failure: the client stays "connected" to the control server while the public edge is dead, and no `close`/`error` event fires. Handled since July 2026:
- A health check polls `<tunnel-url>/setup` every 45 s; **two consecutive failures force a reconnect** (`tunnel-manager.cjs` → `checkTunnelHealth`).
- `GET /api/notifications/setup-url` (the QR-code endpoint) live-verifies the tunnel before preferring it; if dead it falls back to the LAN HTTPS URL and kicks `forceReconnect()` in the background.

If you hit a dead tunnel link, just re-open the QR/setup dialog — it will hand out a working URL.

### Only the LAN IP shows up, never a tunnel URL

At startup `tunnel-manager.cjs` tries to connect 3 times a few seconds apart; if loca.lt is briefly unreachable during that window (slow boot network, DNS not up yet) it used to give up permanently and require a manual "Retry connection" click in Notification Settings. Fixed: after those 3 attempts fail, it now keeps retrying automatically every 30 s in the background until it connects — no manual step, no `npx` required (the exe bundles the `localtunnel` package directly; the app never shells out to `npx`). If a `windows/exe/SMK TV <N>.exe` still shows only the IP, it predates this fix — rebuild with `npm run build:exe` and run the newest numbered exe.

### Tunnel keeps getting a random subdomain

The requested subdomain (from `.env`) was taken; localtunnel hands out a random one and logs a warning. Phones registered against the old URL must re-register — push tokens are origin-independent, but the `/setup` bookmark changes.

### `TUNNEL_URL` in `.env` looks stale

`tunnel-manager.cjs` patches `TUNNEL_URL` into `.env` on every successful connect and clears `process.env.TUNNEL_URL` on drop. Treat it as machine-managed — don't hand-edit it while the app is running.

---

## 5. YouTube Data (`live-tv-api`)

**Files:** `live-tv-api/server.js`, `live-tv-api/lib/youtube.js`

When YouTube changes its page structure, **`lib/youtube.js` is the only file you edit** (see `live-tv-api/DEPLOY.md`). Data fetching is a 3-layer waterfall: Piped → YouTube HTML scrape → RSS.

### Monitors show nothing / `"source": "rss"` in responses

Piped instances and the HTML scrape both failed; RSS is the last resort and **can't detect live/upcoming status**. Usually transient. If persistent, the scrape parser in `lib/youtube.js` needs updating for YouTube's new HTML.

### Katha Monitor / Delay keyword-skip can't fetch descriptions; server logs show HTTP 429

Your IP got rate-limited by YouTube (the Google "sorry" page). Hardened in July 2026 (`live-tv-api/server.js`):
- Descriptions are served from a **6-hour in-memory cache**.
- At most **3 concurrent** watch-page fetches (Katha Monitor requests 30 at once — this used to trigger the block).
- Primary source is now the **innertube API** (`youtubei/v1/player` JSON call) which keeps working even when the watch page is 429-blocked; the HTML scrape is only the fallback.
- On a 429, the scrape path backs off for **5 minutes**; expired cache entries are served (`stale: true`) rather than failing.

If you still see 429s, wait out the cooldown — hammering it extends the block.

### `/api/video-description` returns empty description

The video genuinely has none, or both innertube and the scrape failed with no cache. Check the response for `stale`/`cached` flags and the server log for `[Description]` warnings.

---

## 6. Scheduler

**Files:** `scheduler-service.cjs` (engine), `src/components/Scheduler.jsx` (executor), `src/utils/scheduler-api.js`

### A schedule didn't fire

Check in this order:
1. **Scheduler running?** `GET /api/scheduler/status`.
2. **Schedule enabled?** Disabled and "skip next occurrence" states are visible in the UI.
3. **Was a browser tab open?** `show`/`hide` actions are *executed by the frontend* (it owns the OBS connection). The server fires the trigger over WebSocket; with no client connected, nothing can flip the OBS source. You'll get a `SCHEDULER_TRIGGER_FAILED` push after 130 s (see [§3](#phone-got-a-did-not-run-notification-for-a-schedule)).
4. **Was OBS connected?** Disconnected → the trigger is queued and replayed when OBS reconnects, but only for **2 minutes** (`OBS_TRIGGER_EXPIRY_MS` in `Scheduler.jsx`), then dropped and reported as failed.
5. **Was Live Player active?** Triggers are deliberately skipped while the Live Player is visible (guard in `Scheduler.jsx`), and reported as skipped.
6. **Alerts & history:** `GET /api/scheduler/alerts`, `GET /api/scheduler/history` — missed triggers, retries (3× with 5 s delay), and catch-up-on-restart behavior are all logged.

### Trigger fired but OBS didn't change

Look for `SCHEDULER_TRIGGER_OBS_REJECTED` in the logs — the frontend now waits for OBS's own `RequestResponse` (`setSourceVisibilityConfirmed`) instead of fire-and-forget, so the reason (source not found, OBS rejected the request, timeout) is captured in the log entry and in the failure push notification.

### Countdown list in the UI misses schedules

Fixed: `SCHEDULER_TICK` now includes next-trigger info for **all** schedules, not the first 10 (`server.cjs`).

---

## 7. OBS & Players

### Nothing happens when clicking player controls

The React card and the OBS Browser Source communicate via `localStorage` events, which only works when **both are the same origin**. The OBS Browser Source URL must point at the same host:port the control panel is open on (e.g. `http://localhost:3004/DelayLive.html`). Different port ⇒ different origin ⇒ commands never arrive.

### Source switched but shows a warning ring in the control panel

The playback health check waited 8 s for a `timeUpdate` event from the player page and got none — the switch happened but the player isn't actually playing (bad video ID, embed-blocked video, YouTube error). Check the OBS Browser Source's page (Interact) for the actual error.

### Delay Live "skip section by keyword" plays the section anyway

Flow: `DelayPlayerCard.jsx` fetches the video description from `live-tv-api` (`/api/video-description`), finds lines whose timestamp text contains a keyword, and sends the computed skip ranges to `DelayLive.html` via a `setSkipRanges` command. Failure modes:
- **Description fetch failed** (live-tv-api down, or rate-limited — see [§5](#5-youtube-data-live-tv-api)) → status text says "Description fetch failed … playing full video".
- **Keyword not on a timestamp line** → "Keyword not found in description — playing full video". Matching is case-insensitive but the keyword must appear on the same description line as a `H:MM(:SS)` timestamp; both "12:34 Kirtan" and "Kirtan 12:34" orderings work.
- Ranges run from the keyword's timestamp to the **next** timestamp in the description; if the keyword is the last timestamp, the video finishes there (treated like reaching End Time).
- Skip ranges are cleared on every `loadVideo` and re-sent by the card — if you reload manually inside `DelayLive.html`, ranges are gone by design.

### OBS keeps disconnecting/reconnecting

`OBSContext.jsx` reconnects with exponential backoff (5 s → 60 s). Check the OBS WebSocket server is enabled (OBS → Tools → WebSocket Server Settings), and that host/port/password in the app's Settings panel match.

---

## 8. Settings, Backup & Import

### Import / restore silently loses data, or the request fails with 413

Fixed: the Express JSON body limit is now **100 MB** (`server.cjs` — `express.json({ limit: '100mb' })`). Very large loop-player playlists (50k+ IDs) used to exceed the 100 kb default and get 413-rejected. If you see 413 again, something re-introduced a smaller limit.

### Where is everything stored?

All persistence is atomic-write JSON (write `.tmp` → validate → rename, keep `.bak`):

| Data | File |
|---|---|
| Schedules | `data/schedules.json` |
| App/server state | `data/app-state.json` |
| FCM device tokens | `data/fcm-tokens.json` |
| Notification history | `data/notification-history.json` |
| SSL cert/key/meta | `data/ssl-*.pem`, `data/ssl-meta.json` |
| Logs (monthly) | `logs/logs-YYYY-MM.json` |
| Backups | `backups/`, `backups/auto_backup/` |

In the exe, all these folders live **next to the exe file**.

If a JSON store gets corrupted, restore from its `.bak` neighbor or from `backups/`.

---

## 9. HTTPS / SSL

**File:** `cert-manager.cjs`

### Phone shows a certificate warning on `https://<ip>:3443/setup`

Expected — the LAN cert is self-signed. Accept the warning, or use the tunnel URL instead (real trusted cert). The cert's SANs cover every detected LAN IP + localhost, and it's regenerated automatically when the LAN IP list changes (cached in `data/ssl-*.pem`, tracked in `ssl-meta.json`).

### HTTPS server didn't start

Check the startup log for `[HTTPS]` lines. Cert generation failures are logged but never crash the main HTTP server — the app degrades to HTTP-only (notifications setup on phones won't work until fixed).

---

## Reading the logs

- **Server console / PM2:** `node smk.cjs logs` or `pm2 logs smk-controller` / `smk-api`. Prefixed tags: `[Tunnel]`, `[HTTPS]`, `[NotificationService]`, `[Description]`, `[WebSocket]`, `[Scheduler]`.
- **Structured app logs:** Log Viewer panel in the UI, or `logs/logs-YYYY-MM.json`. Categories: `obs`, `video`, `scheduler`, `monitor`, `katha`, `system`. Key types when debugging triggers: `SCHEDULER_TRIGGER_EXECUTING`, `SCHEDULER_TRIGGER_OBS_REJECTED`, `SCHEDULER_SOURCE_NOT_FOUND`.
