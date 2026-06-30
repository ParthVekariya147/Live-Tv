/**
 * Notification Service
 * Sends push notifications via Firebase Admin SDK (FCM HTTP v1)
 * Designed to be called from scheduler, recording, and backup event hooks.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const tokenStore = require('./token-store.cjs');

// Top-level requires so pkg can detect and bundle these modules.
// Init() still handles runtime errors gracefully if credentials are missing.
let _fbApp, _fbCert, _fbMessaging;
try {
    const fbApp = require('firebase-admin/app');
    _fbApp  = fbApp.initializeApp;
    _fbCert = fbApp.cert;
    const fbMsg = require('firebase-admin/messaging');
    _fbMessaging = fbMsg.getMessaging;
    // Also pre-load getApp for reuse detection
    const { getApp } = fbApp;
    _fbApp._getApp = getApp;
} catch (_) { /* firebase-admin unavailable — notificationService.ready stays false */ }

// ── Provider abstraction ────────────────────────────────────────────────────

class NotificationProvider {
    async send(tokens, payload) { throw new Error('abstract'); }
}

class FCMProvider extends NotificationProvider {
    constructor(messagingInstance) {
        super();
        this.messaging = messagingInstance;
    }

    async send(tokens, payload) {
        const succeeded = [];
        const failed = [];

        // FCM supports up to 500 tokens per sendEachForMulticast call
        const CHUNK = 500;
        for (let i = 0; i < tokens.length; i += CHUNK) {
            const chunk = tokens.slice(i, i + CHUNK);
            let result;
            try {
                result = await this.messaging.sendEachForMulticast({
                    tokens: chunk,
                    notification: {
                        title: payload.title,
                        body: payload.body,
                    },
                    // data passes the tag to the SW so onBackgroundMessage can use
                    // event-specific tags — same tag collapses multiple notifications
                    data: {
                        tag: payload.tag || 'livetv',
                    },
                    webpush: {
                        notification: {
                            icon: payload.icon || '/icon-192.png',
                            tag: payload.tag || 'livetv',
                            renotify: true,
                            badge: '/icon-192.png',
                        },
                        fcmOptions: { link: '/' },
                    },
                });
            } catch (err) {
                // Entire batch failed (network / auth error)
                failed.push(...chunk.map(t => ({ token: t, error: err.message })));
                continue;
            }

            result.responses.forEach((resp, idx) => {
                if (resp.success) {
                    succeeded.push(chunk[idx]);
                } else {
                    failed.push({ token: chunk[idx], error: resp.error?.code || 'unknown' });
                }
            });
        }

        return { succeeded, failed };
    }
}

// ── Notification templates ──────────────────────────────────────────────────

const TEMPLATES = {
    SCHEDULER_TRIGGER: {
        title: (d) => `Scheduler: ${d.scheduleName || 'Event'}`,
        body:  (d) => `Action "${d.action || 'triggered'}" at ${d.time || new Date().toLocaleTimeString()}`,
        icon: '/icon-192.png',
        tag: 'scheduler-trigger',
    },
    SCHEDULER_ALERT: {
        title: () => 'Scheduler Alert',
        body:  (d) => `"${d.scheduleName || 'Schedule'}" failed ${d.retries || ''} times`,
        icon: '/icon-192.png',
        tag: 'scheduler-alert',
    },
    RECORDING_STARTED: {
        title: () => 'Recording Started',
        body:  (d) => `Recording: ${d.filename || ''}`,
        icon: '/icon-192.png',
        tag: 'recording',
    },
    RECORDING_STOPPED: {
        title: () => 'Recording Stopped',
        body:  (d) => `Saved: ${d.filename || ''}`,
        icon: '/icon-192.png',
        tag: 'recording',
    },
    RECORDING_ERROR: {
        title: () => 'Recording Error',
        body:  (d) => d.message || 'Recording failed',
        icon: '/icon-192.png',
        tag: 'recording-error',
    },
    BACKUP_COMPLETED: {
        title: () => 'Backup Complete',
        body:  (d) => `${d.type || ''} backup saved`,
        icon: '/icon-192.png',
        tag: 'backup',
    },
    MEMORY_WARNING: {
        title: () => 'Memory Warning',
        body:  (d) => `Server memory at ${d.mb || '?'} MB`,
        icon: '/icon-192.png',
        tag: 'memory',
    },
    MONITOR_LIVE: {
        title: (d) => `Live: ${d.channelName || 'Channel'}`,
        body:  (d) => d.title || 'Stream detected',
        icon: '/icon-192.png',
        tag: 'monitor-live',
    },
};

// ── History persistence ─────────────────────────────────────────────────────

function getDataDir() {
    if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
    return path.join(__dirname, 'data');
}

function appendHistory(entry) {
    if (process.env.NOTIFICATION_HISTORY !== 'true') return;
    const histFile = path.join(getDataDir(), 'notification-history.json');
    let store = { version: 1, maxEntries: 500, entries: [] };
    try {
        if (fs.existsSync(histFile)) store = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    } catch (_) {}
    store.entries.unshift(entry);
    if (store.entries.length > store.maxEntries) store.entries = store.entries.slice(0, store.maxEntries);
    const tmp = histFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, histFile);
}

// ── Service ─────────────────────────────────────────────────────────────────

