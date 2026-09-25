/**
 * Playback mode and playback session — the two things this app was missing.
 *
 * MODE answers "what is this video?" and therefore which extraction machinery is
 * allowed to touch it. SESSION answers "which load does this event belong to?" and
 * therefore whether an event may act on what is playing right now. They are
 * deliberately independent of WHICH player is selected: player selection decides
 * where playback is shown (obs.activeSource / player-switching.js), mode decides
 * what the playback source is allowed to do. Mixing those two responsibilities is
 * what routed ordinary videos into the live pipeline.
 *
 * Kept free of React and of any browser API so the rules can be exercised directly
 * from tests/ — same convention as player-switching.js.
 */

export const PLAYBACK_MODE = {
    /** An ordinary YouTube Video ID: browser/IFrame playback, nothing else. */
    NORMAL: 'normal',
    /** An actual YouTube live event: the yt-dlp / cookies / ffmpeg relay may apply. */
    LIVE: 'live',
};

/** Anything unrecognised (including a command from an older build that carries no
 *  mode at all) is treated as LIVE, because that is exactly what every existing
 *  caller meant before modes existed. New normal-video callers opt in explicitly. */
export function normalizeMode(mode) {
    return mode === PLAYBACK_MODE.NORMAL ? PLAYBACK_MODE.NORMAL : PLAYBACK_MODE.LIVE;
}

export function isNormalMode(mode) {
    return normalizeMode(mode) === PLAYBACK_MODE.NORMAL;
}

/**
 * The single gate for yt-dlp / cookies.txt / ffmpeg / HLS relay / live manifest work.
 * Availability of those binaries is NOT a reason to use them — only the declared mode is.
 */
export function allowsStreamExtraction(mode) {
    return normalizeMode(mode) === PLAYBACK_MODE.LIVE;
}

/** The same gate for the live-event monitoring that can replace what is loaded. */
export function allowsLiveEventTakeover(mode) {
    return normalizeMode(mode) === PLAYBACK_MODE.LIVE;
}

/** ...and for the Stream-End Rules, which exist to react to a broadcast finishing. */
export function allowsStreamEndRules(mode) {
    return normalizeMode(mode) === PLAYBACK_MODE.LIVE;
}

/** Fresh token per load. Short, sortable-ish, and unique enough for one session. */
export function newPlaybackSessionId() {
    return `pb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Only a genuinely completed playback is an "ended".
 *
 * BUFFERING / CUED / PAUSED / UNSTARTED / a destroyed or reloaded player / a
 * visibility change / duration momentarily 0 are NOT ends — none of them reaches
 * here, because the player pages report them as state logs and never as videoEnded.
 * An ERROR is not an end either: it is its own event with its own handling below.
 */
export function isEndOfPlayback(eventName) {
    return eventName === 'videoEnded';
}

/**
 * YouTube IFrame error codes that mean "this video can never play here", so a
 * playlist is right to move past the entry. Everything else (notably 5, the HTML5
 * player error) is transient and must NOT advance anything — that is the
 * invisible-skip behavior this fix removes.
 *
 *   2   malformed / invalid video id
 *   100 video removed or private
 *   101 embedding disabled by the owner
 *   150 embedding disabled (same as 101, different origin bucket)
 */
const TERMINAL_YT_ERROR_CODES = new Set([2, 100, 101, 150]);

export function isUnplayableVideoError(errorCode) {
    return TERMINAL_YT_ERROR_CODES.has(Number(errorCode));
}

/**
 * Stale-event gate.
 *
 * Video A is playing, video B is loaded, A's delayed ENDED lands a moment later and
 * the app skips B. That is only possible while an event carries no identity. Every
 * player page now stamps each event with the playbackSessionId and videoId of the
 * load it belongs to, and this decides whether the event may act.
 *
 * An event with NO identity at all is accepted: a player page from an older build
 * (or one that has not been reloaded since the upgrade) must keep working exactly as
 * before rather than going silently unresponsive.
 */
export function shouldAcceptPlayerEvent(event = {}, current = {}) {
    const { playbackSessionId: evtSession, videoId: evtVideo } = event;
    const { playbackSessionId: curSession, videoId: curVideo } = current;

    if (evtSession && curSession) return evtSession === curSession;
    if (evtVideo && curVideo) return evtVideo === curVideo;
    return true;
}

/**
 * Runaway-advance circuit breaker.
 *
 * Observed in the field as a burst of one full advance per second — state save, two
 * log writes and a push notification, repeating — as a playlist tore through itself:
 * each load failed, the failure was read as "ended", that advanced to the next entry,
 * which failed too. Skipping a single unplayable entry is intended; doing it dozens of
 * times without one video ever reaching playback is a fault, and it hammers /api/log
 * and /api/notifications/emit while it runs.
 *
 * The counter is incremented on every automatic advance and reset the moment a video
 * genuinely plays (a timeUpdate arrives). Past the limit, advancing stops and the
 * operator is told, rather than the app silently cycling the list forever.
 */
export const MAX_ADVANCES_WITHOUT_PLAYBACK = 5;

export function isRunawayAdvance(advancesSinceLastPlayback) {
    return advancesSinceLastPlayback >= MAX_ADVANCES_WITHOUT_PLAYBACK;
}

/**
 * The structured playback line required for telemetry — normal-video failures have to
 * be distinguishable from live-stream extraction failures at a glance. Never carries
 * cookie contents or any other secret; `source` names the pipeline, not its inputs.
 */
export function describePlayback({ mode, videoId, eventId, playerId, event, source, reason } = {}) {
    const parts = [
        `mode=${normalizeMode(mode)}`,
        videoId ? `videoId=${videoId}` : null,
        eventId ? `eventId=${eventId}` : null,
        playerId ? `playerId=${playerId}` : null,
        event ? `event=${event}` : null,
        source ? `source=${source}` : null,
        reason ? `reason=${reason}` : null,
    ].filter(Boolean);
    return `[Playback] ${parts.join(' ')}`;
}

export default {
    MAX_ADVANCES_WITHOUT_PLAYBACK, isRunawayAdvance,
    PLAYBACK_MODE, normalizeMode, isNormalMode,
    allowsStreamExtraction, allowsLiveEventTakeover, allowsStreamEndRules,
    newPlaybackSessionId, isEndOfPlayback, isUnplayableVideoError,
    shouldAcceptPlayerEvent, describePlayback,
};
