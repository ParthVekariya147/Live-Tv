# SMK TV — Live TV Controller (deep technical reference)

A full-stack desktop application (React + Express, packaged as a Windows EXE via `pkg`) for operating a religious broadcast channel (SMK TV / Swaminarayan). The app controls OBS Studio sources, manages video playlists, monitors YouTube live streams, schedules automated source-switching events, sends push notifications to phones, and keeps structured logs — all from a single browser-based UI served locally.

> This is the deep-dive for the controller app. Companions at the repo root:
> **[../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)** (symptom → fix), **[../FEATURES-REPORT.md](../FEATURES-REPORT.md)** (feature-by-feature overview), **[../COMMANDS.md](../COMMANDS.md)** (ops commands).

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Directory Structure](#2-directory-structure)
3. [Running the App](#3-running-the-app)
4. [OBS Integration](#4-obs-integration)
5. [Player System](#5-player-system)
6. [Scheduler System](#6-scheduler-system)
7. [Monitor System](#7-monitor-system)
8. [Push Notification System](#8-push-notification-system)
9. [Settings & Backup System](#9-settings--backup-system)
10. [Log System](#10-log-system)
11. [Express Server & REST API](#11-express-server--rest-api)
12. [WebSocket Architecture](#12-websocket-architecture)
13. [State Management](#13-state-management)
14. [LocalStorage Keys](#14-localstorage-keys)
15. [Build & Packaging](#15-build--packaging)
16. [Data & File Directories](#16-data--file-directories)
17. [Key Technical Decisions](#17-key-technical-decisions)

---

## 1. High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser (React UI at http://localhost:3004)             │
│                                                          │
│  OBSControlPanel  PlayerManager  Scheduler               │
│  MonitorManager   KathaMonitor   LogViewer               │
│  SettingsBackup   NotificationSettings                   │
└───────────────────┬──────────────────────────────────────┘
                    │  REST API + WebSocket (/ws)
┌───────────────────▼──────────────────────────────────────┐
│  Express Server (server.cjs)                             │
│    dev: port 3005 (behind Vite proxy on 3004)            │
│    prod/EXE: port 3004 · HTTPS: port 3443 (/setup)       │
│                                                          │
│  SchedulerService  StateService   BackupService          │
│  NotificationService (FCM)        TokenStore             │
│  CertManager / IPDetector / TunnelManager                │
│  Video Scan API    File Proxy     Logs API               │
└──────┬────────────────────────────────────────┬──────────┘
       │ OBS WebSocket (port 4455)              │ File system
       ▼                                        ▼
  OBS Studio                            data/, logs/, videos/,
  (scene source visibility,             backups/, live_recordings/
   stream/record/virtualcam)
       ▲
       │ (frontend owns this connection too — OBSContext.jsx)
```

**Communication patterns:**

| From → To | Protocol |
|-----------|----------|
| React UI → Express API | REST (fetch) |
| React UI ↔ Express | WebSocket `/ws` (server pushes + `TRIGGER_RESULT` reports back up) |
| React UI → OBS | OBS WebSocket v5, port 4455 (via OBSContext — the **frontend**, not the server, talks to OBS) |
| React ↔ OBS Browser Sources | `localStorage` storage events (same origin) |
| Express → Phones | FCM push (Firebase Admin SDK) |
| React UI → YouTube data | `live-tv-api` on port 3000 (separate service; see repo root) |

---

## 2. Directory Structure

```
live-tv-controller-react/
├── server.cjs                # Express + WebSocket + HTTPS server (entry point)
├── scheduler-service.cjs     # Server-side scheduler (1-second tick loop)
├── state-service.cjs         # Persistent key-value state store (data/app-state.json)
├── notification-service.cjs  # FCM push: templates, batching, retry, history
├── token-store.cjs           # Atomic store for FCM device tokens (data/fcm-tokens.json)
├── cert-manager.cjs          # Self-signed SSL cert generation (SANs = all LAN IPs)
├── ip-detector.cjs           # Enumerates LAN IPs for cert + setup URLs
├── tunnel-manager.cjs        # localtunnel wrapper: connect, health-poll, auto-reconnect
├── generate-public-assets.cjs# Pre-pkg step: embeds public/ into public-assets.cjs
├── public-assets.cjs         # GENERATED — public/ files as an in-memory module for the EXE
├── vite.config.js            # Dev config: UI on 3004, proxies /api /videos /ws → 3005
├── package.json              # v1.8.x — note firebase-admin pinned to ^12.7.0 (pkg compat)
│
├── src/
│   ├── App.jsx               # Root layout, global storage event listeners
│   ├── main.jsx              # React root + FCM init
│   ├── firebase-config.js    # Browser-side Firebase app init (VITE_FIREBASE_* env)
│   ├── services/fcm.js       # Permission, token registration, foreground onMessage
│   ├── context/
│   │   └── OBSContext.jsx    # OBS WS client, source state, confirmed-request support
│   ├── components/
│   │   ├── OBSControlPanel.jsx      # Top bar: stream, record, virtual cam, auto-record
│   │   ├── PlayerManager.jsx        # Renders the 4 player cards
│   │   ├── LoopPlayerCard.jsx       # YouTube playlist looper (+ txt/csv/xlsx import)
│   │   ├── LivePlayerCard.jsx       # YouTube live player + yt-dlp recording manager
│   │   ├── DelayPlayerCard.jsx      # Windowed playback + keyword-based section skip
│   │   ├── LocalPlayerCard.jsx      # Local file playlist with drag-drop & auto-scan
│   │   ├── MonitorManager.jsx / MonitorCard.jsx   # YouTube channel live monitors
│   │   ├── KathaMonitor.jsx         # Katha video detector (Mangla Charan timestamp)
│   │   ├── UpcomingEventMonitor.jsx # Scheduled stream countdown
│   │   ├── Scheduler.jsx            # Schedule CRUD + trigger execution + result reporting
│   │   ├── NotificationSettings.jsx # Devices, per-event toggles, QR pairing, test send
│   │   ├── LogViewer.jsx            # Log browser with filter/search/export
│   │   ├── SettingsBackup.jsx       # JSON export/import + server-side backups
│   │   ├── PreviewBox.jsx, BuildFooter.jsx
│   │   └── common/  (PlayerControlBtn, ThumbnailLoader, TimePickerAMPM)
│   ├── hooks/    (useAppState.js, useVideoInfo.js)
│   └── utils/
│       ├── core-utils.js     # Time formatters, sendPlayerCommand(+extras), YT parsers
│       ├── logger.js         # REST-backed structured logging
│       ├── scheduler-api.js  # REST wrappers + WS client + reportTriggerResult()
│       ├── state-api.js      # REST wrappers for StateService
│       └── usePlayerHooks.js # usePlayerTime hook (localStorage time events)
│
├── public/                   # Static files; player pages open as OBS Browser Sources
│   ├── LoopPlayer.html · LivePlayer.html · DelayLive.html · LocalPCPlayer.html
│   ├── obs-auto-setup.html   # OBS auto-configuration helper
│   ├── setup.html            # Phone notification-setup page (served at /setup)
│   ├── firebase-messaging-sw.js  # Plain service worker: background push handler
│   └── manifest.json, icon-192.png, icon-512.png
│
├── sample-files/             # Playlist import templates (.txt / .xlsx)
├── data/                     # schedules.json, app-state.json, fcm-tokens.json,
│                             # notification-history.json, ssl-*.pem, ssl-meta.json
├── logs/                     # Monthly log files (logs-YYYY-MM.json)
├── videos/                   # Default video folder scanned by Local Player
├── live_recordings/          # yt-dlp recordings managed by LivePlayerCard
└── backups/                  # Server-side settings backups (+ auto_backup/)
```

> ⚠ Changes under `public/` do **not** reach a built EXE until you rebuild — the EXE serves those files from the generated `public-assets.cjs`, not from disk. See [§15](#15-build--packaging).

---

## 3. Running the App

### Development (from repo root)

```bash
node smk.cjs dev     # or npm run dev at the root
```

This starts the Express API on **3005** and Vite on **3004** (plus `live-tv-api` on 3000). Open `http://localhost:3004`. The Vite proxy sends `/api/*`, `/videos/*`, and WebSocket `/ws` to Express on 3005, so dev and production have identical URLs.

Manually (two terminals inside this folder): `npm run dev:api` (Express :3005) + `npm run dev` (Vite :3004).

### Production

- **PM2:** `node smk.cjs start` at the root — `smk-controller` runs `server.cjs` on `CONTROLLER_PORT` (default **3004**), `smk-api` runs the YouTube service on 3000.
- **EXE:** `npm run build:exe` at the **root** (see [§15](#15-build--packaging)) → `windows/exe/SMK TV <N>.exe`. The exe serves UI + API + WS on port 3004 and creates `data/`, `logs/`, `videos/`, `live_recordings/`, `backups/` next to itself on first run. It reads `.env` from **next to the exe** (auto-synced from the root `.env` at build time).

In every mode the browser-facing port is **3004**, so OBS Browser Source URLs never change.

An HTTPS server also starts on `HTTPS_PORT` (default **3443**) with a self-signed cert covering all LAN IPs — needed only for the phone notification setup page (`/setup`), because Web Push requires a secure context.

---

## 4. OBS Integration

**Connection:** `OBSContext.jsx` connects **from the browser** to OBS Studio via OBS WebSocket v5 (`ws://localhost:4455` by default). Host/port configurable in the Settings panel, persisted in `localStorage['obsSettings']`. Auto-reconnect with exponential back-off (5 s → 60 s).

**Scene layout:** a single OBS scene named `"Scene"` containing sources managed by name:

| OBS Source Name | Purpose |
|----------------|---------|
| `Loop Player`  | Background YouTube loop (always-on fallback) |
| `Live Player`  | YouTube live stream |
| `Delay Live`   | YouTube video played in a custom time window |
| `Local Player` | Local video playlist |
| `OrdaChesta`   | Additional source (hidden from the Scheduler's source dropdown) |

**Source visibility** uses `SetSceneItemEnabled`. OBSContext polls `GetSceneItemList` / `GetStreamStatus` / `GetRecordStatus` / `GetVirtualCamStatus` every second and reacts to OBS events. **Exclusivity:** turning one managed source ON turns the others OFF; hiding the last visible source falls back to Loop Player.

**Two request modes:**

- `sendRequest(type, data)` — fire-and-forget; used by all normal UI interactions.
- `sendRequestConfirmed(type, data, timeoutMs=5000)` — tracks the request by `requestId` and resolves `{ ok, reason }` from OBS's own op-7 `RequestResponse` (or a timeout). `setSourceVisibilityConfirmed(source, visible)` builds on this and is used by the scheduler's confirm-before-notify flow ([§6](#6-scheduler-system)); its companion "turn the others off" calls remain fire-and-forget.

**OBSControlPanel:** Start/Stop Stream, Start/Stop Record (OBS's own recorder — distinct from the Live Player's yt-dlp recording), Toggle Virtual Cam, Auto-Record toggle, Live↔Loop quick swap, connection settings, and a playback health check (waits up to 8 s for a `timeUpdate` storage event after a switch; shows a warning ring if the player isn't actually playing).

---

## 5. Player System

Each React player card communicates with its paired OBS Browser Source HTML page via `localStorage` events:

```
React PlayerCard  →  localStorage.setItem(key, JSON.stringify(command))
                     (key removed after 100 ms so the same command can re-fire)
        ↓ storage event (same-origin tabs share localStorage)
OBS Browser Source HTML  →  YouTube IFrame API / <video> element
```

`sendPlayerCommand(playerKey, command, videoId, startSeconds, endSeconds, videoPath, extras)` in `core-utils.js` builds the command object; the trailing `extras` object is merged in for commands with non-standard payloads (currently the Delay player's `setSkipRanges`).

### Loop Player — `LoopPlayerCard.jsx` + `public/LoopPlayer.html`
Comma-separated YouTube ID playlist looped forever (the always-on fallback source). Auto-advances on `videoEnded`, jump-to-index, play/pause/stop/next/prev, oEmbed title/thumbnail. Playlist import from `.txt`/`.csv`/`.xlsx` (SheetJS; templates in `sample-files/`). Keys: `loopPlayerEvent`, `loopPlayerState`.

### Live Player — `LivePlayerCard.jsx` + `public/LivePlayer.html`
Plays the on-air YouTube stream. The Live Monitor can auto-populate the video ID on a title match. Auto-record spawns a **yt-dlp subprocess server-side** (`/api/recording/*`) that downloads the actual YouTube stream to `live_recordings/`; it auto-starts/stops with source visibility (guarded by `wasAutoStarted` so manual recordings aren't killed) and is stopped via `navigator.sendBeacon` on page unload. In production, `yt-dlp.exe` must sit next to the EXE. On video end → switches OBS back to Loop Player. Keys: `livePlayerEvent`, `livePlayerState`, `liveAutoRecord`.

### Delay Live Player — `DelayPlayerCard.jsx` + `public/DelayLive.html`
Plays a video from Start Time to End Time (HH:MM:SS). On end → hides itself; falls back to Loop Player if Live Player isn't visible.

**Keyword skip:** with "Skip section by keyword" enabled, Load & Play also fetches the video description from `live-tv-api` (`/api/video-description`) in the background, scans description lines carrying a `H:MM(:SS)` timestamp for the comma-separated keywords (case-insensitive, both "12:34 Kirtan" and "Kirtan 12:34" line orders), and builds one skip range per keyword: from that timestamp to the *next* timestamp in the description (`end = null` ⇒ keyword was the last timestamp ⇒ finish the video there). Ranges are merged/sorted (`findKeywordSkipRanges`) and sent with `setSkipRanges`; the HTML player's 1-second watcher seeks over any range it enters. All best-effort: fetch failure or no match ⇒ full video plays and the status line explains. `loadVideo` clears ranges player-side; the card re-sends them (kept in `skipRangeRef`) when resuming. Keys: `delayLivePlayerEvent`, `delayPlayerState` (now includes `keywordSkipEnabled`, `skipKeyword`).

### Local PC Player — `LocalPlayerCard.jsx` + `public/LocalPCPlayer.html`
Local video playlist (mp4/mkv/avi/mov/webm/wmv). Auto-scans `videos/` (`GET /api/videos/scan`), scans any custom folder (`POST /api/videos/scan-folder`), drag-drop, file picker, manual paths, drag-to-reorder, per-item enable/disable with proactive skip, per-item start/end trim (`H:MM` format), per-day-of-week end action. All local files stream through `GET /api/videos/serve?path=` (HTTP Range support, no `file://`). Scheduler can trigger `local_player_start/stop/next` via WebSocket. Keys: `localPCPlayerEvent`, `localPCPlayerState`, `localPCPlayerEndActions`.

---

## 6. Scheduler System

Runs **server-side** in `scheduler-service.cjs` (1-second tick) so triggers fire even with the browser minimized. Persists to `data/schedules.json`.

| Feature | Detail |
|---------|--------|
| Recurrence | `daily`, `weekly`, specific `days`, `once` |
| Catch-up on restart | Missed windows fire immediately on startup |
| Deduplication | `lastTriggered` prevents double-firing in the same minute |
| Skip next occurrence / cancel skip | Per schedule |
| Retry on failure | 3 retries, 5 s delay; then alert |
| Alerts, history, health | Broadcast over WS; last 100 executions; `totalTriggers/Missed/Skipped/Retries` |

**Actions:** `show` / `hide` (OBS source visibility, executed by the frontend), `local_player_start` / `local_player_stop` / `local_player_next` (Local PC Player), `katha_refresh` / `katha_player` (registered and handled by KathaMonitor).

### Trigger execution & confirm-before-notify

`show`/`hide` actions are executed by **`Scheduler.jsx` in the browser** — the frontend owns the OBS connection. Since July 2026 the flow confirms before notifying:

```
scheduler-service tick → server broadcasts SCHEDULER_TRIGGER over /ws
  server: action is show/hide?  → hold the push, awaitTriggerConfirmation() (130 s timer)
                       else     → push SCHEDULER_TRIGGER notification immediately

Scheduler.jsx receives the trigger:
  OBS disconnected  → queue (replayed on reconnect, expires after 2 min) or report failure
  Live Player active → skip; report { ok:false, reason:'Live Player is active' }
  source not found   → report failure
  otherwise → await setSourceVisibilityConfirmed()  ← waits for OBS's op-7 RequestResponse
            → reportTriggerResult({ id, triggerKey, ok, reason, ... })
              (WS 'TRIGGER_RESULT' message, REST POST /api/scheduler/trigger-result fallback)

server handleTriggerResult():
  ok    → push SCHEDULER_TRIGGER   ("<title> ran")
  !ok   → push SCHEDULER_TRIGGER_FAILED with the concrete reason
  no report within 130 s → push SCHEDULER_TRIGGER_FAILED
         ("No confirmation from the app… closed, backgrounded, or OBS unreachable")
```

The 130 s server timeout deliberately exceeds the frontend's 2-minute trigger-replay window (`OBS_TRIGGER_EXPIRY_MS`) so a late success report can't contradict an already-sent failure push.

**UI details:** time input is `type="text"` with auto-colon insertion and `normalizeTime()` zero-padding (native `<input type="time">` shows un-hideable AM/PM segments on Windows Chrome); `SCHEDULER_TICK` (every second) drives countdowns and includes next-trigger info for **all** schedules.

---

## 7. Monitor System

### Live Monitor — `MonitorManager.jsx`, `MonitorCard.jsx`
Watches two YouTube channels (Swaminarayan `UC7HQ3mzdsyvLU0Y7a2t3N7A`, Swaminarayan Bhagwan `UCQXWP4gEdEwlb6vodwrU75A`) for live/upcoming streams via `live-tv-api` (port 3000), polling every 30 s. Handles both `videoRenderer` and `lockupViewModel` data formats; saved search terms auto-load a matching stream into the Live Player; countdowns to scheduled starts. State: `savedSearchTitles1/2`, `liveSelectedChannelId`.

### Katha Monitor — `KathaMonitor.jsx`
Finds today's/yesterday's Katha upload, fetches its description via `/api/video-description` to regex-extract the Mangla Charan timestamp, and loads the video pre-seeked with one click. Also owns the scheduler actions `katha_refresh` / `katha_player`. (The description endpoint is cached and rate-limit-hardened server-side — see `../TROUBLESHOOTING.md` §5.)

### Upcoming Event Monitor — `UpcomingEventMonitor.jsx`
Countdown display for scheduled/premiere streams, sharing Live Monitor data.

---

## 8. Push Notification System

**Files:** `notification-service.cjs`, `token-store.cjs`, `public/setup.html`, `public/firebase-messaging-sw.js`, `src/services/fcm.js`, `src/firebase-config.js`, `src/components/NotificationSettings.jsx`, plus `cert-manager.cjs` / `ip-detector.cjs` / `tunnel-manager.cjs` for reachability.

- **Register a phone:** open `/setup` (QR + URLs from `GET /api/notifications/setup-url` — prefers the tunnel URL *after live-verifying it*, else LAN HTTPS `:3443`). The page obtains an FCM token and `POST /api/notifications/register`s it → `data/fcm-tokens.json` (atomic writes, capped by `MAX_FCM_TOKENS`).
- **Send:** `notificationService.send(event, data)` — template lookup (`SCHEDULER_TRIGGER`, `SCHEDULER_TRIGGER_FAILED`, `SCHEDULER_ALERT`, `RECORDING_*`, `BACKUP_COMPLETED`, `MEMORY_WARNING`, `MONITOR_LIVE`), per-event preference check, `sendEachForMulticast` in 500-token chunks, auto-prune dead tokens, optional history (`NOTIFICATION_HISTORY=true`). Failed sends keep FCM's error **code and message**; `sendTest()` throws on rejection so the UI never shows a false success.
- **Receive:** `firebase-messaging-sw.js` is a plain service worker (no gstatic dependency) handling the background `push` event; `src/services/fcm.js` handles foreground messages.
- **Delete a device:** `DELETE /api/notifications/register` accepts `{ token }` or `{ deviceId }` — the in-app device list only knows ids (tokens are never exposed by `/devices`), and the row is removed only after the server confirms.
- **Tunnel:** `tunnel-manager.cjs` starts localtunnel, writes `TUNNEL_URL` into the root `.env`, health-polls `<url>/setup` every 45 s (2 misses ⇒ reconnect), and exports `checkTunnelHealth` / `forceReconnect` for the setup-url route.
- **Env:** `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (missing ⇒ sends are skipped with a warning, never a crash). `firebase-admin` is pinned to `^12.7.0` for `pkg` compatibility.

---

## 9. Settings & Backup System

**File:** `SettingsBackup.jsx`

- **Export/Import:** one `.json` bundling server state (`GET /api/settings/export`), all relevant localStorage keys, and schedules; restored via `POST /api/settings/import`. Before export/backup the server broadcasts `FLUSH_STATE_FOR_BACKUP` so player cards flush their latest state.
- **Server-side backups:** automatic + manual JSON files in `backups/` via the `/api/backup/*` endpoints ([§11](#11-express-server--rest-api)). Auto-backup: every N hours/days or a weekday.
- The Express JSON body limit is **100 MB** — imports with 50k+ playlist entries used to 413 against the 100 kb default.

---

## 10. Log System

**Files:** `src/utils/logger.js`, `LogViewer.jsx`. Monthly server files `logs/logs-YYYY-MM.json`.

Entry shape: `{ id, timestamp, date, time, dayName, level, type, category, message, data }`. Categories: `obs`, `video`, `scheduler`, `monitor`, `katha`, `system`. LogViewer: pagination (50/page), month/category/type/text filters, bulk delete, CSV export, auto-refresh. Useful trigger-debugging types: `SCHEDULER_TRIGGER_EXECUTING`, `SCHEDULER_TRIGGER_OBS_REJECTED`, `SCHEDULER_SOURCE_NOT_FOUND`.

---

## 11. Express Server & REST API

**File:** `server.cjs` · Ports: 3005 (dev) / 3004 (prod & EXE) / 3443 (HTTPS)

### Video API
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/videos/scan` | GET | List videos in the default `videos/` folder |
| `/api/videos/scan-folder` | POST | List videos in any absolute folder (`{ folderPath }`) |
| `/api/videos/root-folder` | GET | Path of the default videos folder |
| `/api/videos/serve` | GET | Stream a local file by `?path=` with HTTP Range support |

### Scheduler API
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scheduler/status` · `/health` · `/history` · `/retries` | GET | State, health counters, execution history, retry queue |
| `/api/scheduler/start` · `/stop` | POST | Control the tick loop |
| `/api/scheduler/next` | GET | Upcoming triggers |
| `/api/scheduler/trigger-result` | POST | REST fallback for reporting a trigger's confirmed outcome (normally sent as WS `TRIGGER_RESULT`) |
| `/api/scheduler/alerts` | GET / DELETE | Unacknowledged alerts / clear all |
| `/api/scheduler/alerts/:id/acknowledge` | POST | Acknowledge one alert |
| `/api/scheduler/backup` | POST | Snapshot schedules |
| `/api/schedules` | GET / POST / PUT | List / add / bulk-replace |
| `/api/schedules/:id` | PUT / DELETE | Update / delete |
| `/api/schedules/:id/toggle` · `/fire` · `/skip-day` · `/cancel-skip` | POST | Enable-disable / fire now / skip next / cancel skip |

### State API (`state-service.cjs` → `data/app-state.json`)
| Endpoint | Method |
|----------|--------|
| `/api/state` | GET (all) |
| `/api/state/:key` | GET / PUT / PATCH / DELETE (keys may contain `/` — route uses `:key(*)`) |
| `/api/state/import` · `/api/state/reset` | POST |

### Settings API
`GET /api/settings/export` · `POST /api/settings/import`

### Logs API
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/log` | POST | Write one entry |
| `/api/logs` | GET / DELETE | Paginated+filtered read / clear all |
| `/api/logs/months` | GET | Available month keys |
| `/api/logs/:id` | DELETE | Delete one entry |

### Recording API (yt-dlp live-stream recorder)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/recording/start` · `/stop` | POST | Spawn / stop the yt-dlp subprocess |
| `/api/recording/status` | GET | Polled ~2 s by the UI |
| `/api/recording/list` | GET | Files in `live_recordings/` |
| `/api/recording/:filename` | DELETE | Delete a recording |
| `/api/recording/settings` | GET / PUT | Auto-delete-after-N-files etc. |
| `/api/recording/open-folder` · `/folder-path` | POST / GET | Explorer helpers |

### Backup API
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/backup/manual` | POST | Create manual backup |
| `/api/backup/list` · `/status` · `/download` | GET | Enumerate / status / download |
| `/api/backup/restore` | POST | Restore a backup |
| `/api/backup/auto-settings` | GET / PUT | Auto-backup schedule |
| `/api/backup/open-folder` | POST | Open `backups/` in Explorer |

### Notifications API
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/setup` | GET | Phone registration page (`setup.html`) |
| `/firebase-messaging-sw.js` | GET | Service worker (served at origin root) |
| `/api/notifications/register` | POST / DELETE | Register token / remove by `token` **or** `deviceId` |
| `/api/notifications/devices` | GET | Registered devices (tokens excluded) |
| `/api/notifications/test` · `/test-device` | POST | Test push to raw token / registered device id |
| `/api/notifications/settings` | GET / PUT | Per-event on/off preferences |
| `/api/notifications/history` | GET | Send history |
| `/api/notifications/setup-url` | GET | QR + URL(s); live-verifies the tunnel first |
| `/api/notifications/status` | GET | Firebase initialized? device count? |

### OBS status relay
`POST /api/obs/status` / `GET /api/obs/status` — frontend reports OBS connection state so server-side features can read it.

---

## 12. WebSocket Architecture

WebSocket server at `/ws` (`ws` package), same port as HTTP.

### Server → Client
| Type | When |
|------|------|
| `SCHEDULER_TICK` | Every second — `{ nextTriggers (all schedules), serverTime, isRunning, schedulesCount }` |
| `SCHEDULER_TRIGGER` | A schedule fires (frontend executes OBS/player actions) |
| `SCHEDULER_STATUS` · `SCHEDULES_UPDATED` · `SCHEDULER_ALERT(S)` | Status / CRUD sync / alerts |
| `STATE_SYNC` (on connect) · `STATE_CHANGE` | Server state |
| `RECORDING_EVENT` · `RECORDING_STATUS` | yt-dlp recorder output / state |
| `FLUSH_STATE_FOR_BACKUP` | Right before a backup/export snapshot |

### Client → Server
| Type | Purpose |
|------|---------|
| `TRIGGER_RESULT` | Confirmed outcome of a show/hide trigger (`{ id, triggerKey, ok, reason, action, source, title }`) — REST fallback: `POST /api/scheduler/trigger-result` |

All client components reconnect with exponential back-off (1 s → 30 s). In dev, Vite proxies `/ws` to 3005 so `window.location.host` works unchanged.

---

## 13. State Management

- **React state:** each card uses `useState` + mirror `useRef`s to avoid stale closures in storage-event listeners, WS handlers, and timers.
- **localStorage:** per-player UI state, saved on change, loaded on mount (survives refresh).
- **Server state (`state-service.cjs`):** JSON-backed key-value store for settings that must survive restarts and be shared across browsers (OBS settings, player configs mirrored via `setStateValue`).
- **Schedules:** `data/schedules.json` via SchedulerService.

All server-side JSON stores use atomic writes: write `.tmp` → validate → rename old to `.bak` → rename `.tmp` in.

---

## 14. LocalStorage Keys

| Key | Owner | Content |
|-----|-------|---------|
| `loopPlayerState` / `loopPlayerEvent` | Loop Player | `{ playlist, currentIndex, isPlaying, isMuted, isStopped }` / commands |
| `livePlayerState` / `livePlayerEvent` | Live Player | `{ videoId, isPlaying, isMuted, isStopped }` / commands |
| `delayPlayerState` / `delayLivePlayerEvent` | Delay Player | `{ videoId, startTime, endTime, isPlaying, isMuted, isStopped, keywordSkipEnabled, skipKeyword }` / commands (incl. `setSkipRanges`) |
| `localPCPlayerState` / `localPCPlayerEvent` / `localPCPlayerEndActions` | Local Player | playlist state / commands / per-day end actions |
| `obsSettings` / `obsActiveSource` | OBSContext | `{ host, port }` / last active source |
| `liveAutoRecord` | OBSControlPanel + LivePlayerCard | `true / false` |
| `liveMonitorEnabled1/2`, `savedSearchTitles1/2`, `liveSelectedChannelId` | Monitors | visibility / search terms / channel |
| `fcm_permission_status`, `fcm_token` | fcm.js | push permission + token cache |

---

## 15. Build & Packaging

### The real pipeline (repo root)

```bash
npm run build:exe        # = node build.cjs   (also: node smk.cjs exe)
```

`build.cjs` steps:
1. **Sync `.env` → `windows/exe/.env`** — the packaged exe loads env from next to `process.execPath`, not the repo root. (This copy once drifted and silently shipped builds without Firebase credentials.)
2. `vite build` in this folder → `dist/`.
3. esbuild-bundle `live-tv-api/server.js` (ESM) → `live-tv-api/.bundle.cjs` (CJS) so `pkg` can include it.
4. `pkg` (root `package.json` config, `node20-win-x64`, `--no-bytecode --public`) → auto-numbered `windows/exe/SMK TV <N>.exe`; the final move retries 5× with a copy+delete fallback for OneDrive/antivirus `EBUSY`/`EPERM` locks.

(This folder's own `npm run build:exe` produces a standalone `live-tv-controller.exe` of just the controller — the root pipeline is the one used for releases.)

### public/ assets inside the EXE

`pkg`'s glob-based asset bundling proved unreliable for `public/`, so `generate-public-assets.cjs` embeds every `public/` file (base64 for binaries) into the generated module `public-assets.cjs`; `server.cjs` `require()`s it and serves those files from memory when `process.pkg` is set. **Consequence:** editing anything in `public/` requires a rebuild to affect the exe.

### Port / path detection in server.cjs

```js
const PORT = process.env.PORT || (process.pkg
    ? (process.env.CONTROLLER_PORT || 3004)      // production / EXE
    : (process.env.CONTROLLER_DEV_PORT || 3005)); // dev API behind Vite
```

All runtime directories resolve against `path.dirname(process.execPath)` under `pkg`, so they live next to the exe and are writable.

### Vite dev proxy (`vite.config.js`)

UI on `VITE_DEV_PORT` (3004); `/api`, `/videos`, `/ws` proxied to `CONTROLLER_DEV_PORT` (3005). Vite also injects `__APP_VERSION__`, `__BUILD_TIME__`, `__GIT_COMMIT__` (shown by `BuildFooter.jsx`) and loads env from the repo root (`envDir`).

---

## 16. Data & File Directories

| Directory | Purpose | EXE location | Dev location |
|-----------|---------|--------------|--------------|
| `data/` | schedules, app state, FCM tokens, notification history, SSL cert/key/meta | Next to EXE | `live-tv-controller-react/data/` |
| `logs/` | `logs-YYYY-MM.json` | Next to EXE | `live-tv-controller-react/logs/` |
| `videos/` | Default Local Player scan folder | Next to EXE | `live-tv-controller-react/videos/` |
| `live_recordings/` | yt-dlp recordings | Next to EXE | `live-tv-controller-react/live_recordings/` |
| `backups/` | Settings backups (+ `auto_backup/`) | Next to EXE | `live-tv-controller-react/backups/` |

---

## 17. Key Technical Decisions

- **localStorage as IPC** between React and OBS Browser Sources: same-origin tabs share localStorage and `storage` events fire instantly on the other tabs — zero-latency, server-free. Commands are deleted 100 ms after writing so identical commands can re-fire (browsers suppress events for unchanged values).
- **Server-side scheduler** because hidden-tab browser timers throttle to ~1 Hz and would miss time-of-day triggers.
- **Confirm-before-notify** for show/hide triggers: the timer matching is *not* success. Only the frontend knows whether OBS was connected, the source existed, and OBS acknowledged the change — so the push notification waits for that confirmation (or times out into an explicit failure push). A silent no-op never reads as a successful run.
- **File proxy for local videos** (`/api/videos/serve?path=`): browsers block `file://` from an `http://` origin, and the proxy adds HTTP Range support required for `<video>` seeking.
- **Plain service worker (not the Firebase JS SDK)** for background push, so delivery doesn't depend on `gstatic.com`.
- **Self-signed cert with all LAN IPs as SANs** so any device on the LAN can open `/setup` at whatever IP it sees the server at; the tunnel provides a trusted-cert alternative and both are health-verified before being offered.
- **`require()`-embedded public assets** (`public-assets.cjs`) instead of `pkg` asset globs — `pkg` always bundles what's reachable via `require()`.
- **Stale-closure prevention:** mirror refs (`playlistRef`, `isPlayingRef`, …) plus functional `setState(prev => …)` in all async callbacks.
- **Time formats:** Local Player uses `H:MM` (how operators think about long-form content); other players use `HH:MM:SS` (`timeToSeconds` / `secondsToHMS`). Scheduler time input is a text field with auto-colon + `normalizeTime()` because Windows Chrome's `<input type="time">` AM/PM segments can't be hidden.
- **No database:** every store is an atomic-write JSON file with `.bak` recovery — right-sized for a single-operator tool.
- **`express.json({ limit: '100mb' })`** — large playlist imports/backups exceeded the 100 kb default and were silently 413-dropped.
