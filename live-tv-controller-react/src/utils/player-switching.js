/**
 * Player switching rules shared by the OBS context and anything that reasons about
 * which of the four players is on air.
 *
 * Kept free of React and of any browser API so the rules can be exercised directly.
 */

export const SOURCE_NAMES = [
    "Live Player",
    "Loop Player",
    "Delay Live",
    "Local Player",
    // "OrdaChesta",
];

// The player that goes on air whenever nothing else is — the standing fallback.
export const FALLBACK_SOURCE = "Loop Player";

// Mirror of the on-air player in localStorage. setSourceVisibility writes it
// synchronously, before the async state-service push, so it is the only way to ask
// "who is on air *right now*" without waiting a round trip.
export const ACTIVE_SOURCE_KEY = "obsActiveSource";

/**
 * The on-air player as of this instant, including a switch requested microseconds ago
 * that hasn't come back over the WebSocket yet.
 *
 * React state (`sourceState`) lags a switch by a full PUT -> broadcast -> setState ->
 * effect round trip. Anything that decides whether to take the screen has to read
 * through that lag, or two features reacting to the same event will each see the
 * pre-switch world and both grab it — which one wins then depends on who happened to
 * await something first.
 */
export function readActiveSourceNow() {
    try {
        return localStorage.getItem(ACTIVE_SOURCE_KEY);
    } catch {
        return null;
    }
}

/**
 * What "hide X" has to mean once all four players share a single OBS browser source.
 *
 * In the old 4-scene-item layout, hiding a source was a real, self-contained OBS
 * operation — the item went invisible and OBS showed whatever was underneath. In the
 * UnifiedPlayer.html layout there is nothing to switch off: exactly one player is on air
 * at any moment, chosen by the obs.activeSource key, so the only thing "hide" can mean is
 * "put the standing fallback on air instead". Without this a scheduled hide did literally
 * nothing — the state key was only ever written on the show path — and still reported
 * success, so the operator got a "done" notification for a switch that never happened.
 *
 * @returns the source to switch TO, or null when the hide is a legitimate no-op:
 *   hiding something that isn't on air, or hiding the fallback itself (nothing sits
 *   below it). The "some other source is still on air" case mirrors the legacy
 *   `anyOtherVisible` rule, so that in a still-4-scene-item setup hiding one of several
 *   visible sources doesn't wrongly yank everything back to the fallback.
 */
export function resolveHideFallback(sourceName, currentSourceState = {}) {
    if (sourceName === FALLBACK_SOURCE) return null;
    if (!currentSourceState[sourceName]) return null;
    const anyOtherOnAir = SOURCE_NAMES.some(s => s !== sourceName && currentSourceState[s]);
    if (anyOtherOnAir) return null;
    return FALLBACK_SOURCE;
}
