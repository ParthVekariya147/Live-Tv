/**
 * useAppState Hook - React hook for backend state management
 * 
 * Provides:
 * - Real-time state sync via WebSocket
 * - Automatic initialization on mount
 * - Get/set functions that sync with server
 * - 24/7 Reliability: Exponential backoff reconnection
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getState, setStateValue, mergeStateValue, StateKeys } from './state-api';

// WebSocket connection (shared across all hook instances)
let wsConnection = null;
let wsReconnectTimeout = null;
let wsReconnectDelay = 3000; // Start at 3 seconds
const WS_MAX_RECONNECT_DELAY = 30000; // Max 30 seconds
const WS_INITIAL_RECONNECT_DELAY = 3000;
let wsListeners = new Set();
const MAX_LISTENERS = 50; // Prevent memory leaks
let isWsConnected = false;

/**
 * Initialize WebSocket connection for state sync with exponential backoff
 */
function initWebSocket() {
    if (wsConnection && wsConnection.readyState !== WebSocket.CLOSED) {
        return wsConnection;
    }

    // Clear any pending reconnect timeout
    if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    wsConnection = new WebSocket(wsUrl);

    wsConnection.onopen = () => {
        isWsConnected = true;
        // Reset reconnect delay on successful connection
        wsReconnectDelay = WS_INITIAL_RECONNECT_DELAY;
    };

    wsConnection.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);

            // Handle state sync and changes
            if (message.type === 'STATE_SYNC' || message.type === 'STATE_CHANGE') {
                // Notify all listeners
                wsListeners.forEach(listener => {
                    try {
                        listener(message);
                    } catch (e) {
                        console.error('[StateWS] Listener error:', e);
                    }
                });
            }
        } catch (e) {
            // Ignore parse errors
        }
    };

    wsConnection.onclose = () => {
        isWsConnected = false;

        // Schedule reconnect with exponential backoff
        wsReconnectTimeout = setTimeout(() => {
            initWebSocket();
        }, wsReconnectDelay);

        // Increase delay for next time (exponential backoff)
        wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_RECONNECT_DELAY);
    };

    wsConnection.onerror = (err) => {
        console.error('[StateWS] Error:', err);
    };

    return wsConnection;
}

/**
 * Add listener with cap to prevent memory leaks
 */
function addStateListener(listener) {
    if (wsListeners.size >= MAX_LISTENERS) {
        console.warn('[StateWS] Max listeners reached, removing oldest');
        const oldest = wsListeners.values().next().value;
        wsListeners.delete(oldest);
    }
    wsListeners.add(listener);
    return () => wsListeners.delete(listener);
}

/**
 * Hook to use a specific state value with real-time sync
 * 
 * @param {string} key - State key (e.g., 'player.loop')
 * @param {*} defaultValue - Default value if not set
 * @returns {[value, setValue, isLoading]}
 */
export function useStateValue(key, defaultValue = null) {
    const [value, setLocalValue] = useState(defaultValue);
    const [isLoading, setIsLoading] = useState(true);
    const mountedRef = useRef(true);

    // Initialize WebSocket
    useEffect(() => {
        initWebSocket();
    }, []);

    // Load initial value
    useEffect(() => {
        async function load() {
            const state = await getState();
            if (mountedRef.current) {
                setLocalValue(state[key] !== undefined ? state[key] : defaultValue);
                setIsLoading(false);
            }
        }
        load();

        return () => {
            mountedRef.current = false;
        };
    }, [key, defaultValue]);

    // Subscribe to WebSocket changes
    useEffect(() => {
        const handleMessage = (message) => {
            if (message.type === 'STATE_SYNC') {
                // Full state sync
                const newValue = message.data[key];
                if (newValue !== undefined) {
                    setLocalValue(newValue);
                }
            } else if (message.type === 'STATE_CHANGE') {
                // Single key change
                if (message.data.key === key) {
                    setLocalValue(message.data.value);
                } else if (message.data.type === 'SET_MULTIPLE') {
                    // Multiple changes
                    const change = message.data.changes?.find(c => c.key === key);
                    if (change) {
                        setLocalValue(change.value);
                    }
                } else if (message.data.type === 'RESET') {
                    // State reset
                    const newValue = message.data.state?.[key];
                    setLocalValue(newValue !== undefined ? newValue : defaultValue);
                }
            }
        };

        return addStateListener(handleMessage);
    }, [key, defaultValue]);

    // Set value function (updates server)
    const setValue = useCallback(async (newValue) => {
        // Optimistic update
        setLocalValue(newValue);
        // Sync to server
        await setStateValue(key, newValue);
    }, [key]);

    return [value, setValue, isLoading];
}

/**
 * Hook to get full app state with real-time sync
 */
export function useAppState() {
    const [state, setState] = useState({});
    const [isLoading, setIsLoading] = useState(true);
    const [isConnected, setIsConnected] = useState(false);

    // Initialize WebSocket
    useEffect(() => {
        initWebSocket();
    }, []);

    // Load initial state
    useEffect(() => {
        async function load() {
            const fullState = await getState();
            setState(fullState);
            setIsLoading(false);
        }
        load();
    }, []);

    // Subscribe to WebSocket changes
    useEffect(() => {
        const handleMessage = (message) => {
            if (message.type === 'STATE_SYNC') {
                setState(message.data);
                setIsConnected(true);
            } else if (message.type === 'STATE_CHANGE') {
                if (message.data.type === 'SET') {
                    setState(prev => ({ ...prev, [message.data.key]: message.data.value }));
                } else if (message.data.type === 'SET_MULTIPLE') {
                    setState(prev => {
                        const updated = { ...prev };
                        message.data.changes.forEach(c => {
                            updated[c.key] = c.value;
                        });
                        return updated;
                    });
                } else if (message.data.type === 'DELETE') {
                    setState(prev => {
                        const updated = { ...prev };
                        delete updated[message.data.key];
                        return updated;
                    });
                } else if (message.data.type === 'RESET') {
                    setState(message.data.state);
                }
            }
        };

        return addStateListener(handleMessage);
    }, []);

    // Get value by key
    const get = useCallback((key, defaultValue = null) => {
        return state[key] !== undefined ? state[key] : defaultValue;
    }, [state]);

    // Set value by key
    const set = useCallback(async (key, value) => {
        setState(prev => ({ ...prev, [key]: value }));
        await setStateValue(key, value);
    }, []);

    // Merge into object value
    const merge = useCallback(async (key, partialValue) => {
        const merged = await mergeStateValue(key, partialValue);
        if (merged) {
            setState(prev => ({ ...prev, [key]: merged }));
        }
        return merged;
    }, []);

    return {
        state,
        isLoading,
        isConnected,
        get,
        set,
        merge,
        StateKeys
    };
}

export { StateKeys };
export default useAppState;
