import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { logSourceChange, logOBSConnection, logError, LogCategory, LogType } from '../utils/logger';

const OBSContext = createContext();

export const useOBS = () => useContext(OBSContext);

const SOURCE_NAMES = [
    "Live Player",
    "Loop Player",
    "Delay Live",
    "Local Player",
    // "OrdaChesta",
];
const POLL_INTERVAL_MS = 1000;
const ACTIVE_SOURCE_KEY = "obsActiveSource";
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
                    setSourceIds(prev => ({ ...prev, ...newSourceIds }));
                    break;
                }
                case "GetStreamStatus":
                    setStreamActive(msg.d.responseData.outputActive);
                    break;
                case "GetRecordStatus":
                    setRecordActive(msg.d.responseData.outputActive);
                    break;
                case "GetVirtualCamStatus":
                    setVirtualCamActive(msg.d.responseData.outputActive);
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
                    break;
                case "RecordStateChanged":
                    setRecordActive(msg.d.eventData.outputActive);
                    break;
                case "VirtualCamStateChanged":
                    setVirtualCamActive(msg.d.eventData.outputActive);
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
    }, [sendRequest]);

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

        if (!sceneNameRef.current) {
            logError(
                LogType.OBS_SOURCE_ERROR,
                LogCategory.SYSTEM,
                { function: 'setSourceVisibility', sourceName, visible, trigger },
                `setSourceVisibility("${sourceName}") failed — OBS scene name unknown`
            );
            return false;
        }

        // Use == null (covers undefined AND null) instead of ! so that a
        // legitimate sceneItemId of 0 is not mistakenly treated as "not found".
        if (currentSourceIds[sourceName] == null) {
            logError(
                LogType.OBS_SOURCE_ERROR,
                LogCategory.SYSTEM,
                { function: 'setSourceVisibility', sourceName, visible, trigger, knownSourceIds: currentSourceIds },
                `setSourceVisibility("${sourceName}") failed — source ID not found in OBS scene`
            );
            return false;
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

        if (visible) {
            localStorage.setItem(ACTIVE_SOURCE_KEY, sourceName);
        }

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
            }
        }
        return true;
    }, [sendRequest]);

    // Confirmed variant of setSourceVisibility — awaits OBS's actual RequestResponse
    // before resolving, so callers (the scheduler's confirm-before-notify flow) know
    // the change really took effect rather than assuming success once it's sent.
    const setSourceVisibilityConfirmed = useCallback(async (sourceName, visible, trigger = 'scheduler') => {
        const currentSourceIds = sourceIdsRef.current;

        if (!sceneNameRef.current) {
            return { ok: false, reason: 'OBS scene name unknown' };
        }
        if (currentSourceIds[sourceName] == null) {
            return { ok: false, reason: `Source "${sourceName}" not found in OBS scene` };
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
            localStorage.setItem(ACTIVE_SOURCE_KEY, sourceName);
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
