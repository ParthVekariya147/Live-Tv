# FCM Push Notifications — Parallel Build Plan

> Project: Live TV Controller (`live-tv-controller-react`)
> Strategy: Two independent tracks (Backend + Frontend) run in parallel, then merge.
> Execution: Fully autonomous — no prompts, no confirmations, continuous until done.
> Status: **HISTORICAL — executed and complete.** Kept for context only; current behavior is documented in `FEATURES-REPORT.md` §8 and `TROUBLESHOOTING.md` §3.

---

## Execution Rules for Claude Code Agents

```
RULE 1 — Never stop to ask a question. If something is unclear, make a decision and continue.
RULE 2 — Never skip an auto-test. Each phase ends with mandatory verification.
RULE 3 — If a test fails, fix it before marking the phase complete. Do not move on.
RULE 4 — Do not rewrite files outside your assigned scope. Other agents own other files.
RULE 5 — Mark each task complete the moment it finishes. Do not batch.
RULE 6 — Read FCM-PUSH-NOTIFICATIONS.md before writing any code for design reference.
RULE 7 — Keep backward compatibility. Existing 46 API routes must continue to work.
```

---

## Pre-requisites (Human action required before starting agents)

Fill in `.env` at the repo root. These values come from the Firebase Console:

```
Step 1 — Create Firebase project
  → https://console.firebase.google.com
  → Add Web App → copy SDK config object

Step 2 — Fill VITE_FIREBASE_* vars in .env
  VITE_FIREBASE_API_KEY           = "AIza..."
  VITE_FIREBASE_AUTH_DOMAIN       = "your-project.firebaseapp.com"
  VITE_FIREBASE_PROJECT_ID        = "your-project-id"
  VITE_FIREBASE_STORAGE_BUCKET    = "your-project.appspot.com"
  VITE_FIREBASE_MESSAGING_SENDER_ID = "123456789"
  VITE_FIREBASE_APP_ID            = "1:123:web:abc..."

Step 3 — Generate VAPID key
  → Firebase Console → Project Settings → Cloud Messaging
  → Web Push certificates → Generate key pair
  VITE_FIREBASE_VAPID_KEY         = "BNJ..."

Step 4 — Generate service account
  → Firebase Console → Project Settings → Service Accounts
  → Generate new private key → download JSON
  FIREBASE_PROJECT_ID             = (from JSON: project_id)
  FIREBASE_CLIENT_EMAIL           = (from JSON: client_email)
  FIREBASE_PRIVATE_KEY            = (from JSON: private_key — keep \n as literal \n)

Step 5 — (Optional, Safari support)
  → Firebase Console → Project Settings → Cloud Messaging
  → Apple app configuration → upload APNs Auth Key
```

Once `.env` is filled in, agents can start. Both Track A and Track B start simultaneously.

---

## Parallel Execution Map

```
START
  │
  ├─── Track A (Backend) ────────────────────────────────────────┐
  │    A1: token-store + stub routes + static serving            │
  │      ↓ (auto-test A1 passes)                                 │
  │    A2: notification-service.cjs (FCM core)                   │
  │      ↓ (auto-test A2 passes)                                 │
  │    A3: wire triggers into scheduler + server handlers        ─┤
  │                                                              │
  ├─── Track B (Frontend) ───────────────────────────────────────┤
  │    B1: firebase-config + manifest + icons                    │
  │      ↓ (auto-test B1 passes)                                 │
  │    B2: fcm.js service + firebase-messaging-sw.js             │
  │      ↓ (auto-test B2 passes)                                 │
  │    B3: main.jsx + NotificationSettings.jsx                  ─┤
  │                                                              │
  │         (wait for A3 + B3 both complete)                     │
  │                   ↓                                          │
  │              Integration Test                                │
  │                   ↓ (passes)                                 │
  │              Hardening Phase                                 │
  │                   ↓ (passes)                                 │
  │                  DONE                                        │
```

---

## Track A — Backend

### A1 — Foundation

**Goal:** Token persistence layer + stub API routes + static file serving for public/

**Files to create:**

#### `live-tv-controller-react/token-store.cjs`

