import { useCallback, useEffect, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { getStateValue } from '../utils/state-api';
import { notifyEvent } from '../utils/notify';
import { describePlayback, PLAYBACK_MODE } from '../utils/playback-mode';
import {
    FAILOVER_LOCAL_KEY, FAILOVER_SERVER_KEY, FAILOVER_UPDATED_EVENT,
    defaultFailoverConfig, normalizeFailoverConfig, resolveFailoverAction,
} from '../utils/playbackFailover';

// Both the Loop Player card and the Playlist Automation engine watch the same player
// event stream, so a run of failures reaches both and each would perform its own
// handover — two OBS switches and two pushes for one event. Module scope (not a ref)
// because they are separate components in the same tab.
let lastFailoverAt = 0;
const FAILOVER_DEDUPE_MS = 15000;

/**
 * Runs the Playback Failover policy: when videos stop playing, put another player on
 * air, optionally start a playlist there, and raise the emergency notification.
 *
 * The decision of WHEN to call this lives with the caller (the runaway counter in
 * playback-mode.js); this owns WHAT HAPPENS, so the behavior is identical no matter
 * which component noticed the failure first.
 *
 * @returns {{ configRef: {current: object}, triggerFailover: Function }}
 */
export function usePlaybackFailover() {
    const { setSourceVisibility } = useOBS();
    const configRef = useRef(defaultFailoverConfig());
    const setSourceVisibilityRef = useRef(setSourceVisibility);
    useEffect(() => { setSourceVisibilityRef.current = setSourceVisibility; }, [setSourceVisibility]);

    // localStorage first, then the server copy. The editor has always had that fallback;
    // the code that RUNS the policy needs it too, or a machine that never saved locally
    // would quietly run defaults while the operator's real settings sat on the server.
    useEffect(() => {
        const load = async () => {
            try {
                const local = localStorage.getItem(FAILOVER_LOCAL_KEY);
                if (local) { configRef.current = normalizeFailoverConfig(JSON.parse(local)); return; }
            } catch { /* fall through to the server copy */ }
            try {
                configRef.current = normalizeFailoverConfig(await getStateValue(FAILOVER_SERVER_KEY));
            } catch { configRef.current = defaultFailoverConfig(); }
        };
        load();
        const onStorage = (e) => { if (e.key === FAILOVER_LOCAL_KEY) load(); };
        window.addEventListener('storage', onStorage);
        window.addEventListener(FAILOVER_UPDATED_EVENT, load);
        return () => {
            window.removeEventListener('storage', onStorage);
            window.removeEventListener(FAILOVER_UPDATED_EVENT, load);
        };
    }, []);

    /**
     * @param {object}  info
     * @param {string}  info.player   the player that is failing, e.g. 'Loop Player'
     * @param {number}  info.skipped  videos skipped in a row with nothing playing
     * @param {string} [info.videoId] the last video that failed
     * @param {string} [info.reason]  why it failed
     * @param {string} [info.source]  which component noticed, for the log line
     * @returns {{ switchedTo: string|null, startedGroup: object|null }|null}
     *          null when another component already handled this same failure.
     */
    const triggerFailover = useCallback((info = {}) => {
        const now = Date.now();
        if (now - lastFailoverAt < FAILOVER_DEDUPE_MS) return null;
        lastFailoverAt = now;

        const cfg = configRef.current;
        const player = info.player || 'Loop Player';
        const action = resolveFailoverAction(cfg, player);
        const target = action?.targetPlayer || null;

        console.error(describePlayback({
            mode: PLAYBACK_MODE.NORMAL, videoId: info.videoId, playerId: player,
            event: 'FAILOVER', source: info.source || 'playback_failover',
            reason: `${info.skipped} videos in a row did not play — ${target ? `switching to ${target}` : 'no failover target available'}`,
        }));

        if (target) {
            // The same two-step Stream-End Rules performs: put the target on air, then
            // (separately) start a playlist there if one was configured. Switching and
            // starting are independent — a failover with no Group still switches.
            setSourceVisibilityRef.current?.(target, true, 'failover');
            if (action.startGroup) {
                window.dispatchEvent(new CustomEvent('loopAutomationStartGroup', {
                    detail: {
                        groupId: action.startGroup.groupId,
                        listId: action.startGroup.listId,
                        label: 'Playback failover',
                    },
                }));
            }
        }

        // Sent whether or not a switch happened — a black screen has to reach the phone
        // even when there is nowhere to fail over to.
        notifyEvent('PLAYBACK_FAILOVER', {
            player,
            skipped: String(info.skipped ?? ''),
            switchedTo: target || 'nothing (no failover target)',
            startedList: action?.startGroup ? 'configured playlist' : 'none',
            videoId: info.videoId || 'unknown',
            reason: info.reason || 'videos did not play',
        });

        return { switchedTo: target, startedGroup: action?.startGroup || null };
    }, []);

    return { configRef, triggerFailover };
}

export default usePlaybackFailover;
