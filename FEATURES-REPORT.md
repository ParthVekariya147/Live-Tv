# SMK TV — Live TV Controller — Full Feature Report

> One-file reference: what the project does, every feature, how each one works internally, and where its code lives.
> Generated: 2026-07-01 · Last updated: 2026-07-14 (confirm-before-notify scheduler flow, Delay Player keyword skip, tunnel health checks, YouTube description caching)
> When something is broken, start with [TROUBLESHOOTING.md](TROUBLESHOOTING.md) instead.

---

## 1. Project Summary

**SMK TV (Live TV Controller)** is a full-stack, single-operator desktop application used to run a religious broadcast channel (Swaminarayan / Katha content) on YouTube via **OBS Studio**. One person (the "operator") uses a browser-based control panel to:

- Switch between four video sources (looping background, live stream, delayed/windowed playback, local file playlist) inside OBS
- Auto-detect when the channel's YouTube live stream goes live, or when a new Katha (discourse) video is uploaded, and load it into the player with one click
- Schedule automatic source switches at specific times of day (e.g. "show Live Player at 07:30 every weekday")
- Record the live broadcast to disk and manage recording files
- Back up and restore all settings
- Get push notifications (desktop + phone) about scheduler events, recordings, backups, and detected live streams — even when the control-panel browser tab isn't open
- Package everything into a single Windows `.exe` so it can run without Node.js installed

It is **not** a multi-tenant SaaS product — it's an internal broadcast-operations tool for one organization, designed to run on one Windows PC on a LAN.

### Monorepo layout

```
Live-Tv/                              ← git root
├── live-tv-api/                      Standalone YouTube data-scraping service (port 3000)
├── live-tv-controller-react/         Main app: React UI + Express + WebSocket (port 3003/3004)
├── smk.cjs, smk-launcher.cjs         CLI launcher (dev/build/exe/start/stop via PM2)
├── build.cjs                         Windows EXE build pipeline
├── ecosystem.config.cjs              PM2 process definitions (production)
├── env-loader.cjs                    Shared .env loader used by all services
├── .env / .env.example               Single shared environment config for all services
├── windows/ , mac/                   Per-OS launcher scripts and EXE output folder
├── COMMANDS.md                       Ops cheat-sheet (ports, PM2, kill commands)
├── FCM-PUSH-NOTIFICATIONS.md         Design doc for the push-notification feature
└── FCM-PARALLEL-PLAN.md              Implementation plan for the same feature
```

### Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19.2, Vite 7.2, Tailwind CSS 3.4 |
| Backend | Node.js 18+, Express 4.18, `ws` 8.19 (WebSocket) |
| Persistence | Atomic JSON files on disk — **no database** |
| Push notifications | Firebase Admin SDK (FCM HTTP v1), native Web Push service worker |
| Remote access | `localtunnel` (public HTTPS tunnel), self-signed LAN SSL cert |
| External integrations | OBS WebSocket v5, YouTube (scraping — no official API key), `xlsx` for playlist import |
| Packaging | `vite build` → `pkg`/`@yao-pkg/pkg` → single Windows `.exe`; PM2 for production process management |

### Ports

| Service | Port | Purpose |
|---|---|---|
| `live-tv-api` | 3000 | YouTube data proxy (live streams, upcoming events, Katha videos, descriptions) |
| `live-tv-controller-react` (dev UI) | 3004 | Vite dev server, proxies to 3005 |
| `live-tv-controller-react` (dev API) | 3005 | Express + WebSocket (dev only) |
| `live-tv-controller-react` (production) | 3004 (`CONTROLLER_PORT`) | Single Express server serves UI + API + WebSocket — same port as the dev UI, so OBS Browser Source URLs never change |
| HTTPS (mobile notification setup) | `HTTPS_PORT` (see server.cjs) | Self-signed cert server, needed because push notifications require a secure context on phones |

---

## 2. Feature Directory (quick index)