```
Responsibilities:
- Load data/fcm-tokens.json on startup (create if missing)
- Atomic write: .tmp → validate → rename → .bak (same pattern as state-service.cjs)
- Exports:
    getTokens()                  → token[]
    upsertToken({ token, deviceName, userAgent })  → saved token object
    removeToken(tokenString)     → boolean
    pruneInactive(daysThreshold) → number removed
- Token schema:
    { id: uuid, token: string, deviceName: string, userAgent: string,
      registeredAt: ISO, lastSeenAt: ISO, active: boolean }
- Max tokens: read MAX_FCM_TOKENS from process.env (default 50)
  When limit exceeded: remove oldest inactive first, then oldest active
```

#### `live-tv-controller-react/data/fcm-tokens.json`

```json
{ "version": 1, "lastModified": "", "tokens": [] }
```

#### Modify `live-tv-controller-react/server.cjs`

```
Changes (additive only — do not touch existing routes):

1. Add near top with other requires:
   const tokenStore = require('./token-store.cjs')

2. Add public/ static serving BEFORE the existing dist/ static serving:
   app.use(express.static(path.join(__dirname, 'public')))

3. Add 7 new routes in a /api/notifications block:

   POST   /api/notifications/register
     body: { token, deviceName, userAgent }
     action: tokenStore.upsertToken(body), return { id, registered: true }

   DELETE /api/notifications/register
     body: { token }
     action: tokenStore.removeToken(body.token), return { removed: true }

   GET    /api/notifications/devices
     action: return { devices: tokenStore.getTokens().map(t => omit(t,'token')) }
     (never return the raw FCM token string in list responses)

   POST   /api/notifications/test
     body: { token }
     action: stub → { sent: true }  (Phase A2 will complete this)

   GET    /api/notifications/history
     query: ?limit=20&offset=0
     action: stub → { total: 0, entries: [] }  (Phase A2 will complete this)

   GET    /api/notifications/settings
     action: read app-state key "notifications.settings", return it
     default if missing:
       { enabled: true, events: {
           SCHEDULER_TRIGGER: true, SCHEDULER_ALERT: true,
           RECORDING_STARTED: true, RECORDING_STOPPED: true,
           RECORDING_ERROR: true, BACKUP_COMPLETED: false,
           MEMORY_WARNING: true, MONITOR_LIVE: true } }

   PUT    /api/notifications/settings
     body: { enabled, events }
     action: stateService.set('notifications.settings', body), broadcast STATE_CHANGE
     return: { saved: true }
```

**Auto-test A1:**
```
1. node -e "require('./token-store.cjs')" → no error
2. Verify data/fcm-tokens.json exists and is valid JSON
3. node server.cjs &  (start server briefly)
4. curl http://localhost:3004/api/notifications/settings → 200 JSON response
5. curl http://localhost:3004/manifest.json → 200 (after manifest exists from B1)
6. Stop server
Pass criteria: all 4 curl calls return 2xx with JSON body
```

---

### A2 — FCM Core

**Goal:** Backend can send real push notifications via Firebase Admin SDK

**Install:**
```
cd live-tv-controller-react
npm install firebase-admin
```

**File to create: `live-tv-controller-react/notification-service.cjs`**

