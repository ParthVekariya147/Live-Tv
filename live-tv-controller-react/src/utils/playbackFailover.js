import { SOURCE_NAMES, FALLBACK_SOURCE } from './player-switching.js'; // .js so this module is directly importable by tests/ under plain node, as Vite resolves it identically

// ============================================================================
// Playback Failover — what to do when videos stop playing.
//
// The runaway detector in playback-mode.js decides WHEN playback has failed
// (N automatic advances in a row without a single video actually playing). This
// module decides WHAT HAPPENS THEN: which player takes over, and which Loop
// Playlist Automation Group/Playlist starts on arrival.
//
// Deliberately React-free and browser-API-free so the rules can be exercised
// directly from tests/ — same convention as player-switching.js.
// ============================================================================

export const FAILOVER_LOCAL_KEY = 'playbackFailover';
export const FAILOVER_SERVER_KEY = 'playback.failover';
export const FAILOVER_UPDATED_EVENT = 'playbackFailoverUpdated';

// Below 2 the breaker would trip on a single bad video, which is normal playlist
// behaviour and not a failure. The ceiling keeps a misconfiguration from letting a
// storm run for minutes before anything notices.
export const MIN_THRESHOLD = 2;
export const MAX_THRESHOLD = 20;

export function defaultFailoverConfig() {
    return {
        enabled: true,
        // Matches MAX_ADVANCES_WITHOUT_PLAYBACK — "more than 5 IDs skipped" is the
        // operator-facing description of exactly this.
        threshold: 5,
        // Any registered player. Never hardcoded to one: the operator picks, and the
        // list comes from SOURCE_NAMES so a player added later appears automatically.
        targetPlayer: FALLBACK_SOURCE,
        // Optional — the same Group/Playlist handoff Stream-End Rules performs, so a
        // failover lands on real content instead of a player with nothing loaded.
        groupId: '',
        listId: '',
    };
}

/** Available failover targets — read from the shared player registry, never a literal list. */
export function failoverTargets() {
    return [...SOURCE_NAMES];
}

/**
 * Repairs anything stored by an older build, a hand-edited backup or a deleted
 * player, so the runtime never acts on a config it cannot honour.
 */
export function normalizeFailoverConfig(raw) {
    const base = defaultFailoverConfig();
    if (!raw || typeof raw !== 'object') return base;

    const threshold = Number.parseInt(raw.threshold, 10);
    const targets = failoverTargets();

    return {
        enabled: raw.enabled !== false,
        threshold: Number.isFinite(threshold)
            ? Math.min(Math.max(threshold, MIN_THRESHOLD), MAX_THRESHOLD)
            : base.threshold,
        // A target that no longer exists (renamed or removed player) falls back to the
        // standing fallback rather than pointing the failover at nothing.
        targetPlayer: targets.includes(raw.targetPlayer) ? raw.targetPlayer : base.targetPlayer,
        groupId: typeof raw.groupId === 'string' ? raw.groupId : '',
        listId: typeof raw.listId === 'string' ? raw.listId : '',
    };
}

/**
 * Has playback failed badly enough to hand over?
 *
 * @param {number} consecutiveSkips advances since a video last actually played
 * @param {object} config           normalized failover config
 */
export function shouldFailover(consecutiveSkips, config) {
    const cfg = normalizeFailoverConfig(config);
    if (!cfg.enabled) return false;
    return consecutiveSkips >= cfg.threshold;
}

/**
 * The handover itself, as data — the caller performs it.
 *
 * Returns null when there is nothing to do. `startGroup` is separate from
 * `targetPlayer` on purpose: switching player and starting a playlist are two
 * decisions, and fusing them is what made Stream-End Rules silently do nothing
 * when no Group was picked (see liveEndRules.js). A failover with no Group still
 * switches; it just has no playlist to start on arrival.
 *
 * @param {object} config          normalized failover config
 * @param {string} currentPlayer   the player that is failing (never hand over to itself)
 */
export function resolveFailoverAction(config, currentPlayer) {
    const cfg = normalizeFailoverConfig(config);
    if (!cfg.enabled) return null;

    // Handing the failing player back to itself would just restart the same storm.
    // The standing fallback takes over instead — unless IT is the one failing, in
    // which case there is nowhere safe to go and the caller only halts and alerts.
    let target = cfg.targetPlayer;
    if (target === currentPlayer) {
        if (currentPlayer === FALLBACK_SOURCE) return { targetPlayer: null, startGroup: null };
        target = FALLBACK_SOURCE;
    }

    return {
        targetPlayer: target,
        startGroup: cfg.groupId ? { groupId: cfg.groupId, listId: cfg.listId || null } : null,
    };
}

export default {
    FAILOVER_LOCAL_KEY, FAILOVER_SERVER_KEY, FAILOVER_UPDATED_EVENT,
    MIN_THRESHOLD, MAX_THRESHOLD,
    defaultFailoverConfig, failoverTargets, normalizeFailoverConfig,
    shouldFailover, resolveFailoverAction,
};