class NotificationService {
    constructor() {
        this.provider = null;
        this.ready = false;
        this.initError = null;
    }

    init({ projectId, clientEmail, privateKey } = {}) {
        console.log(`[NotificationService] init() → projectId=${projectId || 'MISSING'} clientEmail=${clientEmail || 'MISSING'} privateKey=${privateKey ? 'SET(' + privateKey.length + ' chars)' : 'MISSING'}`);
        if (!projectId || !clientEmail || !privateKey) {
            const missing = [!projectId && 'FIREBASE_PROJECT_ID', !clientEmail && 'FIREBASE_CLIENT_EMAIL', !privateKey && 'FIREBASE_PRIVATE_KEY'].filter(Boolean);
            this.initError = `Missing env vars: ${missing.join(', ')}`;
            console.warn('[NotificationService] Firebase credentials missing:', this.initError);
            return;
        }
        try {
            if (!_fbApp || !_fbCert || !_fbMessaging) {
                throw new Error('firebase-admin could not be loaded — check installation');
            }

            let app;
            try {
                app = _fbApp._getApp('notification-service');
                console.log('[NotificationService] Reusing existing Firebase app');
            } catch (_) {
                app = _fbApp({
                    credential: _fbCert({ projectId, clientEmail, privateKey }),
                }, 'notification-service');
                console.log('[NotificationService] Firebase app initialized');
            }

            this.provider = new FCMProvider(_fbMessaging(app));
            this.ready = true;
            this.initError = null;
            console.log('[NotificationService] ✅ Ready — Firebase Admin v14 initialized');
        } catch (err) {
            this.initError = err.message;
            console.error('[NotificationService] ❌ Init failed:', err.message);
        }
    }

    getStatus() {
        return {
            ready: this.ready,
            initError: this.initError,
            deviceCount: tokenStore.getTokens().length,
            activeDevices: tokenStore.getTokens().filter(t => t.active).length,
        };
    }

    async send(event, data = {}) {
        console.log(`[NotificationService] send() called: event=${event} data=${JSON.stringify(data)}`);

        if (!this.ready || !this.provider) {
            console.warn(`[NotificationService] Not ready (ready=${this.ready} provider=${!!this.provider}) — skipping`);
            return;
        }

        const template = TEMPLATES[event];
        if (!template) {
            console.warn(`[NotificationService] Unknown event type: ${event}`);
            return;
        }

        // Check per-event preferences (read from state file directly to avoid circular deps)
        try {
            const stateFile = path.join(getDataDir(), 'app-state.json');
            if (fs.existsSync(stateFile)) {
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                const settings = state?.state?.['notifications.settings'];
                if (settings) {
                    if (settings.enabled === false) { console.log('[NotificationService] Notifications disabled globally — skipping'); return; }
                    if (settings.events?.[event] === false) { console.log(`[NotificationService] Event ${event} disabled — skipping`); return; }
                }
            }
        } catch (_) {}

        const allTokens = tokenStore.getTokens();
        const tokens = allTokens.filter(t => t.active).map(t => t.token);
        console.log(`[NotificationService] Registered devices: ${allTokens.length} total, ${tokens.length} active`);
        if (tokens.length === 0) {
            console.warn('[NotificationService] No active device tokens — nothing to send');
            return;
        }

        const payload = {
            title: template.title(data),
            body:  template.body(data),
            icon:  template.icon,
            tag:   template.tag,
        };

        let result = { succeeded: [], failed: [] };
        let lastError = null;

        // Retry up to 3 times on network/5xx errors
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                result = await this.provider.send(tokens, payload);
                break;
            } catch (err) {
                lastError = err;
                if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
            }
        }

        // Auto-remove invalid tokens
        for (const { token, error } of result.failed) {
            if (error === 'messaging/registration-token-not-registered' ||
                error === 'messaging/invalid-registration-token') {
                tokenStore.removeToken(token);
                console.log(`[NotificationService] Removed invalid token: ${token.slice(0, 20)}...`);
            }
        }

        const logEntry = {
            id: crypto.randomUUID(),
            sentAt: new Date().toISOString(),
            event,
            title: payload.title,
            body: payload.body,
            tokensAttempted: tokens.length,
            tokensSucceeded: result.succeeded.length,
            tokensFailed: result.failed.length,
        };

        if (lastError && result.succeeded.length === 0) {
            console.error(`[NotificationService] NOTIFICATION_ERROR event=${event}:`, lastError.message);
        } else {
            console.log(`[NotificationService] NOTIFICATION_SENT event=${event} ok=${result.succeeded.length} fail=${result.failed.length}`);
        }

        appendHistory(logEntry);
    }

    async sendTest(token) {
        console.log(`[NotificationService] sendTest() → token=${token.slice(0, 20)}…`);
        if (!this.ready || !this.provider) {
            throw new Error('Notification service not initialized — check Firebase credentials in .env');
        }
        const payload = {
            title: 'Test Notification',
            body: 'Live TV Controller notifications are working!',
            icon: '/icon-192.png',
            tag: 'test',
        };
        const result = await this.provider.send([token], payload);
        console.log(`[NotificationService] sendTest result: ok=${result.succeeded.length} fail=${result.failed.length}`);
        if (result.failed.length > 0) {
            console.warn('[NotificationService] sendTest failed:', result.failed[0]?.error);
        }
    }
}

module.exports = new NotificationService();