```
Structure:

class NotificationProvider {
  async send(tokens, payload) { throw new Error('abstract') }
}

class FCMProvider extends NotificationProvider {
  constructor(adminApp)
  async send(tokens, payload):
    - chunk tokens into groups of 500
    - call admin.messaging().sendEachForMulticast({ tokens: chunk, notification, data, webpush })
    - return { succeeded: [], failed: [] }
}

const TEMPLATES = {
  SCHEDULER_TRIGGER:  { title(d), body(d), icon, tag: 'scheduler-trigger' },
  SCHEDULER_ALERT:    { title(d), body(d), icon, tag: 'scheduler-alert' },
  RECORDING_STARTED:  { title(d), body(d), icon, tag: 'recording' },
  RECORDING_STOPPED:  { title(d), body(d), icon, tag: 'recording' },
  RECORDING_ERROR:    { title(d), body(d), icon, tag: 'recording-error' },
  BACKUP_COMPLETED:   { title(d), body(d), icon, tag: 'backup' },
  MEMORY_WARNING:     { title(d), body(d), icon, tag: 'memory' },
  MONITOR_LIVE:       { title(d), body(d), icon, tag: 'monitor-live' },
}

class NotificationService {
  init(config):
    - initialize firebase-admin app with config
    - initialize FCMProvider
    - log "NotificationService ready" via logger pattern

  async send(event, data):
    - load tokens from tokenStore.getTokens() where active === true
    - read preferences from stateService: 'notifications.settings'
    - if settings.enabled === false → return early
    - if settings.events[event] === false → return early
    - build payload from TEMPLATES[event]
    - call FCMProvider.send(tokens.map(t => t.token), payload)
    - handle results:
        succeeded: call tokenStore.upsertToken({ ..., lastSeenAt: now })
        failed with "registration-token-not-registered": call tokenStore.removeToken(token)
    - retry on network/5xx: up to 3 attempts (1s, 2s backoff)
    - log result via logger (type: NOTIFICATION_SENT or NOTIFICATION_ERROR)
    - if NOTIFICATION_HISTORY env === 'true': append to notification-history.json

  async sendTest(token):
    - send one test payload directly to single token
    - do not check preferences (test always sends)

module.exports = new NotificationService()
```

**Modify `server.cjs` — complete the stubs:**
```
- require('./notification-service.cjs') at top
- notificationService.init({ projectId, clientEmail, privateKey }) from process.env
  (call inside a try/catch — if env missing, log warning and disable service gracefully)

- Complete POST /api/notifications/test:
    body: { token }
    action: await notificationService.sendTest(body.token)
    return { sent: true }

- Complete GET /api/notifications/history:
    Read data/notification-history.json if it exists (empty array if not)
    Paginate with limit/offset query params
```

**Auto-test A2:**
```
1. npm install → no errors
2. node -e "require('./notification-service.cjs')" → no error
3. Start server
4. curl -X POST http://localhost:3004/api/notifications/test \
     -H "Content-Type: application/json" \
     -d '{"token":"test-invalid-token"}'
   → should return { sent: true } or graceful { error: "invalid token" } — NOT a crash
5. curl http://localhost:3004/api/notifications/history → { total: 0, entries: [] }
6. Stop server
Pass criteria: server does not crash on invalid token. Returns JSON on all routes.
```

---

### A3 — Trigger Wiring

**Goal:** Real notification sends fire automatically when scheduler, recording, backup, memory events occur

**Modify `live-tv-controller-react/scheduler-service.cjs`:**
```
- At the top, add:
    let notificationService = null
    function setNotificationService(svc) { notificationService = svc }
    module.exports.setNotificationService = setNotificationService

- In onTrigger callback (where SCHEDULER_TRIGGER is broadcast):
    if (notificationService) {
      notificationService.send('SCHEDULER_TRIGGER', {
        scheduleName: schedule.name,
        action: schedule.action,
        time: new Date().toLocaleTimeString()
      }).catch(() => {})   // never let notification failure affect scheduler
    }

- In onAlert callback (where SCHEDULER_ALERT is broadcast):
    if (notificationService) {
      notificationService.send('SCHEDULER_ALERT', {
        scheduleName: alert.scheduleName,
        retries: alert.retryCount
      }).catch(() => {})
    }
```

**Modify `live-tv-controller-react/server.cjs`:**
```
After notificationService.init():
  schedulerService.setNotificationService(notificationService)

In POST /api/recording/start success handler (after yt-dlp spawns):
  notificationService.send('RECORDING_STARTED', { filename }).catch(() => {})

In POST /api/recording/stop success handler:
  notificationService.send('RECORDING_STOPPED', { filename }).catch(() => {})

In RECORDING_EVENT broadcast (error case):
  notificationService.send('RECORDING_ERROR', { message: errorMsg }).catch(() => {})

In POST /api/backup/manual success handler:
  notificationService.send('BACKUP_COMPLETED', { type: 'manual' }).catch(() => {})

In auto-backup routine success callback:
  notificationService.send('BACKUP_COMPLETED', { type: 'auto' }).catch(() => {})

In memory warning log (300MB threshold):
  notificationService.send('MEMORY_WARNING', { mb: usedMb }).catch(() => {})
```

