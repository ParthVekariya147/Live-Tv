import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { logSourceChange, logOBSConnection } from '../utils/logger';

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
    const obsReconnectTimeoutRef = useRef(null);
    const obsReconnectDelayRef = useRef(5000);
    const OBS_MAX_RECONNECT_DELAY = 60000; // 60 seconds max for OBS
    const OBS_INITIAL_RECONNECT_DELAY = 5000;
    // Use refs to always have access to the latest state values inside callbacks
    const sourceStateRef = useRef(sourceState);
    const sourceIdsRef = useRef(sourceIds);

    // Keep refs in sync with state
    useEffect(() => {
        sourceStateRef.current = sourceState;
    }, [sourceState]);

    useEffect(() => {
        sourceIdsRef.current = sourceIds;
    }, [sourceIds]);

    const sendRequest = useCallback((type, data = {}) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn(`sendRequest(${type}): OBS not connected.`);
            return;
        }
        ws.send(JSON.stringify({
            op: 6,
            d: {
                requestType: type,
                requestId: type + Date.now(),
                requestData: data
            }
        }));
    }, []);

    const getCurrentScene = useCallback(() => sendRequest("GetCurrentProgramScene"), [sendRequest]);
    const getSceneItems = useCallback(() => {
        if (!sceneNameRef.current) return; // wait until we know the real scene name
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
        if (msg.op === 7 && msg.d.requestStatus.result) {
            switch (msg.d.requestType) {
                case "GetCurrentProgramScene":
                    setSceneName(msg.d.responseData.currentProgramSceneName ?? msg.d.responseData.sceneName);
                    break;
                case "GetSceneItemList": {
                    const items = msg.d.responseData.sceneItems;
                    const newSourceState = {};
                    const newSourceIds = {};

                    for (const item of items) {
                        const name = item.sourceName;
                        if (SOURCE_NAMES.includes(name)) {
                            newSourceState[name] = item.sceneItemEnabled;
                            newSourceIds[name] = item.sceneItemId;
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

        if (msg.op === 5) { // Events
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
                case "CurrentProgramSceneChanged":
                    setSceneName(msg.d.eventData.sceneName);
                    break;
            }
        }
    }, []);

    const connectOBS = useCallback(() => {
        // Avoid double connections — also block if socket is CLOSING (mid-teardown)
        if (socketRef.current && (
            socketRef.current.readyState === WebSocket.OPEN ||
            socketRef.current.readyState === WebSocket.CONNECTING ||
            socketRef.current.readyState === WebSocket.CLOSING
        )) {
            return;
        }

        // Clear any pending reconnect timeout (24/7 Reliability)
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
            logOBSConnection(true, 'localhost:4455');

            // Reset reconnect delay on successful connection (24/7 Reliability)
            obsReconnectDelayRef.current = OBS_INITIAL_RECONNECT_DELAY;

            // Notify server of connection
            fetch('/api/obs/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected: true })
            }).catch(() => { });

            // Identify
            // General(0) | Scenes(2) | Inputs(3) | Transitions(4) | Filters(5) | Outputs(6) | SceneItems(7)
            // Outputs/SceneItems are required so stream/record/vcam status and source visibility
            // (SceneItemEnableStateChanged) arrive instantly via events instead of waiting on the
            // 1s poll — without them the UI can briefly show a stale snapshot mid-switch and
            // re-fire load/pause on every player card.
            ws.send(JSON.stringify({
                op: 1,
                d: {
                    rpcVersion: 1,
                    eventSubscriptions: (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7),
                },
            }));

            // Find out what the current program scene is actually called before
            // doing anything scene-scoped — it's rarely the literal word "Scene".
            getCurrentScene();

            // Initial fetch
            fetchAllStatuses();

            // Restore saved active source from localStorage
            const savedActiveSource = localStorage.getItem(ACTIVE_SOURCE_KEY);
            if (savedActiveSource && SOURCE_NAMES.includes(savedActiveSource)) {
                // We'll apply this after the initial fetch populates sourceIds
                // Use a short timeout to allow first poll to complete
                setTimeout(() => {
                    const currentIds = sourceIdsRef.current;
                    const scene = sceneNameRef.current;
                    if (scene && currentIds[savedActiveSource]) {
                        // Turn on the saved source
                        sendRequest("SetSceneItemEnabled", {
                            sceneName: scene,
                            sceneItemId: currentIds[savedActiveSource],
                            sceneItemEnabled: true
                        });
                        setSourceState(prev => ({ ...prev, [savedActiveSource]: true }));

                        // Turn off all other sources for exclusivity
                        SOURCE_NAMES.forEach(s => {
                            if (s !== savedActiveSource && currentIds[s]) {
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

            // Start polling
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
                console.error("OBS message parse error:", e);
            }
        };

        ws.onclose = () => {
            setIsConnected(false);
            logOBSConnection(false, 'localhost:4455');

            // Notify server of disconnection
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

            // Increase delay for next time (exponential backoff)
            obsReconnectDelayRef.current = Math.min(
                obsReconnectDelayRef.current * 1.5,
                OBS_MAX_RECONNECT_DELAY
            );
        };

        ws.onerror = (err) => {
            console.error("OBS WebSocket error:", err);
            setConnectionError("OBS WebSocket Error");
        };
    }, [fetchAllStatuses, handleOBSMessage, getCurrentScene]);

    useEffect(() => {
        connectOBS();
        return () => {
            if (socketRef.current) {
                socketRef.current.close();
            }
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
            console.warn(`setSourceVisibility: OBS program scene name not known yet. Cannot set visibility.`);
            return;
        }

        if (!currentSourceIds[sourceName]) {
            console.warn(`setSourceVisibility: Source ID for "${sourceName}" not found. Cannot set visibility.`);
            return;
        }


        // Send command to OBS for the target source
        sendRequest("SetSceneItemEnabled", {
            sceneName: sceneNameRef.current,
            sceneItemId: currentSourceIds[sourceName],
            sceneItemEnabled: visible
        });

        // Update local state immediately for responsiveness
        setSourceState(prev => ({ ...prev, [sourceName]: visible }));

        // Find what was previously visible for logging
        const previousSource = visible ? Object.entries(currentSourceState).find(([name, isVisible]) => isVisible && name !== sourceName)?.[0] : null;

        // Log the visibility change with the trigger source
        logSourceChange(sourceName, visible, trigger, previousSource);

        // Save active source to localStorage for persistence
        if (visible) {
            localStorage.setItem(ACTIVE_SOURCE_KEY, sourceName);
        }

        // Enforce exclusivity logic: if turning ON a source, turn OFF all others
        if (visible) {
            SOURCE_NAMES.forEach(s => {
                if (s !== sourceName && currentSourceIds[s]) {
                    // Only send command if the other source is currently visible
                    if (currentSourceState[s]) {
                        sendRequest("SetSceneItemEnabled", {
                            sceneName: sceneNameRef.current,
                            sceneItemId: currentSourceIds[s],
                            sceneItemEnabled: false
                        });
                        setSourceState(prev => ({ ...prev, [s]: false }));
                    }
                }
            });
        } else {
            // If turning OFF a source, check if any source is still visible
            // If none, turn on Loop Player as default
            const anyOtherVisible = SOURCE_NAMES.some(s => s !== sourceName && currentSourceState[s]);
            if (!anyOtherVisible) {
                if (currentSourceIds["Loop Player"]) {
                    sendRequest("SetSceneItemEnabled", {
                        sceneName: sceneNameRef.current,
                        sceneItemId: currentSourceIds["Loop Player"],
                        sceneItemEnabled: true
                    });
                    setSourceState(prev => ({ ...prev, "Loop Player": true }));
                }
            }
        }
    }, [sendRequest]);

    const toggleSource = useCallback((sourceName) => {
        const current = sourceStateRef.current[sourceName];
        setSourceVisibility(sourceName, !current);
    }, [setSourceVisibility]);

    const updateOBSSettings = useCallback((newSettings) => {
        const merged = { ...obsSettingsRef.current, ...newSettings };
        obsSettingsRef.current = merged;
        setObsSettings(merged);
        localStorage.setItem(OBS_SETTINGS_KEY, JSON.stringify(merged));
        // Force reconnect with new settings
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
