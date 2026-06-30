/**
 * FCM Token Store
 * Manages device token persistence in data/fcm-tokens.json
 * Follows the same atomic-write pattern as state-service.cjs
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TOKENS = parseInt(process.env.MAX_FCM_TOKENS || '50', 10);

function getTokensFilePath() {
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'data', 'fcm-tokens.json');
    }
    return path.join(__dirname, 'data', 'fcm-tokens.json');
}

const TOKENS_FILE = getTokensFilePath();

const EMPTY_STORE = { version: 1, lastModified: '', tokens: [] };

function readStore() {
    try {
        if (!fs.existsSync(TOKENS_FILE)) return { ...EMPTY_STORE };
        const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return { ...EMPTY_STORE };
    }
}

function writeStore(store) {
    store.lastModified = new Date().toISOString();
    const json = JSON.stringify(store, null, 2);
    const tmpFile = TOKENS_FILE + '.tmp';
    const bakFile = TOKENS_FILE + '.bak';

    fs.writeFileSync(tmpFile, json, 'utf8');

    // Validate the temp file before overwriting
    JSON.parse(fs.readFileSync(tmpFile, 'utf8'));

    if (fs.existsSync(TOKENS_FILE)) {
        fs.renameSync(TOKENS_FILE, bakFile);
    }
    fs.renameSync(tmpFile, TOKENS_FILE);
}

function getTokens() {
    return readStore().tokens;
}

function upsertToken({ token, deviceName, userAgent }) {
    const store = readStore();
    const now = new Date().toISOString();
    const existing = store.tokens.find(t => t.token === token);

    if (existing) {
        existing.lastSeenAt = now;
        existing.deviceName = deviceName || existing.deviceName;
        existing.userAgent = userAgent || existing.userAgent;
        existing.active = true;
        writeStore(store);
        console.log(`[TokenStore] Updated existing device: "${existing.deviceName}" id=${existing.id.slice(0,8)}`);
        return existing;
    }

    // Enforce max token limit: remove oldest inactive first, then oldest active
    if (store.tokens.length >= MAX_TOKENS) {
        const inactive = store.tokens.filter(t => !t.active);
        if (inactive.length > 0) {
            const oldest = inactive.sort((a, b) => new Date(a.lastSeenAt) - new Date(b.lastSeenAt))[0];
            store.tokens = store.tokens.filter(t => t.id !== oldest.id);
        } else {
            const oldest = store.tokens.sort((a, b) => new Date(a.lastSeenAt) - new Date(b.lastSeenAt))[0];
            store.tokens = store.tokens.filter(t => t.id !== oldest.id);
        }
    }

    const entry = {
        id: crypto.randomUUID(),
        token,
        deviceName: deviceName || 'Unknown device',
        userAgent: userAgent || '',
        registeredAt: now,
        lastSeenAt: now,
        active: true,
    };

    store.tokens.push(entry);
    writeStore(store);
    console.log(`[TokenStore] ✅ New device registered: "${entry.deviceName}" id=${entry.id.slice(0,8)} total=${store.tokens.length}`);
    return entry;
}

function removeToken(tokenString) {
    const store = readStore();
    const before = store.tokens.length;
    store.tokens = store.tokens.filter(t => t.token !== tokenString);
    if (store.tokens.length !== before) {
        writeStore(store);
        console.log(`[TokenStore] Removed token ${tokenString.slice(0,20)}… (${before - store.tokens.length} removed)`);
        return true;
    }
    console.warn(`[TokenStore] removeToken: token not found (${tokenString.slice(0,20)}…)`);
    return false;
}

function markInactive(tokenString) {
    const store = readStore();
    const entry = store.tokens.find(t => t.token === tokenString);
    if (entry) {
        entry.active = false;
        writeStore(store);
    }
}

function pruneInactive(daysThreshold = 30) {
    const store = readStore();
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000);
    const before = store.tokens.length;
    store.tokens = store.tokens.filter(t => {
        if (!t.active && new Date(t.lastSeenAt) < cutoff) return false;
        return true;
    });
    const removed = before - store.tokens.length;
    if (removed > 0) {
        writeStore(store);
        console.log(`[TokenStore] Pruned ${removed} inactive token(s) older than ${daysThreshold} days`);
    }
    return removed;
}

module.exports = { getTokens, upsertToken, removeToken, markInactive, pruneInactive };