**Auto-test A3:**
```
1. Start server with valid FIREBASE_* env vars in .env
2. curl -X POST http://localhost:3004/api/scheduler/schedules/:id/fire (fire any test schedule)
   → Check server logs for "NOTIFICATION_SENT" or "NOTIFICATION_ERROR" entry (either is ok)
   → Server must not crash
3. curl -X POST http://localhost:3004/api/backup/manual
   → Check server logs for notification attempt
4. Stop server
Pass criteria: notification attempts logged; server stable throughout
```

---

## Track B — Frontend

### B1 — Firebase Config + PWA Manifest

**Goal:** Firebase app initialized, PWA manifest in place, icons served

**File to create: `live-tv-controller-react/public/manifest.json`**
```json
{
  "name": "Live TV Controller",
  "short_name": "LiveTV",
  "description": "Live TV scheduler, OBS controller, and stream monitor",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**Icons:**
```
Create two PNG icons and save to public/:
  public/icon-192.png  — 192×192 px, dark background (#0f172a), white "LTV" text
  public/icon-512.png  — 512×512 px, same style

If image generation is not available, create minimal valid PNG files.
Alternatively use a solid-color PNG as placeholder.
```

**File to create: `live-tv-controller-react/src/firebase-config.js`**
```js
import { initializeApp } from 'firebase/app'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

export const firebaseApp = initializeApp(firebaseConfig)
```

**Modify `live-tv-controller-react/index.html`:**
```
Add inside <head>:
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0f172a">
```

**Auto-test B1:**
```
1. npm run build → exit code 0, no errors
2. Start server
3. curl http://localhost:3004/manifest.json → valid JSON with "name" field
4. curl http://localhost:3004/icon-192.png → 200, Content-Type: image/png
5. View page source in browser → <link rel="manifest"> present
6. Stop server
Pass criteria: build succeeds, manifest + icons served correctly
```

---

### B2 — FCM Service + Service Worker

**Goal:** Browser can request permission, get a token, and receive background notifications

**Install:**
```
cd live-tv-controller-react
npm install firebase
```

**File to create: `live-tv-controller-react/src/services/fcm.js`**

```js
import { getMessaging, getToken, onMessage } from 'firebase/messaging'
import { firebaseApp } from '../firebase-config.js'

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY
const PERMISSION_KEY = 'fcm_permission_status'
const TOKEN_KEY = 'fcm_token'

async function registerToken(token) {
  await fetch('/api/notifications/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      deviceName: getBrowserName(),
      userAgent: navigator.userAgent,
    }),
  })
}

function getBrowserName() {
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Chrome/')) return 'Chrome'
  if (ua.includes('Firefox/')) return 'Firefox'
  if (ua.includes('Safari/')) return 'Safari'
  return 'Browser'
}

export async function initFCM() {
  // Guard: browser must support push
  if (!('PushManager' in window) || !('Notification' in window) || !('serviceWorker' in navigator)) {
    console.info('[FCM] Push not supported in this browser')
    return
  }

  const messaging = getMessaging(firebaseApp)

  // Guard: already denied
  if (Notification.permission === 'denied') {
    localStorage.setItem(PERMISSION_KEY, 'denied')
    return
  }

  // Guard: already registered and token exists
  const existing = localStorage.getItem(TOKEN_KEY)
  if (existing && Notification.permission === 'granted') {
    setupForegroundHandler(messaging)
    return
  }

  // Register service worker first
  let swReg
  try {
    swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js')
  } catch (err) {
    console.warn('[FCM] Service worker registration failed:', err)
    return
  }

  // Request permission (browser native dialog)
  const permission = await Notification.requestPermission()
  localStorage.setItem(PERMISSION_KEY, permission)

  if (permission !== 'granted') return

  // Get FCM token
  let token
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg })
      break
    } catch (err) {
      if (attempt === 3) { console.warn('[FCM] Token fetch failed after 3 attempts:', err); return }
      await new Promise(r => setTimeout(r, attempt * 1000))
    }
  }

  if (!token) return

  localStorage.setItem(TOKEN_KEY, token)
  await registerToken(token)

  setupForegroundHandler(messaging)
}

