# SMK TV — Live TV Controller

A full-stack desktop application (React + Express, packaged as a Windows EXE via `pkg`) for operating a religious broadcast channel (SMK TV / Swaminarayan). The app controls OBS Studio sources, manages video playlists, monitors YouTube live streams, schedules automated source-switching events, and keeps structured logs — all from a single browser-based UI served locally.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Directory Structure](#2-directory-structure)
3. [Running the App](#3-running-the-app)
4. [OBS Integration](#4-obs-integration)
5. [Player System](#5-player-system)
   - [Loop Player](#loop-player)
   - [Live Player](#live-player)
   - [Delay Live Player](#delay-live-player)
   - [Local PC Player](#local-pc-player)
6. [Scheduler System](#6-scheduler-system)
7. [Monitor System](#7-monitor-system)
   - [Live Monitor (MonitorManager)](#live-monitor-monitormanager)
   - [Katha Monitor](#katha-monitor)
   - [Upcoming Event Monitor](#upcoming-event-monitor)
8. [Settings & Backup System](#8-settings--backup-system)
9. [Log System](#9-log-system)
10. [Express Server & REST API](#10-express-server--rest-api)
11. [WebSocket Architecture](#11-websocket-architecture)
12. [State Management](#12-state-management)
13. [LocalStorage Keys](#13-localstorage-keys)
14. [Build & Packaging](#14-build--packaging)
15. [Data & File Directories](#15-data--file-directories)
16. [Key Technical Decisions](#16-key-technical-decisions)

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (React UI at http://localhost:3003)         │
│                                                      │
│  OBSControlPanel  PlayerManager  Scheduler           │
│  MonitorManager   KathaMonitor   LogViewer           │
│  SettingsBackup                                      │
└────────────────────┬────────────────────────────────┘
                     │  REST API + WebSocket (/ws)
┌────────────────────▼────────────────────────────────┐
│  Express Server (server.cjs)  port 3003 (EXE)       │
│                               port 3004 (dev)        │
│                                                      │
│  SchedulerService  StateService  BackupService       │
│  Video Scan API    File Proxy    Logs API            │
└──────┬─────────────────────────────────────┬────────┘
       │ OBS WebSocket (port 4455)            │ File system
       ▼                                      ▼
  OBS Studio                          data/, logs/,
  (scene source visibility,           videos/, backups/,
   stream/record/virtualcam)          live_recordings/
```

**Communication patterns:**

| From → To | Protocol |
|-----------|----------|
| React UI → Express API | REST (fetch) |
| React UI ↔ Express | WebSocket `/ws` |
| Express → OBS | OBS WebSocket v5 (port 4455) |
| React UI → OBS | OBS WebSocket v5 (via OBSContext) |
| React ↔ OBS Browser Sources | `localStorage` storage events |

---

## 2. Directory Structure

```
live-tv-controller-react/
├── server.cjs              # Express server (entry point for EXE)
├── scheduler-service.cjs   # Server-side scheduler (1-second tick loop)
├── state-service.cjs       # Persistent key-value state store
├── package.json
├── vite.config.js          # Vite dev config (proxies /api, /videos, /ws → port 3004)
│
├── src/
│   ├── App.jsx             # Root layout, global storage event listeners
│   ├── main.jsx
│   ├── context/
│   │   └── OBSContext.jsx  # OBS WebSocket client, source state, stream/record controls
│   ├── components/
│   │   ├── OBSControlPanel.jsx     # Top bar: stream, record, virtual cam, auto-record
│   │   ├── PlayerManager.jsx       # Renders all 4 player cards in a row
│   │   ├── LoopPlayerCard.jsx      # YouTube playlist looper
│   │   ├── LivePlayerCard.jsx      # YouTube live stream player + recording manager
│   │   ├── DelayPlayerCard.jsx     # YouTube video with custom start/end window
│   │   ├── LocalPlayerCard.jsx     # Local MP4 playlist with drag-drop & auto-scan
│   │   ├── MonitorManager.jsx      # Two YouTube channel live monitors
│   │   ├── MonitorCard.jsx         # Single channel monitor card
│   │   ├── KathaMonitor.jsx        # Katha video detector (via local proxy API)
│   │   ├── UpcomingEventMonitor.jsx# Scheduled stream countdown monitor
│   │   ├── Scheduler.jsx           # Schedule CRUD + WebSocket-driven trigger handler
│   │   ├── LogViewer.jsx           # Collapsible log browser with filter/search/export
│   │   ├── SettingsBackup.jsx      # JSON export/import + server-side backup management
│   │   └── common/
│   │       ├── PlayerControlBtn.jsx
│   │       └── ThumbnailLoader.jsx
│   ├── hooks/
│   │   ├── useAppState.js          # Server state API hook
│   │   └── useVideoInfo.js         # YouTube oEmbed title + thumbnail fetch
│   └── utils/
│       ├── core-utils.js           # Time formatters, sendPlayerCommand, YouTube parsers
│       ├── logger.js               # REST-backed log write/read/filter
│       ├── scheduler-api.js        # REST wrappers + WebSocket client for scheduler
│       ├── state-api.js            # REST wrappers for StateService
│       └── usePlayerHooks.js       # usePlayerTime hook (localStorage time events)
│
├── public/                         # Served as static files; opened as OBS Browser Sources
│   ├── LoopPlayer.html             # YouTube IFrame API looper
│   ├── LivePlayer.html             # YouTube IFrame API live viewer
│   ├── DelayLive.html              # YouTube IFrame API (windowed segment)
│   ├── LocalPCPlayer.html          # HTML5 <video> element player (local files)
│   └── obs-auto-setup.html         # OBS auto-configuration helper
│
├── data/                           # Runtime data (created next to EXE in production)
│   └── schedules.json
├── logs/                           # Monthly log files (logs-YYYY-MM.json)
├── videos/                         # Default video folder scanned by Local Player
├── live_recordings/                # Recordings saved by LivePlayerCard file manager
└── backups/                        # Server-side settings backups
```

---

## 3. Running the App

### Development

```bash
# Terminal 1 — Express API + WebSocket server (port 3004)
npm run dev:api

# Terminal 2 — Vite dev server (port 3003, proxies /api /videos /ws → 3004)
npm run dev
```

Open `http://localhost:3003` in a browser.

> The Vite proxy ensures `/api/*`, `/videos/*`, and WebSocket `/ws` all reach the Express server on port 3004, so both dev and EXE have identical behaviour.

### Production (EXE)

```bash
npm run build:exe
```

This runs `vite build` (outputs to `dist/`) then `pkg . --targets node18-win-x64 --output live-tv-controller.exe`. The EXE bundles the server and the built React app. On launch it listens on **port 3003** and serves the UI at `http://localhost:3003`.

Create the following folders **next to the EXE** (they are created automatically on first run if missing):

```
live-tv-controller.exe
data/            ← schedules + server state
logs/            ← monthly log files
videos/          ← default local video folder
live_recordings/ ← OBS recording file manager
backups/         ← automatic + manual settings backups
```

---

## 4. OBS Integration

**Connection:** OBSContext.jsx connects to OBS Studio via the OBS WebSocket v5 protocol (`ws://localhost:4455` by default). Host and port are configurable through the Settings panel in OBSControlPanel and persisted in localStorage under `obsSettings`.

**Scene layout:** The app assumes a single OBS scene named `"Scene"` containing these sources:

| OBS Source Name | Purpose |
|----------------|---------|
| `Loop Player`  | Background YouTube loop (always-on fallback) |
| `Live Player`  | YouTube live stream |
| `Delay Live`   | YouTube video played from a specific timestamp |
| `Local Player` | Local MP4/MKV/AVI playlist |
| `OrdaChesta`   | Additional source (toggled manually) |

**Source visibility** is controlled via `SetSceneItemEnabled` OBS requests. OBSContext polls (`GetSceneItemList`, `GetStreamStatus`, `GetRecordStatus`, `GetVirtualCamStatus`) every 1 second and reacts to OBS WebSocket events for real-time state.

**Auto-reconnect:** OBSContext uses exponential back-off (5 s → 60 s max) to reconnect if OBS disconnects.

**Controls in OBSControlPanel:**
- Start/Stop Stream (`ToggleStream`)
- Start/Stop Recording (`StartRecord` / `StopRecord`)
- Toggle Virtual Camera (`ToggleVirtualCam`)
- Auto-Record toggle — automatically starts recording when Live Player becomes visible, stops when it hides
- Live ↔ Loop quick-swap button
- OBS connection settings (host/port)

---

## 5. Player System

Each player card in React communicates with its paired OBS Browser Source HTML page via `localStorage` events. The React card writes a command to a known localStorage key; the HTML page reads it via the `storage` event listener.

### Communication Pattern

```
React PlayerCard  →  localStorage.setItem(key, JSON.stringify(command))
                      (key removed after 100 ms to allow re-fire)
        ↓
OBS Browser Source HTML  ←  window.addEventListener('storage', ...)
```

Reverse direction (HTML → React) uses the same pattern with a separate event key.

---

### Loop Player

**File:** `LoopPlayerCard.jsx` + `public/LoopPlayer.html`

**Purpose:** Plays a list of YouTube video IDs in sequence, looping forever. This is the background / fallback source always running in OBS.

**Features:**
- Comma-separated YouTube ID list input
- Auto-advances to next video when current ends (`videoEnded` storage event)
- Jump-to-index button
- Play / Pause / Stop / Next / Prev controls
- Playback state persisted to `localStorage['loopPlayerState']`
- Thumbnail and title loaded from YouTube oEmbed API

**LocalStorage key:** `loopPlayerEvent` (command), `loopPlayerState` (saved state)

---

### Live Player

**File:** `LivePlayerCard.jsx` + `public/LivePlayer.html`

**Purpose:** Plays a YouTube live stream (or any YouTube video ID). Intended to be the primary on-air source.

**Features:**
- Single video ID input with auto-play
- Priority mode: `matchSearchTerms` — the Live Monitor can auto-populate the video ID when it finds a matching live stream
- Auto-record integration: mirrors the Auto-Record toggle in OBSControlPanel (shared via `localStorage['liveAutoRecord']`)
- Recording file manager — lists files in `live_recordings/`, shows file size, allows deletion
- Auto-delete: keeps only N most recent recordings (configurable)
- Polling `/api/recordings/list` and `/api/recordings/delete`
- On video end → automatically switches OBS to Loop Player

**LocalStorage key:** `livePlayerEvent`, `livePlayerState`, `liveAutoRecord`

---

### Delay Live Player

**File:** `DelayPlayerCard.jsx` + `public/DelayLive.html`

**Purpose:** Plays a YouTube video from a specific start time to a specific end time — used to broadcast a pre-recorded or live-delayed segment with a custom window.

**Features:**
- Video ID + Start time (HH:MM:SS) + End time inputs
- Plays from `startTime` and pauses/ends at `endTime`
- On video end → hides Delay Live; if Live Player is not visible switches to Loop Player
- Thumbnail + title via oEmbed
- Playback state persisted to `localStorage['delayPlayerState']`

**LocalStorage key:** `delayLivePlayerEvent`, `delayPlayerState`

---

### Local PC Player

**File:** `LocalPlayerCard.jsx` + `public/LocalPCPlayer.html`

**Purpose:** Plays a locally-stored video playlist (MP4, MKV, AVI, MOV, WEBM, WMV). Designed for Katha and pre-recorded content.

**Features:**

| Feature | Details |
|---------|---------|
| **Auto-scan default folder** | Scans `videos/` next to EXE via `GET /api/videos/scan` |
| **Custom folder scan** | Enter any Windows path → `POST /api/videos/scan-folder` → returned as `/api/videos/serve?path=` URLs (never raw `file://`) |
| **Drag-drop from Windows Explorer** | Creates blob URLs in the browser |
| **File picker** | `showOpenFilePicker` or fallback `<input type="file">` |
| **Manual path input** | Type any path; Windows absolute paths are routed via `/api/videos/serve?path=` proxy |
| **Playlist reorder** | Drag rows up/down to reorder |
| **Per-item enable/disable** | Toggle each video ON/OFF; disabled videos are skipped automatically |
| **Proactive skip** | A `useEffect([playlist, currentIndex])` detects disabled current video and jumps immediately, without waiting for `videoEnded` |
| **Per-item play button** | Click to jump directly to any item |
| **Start / End time per video** | Uses H:MM format (hours:minutes, no seconds) |
| **End action per day** | Per day-of-week: when playlist ends, switch to a named OBS source |
| **Scheduler integration** | WebSocket triggers `local_player_start`, `local_player_stop`, `local_player_next` |
| **State persistence** | Playlist paths, index, play state saved to localStorage (blob: URLs cleared on save) |

**File proxy endpoint:** All local video files (from custom folder or typed paths) are served via:
```
GET /api/videos/serve?path=<encoded-absolute-path>
```
This supports HTTP range requests for seeking. Browsers can load these via `http://` without `file://` CORS restrictions.

**Time format:** Start/End fields accept `H:MM` (e.g. `1:30` = 1 hour 30 min). Display shows `HH:MM` (no seconds).

**LocalStorage key:** `localPCPlayerEvent`, `localPCPlayerState`, `localPCPlayerEndActions`

---

## 6. Scheduler System

The scheduler runs **server-side** in `scheduler-service.cjs`, not in the browser. This ensures triggers fire reliably even if the browser tab is minimized or hidden.

### Server Side (scheduler-service.cjs)

| Feature | Detail |
|---------|--------|
| **Tick interval** | 1 second — checks all schedules on each tick |
| **Persistence** | `data/schedules.json` |
| **Recurrence types** | `daily`, `weekly` (specific days), `once` |
| **Catch-up on restart** | If a schedule's `lastTriggered` is before the current expected window, it fires immediately on startup |
| **Deduplication** | `lastTriggered` timestamp prevents double-firing within the same minute |
| **Skip a day** | Individual schedules can be marked to skip the next occurrence |
| **Cancel skip** | Remove a pending skip |
| **Retry on failure** | Up to 3 retries with 5-second delay |
| **Alert system** | Generates alerts for missed triggers; broadcasts to WebSocket clients |
| **Execution history** | Keeps last 100 executions |
| **Health tracking** | `totalTriggers`, `totalMissed`, `totalSkipped`, `totalRetries` counters |

### Schedule Object

```json
{
  "id": "uuid",
  "title": "Morning Live",
  "time": "07:30",
  "source": "Live Player",
  "action": "show",
  "recurrence": "daily",
  "days": [1, 2, 3, 4, 5],
  "enabled": true,
  "lastTriggered": "2026-06-13T07:30:00.000Z",
  "skipNextOccurrence": false
}
```

### Actions

| Action | Effect |
|--------|--------|
| `show` | Makes OBS source visible |
| `hide` | Hides OBS source |
| `local_player_start` | Sends start command to Local PC Player |
| `local_player_stop` | Sends stop command to Local PC Player |
| `local_player_next` | Advances Local PC Player to next video |

### React Side (Scheduler.jsx + scheduler-api.js)

- Connects to WebSocket `/ws` for real-time trigger events and schedule list sync
- Handles `SCHEDULER_TRIGGER` → executes OBS visibility change or local player command
- Handles `SCHEDULER_TICK` → updates countdown timers
- Pending OBS triggers are queued if OBS is disconnected and replayed when reconnected (2-minute expiry)
- Time input: `type="text"` with auto-colon insertion (no AM/PM browser segments); validated and zero-padded before saving

---

## 7. Monitor System

### Live Monitor (MonitorManager)

**Files:** `MonitorManager.jsx`, `MonitorCard.jsx`

Monitors two YouTube channels for live or upcoming streams. Uses a local proxy API (`http://localhost:3000/api/...`) to fetch channel pages (avoids CORS). Polls every 30 seconds.

**Channels supported:**
- Swaminarayan (`UC7HQ3mzdsyvLU0Y7a2t3N7A`)
- Swaminarayan Bhagwan (`UCQXWP4gEdEwlb6vodwrU75A`)

**Features:**
- Detects both legacy `videoRenderer` format and new `lockupViewModel` (richGridRenderer) format from YouTube's internal data
- Filters by channel name via oEmbed verification
- Search term matching — each monitor has saved search terms; auto-loads a matching live video into the Live Player card
- Countdown timer to scheduled stream start
- One-click load into Live Player / Delay Player

**Saved state:** `savedSearchTitles1`, `savedSearchTitles2`, `liveSelectedChannelId` in localStorage.

---

### Katha Monitor

**File:** `KathaMonitor.jsx`

Monitors a YouTube channel for Katha (religious discourse) videos uploaded today or yesterday. Fetches video descriptions via `http://localhost:3000/api/video-description?videoId=` to extract the Mangla Charan timestamp.

**Features:**
- Filter modes: `today`, `yesterday`, `auto` (today if available, else yesterday)
- Extracts `Mangla Charan` / `Katha` timestamps from video description using regex
- Countdown to Mangla Charan time
- One-click load into Loop Player or Live Player with the Mangla Charan timestamp as `startTime`
- Filters by description content (not title) to find valid Katha videos

---

### Upcoming Event Monitor

**File:** `UpcomingEventMonitor.jsx`

Displays scheduled (premiere / upcoming) YouTube streams with a live countdown clock to their start time. Shares data with MonitorManager.

---

## 8. Settings & Backup System

**File:** `SettingsBackup.jsx`

### Manual JSON Export / Import

Export bundles:
- All server state (from `GET /api/settings/export`)
- All localStorage keys (loopPlayer, livePlayer, delayPlayer, localPCPlayer, monitors, etc.)
- Scheduler schedules

The downloaded file is a single `.json` which can be imported on another machine or after a fresh install.

> **Technical note:** The download uses `document.body.appendChild(a)` → `a.click()` → `document.body.removeChild(a)` → `setTimeout(URL.revokeObjectURL, 1000)` to ensure the browser initiates the download before the blob is revoked.

Import restores server state via `POST /api/settings/import` and writes localStorage keys directly.

### Server-Side Backups

Automatic and manual backups are stored in the `backups/` folder as JSON files. Managed via:

| Endpoint | Action |
|----------|--------|
| `GET /api/backups/list` | List all backup files with metadata |
| `POST /api/backups/save` | Create a manual backup |
| `POST /api/backups/restore/:filename` | Restore from a specific backup |
| `DELETE /api/backups/:filename` | Delete a backup |
| `GET /api/backups/auto-settings` | Get auto-backup schedule |
| `PUT /api/backups/auto-settings` | Set auto-backup schedule |

Auto-backup modes: every N hours, every N days, or on a specific day of the week.

---

## 9. Log System

**Files:** `src/utils/logger.js`, `LogViewer.jsx`

Logs are stored as monthly JSON files on the server: `logs/logs-YYYY-MM.json`.

### Log Entry Shape

```json
{
  "id": "1749876543210-abc12def",
  "timestamp": "2026-06-13T10:30:00.000+05:30",
  "date": "13 Jun 2026",
  "time": "10:30:00",
  "dayName": "Saturday",
  "level": "info",
  "type": "SOURCE_CHANGE",
  "category": "obs",
  "message": "Switched to Live Player",
  "data": { ... }
}
```

### Log Categories

| Category | What it captures |
|----------|-----------------|
| `obs` | OBS source visibility changes, connection events |
| `video` | Video load, play, end, error events |
| `scheduler` | Schedule triggers, alerts, missed triggers |
| `monitor` | Live monitor refresh, video found events |
| `katha` | Katha video refresh, load events |
| `system` | Server startup, errors |

### LogViewer Features

- Pagination (50 entries per page)
- Filter by month, category, type, text search
- Bulk select + delete
- Individual log expansion for full `data` object
- Auto-refresh toggle
- CSV export

---

## 10. Express Server & REST API

**File:** `server.cjs`  
**Port:** 3003 (EXE) / 3004 (dev)

### Video API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/videos/scan` | GET | List MP4/MKV/etc. in the default `videos/` folder |
| `/api/videos/scan-folder` | POST | List video files in any absolute folder path (body: `{ folderPath }`) |
| `/api/videos/root-folder` | GET | Return the path of the default videos folder |
| `/api/videos/serve` | GET | Stream any local video file by path (`?path=`) with HTTP range support |

### Scheduler API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scheduler/status` | GET | Health and running state |
| `/api/scheduler/start` | POST | Start the tick loop |
| `/api/scheduler/stop` | POST | Stop the tick loop |
| `/api/schedules` | GET | All schedules |
| `/api/schedules` | POST | Add schedule |
| `/api/schedules/:id` | PUT | Update schedule |
| `/api/schedules/:id` | DELETE | Delete schedule |
| `/api/schedules/:id/toggle` | POST | Enable/disable schedule |
| `/api/schedules/:id/fire` | POST | Fire a schedule immediately |
| `/api/schedules/:id/skip` | POST | Skip next occurrence |
| `/api/schedules/:id/cancel-skip` | POST | Cancel pending skip |
| `/api/schedules/import` | POST | Bulk replace all schedules |

### State API

Persistent server-side key-value store backed by a JSON file in `data/`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Get all state |
| `/api/state/:key` | GET | Get a single key |
| `/api/state/:key` | PUT | Set a key |
| `/api/state/:key` | PATCH | Merge into object key |
| `/api/state/:key` | DELETE | Delete a key |
| `/api/state/import` | POST | Bulk import from localStorage |
| `/api/state/reset` | POST | Reset to defaults |

### Settings API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings/export` | GET | Full settings JSON (state + schedules) |
| `/api/settings/import` | POST | Restore settings |

### Logs API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/logs` | GET | Paginated logs with filters |
| `/api/logs` | POST | Write a log entry |
| `/api/logs/months` | GET | Available log month keys |
| `/api/logs/:yearMonth` | DELETE | Delete all logs for a month |
| `/api/logs` | DELETE | Clear all logs |

### Recordings API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/recordings/list` | GET | List files in `live_recordings/` |
| `/api/recordings/delete` | DELETE | Delete a recording file |

### Backup API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/backups/list` | GET | All backup files |
| `/api/backups/save` | POST | Create backup |
| `/api/backups/restore/:filename` | POST | Restore backup |
| `/api/backups/:filename` | DELETE | Delete backup |
| `/api/backups/auto-settings` | GET/PUT | Auto-backup configuration |

---

## 11. WebSocket Architecture

The Express server maintains a WebSocket server at `/ws` using the `ws` package.

### Server → Client Messages

| Message Type | When | Payload |
|-------------|------|---------|
| `SCHEDULER_TICK` | Every 1 second | `{ nextTriggers, serverTime, isRunning, schedulesCount }` |
| `SCHEDULER_TRIGGER` | When a schedule fires | `{ id, action, source, title, ... }` |
| `SCHEDULER_STATUS` | On WS connect | Current scheduler status |
| `SCHEDULES_UPDATED` | After any schedule change | `{ schedules: [...] }` |
| `SCHEDULER_ALERT` | On missed/failed trigger | Alert object |
| `SCHEDULER_ALERTS` | On WS connect (if unacknowledged) | `{ alerts: [...] }` |
| `STATE_SYNC` | On WS connect | Full server state |
| `STATE_CHANGE` | On state mutation | `{ type, key, value }` |

### Client Usage

- **Scheduler.jsx** — receives `SCHEDULER_TRIGGER` and executes OBS actions or player commands; receives `SCHEDULER_TICK` for countdown timers
- **LocalPlayerCard.jsx** — receives `SCHEDULER_TRIGGER` with `local_player_start / stop / next` actions
- All components reconnect automatically with exponential back-off (1 s → 30 s)

### Dev Note

In development, Vite proxies `/ws` to `ws://localhost:3004` so `window.location.host` (which Vite serves on port 3003) connects to the correct Express WebSocket server.

---

## 12. State Management

### React State (in-memory)

Each player card manages its own state via `useState` + `useRef` pairs. Refs are used alongside state to prevent stale closures in:
- `storage` event listeners (added once at mount)
- WebSocket message handlers
- `setTimeout` / `setInterval` callbacks
- `advanceToNext` logic (reads `playlistRef`, `currentIndexRef`, `isPlayingRef`, etc.)

### localStorage (browser persistence)

Player state (current video, playlist, play/pause/stop flags) is saved to localStorage on every relevant state change. Loaded on mount. This survives page refresh within the same browser session.

### Server State (StateService)

`state-service.cjs` provides a persistent JSON-backed key-value store for settings that need to survive EXE restarts and be shared across browser sessions:
- OBS connection settings
- Player configuration that needs server-level persistence

### Scheduler State

Schedules are persisted in `data/schedules.json` by SchedulerService and reloaded on server restart.

---

## 13. LocalStorage Keys

| Key | Owner | Content |
|-----|-------|---------|
| `loopPlayerState` | LoopPlayerCard | `{ playlist, currentIndex, isPlaying, isMuted, isStopped }` |
| `loopPlayerEvent` | LoopPlayer ↔ LoopPlayer.html | Player commands |
| `livePlayerState` | LivePlayerCard | `{ videoId, isPlaying, isMuted, isStopped }` |
| `livePlayerEvent` | LivePlayer ↔ LivePlayer.html | Player commands |
| `delayPlayerState` | DelayPlayerCard | `{ videoId, startTime, endTime, ... }` |
| `delayLivePlayerEvent` | DelayPlayer ↔ DelayLive.html | Player commands |
| `localPCPlayerState` | LocalPlayerCard | `{ playlist, currentIndex, isPlaying, isMuted, isStopped }` |
| `localPCPlayerEvent` | LocalPlayer ↔ LocalPCPlayer.html | Player commands |
| `localPCPlayerEndActions` | LocalPlayerCard | `[null, null, ..., null]` (7 days) |
| `obsSettings` | OBSContext | `{ host, port }` |
| `obsActiveSource` | OBSContext | Last active source name |
| `liveAutoRecord` | OBSControlPanel + LivePlayerCard | `true / false` |
| `liveMonitorEnabled1` | App | Monitor 1 show/hide |
| `liveMonitorEnabled2` | App | Monitor 2 show/hide |
| `savedSearchTitles1` | MonitorManager | Search terms for monitor 1 |
| `savedSearchTitles2` | MonitorManager | Search terms for monitor 2 |
| `liveSelectedChannelId` | MonitorManager | Selected YouTube channel |

---

## 14. Build & Packaging

### Scripts

```bash
npm run dev          # Vite dev server on port 3003
npm run dev:api      # Express server on port 3004
npm run build        # Vite production build → dist/
npm run build:exe    # build + pkg → live-tv-controller.exe
```

### pkg Configuration

```json
{
  "pkg": {
    "assets": ["dist/**/*"],
    "outputPath": "."
  }
}
```

The `dist/` folder (React build output) is bundled as assets into the EXE. The server detects the EXE context via `process.pkg`:

```js
const PORT = process.env.PORT || (process.pkg ? 3003 : 3004);
const dataDir = process.pkg
    ? path.join(path.dirname(process.execPath), 'data')
    : path.join(__dirname, 'data');
```

All runtime directories (`data`, `logs`, `videos`, `live_recordings`, `backups`) use `path.dirname(process.execPath)` as the base when running as EXE, so they live next to the EXE file and are writable.

### Vite Config

```js
server: {
  port: 3003,
  proxy: {
    '/api':    { target: 'http://localhost:3004', changeOrigin: true },
    '/videos': { target: 'http://localhost:3004', changeOrigin: true },
    '/ws':     { target: 'ws://localhost:3004', ws: true, changeOrigin: true },
  }
}
```

The proxy makes all three paths (REST, static video files, WebSocket) reach Express in dev mode, giving identical behaviour to the EXE build.

---

## 15. Data & File Directories

| Directory | Purpose | EXE Location | Dev Location |
|-----------|---------|--------------|--------------|
| `data/` | `schedules.json`, server state JSON | Next to EXE | `live-tv-controller-react/data/` |
| `logs/` | `logs-YYYY-MM.json` monthly log files | Next to EXE | `live-tv-controller-react/logs/` |
| `videos/` | Default local video folder (scanned by Local Player) | Next to EXE | `live-tv-controller-react/videos/` |
| `live_recordings/` | OBS recording files managed by LivePlayerCard | Next to EXE | `live-tv-controller-react/live_recordings/` |
| `backups/` | Settings backup JSON files | Next to EXE | `live-tv-controller-react/backups/` |

---

## 16. Key Technical Decisions

### localStorage as IPC between React and OBS Browser Sources

OBS Browser Sources run their HTML pages in Chromium. When both the React app and the OBS browser source are opened from the same origin (`http://localhost:3003`), they share `localStorage`. A storage event on one tab fires on all other tabs/windows with the same origin — giving zero-latency IPC without any additional server round-trip.

Commands are written then deleted after 100 ms to allow the same command to be fired again without the storage event being suppressed (browsers suppress events when the value hasn't changed).

### Server-side Scheduler vs Browser Timers

Browser `setTimeout`/`setInterval` are throttled when the tab is hidden (Chrome throttles to 1 Hz minimum). A schedule set for 07:30 would miss its window if the browser is minimized. The server-side 1-second tick loop in `scheduler-service.cjs` runs independently of browser tab visibility, ensuring schedules always fire on time.

### File Proxy for Local Videos

Windows absolute paths (`C:\...`) cannot be loaded from `http://` origins via `file://` URLs due to browser CORS restrictions. All local video files are served through:

```
GET /api/videos/serve?path=<URL-encoded-absolute-path>
```

This endpoint supports HTTP `Range` headers, which the `<video>` element requires for seeking. The Express server streams the file directly from disk, so no memory buffering occurs.

### Stale Closure Prevention

All async callbacks (storage event listeners, WebSocket handlers, timeouts) that need current React state use either:
1. **Refs** — `playlistRef`, `currentIndexRef`, `isPlayingRef` — kept in sync by `useEffect` pairs
2. **Functional state updates** — `setPlaylist(prev => ...)` — always receives the current state regardless of when the closure was created

This prevents the classic React stale closure bug where event handlers read old state values.

### Time Format: H:MM for Local Player

The Local Player uses `H:MM` (hours:minutes, no seconds) for start/end times to match how broadcast operators think about long-form content. `timeHMToSeconds` parses this format (and also H:MM:SS for precision). `secondsToHM` formats display output as `HH:MM`.

Other players use `HH:MM:SS` (`timeToSeconds` / `secondsToHMS`) for YouTube segment precision.

### Scheduler Time Input

The browser's native `<input type="time">` shows AM/PM segments on Windows Chrome that can't be removed via CSS. The Scheduler uses `<input type="text" maxLength={5}>` with an auto-colon insertion handler and a `normalizeTime()` validator that zero-pads and range-checks before saving (`"9:5"` → `"09:05"`).