| # | Feature | Primary file(s) |
|---|---|---|
| 1 | OBS Integration & Control | `src/context/OBSContext.jsx`, `src/components/OBSControlPanel.jsx` |
| 2 | Loop Player | `src/components/LoopPlayerCard.jsx`, `public/LoopPlayer.html` |
| 3 | Live Player + Recording Manager | `src/components/LivePlayerCard.jsx`, `public/LivePlayer.html` |
| 4 | Delay Live Player | `src/components/DelayPlayerCard.jsx`, `public/DelayLive.html` |
| 5 | Local PC Player | `src/components/LocalPlayerCard.jsx`, `public/LocalPCPlayer.html` |
| 6 | Scheduler (server-side cron-like engine) | `scheduler-service.cjs`, `src/components/Scheduler.jsx`, `src/utils/scheduler-api.js` |
| 7 | Live Stream Monitor (2 channels) | `src/components/MonitorManager.jsx`, `MonitorCard.jsx` |
| 8 | Katha (discourse) Monitor | `src/components/KathaMonitor.jsx` |
| 9 | Upcoming Event Monitor | `src/components/UpcomingEventMonitor.jsx` |
| 10 | Settings Export/Import + Server Backups | `src/components/SettingsBackup.jsx`, backup endpoints in `server.cjs` |
| 11 | Structured Logging & Log Viewer | `src/utils/logger.js`, `src/components/LogViewer.jsx` |
| 12 | Push Notifications (FCM) | `notification-service.cjs`, `token-store.cjs`, `public/firebase-messaging-sw.js`, `public/setup.html` |
| 13 | SSL Certificate Manager | `cert-manager.cjs` |
| 14 | LAN IP Detection | `ip-detector.cjs` |
| 15 | Public Remote Tunnel | `tunnel-manager.cjs` |
| 16 | Static Asset Bundling (for EXE) | `public-assets.cjs`, `generate-public-assets.cjs` |
| 17 | YouTube Data Service (separate microservice) | `live-tv-api/server.js`, `live-tv-api/api/*.js`, `live-tv-api/lib/youtube.js` |
| 18 | Playlist Import (txt/csv/xlsx) | `LoopPlayerCard.jsx` (uses `xlsx` lib), `sample-files/` |
| 19 | Launcher / Build / Process Manager | `smk.cjs`, `smk-launcher.cjs`, `build.cjs`, `ecosystem.config.cjs` |
| 20 | State Persistence Service | `state-service.cjs` |
| 21 | Live Stream Recording (yt-dlp) | `server.cjs` (`/api/recording/*`), `src/components/LivePlayerCard.jsx` |
| 22 | Notification Settings UI + Foreground FCM | `src/components/NotificationSettings.jsx`, `src/services/fcm.js`, `src/firebase-config.js` |
| 23 | OBS Preview & Build Info Footer | `src/components/PreviewBox.jsx`, `src/components/BuildFooter.jsx` |
| 24 | Custom Time Picker (no AM/PM segments) | `src/components/common/TimePickerAMPM.jsx` |

---

## 3. OBS Integration

**Files:** `src/context/OBSContext.jsx`, `src/components/OBSControlPanel.jsx`

**How it works:** The React app connects directly from the browser to OBS Studio's built-in WebSocket server (protocol v5, default `ws://localhost:4455`). Host/port are configurable in Settings and saved to `localStorage['obsSettings']`.

The app assumes a single OBS scene called `"Scene"` with 5 sources it manages by name: `Loop Player`, `Live Player`, `Delay Live`, `Local Player`, `OrdaChesta`. Visibility is toggled with the `SetSceneItemEnabled` request. `OBSContext` polls scene/stream/record/virtual-cam status every second and also reacts to OBS's own WebSocket events, so state stays accurate even if something is changed directly inside OBS. If the connection drops, it reconnects with exponential backoff (5s → 60s).

