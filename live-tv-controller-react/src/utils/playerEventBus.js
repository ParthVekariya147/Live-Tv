import { connectWebSocket, addWsListener } from './scheduler-api';

// ============================================================================
// Player event bus — one place every player event arrives, no matter which
// browser produced it.
//
// The four player pages report videoEnded / videoError / timeUpdate /
// relayStatus two ways (see publishPlayerEvent() in public/*Player*.html):
//
//   1. a localStorage write, delivered to this tab as a "storage" event — only
//      works when the player page and this controller share a browser profile;
//   2. a POST to /api/player-event, re-broadcast by the server as a
//      PLAYER_EVENT WebSocket message — works from anywhere.
//
// Path 2 is the one that matters in the real deployment: the players run inside
// UnifiedPlayer.html in OBS's embedded browser while the controller is open in
// Chrome or on a phone, so path 1 never fires there and every event — including
// the videoEnded that drives Live Player's Stream-End Rules — was silently lost.
//
// Both paths are kept, so nothing regresses for a same-browser setup. When both
// deliver the same event, the eventId the player stamps on it de-duplicates them.
// ============================================================================

const listeners = new Map(); // storage key -> Set<handler>

// eventId -> timestamp of first delivery. Pruned on every insert; nothing here
// survives longer than the window, so it cannot grow with a long-running session.
const seen = new Map();
const DEDUPE_WINDOW_MS = 10_000;

function isDuplicate(eventId) {
    if (!eventId) return false; // pre-bridge player page — nothing to match on
    const now = Date.now();
    if (seen.size > 200) {
        for (const [id, at] of seen) {
            if (now - at > DEDUPE_WINDOW_MS) seen.delete(id);
        }
    }
    if (seen.has(eventId)) return true;
    seen.set(eventId, now);
    return false;
}

function emit(key, data) {
    const set = listeners.get(key);
    if (!set || set.size === 0) return;
    if (isDuplicate(data?.eventId)) return;
    for (const handler of set) {
        try { handler(data); } catch (err) { console.error('[PlayerEvents] handler failed:', err); }
    }
}

let wired = false;

function wireOnce() {
    if (wired) return;
    wired = true;

    // Path 1 — same-browser localStorage delivery (unchanged legacy behavior).
    window.addEventListener('storage', (event) => {
        if (!event.key || !event.newValue || !listeners.has(event.key)) return;
        try { emit(event.key, JSON.parse(event.newValue)); } catch { /* not our payload */ }
    });

    // Path 2 — server bridge. Shares the single app-wide WebSocket that
    // Scheduler/LoopPlaylistAutomation already use; connectWebSocket() is idempotent.
    connectWebSocket();
    addWsListener((msg) => {
        if (msg?.type !== 'PLAYER_EVENT') return;
        const data = msg.data;
        if (!data || typeof data.key !== 'string') return;
        emit(data.key, data);
    });
}

/**
 * Subscribe to one player's event stream.
 *
 * @param {string} key - the player's event key (e.g. 'livePlayerEvent')
 * @param {(data: object) => void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribePlayerEvents(key, handler) {
    wireOnce();
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(handler);
    return () => {
        const set = listeners.get(key);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) listeners.delete(key);
    };
}

export default { subscribePlayerEvents };