function setupForegroundHandler(messaging) {
  onMessage(messaging, (payload) => {
    // App is in foreground — show a manual notification since browser suppresses push
    const { title, body, icon } = payload.notification || {}
    if (Notification.permission === 'granted' && title) {
      new Notification(title, { body, icon: icon || '/icon-192.png' })
    }
  })
}

export async function unregisterFCM() {
  const token = localStorage.getItem(TOKEN_KEY)
  if (!token) return
  await fetch('/api/notifications/register', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(PERMISSION_KEY)
}
```

**File to create: `live-tv-controller-react/public/firebase-messaging-sw.js`**

```js
// Background push message handler for Firebase Cloud Messaging
// Must live at the root path — served by Express static(public/)

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js')

// Config is duplicated here because service workers cannot access import.meta.env
// These values are public — they only route to your Firebase project, they are not secrets
const FIREBASE_CONFIG = {
  apiKey:            '%%VITE_FIREBASE_API_KEY%%',
  authDomain:        '%%VITE_FIREBASE_AUTH_DOMAIN%%',
  projectId:         '%%VITE_FIREBASE_PROJECT_ID%%',
  storageBucket:     '%%VITE_FIREBASE_STORAGE_BUCKET%%',
  messagingSenderId: '%%VITE_FIREBASE_MESSAGING_SENDER_ID%%',
  appId:             '%%VITE_FIREBASE_APP_ID%%',
}
// IMPORTANT: Replace the %%VITE_FIREBASE_*%% placeholders above with actual values
// from your .env file before deploying. These are intentionally NOT secrets.

firebase.initializeApp(FIREBASE_CONFIG)

const messaging = firebase.messaging()

// Background message handler (app tab is hidden or closed)
messaging.onBackgroundMessage((payload) => {
  const { title, body, icon, tag } = payload.notification || {}
  self.registration.showNotification(title || 'Live TV Controller', {
    body: body || '',
    icon: icon || '/icon-192.png',
    tag: tag || 'livetv',
    badge: '/icon-192.png',
    renotify: true,
  })
})

// Click on background notification → focus or open the app tab
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      if (clients.openWindow) return clients.openWindow('/')
    })
  )
})
```

**Auto-test B2:**
```
1. npm install → no errors
2. npm run build → exit code 0, no errors in output
3. Start server
4. Open http://localhost:3004 in Chrome
5. Open DevTools → Application → Service Workers
   → firebase-messaging-sw.js should appear as registered or activating
6. Open DevTools → Console → no uncaught errors on load
7. Stop server
Pass criteria: build succeeds, service worker appears in DevTools
```

---

### B3 — main.jsx + NotificationSettings UI

**Goal:** FCM initializes on app load; user can manage notifications from Settings

**Modify `live-tv-controller-react/src/main.jsx`:**
```
Add after React root render (not before — rendering must not block on FCM):

import { initFCM } from './services/fcm.js'

// After createRoot(...).render(...)
setTimeout(() => {
  initFCM().catch(err => console.warn('[FCM] Init error:', err))
}, 2000)
// 2s delay: let the app fully paint before triggering the permission dialog
```

**File to create: `live-tv-controller-react/src/components/NotificationSettings.jsx`**

```
Component: NotificationSettings

State:
  settings: { enabled, events: { SCHEDULER_TRIGGER, ... } }
  devices: [{ id, deviceName, registeredAt, lastSeenAt, active }]
  testStatus: 'idle' | 'sending' | 'sent' | 'error'
  loading: boolean

On mount:
  GET /api/notifications/settings → setSettings()
  GET /api/notifications/devices  → setDevices()

UI sections:

1. Push Notifications header
   Toggle: "Enable push notifications" (master switch)
   If browser not supported: show info banner "Your browser does not support push notifications"
   If permission === 'denied': show warning "Notifications blocked in browser settings"