`OBSControlPanel` exposes: Start/Stop Stream, Start/Stop Recording (OBS's own scene recorder — distinct from the yt-dlp-based Live Player recording, see §4.2), Toggle Virtual Camera, an **Auto-Record** master toggle, a one-click Live↔Loop swap button, monitor show/hide buttons, a live clock, and the connection settings form.

**Source exclusivity:** turning a source ON automatically turns every other managed source OFF — only one of Loop/Live/Delay/Local can be visible at a time.

**Playback health check:** after switching a source visible, the panel waits up to 8 seconds for a `timeUpdate` storage event from that player's HTML page as proof it's actually playing. A spinner shows while waiting; if no `timeUpdate` arrives in time, a warning ring is shown instead so the operator notices a silently-failed switch (e.g. broken video ID) instead of assuming it's live.

---

## 4. Player System

All four player cards follow the same communication pattern: the React card is the "remote control," and a matching static HTML page (opened inside OBS as a Browser Source) is the actual player.

```
React PlayerCard  →  localStorage.setItem(commandKey, JSON.stringify(cmd))
                      (removed again after 100ms so the same command can re-fire)
        ↓ (storage event — same-origin tabs share localStorage)
OBS Browser Source HTML page  →  YouTube IFrame API / <video> element
```

This gives zero-latency, server-free IPC between the control UI and the actual on-air players, because OBS Browser Sources and the control-panel tab are the same origin (`localhost:3004`).

### 4.1 Loop Player
`src/components/LoopPlayerCard.jsx` + `public/LoopPlayer.html`
Always-on background/fallback source. Takes a comma-separated list of YouTube video IDs (or import from `.txt`, `.csv`, or `.xlsx` — see [§10 Playlist Import](#10-playlist-import)) and loops through them forever, auto-advancing when a video ends. Supports jump-to-index, play/pause/stop/next/prev, and shows title/thumbnail via YouTube's oEmbed API. State persists to `localStorage['loopPlayerState']`.

### 4.2 Live Player
`src/components/LivePlayerCard.jsx` + `public/LivePlayer.html`
Plays a single YouTube video ID — normally the actual live broadcast. Can be auto-populated by the Live Monitor when it detects a matching stream. When the video ends, it automatically switches OBS back to the Loop Player.

**Recording is *not* OBS's built-in recorder.** The "Auto-Record" toggle here spawns a separate **`yt-dlp` subprocess** on the server that downloads the actual YouTube live stream directly to `live_recordings/` (`server.cjs`: `POST /api/recording/start`, `GET /api/recording/status` — polled every ~2s by the UI, `POST /api/recording/stop`, `GET /api/recording/list`, `DELETE /api/recording/:filename`, `GET/PUT /api/recording/settings` for auto-delete-after-N-files, `POST /api/recording/open-folder`). It starts automatically when the Live Player source becomes visible and stops when hidden (tracked via a `wasAutoStarted` flag so it never stops a manually-started recording). `yt-dlp.exe` must sit next to the packaged `.exe` in production — the server looks for it there first. This is entirely separate from OBS's own Start/Stop Recording button in `OBSControlPanel` (which records whatever the OBS scene/canvas is showing, not the raw YouTube stream). On page unload, the browser fires `navigator.sendBeacon()` to stop the recording server-side, preventing an orphaned `yt-dlp` process.

### 4.3 Delay Live Player
`src/components/DelayPlayerCard.jsx` + `public/DelayLive.html`
Plays a YouTube video ID starting at a specific timestamp and stopping at another — used to air a segment with a custom in/out window (e.g. skip a video's intro, or delay a live feed). On end, hides itself and falls back to Loop Player if Live Player isn't currently visible.

**Skip section by keyword** (added July 2026): a checkbox + comma-separated keyword input on the card. On Load & Play, the card fetches the video's description from `live-tv-api` (`/api/video-description`), scans description lines that carry a `H:MM(:SS)` timestamp, and for each keyword found builds a skip range from that line's timestamp to the *next* timestamp in the description (if the keyword sits on the last timestamp, the video simply finishes there). Overlapping ranges are merged, then sent to `DelayLive.html` as a `setSkipRanges` player command; the player's 1-second watcher seeks over any range it enters, so the section is never shown on air. Everything is best-effort and non-blocking — if the description fetch fails or no keyword matches, the video plays in full and the card's status line says why. The checkbox + keywords persist in `localStorage['delayPlayerState']`.

### 4.4 Local PC Player
`src/components/LocalPlayerCard.jsx` + `public/LocalPCPlayer.html`
Plays a playlist of local video files (mp4/mkv/avi/mov/webm/wmv) — used for pre-recorded Katha content. Supports: auto-scanning the default `videos/` folder (`GET /api/videos/scan`), scanning any custom Windows folder path (`POST /api/videos/scan-folder`), drag-and-drop from Explorer, a native file picker, manual path entry, drag-to-reorder, per-item enable/disable (disabled items are skipped automatically, even mid-playback), per-item start/end time trimming (`H:MM` format), and a per-day-of-week "what to switch to when the playlist ends" action. All local files are streamed through a proxy endpoint rather than `file://` URLs:
```
GET /api/videos/serve?path=<url-encoded absolute path>
```
This supports HTTP Range requests (required for `<video>` seeking) and avoids browser CORS restrictions on local files. The Scheduler can also remotely trigger `local_player_start` / `stop` / `next` on this player via WebSocket.

---

## 5. Scheduler System

**Files:** `scheduler-service.cjs` (server), `src/components/Scheduler.jsx` + `src/utils/scheduler-api.js` (client)

**Why server-side:** Browser timers throttle to ~1Hz when a tab is hidden/minimized, which would cause a 07:30 trigger to be missed. Instead, `scheduler-service.cjs` runs a 1-second tick loop **inside the Express server itself**, independent of any browser tab, and persists schedules to `data/schedules.json`.

Each schedule has: title, time (`HH:MM`), target OBS source, action (`show`/`hide`/`local_player_start`/`local_player_stop`/`local_player_next`), recurrence (`daily` / `weekly` with specific weekdays / `once`), enabled flag, and `lastTriggered`. On server restart, any schedule whose expected trigger time has already passed (and hasn't fired) is caught up immediately. Failed triggers retry up to 3 times with a 5-second delay; after repeated failures an alert is broadcast over WebSocket and (if configured) pushed as a notification. The last 100 executions and running totals (`totalTriggers`, `totalMissed`, `totalSkipped`, `totalRetries`) are kept for the Scheduler UI's health view. Individual schedules can also be "skipped" for their next occurrence only.

The React `Scheduler.jsx` component connects to the server's WebSocket, receives `SCHEDULER_TICK` (for countdowns — since July 2026 it carries next-trigger info for *all* schedules, not just 10) and `SCHEDULER_TRIGGER` (executes the actual OBS visibility change or Local Player command), and manages CRUD for schedules via REST. Besides `show`/`hide` and `local_player_start/stop/next`, the Katha Monitor registers its own `katha_refresh` and `katha_player` actions.

**Confirm-before-notify (added July 2026):** for `show`/`hide` triggers, the push notification is no longer sent the instant the timer matches. Instead:

1. The frontend executes the OBS change via `setSourceVisibilityConfirmed()` (`OBSContext.jsx`), which waits for OBS's own `RequestResponse` (op 7) instead of firing blind.
2. It reports the real outcome back with `reportTriggerResult()` (`scheduler-api.js`) — over the WebSocket as a `TRIGGER_RESULT` message, or `POST /api/scheduler/trigger-result` as a REST fallback if the socket is down.
3. The server (`server.cjs` → `awaitTriggerConfirmation`) holds the notification until that report arrives: success → normal `SCHEDULER_TRIGGER` push; failure or skip (OBS disconnected, source missing, Live Player active) → a `SCHEDULER_TRIGGER_FAILED` push with the concrete reason.
4. If nothing reports back within **130 s** (browser closed, tab dead, OBS never reconnected — deliberately longer than the frontend's 2-minute trigger-replay window), the server sends the failure push anyway, so a silent no-op never looks like a successful run.

Non-OBS actions (`katha_refresh`, `katha_player`, `local_player_*`) have no confirmation path and notify immediately as before.

---

## 6. Monitor System

### 6.1 Live Stream Monitor
`src/components/MonitorManager.jsx` + `MonitorCard.jsx`
Watches two YouTube channels (Swaminarayan main channel + Swaminarayan Bhagwan) for live or upcoming streams, polling every 30 seconds through the separate `live-tv-api` service (avoids CORS / needing an API key). Each monitor card can hold saved search terms — if a live/upcoming video's title matches, it's auto-loaded into the Live Player with one click. Shows a countdown to scheduled start times for upcoming/premiere streams.

### 6.2 Katha Monitor
`src/components/KathaMonitor.jsx`
Looks for today's (or yesterday's/auto) Katha discourse video upload on a channel, then fetches the video's **description** (via `live-tv-api`'s `/api/video-description`) to regex-extract the "Mangla Charan" timestamp — the exact point the actual discourse begins, after intro music/ceremony. One click loads that video into Loop or Live Player pre-seeked to that timestamp.

### 6.3 Upcoming Event Monitor
`src/components/UpcomingEventMonitor.jsx`
Displays scheduled/premiere YouTube events with a live countdown, sharing data already fetched by the Live Monitor.

---

## 7. Settings, Backup & Logging

### 7.1 Settings Export/Import + Server Backups
`src/components/SettingsBackup.jsx`
"Export" bundles server state (`GET /api/settings/export`), every relevant `localStorage` key, and all schedules into one downloadable `.json` — used to migrate to a new machine or restore after reinstall. "Import" restores it via `POST /api/settings/import`. Separately, the server keeps its own automatic + manual backups as JSON files in `backups/` (see the `backups/auto_backup/` folder already present in this repo), configurable to run every N hours/days or on a specific weekday, managed through `/api/backups/*` endpoints.

### 7.2 Logging
`src/utils/logger.js` + `src/components/LogViewer.jsx`
Every meaningful event (OBS source changes, video load/play/end/error, scheduler triggers/alerts, monitor refreshes, Katha detections, system errors) is written as a structured JSON entry to a monthly file `logs/logs-YYYY-MM.json`. `LogViewer.jsx` gives paginated browsing, filter by month/category/type/text, bulk delete, CSV export, and auto-refresh.

---

## 8. Push Notification System (FCM)

**Files:** `notification-service.cjs`, `token-store.cjs`, `public/firebase-messaging-sw.js`, `public/setup.html`, `ip-detector.cjs`, `cert-manager.cjs`, `tunnel-manager.cjs`

This is the newest feature set (added in the latest commit, alongside SSL and the EBUSY build fix). It lets the operator get real push notifications on their phone/desktop for scheduler triggers/alerts, recording start/stop/error, backup completion, memory warnings, and detected live streams — **without needing the control-panel tab open**.

**How it's wired together:**

1. **Device registration** — A phone/browser visits `GET /setup` (served by `server.cjs`), which shows `public/setup.html`. That page registers a Web Push subscription and posts the resulting FCM token to `POST /api/notifications/register` (`server.cjs` → `token-store.cjs`). Tokens are stored in `data/fcm-tokens.json` with atomic write + `.bak` recovery (same pattern as `state-service.cjs`). Max token count is capped (`MAX_FCM_TOKENS`, default 50); oldest inactive tokens are evicted first.
2. **Sending a notification** — Application code calls `notificationService.send(eventName, data)` (see call sites in `server.cjs` around scheduler trigger/alert handling). `notification-service.cjs` looks up a message template for the event (`SCHEDULER_TRIGGER`, `SCHEDULER_TRIGGER_FAILED`, `SCHEDULER_ALERT`, `RECORDING_STARTED/STOPPED/ERROR`, `BACKUP_COMPLETED`, `MEMORY_WARNING`, `MONITOR_LIVE`), checks per-event on/off preferences (read from `data/app-state.json`), then sends via Firebase Admin SDK's `sendEachForMulticast` (chunked at 500 tokens/call) to every active device token. Failed/expired tokens are automatically pruned from the store. Every send is appended to a rolling history (`data/notification-history.json`, capped at 500 entries, only if `NOTIFICATION_HISTORY=true`).
3. **Receiving on the device** — `public/firebase-messaging-sw.js` is a plain service worker (not the Firebase JS SDK, to avoid depending on `gstatic.com` availability) that listens for the raw `push` event, shows a native OS notification, and focuses/opens the app tab on click.
4. **Why HTTPS matters** — Web Push and service workers require a secure context. Since this app normally runs on plain `http://localhost`, `cert-manager.cjs` generates a self-signed certificate (`selfsigned` package) whose Subject Alternative Names cover every current LAN IP address (via `ip-detector.cjs`) plus `localhost`/`127.0.0.1`. `server.cjs` starts a parallel `https` server with that cert so phones on the same LAN can load `/setup` over HTTPS and accept push permission. The cert is cached in `data/ssl-*.pem` and only regenerated if the LAN IP list changes.
5. **Off-LAN access** — `tunnel-manager.cjs` optionally starts a public `localtunnel` on server boot, writes the resulting HTTPS URL into the shared `.env` as `TUNNEL_URL`, and auto-reconnects if the tunnel drops (localtunnel's free tier is flaky). This lets `/setup` be reached from outside the LAN (e.g. mobile data) without port-forwarding. Because the localtunnel client can stay "connected" while the public edge answers 502/503 (no close/error event fires), the manager also **polls the real public URL every 45 s** — two consecutive failures force a reconnect (`checkTunnelHealth` / `forceReconnect` exports). `GET /api/notifications/setup-url` performs the same live check before handing out the tunnel URL in the QR code, falling back to the LAN HTTPS URL if the tunnel is dead.
6. **Honest test sends** — `sendTest()` throws when FCM rejects the token (surfacing FCM's real error code *and* message, e.g. the cause behind `app/invalid-credential`), so the setup page and in-app "send test" button show real failures instead of a false success.

**Notification API surface** (all in `server.cjs`):

| Endpoint | Purpose |
|---|---|
| `GET /setup` | Serves the mobile/device registration page |
| `POST /api/notifications/register` | Register/refresh a device's FCM token |
| `DELETE /api/notifications/register` | Remove a device — accepts `{ token }` (setup page) or `{ deviceId }` (in-app UI, which never sees raw tokens) |
| `GET /api/notifications/devices` | List registered devices (token itself excluded from response) |
| `POST /api/notifications/test` | Send a test push to an arbitrary token |
| `POST /api/notifications/test-device` | Send a test push to a specific registered device by id |
| `GET /api/notifications/history` | Paginated send history |
| `GET` / `PUT /api/notifications/settings` | Read/update per-event notification on/off preferences |
| `GET /api/notifications/setup-url` | Returns the QR code + URL(s) to open `/setup` (LAN IPs or tunnel URL) |
| `GET /api/notifications/status` | Diagnostic — is Firebase Admin initialized, how many devices |

Notification routes can optionally be locked behind a shared secret (`server.cjs` ~line 1782 applies middleware to all `/api/notifications/*` routes when configured).

**Required environment variables** (Firebase Admin credentials — see `.env.example` and `FCM-PARALLEL-PLAN.md`): `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. Without these, `notificationService.ready` stays `false` and sends are silently skipped (logged as a warning) rather than crashing the server.

---

## 8a. Notification Settings UI, Preview & Misc Components

- **`src/components/NotificationSettings.jsx`** — the in-app panel (as opposed to the phone's `/setup` page) for managing push notifications: shows registered devices, per-event on/off toggles, send-test buttons, and the QR code/URL from `/api/notifications/setup-url` for pairing a new phone.
- **`src/services/fcm.js` + `src/firebase-config.js`** — browser-side Firebase initialization and the foreground `onMessage()` handler (shows a notification via the Notifications API when a push arrives while the tab is focused; `public/firebase-messaging-sw.js` handles the background/tab-not-focused case).
- **`src/components/PreviewBox.jsx`** — optional OBS scene preview display in the control panel.
- **`src/components/BuildFooter.jsx`** — shows build metadata (app version, build time, git commit) injected by Vite at build time (`__APP_VERSION__`, `__BUILD_TIME__`, `__GIT_COMMIT__` globals defined in `vite.config.js`).
- **`src/components/common/TimePickerAMPM.jsx`** — the reusable custom time input used by the Scheduler and Katha/monitor auto-refresh times, working around Windows Chrome's un-hideable AM/PM segments on native `<input type="time">`.

**Server memory monitoring:** `server.cjs` checks heap usage every ~60 seconds; logs a warning above 300 MB and a critical alert (and pushes a `MEMORY_WARNING` notification) above 1000 MB, alongside current WebSocket client count.

---

## 9. Playlist Import (txt / csv / xlsx)

**Files:** `src/components/LoopPlayerCard.jsx`, `sample-files/video-ids-template.txt`, `sample-files/video-ids-template.xlsx`

The Loop Player's file-import button accepts `.txt`, `.csv`, `.xlsx`, or `.xls`. For spreadsheet files it dynamically imports the `xlsx` (SheetJS) library, reads the first sheet, flattens all rows, and treats every non-empty cell as a YouTube video ID or full URL. Plain text/CSV files are parsed line-by-line. `sample-files/` ships one example of each format for the operator to copy from (mixing raw IDs and full YouTube/Shorts URLs — parsing extracts the ID from either form).

---

## 10. YouTube Data Service (`live-tv-api`)

**Files:** `live-tv-api/server.js`, `live-tv-api/api/live.js`, `live-tv-api/api/videos.js`, `live-tv-api/lib/youtube.js`

A small, standalone Node HTTP server (no Express) run separately on port 3000, whose only job is fetching YouTube data without an official API key (waterfall: Piped API → HTML scrape → RSS fallback, per its own docs). It exists so that when YouTube changes its internal page structure, only this one service needs updating — the React app never talks to YouTube directly, avoiding CORS and key-management entirely.

| Endpoint | Purpose |
|---|---|
| `GET /api/live?channelId=` | Currently-live + upcoming videos for a channel (defaults to the configured "streams" channel) |
| `GET /api/videos` | Last ~30 recent uploads for the Katha Monitor channel |
| `GET /api/video-description?videoId=` | A video's full description (Mangla Charan timestamp detection, Delay Player keyword-skip) |

**Description endpoint resilience** (hardened July 2026 after the machine's IP got 429-blocked by YouTube): responses are cached in memory for 6 hours; at most 3 watch-page fetches run concurrently (the Katha Monitor requests ~30 descriptions at once); the primary source is YouTube's **innertube API** (`POST youtubei/v1/player` — a small JSON call that keeps working even when the watch page is behind the Google "sorry" block), with the HTML scrape as fallback; a 429 puts the scrape path on a 5-minute cooldown; and if every source is down, an expired cache entry is served with `stale: true` rather than failing.

Background refresh runs every 90 seconds (`warmCache`, `fetchStreamChannel`, `fetchKathaChannel`) so the endpoints usually respond from cache instantly. Also deployable standalone to Vercel (`vercel.json`, `DEPLOY.md` present in that folder).

---

## 11. Launcher, Build & Process Management

**Files:** root `smk.cjs`, `smk-launcher.cjs`, `build.cjs`, `ecosystem.config.cjs`, `env-loader.cjs`, `windows/*.bat`, `mac/*.command`

`smk.cjs` is the single CLI entry point for every lifecycle action across both services:

| Command | Effect |
|---|---|
| `node smk.cjs dev` | Starts Vite (3004) + Express API (3005) for local development |
| `node smk.cjs build` | Builds the React UI to `live-tv-controller-react/dist/` |
| `node smk.cjs exe` | Builds the UI then packages a Windows `.exe` via `build.cjs` |
| `node smk.cjs start` / `stop` / `restart` | Manage production processes through PM2 (`ecosystem.config.cjs` defines `smk-controller` and `smk-api` processes) |
| `node smk.cjs install` | Runs `npm install` in root, `live-tv-api/`, and `live-tv-controller-react/` |
| `node smk.cjs status` / `logs` | PM2 status / tailing logs |

`build.cjs` (the EXE pipeline behind `smk.cjs exe` / `npm run build:exe`) auto-numbers builds by scanning `windows/exe/` (`SMK TV <N>.exe`), **syncs the root `.env` into `windows/exe/.env`** (the packaged exe reads its env from next to `process.execPath`, not the repo root — this copy once drifted and silently shipped builds without Firebase credentials), and retries the final file move up to 5× with a copy+delete fallback to survive OneDrive/antivirus `EBUSY`/`EPERM` locks.

`env-loader.cjs` loads the single shared root `.env` file so all three Node processes (launcher, API, controller) see identical configuration — ports, Firebase credentials, tunnel settings, etc. Windows (`windows/Start SMK TV.bat`, `Stop SMK TV.bat`, `Build SMK TV.bat`) and Mac (`mac/SMK TV.app`, `Build SMK TV.command`, `stop.command`) each get double-clickable equivalents for non-technical operation.

---

## 12. Static Asset Bundling for the EXE

**Files:** `public-assets.cjs` (generated), `generate-public-assets.cjs`

`pkg`'s asset-globbing for the `public/` folder proved unreliable, so `generate-public-assets.cjs` is run once before packaging: it reads every file in `public/` (HTML, JS, JSON, icons) and emits a single auto-generated CJS module (`public-assets.cjs`) mapping filename → `{ contentType, binary, content }` (base64 for binaries). Since `pkg` always reliably bundles anything reached via `require()`, this sidesteps the glob problem entirely — `server.cjs` requires this module and serves files straight from memory when running as the packaged `.exe`.

---

## 13. State & Data Persistence

| Store | File | Managed by |
|---|---|---|
| Schedules | `data/schedules.json` | `scheduler-service.cjs` |
| General app/server state (OBS settings, per-key config) | `data/app-state.json` (via `state-service.cjs`) | `state-service.cjs` |
| FCM device tokens | `data/fcm-tokens.json` | `token-store.cjs` |
| Notification send history | `data/notification-history.json` (opt-in via `NOTIFICATION_HISTORY=true`) | `notification-service.cjs` |
| SSL cert/key/meta | `data/ssl-cert.pem`, `ssl-key.pem`, `ssl-meta.json` | `cert-manager.cjs` |
| Logs | `logs/logs-YYYY-MM.json` (monthly) | `src/utils/logger.js` (client) + logs API (server) |
| Settings backups | `backups/*.json`, `backups/auto_backup/*.json` | Backup API in `server.cjs` |
| Local video library | `videos/` (default scan folder) | Local PC Player |
| OBS recordings | `live_recordings/` | Live Player's recording manager |

All JSON writes across the project use an atomic write pattern: write to `*.tmp`, validate by re-parsing, rename old file to `*.bak`, then rename `.tmp` into place — preventing corruption if the process is killed mid-write.

Player UI state (current video, playlist, play/pause flags) additionally persists to browser `localStorage` (per-player keys like `loopPlayerState`, `livePlayerState`, `delayPlayerState`, `localPCPlayerState`) so it survives a page refresh within the same browser session — separate from the server-side stores above, which survive full app/EXE restarts.

---

## 14. Environment Variables (shared root `.env`)

| Variable | Used by | Purpose |
|---|---|---|
| `API_PORT` | `live-tv-api` | YouTube data service port (default 3000) |
| `CONTROLLER_PORT` / `CONTROLLER_DEV_PORT` | `live-tv-controller-react` | Production single port / dev-mode internal Express port |
| `VITE_DEV_PORT`, `VITE_LOCAL_API_BASE`, `VITE_CONTROLLER_PORT`, `VITE_CONTROLLER_DEV_PORT` | Vite/React frontend | Dev server + API base URL config, must be `VITE_`-prefixed to reach the browser bundle |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | `notification-service.cjs` | Firebase Admin SDK credentials for sending push notifications |
| `MAX_FCM_TOKENS` | `token-store.cjs` | Cap on stored device tokens (default 50) |
| `NOTIFICATION_HISTORY` | `notification-service.cjs` | Set `true` to persist send history to disk |
| `TUNNEL_URL` | `tunnel-manager.cjs` (auto-written), read by setup-url endpoint | Public HTTPS URL for `/setup` when off-LAN access is enabled — machine-managed, don't hand-edit while running |
| `HTTPS_PORT` | `server.cjs` | Self-signed HTTPS server port for phone setup (default 3443) |

---

## 15. Why Certain Design Choices Were Made

- **`localStorage` as IPC** between the React control panel and OBS Browser Sources avoids any server round-trip: same-origin tabs share `localStorage`, and a `storage` event fires instantly on every other open tab/window.
- **Server-side scheduler** instead of browser timers, because Chrome throttles background-tab timers to ~1Hz, which would make time-of-day triggers unreliable if the tab were minimized.
- **File-serving proxy for local videos** (`/api/videos/serve?path=`) instead of `file://` URLs, because browsers block `file://` access from an `http://` origin; the proxy also enables HTTP Range support needed for video seeking.
- **Plain service worker instead of the Firebase JS SDK** for push notifications, so notification delivery doesn't depend on `gstatic.com` being reachable.
- **Self-signed LAN certificate covering all detected IPs** instead of a single hostname cert, because operators might open `/setup` from any device on the LAN using whatever IP that device sees the server at.
- **No database anywhere** — every store is a JSON file with atomic write + `.bak` recovery, appropriate for a single-operator local tool with no concurrent-writer contention.

---

*Companion documents: `TROUBLESHOOTING.md` (symptom → cause → fix, start here when something breaks), `live-tv-controller-react/PROJECT.md` (deep technical reference for the controller app specifically — architecture diagrams, full REST/WebSocket tables, localStorage key reference), `FCM-PUSH-NOTIFICATIONS.md` and `FCM-PARALLEL-PLAN.md` (original design docs for the push notification feature — historical), `COMMANDS.md` (day-to-day ops command reference).*
