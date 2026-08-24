/**
 * Raise a push-notification event from the browser.
 *
 * Notifications used to be server-only, which is why only automated triggers
 * (scheduler, recorder, backups, memory) ever produced one: every manual change
 * — putting a player on air, starting a playlist, toggling the stream — is
 * decided here in the React app, and the app had no way to tell the notifier
 * anything. This posts to /api/notifications/emit, which validates the event
 * against the shared catalog and applies the operator's own template.
 *
 * Fire-and-forget on purpose. A notification failing must never break, block or
 * slow down the switch that caused it, so nothing here throws or is awaited by
 * callers, and a 429/500 is swallowed after a single console warning.
 */

// Collapses duplicate raises of the same event+subject. React effects and OBS
// polling can call the same path several times for one real-world change (a
// re-render, a poll tick confirming a state we already saw), and each of those
// would otherwise be its own buzz on the phone.
const DEDUPE_MS = 4000;
const lastSent = new Map();

function dedupeKey(event, data) {
    // Only the fields that identify *what* changed take part, so "Live Player is
    // on air" twice in a second collapses, while a switch to a different player
    // right after does not.
    const subject = [data?.player, data?.group, data?.list, data?.videoId, data?.state, data?.position]
        .filter(v => v !== undefined && v !== null)
        .join('|');
    return `${event}::${subject}`;
}

/**
 * @param {string} event  A catalog event key, e.g. 'PLAYER_SWITCHED_MANUAL'.
 * @param {object} data   Placeholder values for that event's template.
 */
export function notifyEvent(event, data = {}) {
    if (!event) return;

    const key = dedupeKey(event, data);
    const now = Date.now();
    const previous = lastSent.get(key);
    if (previous && now - previous < DEDUPE_MS) return;
    lastSent.set(key, now);

    // Keep the map from growing without bound over a 24/7 session.
    if (lastSent.size > 200) {
        for (const [k, t] of lastSent) {
            if (now - t > DEDUPE_MS) lastSent.delete(k);
        }
    }

    try {
        fetch('/api/notifications/emit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data }),
            keepalive: true,   // survives a page teardown mid-request
        }).then(res => {
            if (!res.ok && res.status !== 429) {
                console.warn(`[Notify] ${event} rejected with ${res.status}`);
            }
        }).catch(() => { /* offline / server restarting — not worth surfacing */ });
    } catch (_) { /* ignore */ }
}

/**
 * Maps the `trigger` string that already flows through setSourceVisibility onto
 * the right event, so one call site covers every kind of player switch.
 *
 * 'scheduler' returns null deliberately: a scheduled switch is notified by the
 * server's confirm-before-notify path (SCHEDULER_TRIGGER / _FAILED, which waits
 * for OBS to actually confirm), and raising a second event here would double up
 * on every scheduled change.
 */
export function playerSwitchEventFor(trigger) {
    // Triggers whose switch is already described by a more specific notification.
    // Without this the operator gets two buzzes for one action — e.g. "Loop Player
    // is on air" immediately followed by "Playlist: Morning Set", where putting the
    // Loop Player on air is simply how a playlist run starts.
    if (trigger === 'scheduler') return null;   // server notifies once OBS confirms
    if (trigger === 'monitor') return null;     // MONITOR_LIVE names the channel
    if (trigger === 'playlist') return null;    // PLAYLIST_STARTED names group and list
    if (trigger === 'manual' || !trigger) return 'PLAYER_SWITCHED_MANUAL';
    return 'PLAYER_SWITCHED_AUTO';
}