2. Event Types (show only if enabled === true)
   Table of toggles, one row per event:
     SCHEDULER_TRIGGER  → "Schedule triggered"
     SCHEDULER_ALERT    → "Scheduler alert"
     RECORDING_STARTED  → "Recording started"
     RECORDING_STOPPED  → "Recording stopped"
     RECORDING_ERROR    → "Recording error"
     BACKUP_COMPLETED   → "Backup completed"
     MEMORY_WARNING     → "Memory warning"
     MONITOR_LIVE       → "Live stream detected"
   Each toggle calls PUT /api/notifications/settings on change

3. Registered Devices
   Table columns: Device, Registered, Last seen, Remove
   "Send test" button → POST /api/notifications/test with stored token from localStorage
   Shows testStatus feedback ("Sent!" / "Error")
   Remove button → DELETE /api/notifications/register + refresh device list

Styling: match existing Tailwind dark theme used in SettingsBackup.jsx
```

**Mount in `live-tv-controller-react/src/App.jsx` or `SettingsBackup.jsx`:**
```
Find the existing Settings or Backup tab/section.
Import NotificationSettings and render it as a new section below the existing backup UI.
Do not restructure the existing layout — append only.
```

**Auto-test B3:**
```
1. npm run build → exit code 0
2. Start server
3. Open http://localhost:3004 in Chrome
4. After 2 seconds: browser should show native permission dialog (or it's already granted)
5. Grant permission
6. Open DevTools → Application → Storage → Local Storage
   → fcm_permission_status should equal "granted"
   → fcm_token should have a value
7. Open server logs or data/fcm-tokens.json → token entry should appear
8. Navigate to Settings section in UI → NotificationSettings renders without error
9. Stop server
Pass criteria: token registered, settings UI renders, no console errors
```

---

## Integration Phase

**Goal:** End-to-end flow verified — schedule fires → notification received in browser

**Run:**
```
1. Ensure .env has valid Firebase credentials (all VITE_FIREBASE_* and FIREBASE_* vars)
2. npm run build && node server.cjs
3. Open http://localhost:3004 in Chrome — grant notification permission
4. Wait for token to appear in data/fcm-tokens.json

5. Send a test via curl:
   curl -X POST http://localhost:3004/api/notifications/test \
     -H "Content-Type: application/json" \
     -d "{\"token\": \"$(node -e "const f=require('./data/fcm-tokens.json');console.log(f.tokens[0]?.token)")\"}"
   → Notification should appear in Chrome

6. Fire a schedule:
   curl -X POST http://localhost:3004/api/schedules/{any-schedule-id}/fire
   → Notification "Scheduler: {name}" should appear in Chrome

7. Minimize / close tab, repeat step 5:
   → Background notification should appear via service worker

8. Open NotificationSettings UI:
   → Device list shows the registered device
   → "Send test" button triggers notification
   → Toggle off SCHEDULER_TRIGGER, fire schedule again → no notification appears
   → Toggle back on
```

**Pass criteria:**
- [ ] Foreground notification received
- [ ] Background notification received (tab closed)
- [ ] Event toggle correctly suppresses/enables notifications
- [ ] Device list shows correct device info
- [ ] Server logs show NOTIFICATION_SENT entries
- [ ] No server crashes during the entire test

---

## Hardening Phase

**Goal:** Production-safe — rate limits, pruning, history, edge cases

**Modify `live-tv-controller-react/server.cjs`:**

```
Rate limiting (in-memory — no new dependencies):

const rateLimits = new Map()  // key: "route:identifier" → { count, resetAt }

function checkRateLimit(key, maxCount, windowMs) {
  const now = Date.now()
  const entry = rateLimits.get(key) || { count: 0, resetAt: now + windowMs }
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs }
  entry.count++
  rateLimits.set(key, entry)
  return entry.count <= maxCount
}

POST /api/notifications/register:
  key = `register:${req.ip}`, maxCount = 10, windowMs = 60_000
  if (!checkRateLimit(key, 10, 60000)) return res.status(429).json({ error: 'Too many requests' })

