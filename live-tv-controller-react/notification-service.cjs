/**
 * Notification Service
 * Sends push notifications via Firebase Admin SDK (FCM HTTP v1)
 * Designed to be called from scheduler, recording, and backup event hooks.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const tokenStore = require('./token-store.cjs');
const catalog = require('./notification-catalog.cjs');

// Top-level requires so pkg can detect and bundle these modules.
// Init() still handles runtime errors gracefully if credentials are missing.
let _fbApp, _fbCert, _fbMessaging, _fbLoadError;
try {
    const fbApp = require('firebase-admin/app');
    _fbApp  = fbApp.initializeApp;
    _fbCert = fbApp.cert;
    const fbMsg = require('firebase-admin/messaging');
    _fbMessaging = fbMsg.getMessaging;
    // Also pre-load getApp for reuse detection
    const { getApp } = fbApp;
    _fbApp._getApp = getApp;
} catch (subpathErr) {
    // pkg's resolver can fail on the "firebase-admin/app" subpath export inside
    // the exe. The v14 main entry re-exports the app API (initializeApp, cert,
    // getApp), and the real lib file path — which pkg resolves fine — provides
    // getMessaging. Node itself never reaches this branch (subpaths work there).
    try {
        const admin = require('firebase-admin');
        _fbApp = admin.initializeApp;
        _fbApp._getApp = admin.getApp;
        _fbCert = admin.cert;
        _fbMessaging = require('firebase-admin/lib/messaging/index.js').getMessaging;
        console.warn('[NotificationService] Loaded firebase-admin via fallback paths (subpath failed:', subpathErr.message + ')');
    } catch (mainErr) {
        _fbLoadError = mainErr.message || subpathErr.message;
    }
}

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
                    // Keep code for programmatic handling, but preserve the underlying
                    // message — codes like app/invalid-credential hide the real cause.
                    failed.push({
                        token: chunk[idx],
                        error: resp.error?.code || 'unknown',
                        message: resp.error?.message || ''
                    });
                }
            });
        }

        return { succeeded, failed };
    }
}

// ── Notification templates ──────────────────────────────────────────────────
// The event list, its default wording and the render rules all live in
// notification-catalog.cjs so the Notification Panel can edit them at runtime.
// Nothing about a notification's text is hardcoded in this file any more.

// ── History persistence ─────────────────────────────────────────────────────

function getDataDir() {
    if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
    return path.join(__dirname, 'data');
}

function getSettings() {
    try {
        const stateFile = path.join(getDataDir(), 'app-state.json');
        if (fs.existsSync(stateFile)) {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            return state?.state?.['notifications.settings'] || null;
        }
    } catch (_) {}
    return null;
}

function getAppName() {
    return getSettings()?.appName || 'SMK TV';
}

// History is on unless explicitly switched off. It used to be opt-in via
// NOTIFICATION_HISTORY=true, which nobody sets — so the file stayed empty and
// there was no way to answer "did that notification actually go out?" after the
// fact. The store is capped at maxEntries and written atomically, so leaving it
// on costs a bounded file, not unbounded growth.
function historyEnabled() {
    return process.env.NOTIFICATION_HISTORY !== 'false';
}

function appendHistory(entry) {
    if (!historyEnabled()) return;
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
                throw new Error(`firebase-admin could not be loaded — ${_fbLoadError || 'check installation'}`);
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

        if (!catalog.EVENTS_BY_KEY[event]) {
            console.warn(`[NotificationService] Unknown event type: ${event}`);
            return;
        }

        // Per-event preferences (read from the state file directly to avoid a
        // circular require with server.cjs). isEventEnabled also covers the
        // global kill switch and falls back to the catalog's own default for an
        // event the operator has never touched.
        const settings = getSettings();
        if (!catalog.isEventEnabled(event, settings)) {
            console.log(`[NotificationService] Event ${event} disabled — skipping`);
            return;
        }

        const allTokens = tokenStore.getTokens();
        const tokens = allTokens.filter(t => t.active).map(t => t.token);
        console.log(`[NotificationService] Registered devices: ${allTokens.length} total, ${tokens.length} active`);
        if (tokens.length === 0) {
            console.warn('[NotificationService] No active device tokens — nothing to send');
            // Still recorded, so the History tab can say "this fired, but you have no
            // paired device" — otherwise a missing notification is indistinguishable
            // from one that was switched off or rejected by FCM.
            const payload = catalog.buildPayload(event, data, settings);
            appendHistory({
                id: crypto.randomUUID(),
                sentAt: new Date().toISOString(),
                event,
                trigger: data.trigger || data.source || null,
                title: payload?.title || event,
                body: payload?.body || '',
                ok: false,
                error: 'No registered device — pair one with the QR code',
                tokensAttempted: 0,
                tokensSucceeded: 0,
                tokensFailed: 0,
            });
            return;
        }

        // The panel's template for this event decides the wording, the emoji and
        // whether the app name or the custom title becomes the notification's
        // actual title. buildPayload is the same function the panel previews
        // with, so what was shown there is what gets sent here.
        const payload = catalog.buildPayload(event, data, settings);
        if (!payload) { console.warn(`[NotificationService] Could not build payload for ${event}`); return; }

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
            // What made this fire — 'manual', 'scheduler', 'automation', 'monitor'…
            // The panel's History tab shows it, which is how you tell a push you
            // caused by hand from one the scheduler caused.
            trigger: data.trigger || data.source || null,
            title: payload.title,
            body: payload.body,
            ok: result.succeeded.length > 0,
            error: (lastError && result.succeeded.length === 0) ? lastError.message : (result.failed[0]?.error || null),
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

    /**
     * Send one already-rendered payload, bypassing the enabled/disabled checks.
     *
     * This is what the panel's "Test this message" button uses: it renders the
     * template the operator is editing right now — including unsaved edits — and
     * pushes exactly that, so they can see the emoji land on the phone before
     * committing the wording. Never used by the event paths, which must respect
     * the toggles.
     */
    async sendPayload(payload, tokens = null) {
        if (!this.ready || !this.provider) {
            throw new Error('Notification service not initialized — check Firebase credentials in .env');
        }
        const targets = (tokens && tokens.length)
            ? tokens
            : tokenStore.getTokens().filter(t => t.active).map(t => t.token);
        if (targets.length === 0) throw new Error('No registered devices to send to');

        const result = await this.provider.send(targets, {
            title: payload.title,
            body: payload.body,
            icon: payload.icon || '/icon-192.png',
            tag: payload.tag || 'preview',
        });

        appendHistory({
            id: crypto.randomUUID(),
            sentAt: new Date().toISOString(),
            event: payload.event || 'TEMPLATE_PREVIEW',
            trigger: 'preview',
            title: payload.title,
            body: payload.body,
            ok: result.succeeded.length > 0,
            error: result.failed[0]?.error || null,
            tokensAttempted: targets.length,
            tokensSucceeded: result.succeeded.length,
            tokensFailed: result.failed.length,
        });

        if (result.succeeded.length === 0 && result.failed.length > 0) {
            const f = result.failed[0];
            throw new Error(`FCM rejected the send: ${f?.error || 'unknown error'}${f?.message ? ` — ${f.message}` : ''}`);
        }
        return { sent: result.succeeded.length, failed: result.failed.length };
    }

    async sendTest(token) {
        console.log(`[NotificationService] sendTest() → token=${token.slice(0, 20)}…`);
        if (!this.ready || !this.provider) {
            throw new Error('Notification service not initialized — check Firebase credentials in .env');
        }
        const payload = {
            title: getAppName(),
            body: 'Test notification — Live TV Controller notifications are working!',
            icon: '/icon-192.png',
            tag: 'test',
        };
        const result = await this.provider.send([token], payload);
        console.log(`[NotificationService] sendTest result: ok=${result.succeeded.length} fail=${result.failed.length}`);
        if (result.failed.length > 0) {
            const f = result.failed[0];
            console.warn('[NotificationService] sendTest failed:', f?.error, f?.message || '');
            // Surface the FCM rejection to the caller — otherwise the API replies
            // {sent:true} and the UI shows success for a token Google refused.
            throw new Error(`FCM rejected the token: ${f?.error || 'unknown error'}${f?.message ? ` — ${f.message}` : ''}`);
        }
    }
}

module.exports = new NotificationService();
