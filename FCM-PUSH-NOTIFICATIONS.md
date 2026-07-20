# Firebase FCM Push Notifications — Full Feature Plan

> Generated: 2026-06-29
> Project: Live TV Controller (`live-tv-controller-react`)
> Status: **HISTORICAL — the feature is implemented and has since evolved.** This document is the original design plan, kept for context. For current behavior see `FEATURES-REPORT.md` §8 and `live-tv-controller-react/PROJECT.md` §8; for fixing problems see `TROUBLESHOOTING.md` §3. Notable post-plan changes: `SCHEDULER_TRIGGER_FAILED` template + confirm-before-notify flow, delete-by-deviceId, tunnel health checks, `sendTest()` surfacing FCM rejections, `firebase-admin` pinned to ^12.7.0 for pkg.

---

## Table of Contents

1. [Project Context](#1-project-context)
2. [Existing Backend Architecture](#2-existing-backend-architecture)
3. [Existing Frontend Architecture](#3-existing-frontend-architecture)
4. [Event Sources That Can Trigger Notifications](#4-event-sources-that-can-trigger-notifications)
5. [Firebase Integration Requirements](#5-firebase-integration-requirements)
6. [Device Registration Flow](#6-device-registration-flow)
7. [Notification Service Design](#7-notification-service-design)
8. [Database / Persistence Changes](#8-database--persistence-changes)
9. [API Design](#9-api-design)
10. [Security](#10-security)
11. [Scalability](#11-scalability)
12. [Browser Support](#12-browser-support)
13. [Folder Changes Summary](#13-folder-changes-summary)
14. [Firebase Setup Plan](#14-firebase-setup-plan)
15. [Environment Variables](#15-environment-variables)
16. [Step-by-Step Implementation Roadmap](#16-step-by-step-implementation-roadmap)

---

## 1. Project Context

**Live TV Controller** is a single-operator LAN tool running on Windows.

| Service | Port | Purpose |
|---|---|---|
| `live-tv-api` | 3000 | YouTube data API proxy (Piped → Scrape → RSS waterfall) |
| `live-tv-controller-react` | 3004 | React UI + Express + WebSocket + Scheduler |

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19.2, Vite 7.2, Tailwind CSS 3.4 |
| Backend | Node.js 18+, Express 4.18, ws 8.19 |
| Persistence | Atomic JSON files (no database) |
| External | OBS WebSocket, yt-dlp, YouTube API (no key) |
| Build | Vite → dist/, pkg → .exe, PM2 |

---

## 2. Existing Backend Architecture

### `server.cjs` (1809 lines) — Express + WebSocket hybrid

- Runs on a **single port (3004)** in production
- **46 REST endpoints** organized by domain
- **WebSocket server** (`ws`) on same port for real-time events
- All broadcasts: `{ type, data, timestamp }` envelope
- Dead-client cleanup every 30 seconds
- Memory monitoring: warn at 300 MB, critical at 1000 MB
- Graceful shutdown: auto-backup on SIGINT

### `scheduler-service.cjs` (46 KB) — 1-second heartbeat loop

- Checks each enabled schedule every second
- Three callback hooks already wired: `onTrigger`, `onLog`, `onAlert`
- Execution tracking prevents double-fires; catches up missed triggers on restart
- Retry queue: 5 consecutive failures → `onAlert` fires

### `state-service.cjs` — Key-value persistence

- 20+ keys persisted (`player.live`, `monitor.1.enabled`, etc.)
- State changes broadcast as `STATE_CHANGE` WebSocket messages
- Atomic writes with `.bak` recovery file

### `logger.js` (453 lines) — Structured event logging

```js
{
  timestamp, date, time, dayName,
  level: "info" | "warn" | "error" | "debug",
  type: LogType,       // enum (VIDEO_LOAD, SCHEDULER_TRIGGER, ...)
  category: LogCategory, // enum (VIDEO, SCHEDULER, SYSTEM, ...)
  message: string,
  data: object
}
```

Persisted to monthly `logs/logs-YYYY-MM.json` files via `POST /api/log`.

### Existing WebSocket Message Types

| Type | When |
|---|---|
| `SCHEDULER_TICK` | Every 1 second |
| `SCHEDULER_TRIGGER` | Schedule fires |
| `SCHEDULER_ALERT` | Retry limit exceeded |
| `SCHEDULES_UPDATED` | CRUD on schedules |
| `STATE_CHANGE` | Any state key mutated |
| `STATE_SYNC` | Initial client connection |
| `RECORDING_EVENT` | Recording log lines |
| `RECORDING_STATUS` | Recording state change |
| `FLUSH_STATE_FOR_BACKUP` | Pre-auto-backup |

**New types added by this feature:** `NOTIFICATION_SENT`, `NOTIFICATION_ERROR`

### Atomic Write Pattern (existing — replicate for new files)

```
1. Write to .tmp file
2. Validate .tmp is valid JSON
3. Rename existing → .bak
4. Rename .tmp → main file
5. Keep .bak for recovery
```

---

## 3. Existing Frontend Architecture

### Component Hierarchy (18 components)

```
App.jsx
├── OBSControlPanel.jsx       ← OBS stream/record control
├── LivePlayerCard.jsx        ← YouTube live player + auto-record
├── MonitorManager.jsx        ← N live event monitors
├── KathaMonitor.jsx          ← Content refresh monitor
├── Scheduler.jsx             ← Schedule CRUD + status
├── PlayerManager.jsx         ← Multi-player layout
│   ├── LoopPlayerCard.jsx
│   ├── DelayPlayerCard.jsx
│   └── LocalPlayerCard.jsx
├── SettingsBackup.jsx        ← Backup/restore UI
└── LogViewer.jsx             ← Log display
```

### State Management (3 layers)

| Layer | Where | What |
|---|---|---|
| `OBSContext` | `context/OBSContext.jsx` | OBS WebSocket, reconnect, source toggling |
| `useAppState` hook | `hooks/useAppState.js` | Server state sync via `/api/state/*` |
| `localStorage` | Browser | Quick UI state + inter-tab events |

### Frontend API Layer

| Module | Purpose |
|---|---|
| `scheduler-api.js` | REST calls + WebSocket subscription via `addWsListener()` |
| `state-api.js` | GET/PUT/PATCH/DELETE `/api/state/:key` |
| `logger.js` | Structured log POSTs to `/api/log` |

### Current PWA / Service Worker Status

- No `manifest.json` — **none exists**
- No service worker files — **none exist**
- No `Notification.requestPermission()` calls — **clean slate**

**Best registration point:** `src/main.jsx` — runs once, is the correct global init location.

---

## 4. Event Sources That Can Trigger Notifications

### Server-Side (hook already available)

| Event | File | Hook |
|---|---|---|
| Schedule triggered | `scheduler-service.cjs` | `onTrigger` callback |
| Scheduler alert (retry overflow) | `scheduler-service.cjs` | `onAlert` callback |
| Recording started | `server.cjs` | POST `/api/recording/start` handler |
| Recording stopped | `server.cjs` | POST `/api/recording/stop` handler |
| Recording error | `server.cjs` | RECORDING_EVENT broadcast |
| Auto-backup completed | `server.cjs` | auto-backup routine |
| Manual backup completed | `server.cjs` | POST `/api/backup/manual` handler |
| OBS status change | `server.cjs` | POST `/api/obs/status` handler |
| Memory warning (300 MB) | `server.cjs` | memory monitor |
| Memory critical (1000 MB) | `server.cjs` | memory monitor |

### Frontend-Initiated (promote via new `POST /api/notify` endpoint)

| Event | Component |
|---|---|
| Monitor detected new live stream | `MonitorManager.jsx` |
| Upcoming event is imminent | `UpcomingEventMonitor.jsx` |
| Local player finished playlist | `LocalPlayerCard.jsx` |

### Future Events (zero infrastructure change required)

- OBS scene changed
- yt-dlp download completed
- Scheduler enabled / disabled
- Config import / export completed
- System restart / startup

---

## 5. Firebase Integration Requirements

### Required SDKs

| SDK | Location | Purpose |
|---|---|---|
| `firebase` v10+ | `live-tv-controller-react/package.json` | Token generation, foreground message handler |
| `firebase-admin` v12+ | `live-tv-controller-react/package.json` | Server-side send via FCM HTTP v1 API |

### Frontend Files

| File | Purpose |
|---|---|
| `src/firebase-config.js` | Firebase app init with env vars |
| `src/services/fcm.js` | Permission, token gen, refresh listener, foreground handler |
| `src/main.jsx` (modify) | Import + call `initFCM()` once |
| `public/firebase-messaging-sw.js` | Background push handler (must be at root) |
| `public/manifest.json` | PWA manifest (required for Chrome push) |

### Backend Files

| File | Purpose |
|---|---|
| `notification-service.cjs` | Firebase Admin init, send, retry, templates |
| `token-store.cjs` | Atomic read/write for `data/fcm-tokens.json` |
| `server.cjs` (modify) | Add 7 new routes, import new services |
| `scheduler-service.cjs` (modify) | Call `sendNotification()` in `onTrigger` + `onAlert` |

### Build Changes

- Add `define` block in `vite.config.js` to expose `VITE_FIREBASE_*` vars (or rely on Vite's built-in `import.meta.env` — no change needed if vars are prefixed correctly)
- Express must serve `public/` as static alongside `dist/` — one `app.use(express.static(...))` line

---

## 6. Device Registration Flow

```
Browser opens app
  │
  ▼
src/services/fcm.js  →  Firebase app init
  │
  ▼
Check localStorage: "fcm_permission_status"
  │
  ├── Not yet asked
  │     Show inline UI prompt (not browser native):
  │     "Enable notifications for scheduler alerts?"
  │     [Enable]  [Not now]
  │
  ▼
User clicks Enable
  │
  ▼
Notification.requestPermission()
  │
  ├── "granted"
  │     getToken(messaging, { vapidKey: VITE_FIREBASE_VAPID_KEY })
  │       │
  │       ▼
  │     POST /api/notifications/register
  │     { token, deviceName, userAgent }
  │       │
  │       ▼
  │     token-store.cjs  →  upsert into fcm-tokens.json
  │       │
  │       ▼
  │     200 OK
  │     localStorage "fcm_permission_status" = "granted"
  │     localStorage "fcm_token" = "<token>"
  │
  ├── "denied"
  │     localStorage "fcm_permission_status" = "denied"
  │     Do not ask again
  │
  └── Error
        logger.js log at warn level
        Retry after 60s (max 3 attempts)

Token Refresh (app lifetime listener):
  onTokenRefresh → POST /api/notifications/register (upsert, same id)

Invalid Token Cleanup (server-side, automatic):
  FCM returns "registration-token-not-registered"
  → token-store.cjs.removeToken(token)
```

---

## 7. Notification Service Design

### `notification-service.cjs` Architecture

```
NotificationService
├── init(config)                   ← called once at server startup
│
├── send(event, data)              ← main public entry point
│   ├── loadTokens()               ← token-store.getTokens()
│   ├── filterByPreferences(event) ← check notifications.settings
│   ├── buildPayload(event, data)  ← template lookup
│   ├── sendBatch(tokens, payload) ← FCM sendEachForMulticast (500/batch)
│   ├── handleResults(results)     ← auto-delete invalid tokens
│   └── log(result)                ← logger.js NOTIFICATION_SENT/ERROR
│
└── retry logic:
    Attempt 1 → immediate
    Attempt 2 → wait 1 second
    Attempt 3 → wait 2 seconds
    Max 3 attempts per event
    Retry: 5xx + network errors only
    No retry on 400 (invalid token) → delete immediately
```

### Provider Abstraction (future-proof)

```js
class NotificationProvider {
  async send(tokens, payload) { throw new Error('abstract'); }
}

class FCMProvider extends NotificationProvider {
  async send(tokens, payload) { /* Firebase Admin sendEachForMulticast */ }
}

// Future:
// class WebPushProvider extends NotificationProvider { ... }
// class SlackProvider extends NotificationProvider { ... }
```

### Notification Templates

```js
const TEMPLATES = {
  SCHEDULER_TRIGGER: {
    title: (d) => `Scheduler: ${d.scheduleName}`,
    body:  (d) => `Action "${d.action}" fired at ${d.time}`,
    icon:  '/icon-192.png',
    tag:   'scheduler-trigger',    // replaces previous same-tag notification
  },
  SCHEDULER_ALERT: {
    title: () => 'Scheduler Alert',
    body:  (d) => `"${d.scheduleName}" failed ${d.retries} times`,
    icon:  '/icon-192.png',
    tag:   'scheduler-alert',
  },
  RECORDING_STARTED: {
    title: () => 'Recording Started',
    body:  (d) => `Recording: ${d.filename}`,
    icon:  '/icon-192.png',
    tag:   'recording',
  },
  RECORDING_STOPPED: {
    title: () => 'Recording Stopped',
    body:  (d) => `Saved: ${d.filename}`,
    icon:  '/icon-192.png',
    tag:   'recording',
  },
  RECORDING_ERROR: {
    title: () => 'Recording Error',
    body:  (d) => d.message,
    icon:  '/icon-192.png',
    tag:   'recording-error',
  },
  BACKUP_COMPLETED: {
    title: () => 'Backup Complete',
    body:  (d) => `${d.type} backup saved`,
    icon:  '/icon-192.png',
    tag:   'backup',
  },
  MEMORY_WARNING: {
    title: () => 'Memory Warning',
    body:  (d) => `Server memory at ${d.mb} MB`,
    icon:  '/icon-192.png',
    tag:   'memory',
  },
  MONITOR_LIVE: {
    title: (d) => `Live: ${d.channelName}`,
    body:  (d) => d.title,
    icon:  '/icon-192.png',
    tag:   'monitor-live',
  },
};
```

---

## 8. Database / Persistence Changes

No new database engine. Follows existing atomic JSON file pattern.

### `data/fcm-tokens.json` (new)

```json
{
  "version": 1,
  "lastModified": "2026-06-29T00:00:00.000Z",
  "tokens": [
    {
      "id": "uuid-v4",
      "token": "fcm-token-string",
      "deviceName": "Chrome on Windows",
      "userAgent": "Mozilla/5.0 ...",
      "registeredAt": "2026-06-29T00:00:00.000Z",
      "lastSeenAt": "2026-06-29T00:00:00.000Z",
      "active": true
    }
  ]
}
```

### `data/notification-history.json` (new, optional)

Enable with `NOTIFICATION_HISTORY=true` env var.

```json
{
  "version": 1,
  "maxEntries": 500,
  "entries": [
    {
      "id": "uuid-v4",
      "sentAt": "2026-06-29T00:00:00.000Z",
      "event": "SCHEDULER_TRIGGER",
      "title": "Scheduler: Morning Show",
      "body": "Action fired at 06:00",
      "tokensAttempted": 2,
      "tokensSucceeded": 2,
      "tokensFailed": 0
    }
  ]
}
```

### `token-store.cjs` API

```js
getTokens()             // → token[]
upsertToken(data)       // insert or update by token string
removeToken(tokenStr)   // delete by token string
pruneInactive()         // remove tokens inactive > 30 days
```

Notification event preferences stored in `app-state.json` under key `notifications.settings` — uses existing StateService, zero new infrastructure.

---

## 9. API Design

All routes follow existing Express patterns — JSON body, consistent error shape `{ error: string }`.

### New Routes: `/api/notifications/*`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/notifications/register` | Register or refresh a device token |
| `DELETE` | `/api/notifications/register` | Remove a device token |
| `GET` | `/api/notifications/devices` | List all registered devices |
| `POST` | `/api/notifications/test` | Send test notification to a token |
| `GET` | `/api/notifications/history` | Paginated notification history |
| `GET` | `/api/notifications/settings` | Get per-event preferences |
| `PUT` | `/api/notifications/settings` | Update per-event preferences |

### Request / Response Shapes

**POST /api/notifications/register**
```json
Request:  { "token": "...", "deviceName": "Chrome on Windows", "userAgent": "..." }
Response: { "id": "uuid-v4", "registered": true }
```

**DELETE /api/notifications/register**
```json
Request:  { "token": "..." }
Response: { "removed": true }
```

**GET /api/notifications/devices**
```json
Response: {
  "devices": [
    { "id": "...", "deviceName": "...", "registeredAt": "...", "lastSeenAt": "...", "active": true }
  ]
}
```

**POST /api/notifications/test**
```json
Request:  { "token": "..." }
Response: { "sent": true }
```

**GET /api/notifications/history**
```
Query: ?limit=20&offset=0
Response: { "total": 140, "entries": [...] }
```

**GET /api/notifications/settings**
```json
{
  "enabled": true,
  "events": {
    "SCHEDULER_TRIGGER":  true,
    "SCHEDULER_ALERT":    true,
    "RECORDING_STARTED":  true,
    "RECORDING_STOPPED":  true,
    "RECORDING_ERROR":    true,
    "BACKUP_COMPLETED":   false,
    "MEMORY_WARNING":     true,
    "MONITOR_LIVE":       true
  }
}
```

---

## 10. Security

### Token Validation

- Backend treats FCM token strings as opaque — never trusts them as identity
- Invalid tokens returned by FCM are auto-deleted from `fcm-tokens.json`
- Token strings are never fully logged — only the first 20 characters for debugging

### Authentication

- Project is a single-operator LAN tool with no existing auth layer
- Optional: set `NOTIFICATIONS_SECRET` env var → all `/api/notifications/*` routes require `Authorization: Bearer <secret>` header
- Disabled by default; existing routes unaffected

### Abuse Prevention

- `POST /api/notifications/register` — rate limit: 10 requests / 60 seconds / IP (in-memory counter)
- `POST /api/notifications/test` — rate limit: 3 requests / 60 seconds / token
- Max stored tokens: 50 (env: `MAX_FCM_TOKENS=50`) — oldest inactive tokens pruned first

### Device Ownership

- All registered devices receive all notifications (appropriate for single-operator tool)
- Future: `deviceSecret` UUID generated at registration, stored in `localStorage`, required for `DELETE /api/notifications/register`

### Firebase Admin SDK

- Service account JSON never exposed to frontend
- `FIREBASE_PRIVATE_KEY` stored in `.env` only (already gitignored)
- Admin SDK initialized lazily on first send — missing credentials fail gracefully with logged error, server does not crash

---

## 11. Scalability

### Direct Send vs Queue

**Decision: Direct send** — single operator, ≤50 tokens, FCM `sendEachForMulticast` handles batching in one HTTP call. Message queue (Redis, Bull) not justified. Provider abstraction allows switching later.

### Retry Strategy

```
Attempt 1 → immediate
Attempt 2 → 1 second delay
Attempt 3 → 2 seconds delay
Max 3 attempts, then log NOTIFICATION_ERROR

Retry on: 5xx responses, network errors
No retry on: 400 INVALID_ARGUMENT → delete token immediately
```

### Batching

- FCM `sendEachForMulticast`: up to 500 tokens per call
- Tokens chunked into groups of 500 (unlikely to be needed, but implemented correctly)

### Topic Notifications (future)

Subscribe clients to FCM topics (`/topics/scheduler`) to avoid managing token lists. Defer until multi-user scenario.

### Worker Architecture

No separate worker process needed. Notification sends are async + non-blocking (`await sendNotification()`) inside existing scheduler hooks. Single HTTP call to FCM — negligible overhead on the 1-second loop.

---

## 12. Browser Support

| Browser | Push Support | Notes |
|---|---|---|
| Chrome 50+ | Full | Service worker + FCM background push |
| Edge 79+ (Chromium) | Full | Identical to Chrome |
| Android Chrome | Full | Works even when browser is closed |
| PWA (installed) | Full | Best experience — persistent service worker |
| Firefox 44+ | Partial | FCM not supported; uses Mozilla Push Service. Firebase SDK does not support Firefox push. Foreground messaging works. |
| Safari 16.1+ | Partial | Web Push via APNs bridge. Requires APNs Auth Key in Firebase console. |
| Safari < 16.1 | None | No Web Push support |

### Graceful Degradation

```js
if (!('PushManager' in window) || !('Notification' in window)) {
  // Show one-time message: "Notifications not supported in this browser"
  // App remains fully functional
  return;
}
```

---

## 13. Folder Changes Summary

```
live-tv-controller-react/
│
├── notification-service.cjs          ← NEW
├── token-store.cjs                   ← NEW
│
├── src/
│   ├── main.jsx                      ← MODIFY: import + call initFCM()
│   ├── firebase-config.js            ← NEW
│   ├── services/
│   │   └── fcm.js                    ← NEW
│   └── components/
│       └── NotificationSettings.jsx  ← NEW
│
├── public/
│   ├── firebase-messaging-sw.js      ← NEW (served from root, not dist/)
│   ├── manifest.json                 ← NEW
│   ├── icon-192.png                  ← NEW
│   └── icon-512.png                  ← NEW
│
├── data/
│   ├── fcm-tokens.json               ← NEW
│   └── notification-history.json     ← NEW (optional, env flag)
│
└── server.cjs                        ← MODIFY: 7 new routes + service imports
    scheduler-service.cjs             ← MODIFY: onTrigger + onAlert hooks only
```

**Files replaced:** none  
**Files modified:** `server.cjs`, `src/main.jsx`, `scheduler-service.cjs`  
**Files added:** 10 new files

---

## 14. Firebase Setup Plan

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a new Firebase project (or use existing)
3. Add a **Web App** — copy the config object (apiKey, authDomain, projectId, etc.)
4. In Project Settings → Cloud Messaging:
   - Enable Cloud Messaging
   - Generate a **VAPID Key** (Web Push certificates tab) → `VITE_FIREBASE_VAPID_KEY`
5. In Project Settings → Service Accounts:
   - Click **Generate new private key** → download JSON
   - Extract `project_id` → `FIREBASE_PROJECT_ID`
   - Extract `client_email` → `FIREBASE_CLIENT_EMAIL`
   - Extract `private_key` → `FIREBASE_PRIVATE_KEY`
6. *(Optional — Safari support)*: In Cloud Messaging → APNs Authentication Key, upload Apple APNs Auth Key

---

## 15. Environment Variables

Add to `.env` at repo root:

```env
# ── Firebase Frontend (exposed to Vite bundle) ──────────────────────────
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_VAPID_KEY=

# ── Firebase Backend (server-side only, never in bundle) ─────────────────
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# ── Notification Feature Flags ────────────────────────────────────────────
NOTIFICATION_HISTORY=false        # Set true to enable history persistence
MAX_FCM_TOKENS=50                 # Max stored device tokens
NOTIFICATIONS_SECRET=             # Optional: require Bearer token on /api/notifications/*
```

---

## 16. Step-by-Step Implementation Roadmap

### Phase 1 — Foundation (no Firebase yet)

- [ ] Create `token-store.cjs` — atomic JSON persistence (mirror state-service pattern)
- [ ] Create `data/fcm-tokens.json` — empty initial file
- [ ] Add `public/` as a static directory in `server.cjs` (`app.use(express.static('public'))`)
- [ ] Add `public/manifest.json` — minimal PWA manifest
- [ ] Add `public/icon-192.png` + `public/icon-512.png`
- [ ] Add 7 stub routes in `server.cjs` (return `{ ok: true }` for now)

### Phase 2 — Backend FCM

- [ ] `npm install firebase-admin` in `live-tv-controller-react/`
- [ ] Create `notification-service.cjs` with provider abstraction + FCM implementation
- [ ] Add template definitions for all 8 event types
- [ ] Wire `sendNotification('SCHEDULER_TRIGGER', data)` into `onTrigger` in `scheduler-service.cjs`
- [ ] Wire `sendNotification('SCHEDULER_ALERT', data)` into `onAlert` in `scheduler-service.cjs`
- [ ] Wire into recording start/stop/error handlers in `server.cjs`
- [ ] Wire into backup complete handler in `server.cjs`
- [ ] Wire into memory warning handler in `server.cjs`
- [ ] Complete stub API routes with real service calls
- [ ] Test via `curl -X POST http://localhost:3004/api/notifications/test -d '{"token":"..."}'`

### Phase 3 — Frontend FCM

- [ ] `npm install firebase` in `live-tv-controller-react/`
- [ ] Add all `VITE_FIREBASE_*` vars to `.env`
- [ ] Create `src/firebase-config.js` — Firebase app init
- [ ] Create `src/services/fcm.js` — permission, token, refresh, foreground message handler
- [ ] Create `public/firebase-messaging-sw.js` — background push handler
- [ ] Modify `src/main.jsx` — import + call `initFCM()` after React root render
- [ ] Test: open browser → grant permission → verify token appears in `data/fcm-tokens.json`
- [ ] Test: send test notification → verify it appears in browser

### Phase 4 — Settings UI

- [ ] Create `src/components/NotificationSettings.jsx`
  - Device list table (name, registered date, last seen, remove button)
  - "Send test notification" button
  - Event type toggles (per TEMPLATES map)
  - Enable/disable all toggle
- [ ] Mount inside `SettingsBackup.jsx` as a new section, or new tab in `App.jsx`
- [ ] Wire `GET/PUT /api/notifications/settings` to the toggle state

### Phase 5 — Hardening

- [ ] Add rate limiting to `POST /api/notifications/register` (10/min/IP)
- [ ] Add rate limiting to `POST /api/notifications/test` (3/min/token)
- [ ] Add `pruneInactive()` call on server startup (remove tokens > 30 days stale)
- [ ] Add `MAX_FCM_TOKENS` enforcement in `token-store.cjs`
- [ ] Add optional `NOTIFICATIONS_SECRET` Bearer check middleware
- [ ] Enable `notification-history.json` persistence behind `NOTIFICATION_HISTORY` flag
- [ ] Test Firefox graceful degradation (no crash, "not supported" message)
- [ ] Test Safari 16.1+ with APNs key (if Safari devices in use)
- [ ] Test service worker lifecycle: update, reinstall, background message
- [ ] Test background notification when browser tab is closed

---

## Notes

- No existing architecture is restructured — all changes are additive
- Backward compatibility is fully maintained — existing 46 routes unchanged
- The provider abstraction means swapping from FCM to another push provider is a one-module change
- Notification preferences stored under existing `app-state.json` key `notifications.settings` — zero new state infrastructure needed for preferences