POST /api/notifications/test:
  key = `test:${req.body.token?.slice(0,20)}`, maxCount = 3, windowMs = 60_000
  if (!checkRateLimit(key, 3, 60000)) return res.status(429).json({ error: 'Too many requests' })
```

**Add to startup in `server.cjs`:**
```
tokenStore.pruneInactive(30)  // remove tokens not seen in 30 days
```

**Notification History (in `notification-service.cjs`):**
```
If process.env.NOTIFICATION_HISTORY === 'true':
  After each send, append entry to data/notification-history.json
  Schema: { id, sentAt, event, title, body, tokensAttempted, tokensSucceeded, tokensFailed }
  Max entries: 500 (trim oldest when exceeded)
  Atomic write (same temp→rename pattern)
```

**Optional NOTIFICATIONS_SECRET middleware:**
```
In server.cjs, before the /api/notifications router:

if (process.env.NOTIFICATIONS_SECRET) {
  app.use('/api/notifications', (req, res, next) => {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${process.env.NOTIFICATIONS_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  })
}
```

**Auto-test Hardening:**
```
1. Rate limit test:
   for i in {1..12}; do
     curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:3004/api/notifications/register \
       -H "Content-Type: application/json" -d '{"token":"x","deviceName":"test","userAgent":"test"}'
   done
   → First 10 return 200, 11th and 12th return 429

2. NOTIFICATIONS_SECRET test (set NOTIFICATIONS_SECRET=mysecret in .env, restart):
   curl http://localhost:3004/api/notifications/settings → 401
   curl -H "Authorization: Bearer mysecret" http://localhost:3004/api/notifications/settings → 200

3. History test (set NOTIFICATION_HISTORY=true in .env, restart):
   Send test notification
   curl http://localhost:3004/api/notifications/history → entries array has 1+ items

4. Token pruning test:
   Manually set lastSeenAt to 31 days ago in fcm-tokens.json for one token
   Restart server → that token should be removed from the file

5. Browser compat test:
   Firefox: open http://localhost:3004 → no crash, "not supported" message in NotificationSettings
   Chrome: full flow works
```

**Pass criteria:**
- [ ] Rate limiting returns 429 after limit exceeded
- [ ] Secret auth blocks unauthorized requests
- [ ] History file created and populated
- [ ] Stale tokens pruned on startup
- [ ] Firefox shows graceful degradation message (no crash)

---

## Completion Checklist

```
Track A:
[x] token-store.cjs created and tested
[x] data/fcm-tokens.json exists
[x] 7 /api/notifications/* routes working
[x] notification-service.cjs created with all 8 templates
[x] firebase-admin installed
[x] scheduler-service.cjs wired (onTrigger + onAlert)
[x] server.cjs wired (recording + backup + memory)

Track B:
[x] firebase installed
[x] public/manifest.json + icons in place
[x] src/firebase-config.js created
[x] src/services/fcm.js created
[x] public/firebase-messaging-sw.js created (placeholders replaced with real config)
[x] src/main.jsx calls initFCM()
[x] NotificationSettings.jsx created and mounted

Credentials:
[x] VITE_FIREBASE_API_KEY filled
[x] VITE_FIREBASE_AUTH_DOMAIN filled
[x] VITE_FIREBASE_PROJECT_ID filled
[x] VITE_FIREBASE_STORAGE_BUCKET filled
[x] VITE_FIREBASE_MESSAGING_SENDER_ID filled
[x] VITE_FIREBASE_APP_ID filled
[x] VITE_FIREBASE_VAPID_KEY filled
[x] FIREBASE_PROJECT_ID filled
[x] FIREBASE_CLIENT_EMAIL filled
[x] FIREBASE_PRIVATE_KEY filled

Integration (API verified 2026-06-29):
[x] GET  /api/notifications/settings  → 200 default settings
[x] PUT  /api/notifications/settings  → 200 saved
[x] POST /api/notifications/register  → 200 token stored in fcm-tokens.json
[x] GET  /api/notifications/devices   → 200 device list
[x] DELETE /api/notifications/register → 200 removed
[x] GET  /api/notifications/history   → 200 empty list
[x] manifest.json served from public/ → 200 image/png
[x] firebase-messaging-sw.js served   → 200 application/javascript
[ ] Foreground push verified in Chrome browser (manual step)
[ ] Background push verified (tab closed) (manual step)

Hardening:
[x] Rate limiting active (10/min register, 3/min test)
[x] Token pruning on startup
[x] NOTIFICATIONS_SECRET optional auth
[x] Notification history behind NOTIFICATION_HISTORY flag

Multi-Device QR Registration (added 2026-06-30):
[x] selfsigned + qrcode packages installed
[x] cert-manager.cjs — async, includes all LAN IPs in SAN, regenerates when IP changes
[x] ip-detector.cjs — detects all LAN IPs, primary: 10.54.171.158
[x] public/setup.html — standalone mobile registration page (Firebase CDN, no React)
[x] HTTPS server on port 3443 starts after HTTP server (async cert generation)
[x] GET /setup → serves setup.html for mobile devices
[x] GET /api/notifications/setup-url → QR code + primary LAN/tunnel URL JSON
[x] POST /api/notifications/test-device → per-device test notification
[x] HTTPS_PORT=3443 added to .env
[x] NotificationSettings.jsx — QR code panel, device icons, per-device test, timeAgo, tunnel badge
[x] npm run build passes (0 errors, 69 modules)

Tunnel + Debug (added 2026-06-30):
[x] localtunnel package installed
[x] tunnel-manager.cjs — auto-starts localtunnel on server boot, patches .env TUNNEL_URL, auto-reconnects
[x] server.cjs — wired tunnel auto-start in listen callback (async IIFE)
[x] setup-url route uses TUNNEL_URL when set (trusted cert path for phones)
[x] NotificationSettings QR panel shows green "Tunnel active" badge vs yellow warning
[x] notification-service.cjs — verbose debug logs: send/sendTest entry, skip reasons, token counts
[x] token-store.cjs — debug logs: new device registered, token updated/removed
[x] cert-manager.cjs — debug logs: cert generated/loaded with IP list
[x] TUNNEL_URL=https://hip-olives-dance.loca.lt in .env (auto-updated each start)

Bug Fixes (added 2026-06-30):
[x] firebase-admin v14 API fix — replaced admin.credential.cert() with require('firebase-admin/app').cert
[x] firebase-admin v14 messaging fix — replaced admin.messaging() with require('firebase-admin/messaging').getMessaging()
[x] GET /api/notifications/status diagnostic endpoint — returns ready, initError, deviceCount
[x] notification-service.cjs init() — logs each credential present/missing with char count
[x] notification-service.getStatus() — exposes ready state + initError to API
[x] firebase-messaging-sw.js — added fetch passthrough handler (no caching, push-only SW)
[x] server.cjs SPA fallback — added Cache-Control: no-cache for index.html (fixes soft reload)
[x] tunnel-manager.cjs — tunnel errors now silent/warn, reconnect delay 10s
[x] Verified: /api/notifications/status → ready=true, 2 active devices
[x] Build passes: 69 modules, 0 errors
```

---

## Files Changed Summary

| File | Status | Track |
|---|---|---|
| `token-store.cjs` | CREATE | A |
| `notification-service.cjs` | CREATE | A |
| `src/firebase-config.js` | CREATE | B |
| `src/services/fcm.js` | CREATE | B |
| `src/components/NotificationSettings.jsx` | CREATE | B |
| `public/firebase-messaging-sw.js` | CREATE | B |
| `public/manifest.json` | CREATE | B |
| `public/icon-192.png` | CREATE | B |
| `public/icon-512.png` | CREATE | B |
| `data/fcm-tokens.json` | CREATE | A |
| `data/notification-history.json` | CREATE (auto) | A |
| `server.cjs` | MODIFY (additive) | A |
| `scheduler-service.cjs` | MODIFY (2 hooks only) | A |
| `src/main.jsx` | MODIFY (3 lines) | B |
| `index.html` | MODIFY (2 lines) | B |
| `.env` | MODIFY (add FCM vars) | Pre-req |
| `.env.example` | MODIFY (document vars) | Pre-req |

**Files replaced:** none
**Existing routes changed:** none
**Existing components changed:** none (append only)
