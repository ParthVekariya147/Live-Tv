import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { logSourceChange, logOBSConnection, logError, LogCategory, LogType } from '../utils/logger';
import { setStateValue, StateKeys } from '../utils/state-api';
import { SOURCE_NAMES, ACTIVE_SOURCE_KEY, resolveHideFallback, readActiveSourceNow } from '../utils/player-switching';
import { notifyEvent, playerSwitchEventFor } from '../utils/notify';

const OBSContext = createContext();

export const useOBS = () => useContext(OBSContext);

const POLL_INTERVAL_MS = 1000;
const OBS_SETTINGS_KEY = "obsSettings";

const readOBSSettings = () => {
    try { return JSON.parse(localStorage.getItem(OBS_SETTINGS_KEY) ?? '{}'); } catch { return {}; }
};

export const OBSProvider = ({ children }) => {
    const [isConnected, setIsConnected] = useState(false);
    const [connectionError, setConnectionError] = useState(null);

    const [obsSettings, setObsSettings] = useState(readOBSSettings);
    const obsSettingsRef = useRef(obsSettings);
    useEffect(() => { obsSettingsRef.current = obsSettings; }, [obsSettings]);

    const [sourceState, setSourceState] = useState({});
    const [sourceIds, setSourceIds] = useState({});
    const [streamActive, setStreamActive] = useState(false);
    const [recordActive, setRecordActive] = useState(false);
    const [virtualCamActive, setVirtualCamActive] = useState(false);
    // Scene name is whatever the user's current OBS program scene is actually called —
    // fetched live via GetCurrentProgramScene instead of assumed, since OBS's default
    // scene name ("Scene 1") never matched the hardcoded "Scene" this used to use.
    const [sceneName, setSceneName] = useState(null);
    const sceneNameRef = useRef(sceneName);
    useEffect(() => { sceneNameRef.current = sceneName; }, [sceneName]);

    const pollIntervalRef = useRef(null);
    const socketRef = useRef(null);
    // Tracks in-flight OBS requests awaiting their op:7 RequestResponse, keyed by requestId —
    // lets sendRequestConfirmed() resolve with the real OBS-side result instead of firing blind.
    const pendingRequestsRef = useRef(new Map());
    const obsReconnectTimeoutRef = useRef(null);
    const obsReconnectDelayRef = useRef(5000);
    const OBS_MAX_RECONNECT_DELAY = 60000;
    const OBS_INITIAL_RECONNECT_DELAY = 5000;
    const sourceStateRef = useRef(sourceState);
    const sourceIdsRef = useRef(sourceIds);

    useEffect(() => { sourceStateRef.current = sourceState; }, [sourceState]);
    useEffect(() => { sourceIdsRef.current = sourceIds; }, [sourceIds]);

    // Holds a setSourceVisibility() call that arrived before OBS had reported its current
    // scene (a normal race at app startup / reconnect) — replayed once GetSceneItemList
    // resolves instead of being silently dropped.
    const pendingVisibilityRef = useRef(null);
    // Always-current ref to setSourceVisibility, so handleOBSMessage (declared above it)
    // can replay a pending request without a stale closure.
    const setSourceVisibilityRef = useRef(null);

    // Last known state of OBS's three outputs, used purely to spot real
    // transitions. `undefined` means "OBS hasn't told us yet" — distinct from a
    // reported false, which matters because the React state below starts at false:
    // without this, connecting to an OBS that is *already* streaming would read as
    // false -> true and announce a stream start that happened hours ago.
    const outputStateRef = useRef({ stream: undefined, record: undefined, vcam: undefined });

    /**
     * Notify on an OBS output actually changing state.
     *
     * Deliberately driven by OBS's own status/events rather than by our toggle
     * buttons, so starting the stream from inside OBS notifies exactly like
     * starting it from this app — "even if I change it manually" includes changing
     * it somewhere else entirely.
     */
    const noteOutputChange = useCallback((kind, active) => {
        const previous = outputStateRef.current[kind];
        outputStateRef.current[kind] = active;
        if (previous === undefined || previous === active) return;   // first report, or no change

        if (kind === 'stream') {
            notifyEvent(active ? 'STREAM_STARTED' : 'STREAM_STOPPED', {});
        } else if (kind === 'record') {
            notifyEvent(active ? 'OBS_RECORDING_STARTED' : 'OBS_RECORDING_STOPPED', {});
        } else if (kind === 'vcam') {
            notifyEvent('VIRTUALCAM_TOGGLED', { state: active ? 'started' : 'stopped' });
        }
    }, []);

    const sendRequest = useCallback((type, data = {}) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            logError(
                LogType.OBS_WEBSOCKET_ERROR,
                LogCategory.SYSTEM,
                { function: 'sendRequest', requestType: type, readyState: ws ? ws.readyState : 'null' },
                `OBS command dropped — WebSocket not open (${type})`
            );
            return;
        }
        const payload = {
            op: 6,
            d: {
                requestType: type,
                requestId: type + Date.now(),
                requestData: data
            }
        };
        ws.send(JSON.stringify(payload));
    }, []);

    // Like sendRequest, but resolves with the OBS-side outcome instead of firing blind.
    // Used only where a caller needs to know the action actually took effect (e.g. the
    // scheduler's confirm-before-notify flow) — everyday UI calls stay on sendRequest.
    const sendRequestConfirmed = useCallback((type, data = {}, timeoutMs = 5000) => {
        return new Promise((resolve) => {
            const ws = socketRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                resolve({ ok: false, reason: 'OBS WebSocket not open' });
                return;
            }
            const requestId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const timeoutId = setTimeout(() => {
                pendingRequestsRef.current.delete(requestId);
                resolve({ ok: false, reason: 'OBS did not respond in time' });
            }, timeoutMs);
            pendingRequestsRef.current.set(requestId, { resolve, timeoutId });
            ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId, requestData: data } }));
        });
    }, []);

    const getCurrentScene = useCallback(() => {
        sendRequest("GetCurrentProgramScene");
    }, [sendRequest]);

    const getSceneItems = useCallback(() => {
        // Scene name is not yet known at first connect — GetCurrentProgramScene handler
        // will call GetSceneItemList immediately once the name arrives, so this is safe to skip.
        if (!sceneNameRef.current) return;
        sendRequest("GetSceneItemList", { sceneName: sceneNameRef.current });
    }, [sendRequest]);

    const getStreamStatus = useCallback(() => sendRequest("GetStreamStatus"), [sendRequest]);
    const getRecordStatus = useCallback(() => sendRequest("GetRecordStatus"), [sendRequest]);
    const getVirtualCamStatus = useCallback(() => sendRequest("GetVirtualCamStatus"), [sendRequest]);

    const fetchAllStatuses = useCallback(() => {
        getStreamStatus();
        getRecordStatus();
        getVirtualCamStatus();
        getSceneItems();
    }, [getStreamStatus, getRecordStatus, getVirtualCamStatus, getSceneItems]);

    const handleOBSMessage = useCallback((msg) => {
        if (msg.op === 7) {
            const pending = pendingRequestsRef.current.get(msg.d.requestId);
            if (pending) {
                clearTimeout(pending.timeoutId);
                pendingRequestsRef.current.delete(msg.d.requestId);
                pending.resolve({
                    ok: !!msg.d.requestStatus.result,
                    reason: msg.d.requestStatus.result ? null : (msg.d.requestStatus.comment || 'OBS rejected the request')
                });
            }
        }

        if (msg.op === 7 && msg.d.requestStatus.result) {
            switch (msg.d.requestType) {
                case "GetCurrentProgramScene": {
                    const name = msg.d.responseData.currentProgramSceneName ?? msg.d.responseData.sceneName;
                    // Update the ref synchronously — setSceneName alone won't update sceneNameRef
                    // until after the next render (via useEffect), so getSceneItems() would still
                    // see null and skip. Updating the ref here lets the immediate sendRequest below work.
                    sceneNameRef.current = name;
                    setSceneName(name);
                    // Fetch scene items immediately — this is skipped on first connect because
                    // the ref is null when fetchAllStatuses() runs in onopen.
                    sendRequest("GetSceneItemList", { sceneName: name });
                    break;
                }
                case "GetSceneItemList": {
                    const items = msg.d.responseData.sceneItems;
                    const newSourceState = {};
                    const newSourceIds = {};
                    for (const item of items) {
                        if (SOURCE_NAMES.includes(item.sourceName)) {
                            newSourceState[item.sourceName] = item.sceneItemEnabled;
                            newSourceIds[item.sourceName] = item.sceneItemId;
                        }
                    }
                    setSourceState(prev => ({ ...prev, ...newSourceState }));
                    // Replace rather than merge: scene item IDs belong to one scene, and this
                    // response describes that scene completely. Merging kept IDs from a
                    // previously-inspected scene alive forever — so after switching OBS to the
                    // single-source Unified Player layout, the four stale IDs lingered and made
                    // the app act as if the old per-player scene items were still there:
                    // SetSceneItemEnabled fired against IDs that no longer exist and the
                    // scheduler treated a disconnected OBS as a reason to queue.
                    setSourceIds(newSourceIds);

                    // Replay a visibility change that came in before the scene/sources were
                    // known (e.g. right at startup) now that they've just resolved.
                    if (pendingVisibilityRef.current) {
                        const { sourceName, visible, trigger } = pendingVisibilityRef.current;
                        pendingVisibilityRef.current = null;
                        setTimeout(() => setSourceVisibilityRef.current?.(sourceName, visible, trigger), 0);
                    }
                    break;
                }
                case "GetStreamStatus":
                    setStreamActive(msg.d.responseData.outputActive);
                    noteOutputChange('stream', msg.d.responseData.outputActive);
                    break;
                case "GetRecordStatus":
                    setRecordActive(msg.d.responseData.outputActive);
                    noteOutputChange('record', msg.d.responseData.outputActive);
                    break;
                case "GetVirtualCamStatus":
                    setVirtualCamActive(msg.d.responseData.outputActive);
                    noteOutputChange('vcam', msg.d.responseData.outputActive);
                    break;
                default:
                    break;
            }
        }

        if (msg.op === 5) {
            switch (msg.d.eventType) {
                case "SceneItemEnableStateChanged": {
                    // obs-websocket v5 eventData only carries sceneItemId, not the source
                    // name — resolve it via the id->name map we built from GetSceneItemList.
                    const { sceneItemId, sceneItemEnabled } = msg.d.eventData;
                    const changedItemName = Object.entries(sourceIdsRef.current)
                        .find(([, id]) => id === sceneItemId)?.[0];
                    if (changedItemName && SOURCE_NAMES.includes(changedItemName)) {
                        setSourceState(prev => ({
                            ...prev,
                            [changedItemName]: sceneItemEnabled
                        }));
                    }
                    break;
                }
                case "StreamStateChanged":
                    setStreamActive(msg.d.eventData.outputActive);
                    noteOutputChange('stream', msg.d.eventData.outputActive);
                    break;
                case "RecordStateChanged":
                    setRecordActive(msg.d.eventData.outputActive);
                    noteOutputChange('record', msg.d.eventData.outputActive);
                    break;
                case "VirtualCamStateChanged":
                    setVirtualCamActive(msg.d.eventData.outputActive);
                    noteOutputChange('vcam', msg.d.eventData.outputActive);
                    break;
                case "CurrentProgramSceneChanged": {
                    const newScene = msg.d.eventData.sceneName;
                    sceneNameRef.current = newScene;
                    setSceneName(newScene);
                    sendRequest("GetSceneItemList", { sceneName: newScene });
                    break;
                }
            }
        }
    }, [sendRequest, noteOutputChange]);

    const connectOBS = useCallback(() => {
        // Avoid double connections — also block if socket is CLOSING (mid-teardown)
        if (socketRef.current && (
            socketRef.current.readyState === WebSocket.OPEN ||
            socketRef.current.readyState === WebSocket.CONNECTING ||
            socketRef.current.readyState === WebSocket.CLOSING
        )) {
            return;
        }

        if (obsReconnectTimeoutRef.current) {
            clearTimeout(obsReconnectTimeoutRef.current);
            obsReconnectTimeoutRef.current = null;
        }

        const s = obsSettingsRef.current;
        const obsHost = s.host || 'localhost';
        const obsPort = s.port || 4455;
        const ws = new WebSocket(`ws://${obsHost}:${obsPort}`);
        socketRef.current = ws;

        ws.onopen = () => {
            setIsConnected(true);
            setConnectionError(null);
            logOBSConnection(true, `${obsHost}:${obsPort}`);

            // Reset reconnect delay on successful connection (24/7 Reliability)
            obsReconnectDelayRef.current = OBS_INITIAL_RECONNECT_DELAY;

            fetch('/api/obs/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected: true })
            }).catch(() => { });

            // General(0) | Scenes(2) | Inputs(3) | Transitions(4) | Filters(5) | Outputs(6) | SceneItems(7)
            // Outputs/SceneItems are required so stream/record/vcam status and source visibility
            // (SceneItemEnableStateChanged) arrive instantly via events instead of waiting on the
            // 1s poll — without them the UI can briefly show a stale snapshot mid-switch and
            // re-fire load/pause on every player card.
            const identifyPayload = {
                op: 1,
                d: {
                    rpcVersion: 1,
                    eventSubscriptions: (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7),
                },
            };
            ws.send(JSON.stringify(identifyPayload));

            // Find out what the current program scene is actually called before
            // doing anything scene-scoped — it's rarely the literal word "Scene".
            getCurrentScene();

            // Initial fetch — getSceneItems will silently skip if sceneNameRef is still null;
            // the GetCurrentProgramScene response handler immediately sends GetSceneItemList.
            fetchAllStatuses();

            const savedActiveSource = localStorage.getItem(ACTIVE_SOURCE_KEY);
            if (savedActiveSource && SOURCE_NAMES.includes(savedActiveSource)) {
                // Apply after the initial fetch populates sourceIds
                setTimeout(() => {
                    const currentIds = sourceIdsRef.current;
                    const scene = sceneNameRef.current;
                    if (scene && currentIds[savedActiveSource] != null) {
                        sendRequest("SetSceneItemEnabled", {
                            sceneName: scene,
                            sceneItemId: currentIds[savedActiveSource],
                            sceneItemEnabled: true
                        });
                        setSourceState(prev => ({ ...prev, [savedActiveSource]: true }));

                        SOURCE_NAMES.forEach(s => {
                            if (s !== savedActiveSource && currentIds[s] != null) {
                                sendRequest("SetSceneItemEnabled", {
                                    sceneName: scene,
                                    sceneItemId: currentIds[s],
                                    sceneItemEnabled: false
                                });
                                setSourceState(prev => ({ ...prev, [s]: false }));
                            }
                        });
                    }
                }, 1500);
            }

            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    fetchAllStatuses();
                }
            }, POLL_INTERVAL_MS);
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleOBSMessage(msg);
            } catch (e) {
                logError(
                    LogType.OBS_WEBSOCKET_ERROR,
                    LogCategory.SYSTEM,
                    { function: 'ws.onmessage', error: e.message },
                    'Failed to parse OBS WebSocket message'
                );
            }
        };

        ws.onclose = (ev) => {
            setIsConnected(false);
            logOBSConnection(false, `${obsHost}:${obsPort}`);

            fetch('/api/obs/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected: false })
            }).catch(() => { });

            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

            // Schedule reconnect with exponential backoff (24/7 Reliability)
            obsReconnectTimeoutRef.current = setTimeout(() => {
                connectOBS();
            }, obsReconnectDelayRef.current);

            obsReconnectDelayRef.current = Math.min(
                obsReconnectDelayRef.current * 1.5,
                OBS_MAX_RECONNECT_DELAY
            );
        };

        ws.onerror = () => {
            setConnectionError("OBS WebSocket Error");
            logError(
                LogType.OBS_WEBSOCKET_ERROR,
                LogCategory.SYSTEM,
                { function: 'ws.onerror', host: obsHost, port: obsPort },
                `OBS WebSocket connection error (${obsHost}:${obsPort})`
            );
        };
    }, [fetchAllStatuses, handleOBSMessage, getCurrentScene]);

    useEffect(() => {
        connectOBS();
        return () => {
            if (socketRef.current) socketRef.current.close();
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            if (obsReconnectTimeoutRef.current) clearTimeout(obsReconnectTimeoutRef.current);
        };
    }, [connectOBS]);

    // sourceState above is populated from real OBS scene items (GetSceneItemList),
    // which is empty in the single-source (UnifiedPlayer.html) layout — there are no
    // per-player scene items left to report. Every card (LoopPlayerCard, LivePlayerCard,
    // DelayPlayerCard, LocalPlayerCard) and LoopPlaylistAutomation read sourceState[name]
    // as their "am I on air" signal — e.g. LoopPlayerCard's resumePlayback() only fires
    // on a false->true transition of that flag. So this also derives sourceState from
    // the app's own obs.activeSource key (the same one setSourceVisibility now writes),
    // which is what UnifiedPlayer.html itself watches. GetSceneItemList's contribution
    // becomes a no-op in that layout (nothing named "Loop Player" etc. exists to match),
    // so merging both into the same setSourceState never conflicts.
    useEffect(() => {
        const applyActiveSource = (name) => {
            if (!name) return;
            setSourceState(prev => {
                const next = { ...prev };
                SOURCE_NAMES.forEach(s => { next[s] = (s === name); });
                return next;
            });
        };

        fetch('/api/state/obs.activeSource')
            .then(r => (r.ok ? r.json() : null))
            .then(data => applyActiveSource(data && data.value))
            .catch(() => {});

        let ws;
        let reconnectTimeout;
        const connect = () => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
            ws.onmessage = (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch { return; }
                if (msg.type === 'STATE_SYNC') {
                    applyActiveSource(msg.data && msg.data['obs.activeSource']);
                } else if (msg.type === 'STATE_CHANGE' && msg.data?.key === 'obs.activeSource') {
                    applyActiveSource(msg.data.value);
                }
            };
            ws.onclose = () => { reconnectTimeout = setTimeout(connect, 3000); };
            ws.onerror = () => { ws.close(); };
        };
        connect();

        return () => {
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            if (ws) { ws.onclose = null; ws.close(); }
        };
    }, []);

    // --- Actions ---

    const toggleStream = useCallback(() => {
        const type = streamActive ? "StopStream" : "StartStream";
        sendRequest(type);
    }, [streamActive, sendRequest]);

    const toggleRecord = useCallback(() => {
        const type = recordActive ? "StopRecord" : "StartRecord";
        sendRequest(type);
    }, [recordActive, sendRequest]);

    const toggleVirtualCam = useCallback(() => {
        const type = virtualCamActive ? "StopVirtualCam" : "StartVirtualCam";
        sendRequest(type);
    }, [virtualCamActive, sendRequest]);

    const setSourceVisibility = useCallback((sourceName, visible, trigger = 'manual') => {
        const currentSourceIds = sourceIdsRef.current;
        const currentSourceState = sourceStateRef.current;

        // Push the shared active-source state unconditionally, before touching any
        // OBS-scene-item logic below. UnifiedPlayer.html (single-source layout) has
        // no scene items to toggle at all — it just watches this key over /ws — so
        // this must not be gated behind OBS having a matching scene item or scene name.
        //
        // The return value means "did the switch happen", and callers act on it —
        // OBSControlPanel.switchToSource flags the player as not working when it's false.
        // So once this write IS the switch, it has to count as success: returning false
        // here made every manual switch button in the panel show a failure warning for a
        // switch that had in fact just worked.
        // Read who was on air *before* the write below, so the notification can say
        // what it switched away from.
        const previousActive = readActiveSourceNow();

        let switched = false;
        let notifyTarget = null;
        if (visible) {
            localStorage.setItem(ACTIVE_SOURCE_KEY, sourceName);
            setStateValue(StateKeys.OBS_ACTIVE_SOURCE, sourceName);
            notifyTarget = sourceName;
            switched = true;
        } else {
            const fallback = resolveHideFallback(sourceName, currentSourceState);
            if (fallback) {
                localStorage.setItem(ACTIVE_SOURCE_KEY, fallback);
                setStateValue(StateKeys.OBS_ACTIVE_SOURCE, fallback);
                notifyTarget = fallback;
            }
            // A hide with no fallback is a legitimate no-op (already off air), not a failure.
            switched = true;
        }

        // Every player switch in the app funnels through here, whoever caused it,
        // so this one call covers the manual buttons, the end-of-video handoffs and
        // the playlist engine alike — that's why the notification lives here rather
        // than being repeated at each call site. Scheduled switches are excluded by
        // playerSwitchEventFor (the server notifies those only after OBS confirms),
        // and a switch to the player already on air notifies nothing: OBS reconnects
        // and re-renders re-assert the current source routinely, and none of those
        // are a change worth a buzz.
        if (notifyTarget && notifyTarget !== previousActive) {
            const event = playerSwitchEventFor(trigger);
            if (event) {
                notifyEvent(event, {
                    player: notifyTarget,
                    previousPlayer: previousActive || 'nothing',
                    trigger,
                });
            }
        }

        if (!sceneNameRef.current) {
            // Normal race at startup/reconnect — OBS hasn't reported its current scene yet.
            // Queue it; the GetSceneItemList handler replays it as soon as the scene resolves.
            pendingVisibilityRef.current = { sourceName, visible, trigger };
            return switched;
        }

        // Use == null (covers undefined AND null) instead of ! so that a
        // legitimate sceneItemId of 0 is not mistakenly treated as "not found".
        if (currentSourceIds[sourceName] == null) {
            // No matching OBS scene item for this name. In the single-source layout
            // that's expected for all four names — only warn when OBS scene items are
            // known but this particular one is missing, which points at a real
            // misconfiguration (typo / renamed source) rather than the new layout.
            const anySourceKnown = SOURCE_NAMES.some(s => currentSourceIds[s] != null);
            if (anySourceKnown) {
                logError(
                    LogType.OBS_SOURCE_ERROR,
                    LogCategory.SYSTEM,
                    { function: 'setSourceVisibility', sourceName, visible, trigger, knownSourceIds: currentSourceIds },
                    `setSourceVisibility("${sourceName}") failed — source ID not found in OBS scene`
                );
                return false;
            }
            return switched;
        }

        const payload = {
            sceneName: sceneNameRef.current,
            sceneItemId: currentSourceIds[sourceName],
            sceneItemEnabled: visible
        };
        sendRequest("SetSceneItemEnabled", payload);

        // Update local state immediately for responsiveness
        setSourceState(prev => ({ ...prev, [sourceName]: visible }));

        const previousSource = visible
            ? Object.entries(currentSourceState).find(([name, isVisible]) => isVisible && name !== sourceName)?.[0]
            : null;
        logSourceChange(sourceName, visible, trigger, previousSource);

        // Enforce exclusivity: turning ON one source turns OFF all others
        if (visible) {
            SOURCE_NAMES.forEach(s => {
                if (s !== sourceName && currentSourceIds[s] != null && currentSourceState[s]) {
                    sendRequest("SetSceneItemEnabled", {
                        sceneName: sceneNameRef.current,
                        sceneItemId: currentSourceIds[s],
                        sceneItemEnabled: false
                    });
                    setSourceState(prev => ({ ...prev, [s]: false }));
                }
            });
        } else {
            // If turning OFF and nothing else is visible, fall back to Loop Player
            const anyOtherVisible = SOURCE_NAMES.some(s => s !== sourceName && currentSourceState[s]);
            if (!anyOtherVisible && currentSourceIds["Loop Player"] != null) {
                sendRequest("SetSceneItemEnabled", {
                    sceneName: sceneNameRef.current,
                    sceneItemId: currentSourceIds["Loop Player"],
                    sceneItemEnabled: true
                });
                setSourceState(prev => ({ ...prev, "Loop Player": true }));
                setStateValue(StateKeys.OBS_ACTIVE_SOURCE, "Loop Player");
            }
        }
        return true;
    }, [sendRequest]);

    useEffect(() => { setSourceVisibilityRef.current = setSourceVisibility; }, [setSourceVisibility]);

    // Confirmed variant of setSourceVisibility — awaits OBS's actual RequestResponse
    // before resolving, so callers (the scheduler's confirm-before-notify flow) know
    // the change really took effect rather than assuming success once it's sent.
    const setSourceVisibilityConfirmed = useCallback(async (sourceName, visible, trigger = 'scheduler') => {
        const currentSourceIds = sourceIdsRef.current;

        // Push the shared active-source state — same reasoning as setSourceVisibility
        // above. In the single-source layout there is no OBS scene item to confirm
        // against at all, so this write IS the confirmation: report the server's own
        // answer rather than assuming it landed, since that answer is now the only
        // evidence the switch really happened.
        let stateOk = true;   // stays true when there was legitimately nothing to write
        const target = visible ? sourceName : resolveHideFallback(sourceName, sourceStateRef.current);
        if (target) {
            localStorage.setItem(ACTIVE_SOURCE_KEY, target);
            stateOk = await setStateValue(StateKeys.OBS_ACTIVE_SOURCE, target);
        }
        const stateResult = stateOk
            ? { ok: true, reason: null }
            : { ok: false, reason: `Could not save player state to the server (${visible ? 'show' : 'hide'} ${sourceName})` };

        // A failed state write means the switch did not happen, whatever OBS says.
        if (!stateOk) return stateResult;

        if (!sceneNameRef.current || currentSourceIds[sourceName] == null) {
            // No OBS scene item to toggle — expected for all four names in the
            // single-source layout, where the state push above is the whole switch.
            return stateResult;
        }

        const result = await sendRequestConfirmed('SetSceneItemEnabled', {
            sceneName: sceneNameRef.current,
            sceneItemId: currentSourceIds[sourceName],
            sceneItemEnabled: visible
        });

        if (!result.ok) return result;

        setSourceState(prev => ({ ...prev, [sourceName]: visible }));
        logSourceChange(sourceName, visible, trigger, null);

        if (visible) {
            // Enforce exclusivity: turning ON one source turns OFF all others.
            // These companion calls are best-effort (fire-and-forget) — the caller's
            // confirmation only depends on the primary source's own acknowledgment.
            SOURCE_NAMES.forEach(s => {
                if (s !== sourceName && currentSourceIds[s] != null && sourceStateRef.current[s]) {
                    sendRequest("SetSceneItemEnabled", {
                        sceneName: sceneNameRef.current,
                        sceneItemId: currentSourceIds[s],
                        sceneItemEnabled: false
                    });
                    setSourceState(prev => ({ ...prev, [s]: false }));
                }
            });
        } else {
            const anyOtherVisible = SOURCE_NAMES.some(s => s !== sourceName && sourceStateRef.current[s]);
            if (!anyOtherVisible && currentSourceIds["Loop Player"] != null) {
                sendRequest("SetSceneItemEnabled", {
                    sceneName: sceneNameRef.current,
                    sceneItemId: currentSourceIds["Loop Player"],
                    sceneItemEnabled: true
                });
                setSourceState(prev => ({ ...prev, "Loop Player": true }));
                setStateValue(StateKeys.OBS_ACTIVE_SOURCE, "Loop Player");
            }
        }

        return result;
    }, [sendRequestConfirmed, sendRequest]);

    const toggleSource = useCallback((sourceName) => {
        const current = sourceStateRef.current[sourceName];
        setSourceVisibility(sourceName, !current);
    }, [setSourceVisibility]);

    const updateOBSSettings = useCallback((newSettings) => {
        const merged = { ...obsSettingsRef.current, ...newSettings };
        obsSettingsRef.current = merged;
        setObsSettings(merged);
        localStorage.setItem(OBS_SETTINGS_KEY, JSON.stringify(merged));
        if (socketRef.current) {
            socketRef.current.close();
            socketRef.current = null;
        }
        setIsConnected(false);
        obsReconnectDelayRef.current = 1000;
        obsReconnectTimeoutRef.current = setTimeout(() => connectOBS(), 500);
    }, [connectOBS]);

    return (
        <OBSContext.Provider value={{
            isConnected,
            connectionError,
            sourceState,
            sourceIds,
            streamActive,
            recordActive,
            virtualCamActive,
            toggleStream,
            toggleRecord,
            toggleVirtualCam,
            setSourceVisibility,
            setSourceVisibilityConfirmed,
            toggleSource,
            obsSettings,
            updateOBSSettings,
            SCENE_NAME: sceneName,
            SOURCE_NAMES,
            socket: socketRef.current,
        }}>
            {children}
        </OBSContext.Provider>
    );
};
