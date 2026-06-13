import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { logSourceChange, logOBSConnection } from '../utils/logger';

const OBSContext = createContext();

export const useOBS = () => useContext(OBSContext);

const SCENE_NAME = "Scene";
const SOURCE_NAMES = [
    "Loop Player",
    "Live Player",
    "Delay Live",
    "OrdaChesta",
    "Local Player",
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

    const getSceneItems = useCallback(() => sendRequest("GetSceneItemList", { sceneName: SCENE_NAME }), [sendRequest]);
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
                    const changedItemName = msg.d.eventData.sceneItemSourceName;
                    if (SOURCE_NAMES.includes(changedItemName)) {
                        setSourceState(prev => ({
                            ...prev,
                            [changedItemName]: msg.d.eventData.sceneItemEnabled
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
            ws.send(JSON.stringify({
                op: 1,
                d: {
                    rpcVersion: 1,
                    eventSubscriptions: (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5),
                },
            }));

            // Initial fetch
            fetchAllStatuses();

            // Restore saved active source from localStorage
            const savedActiveSource = localStorage.getItem(ACTIVE_SOURCE_KEY);
            if (savedActiveSource && SOURCE_NAMES.includes(savedActiveSource)) {
                // We'll apply this after the initial fetch populates sourceIds
                // Use a short timeout to allow first poll to complete
                setTimeout(() => {
                    const currentIds = sourceIdsRef.current;
                    if (currentIds[savedActiveSource]) {
                        // Turn on the saved source
                        sendRequest("SetSceneItemEnabled", {
                            sceneName: SCENE_NAME,
                            sceneItemId: currentIds[savedActiveSource],
                            sceneItemEnabled: true
                        });
                        setSourceState(prev => ({ ...prev, [savedActiveSource]: true }));

                        // Turn off all other sources for exclusivity
                        SOURCE_NAMES.forEach(s => {
                            if (s !== savedActiveSource && currentIds[s]) {
                                sendRequest("SetSceneItemEnabled", {
                                    sceneName: SCENE_NAME,
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
    }, [fetchAllStatuses, handleOBSMessage]);

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

        if (!currentSourceIds[sourceName]) {
            console.warn(`setSourceVisibility: Source ID for "${sourceName}" not found. Cannot set visibility.`);
            return;
        }


        // Send command to OBS for the target source
        sendRequest("SetSceneItemEnabled", {
            sceneName: SCENE_NAME,
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
                            sceneName: SCENE_NAME,
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
                        sceneName: SCENE_NAME,
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
            SCENE_NAME,
            SOURCE_NAMES,
            socket: socketRef.current,
        }}>
            {children}
        </OBSContext.Provider>
    );
};
