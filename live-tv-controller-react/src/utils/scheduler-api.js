/**
 * Scheduler API Client
 * 
 * Provides functions to interact with the server-side scheduler
 * and WebSocket for real-time updates.
 */

const API_BASE = '';

// ============================================
// REST API FUNCTIONS
// ============================================

/**
 * Get scheduler status
 */
export const getSchedulerStatus = async () => {
    try {
        const response = await fetch(`${API_BASE}/api/scheduler/status`);
        return await response.json();
    } catch (error) {
        console.error('Error getting scheduler status:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Start the scheduler
 */
export const startScheduler = async () => {
    try {
        const response = await fetch(`${API_BASE}/api/scheduler/start`, { method: 'POST' });
        return await response.json();
    } catch (error) {
        console.error('Error starting scheduler:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Stop the scheduler
 */
export const stopScheduler = async () => {
    try {
        const response = await fetch(`${API_BASE}/api/scheduler/stop`, { method: 'POST' });
        return await response.json();
    } catch (error) {
        console.error('Error stopping scheduler:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Get all schedules
 */
export const getSchedules = async () => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules`);
        return await response.json();
    } catch (error) {
        console.error('Error getting schedules:', error);
        return { success: false, schedules: [], error: error.message };
    }
};

/**
 * Add a new schedule
 */
export const addSchedule = async (scheduleData) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(scheduleData)
        });
        return await response.json();
    } catch (error) {
        console.error('Error adding schedule:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Update a schedule
 */
export const updateSchedule = async (id, updates) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        return await response.json();
    } catch (error) {
        console.error('Error updating schedule:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Delete a schedule
 */
export const deleteSchedule = async (id) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules/${id}`, { method: 'DELETE' });
        return await response.json();
    } catch (error) {
        console.error('Error deleting schedule:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Toggle schedule enabled state
 */
export const toggleSchedule = async (id) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules/${id}/toggle`, { method: 'POST' });
        return await response.json();
    } catch (error) {
        console.error('Error toggling schedule:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Import/replace all schedules
 */
export const importSchedules = async (schedules) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedules })
        });
        return await response.json();
    } catch (error) {
        console.error('Error importing schedules:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Immediately fire a schedule (test/manual trigger)
 */
export const fireSchedule = async (id) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules/${id}/fire`, { method: 'POST' });
        return await response.json();
    } catch (error) {
        console.error('Error firing schedule:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Skip the next trigger for a schedule by 1 day
 */
export const skipScheduleDay = async (id) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules/${id}/skip-day`, { method: 'POST' });
        return await response.json();
    } catch (error) {
        console.error('Error skipping schedule:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Cancel an active skip for a schedule
 */
export const cancelScheduleSkip = async (id) => {
    try {
        const response = await fetch(`${API_BASE}/api/schedules/${id}/cancel-skip`, { method: 'POST' });
        return await response.json();
    } catch (error) {
        console.error('Error cancelling skip:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Get next pending triggers
 */
export const getNextTriggers = async (count = 5) => {
    try {
        const response = await fetch(`${API_BASE}/api/scheduler/next?count=${count}`);
        return await response.json();
    } catch (error) {
        console.error('Error getting next triggers:', error);
        return { success: false, nextTriggers: [], error: error.message };
    }
};

// ============================================
// WEBSOCKET CONNECTION (24/7 Reliability)
// ============================================

let wsConnection = null;
let wsReconnectTimeout = null;
let wsReconnectDelay = 5000; // Start at 5 seconds
const WS_MAX_RECONNECT_DELAY = 30000; // Max 30 seconds
const WS_INITIAL_RECONNECT_DELAY = 5000;
const wsListeners = new Set();
const MAX_LISTENERS = 50; // Prevent memory leaks

/**
 * Get WebSocket URL based on current location
 */
const getWsUrl = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // In development, connect to the API server port (3004)
    const port = import.meta.env.DEV ? '3004' : window.location.port || '3003';
    return `${protocol}//${window.location.hostname}:${port}/ws`;
};

/**
 * Connect to WebSocket server with exponential backoff
 */
export const connectWebSocket = () => {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        return;
    }

    // Clear any pending reconnect timeout
    if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
    }

    const wsUrl = getWsUrl();

    try {
        wsConnection = new WebSocket(wsUrl);

        wsConnection.onopen = () => {
            // Reset reconnect delay on successful connection
            wsReconnectDelay = WS_INITIAL_RECONNECT_DELAY;
            notifyListeners({ type: 'WS_CONNECTED' });
        };

        wsConnection.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // Don't log SCHEDULER_TICK to reduce noise (every 1 second)
                if (data.type !== 'SCHEDULER_TICK') {
                }
                notifyListeners(data);
            } catch (e) {
                console.error('[Scheduler WS] Parse error:', e);
            }
        };

        wsConnection.onclose = () => {
            notifyListeners({ type: 'WS_DISCONNECTED' });

            // Schedule reconnect with exponential backoff
            wsReconnectTimeout = setTimeout(() => {
                connectWebSocket();
            }, wsReconnectDelay);

            // Increase delay for next time (exponential backoff)
            wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_RECONNECT_DELAY);
        };

        wsConnection.onerror = (error) => {
            console.error('[Scheduler WS] Error:', error);
        };
    } catch (error) {
        console.error('[Scheduler WS] Connection error:', error);
        wsReconnectTimeout = setTimeout(() => {
            connectWebSocket();
        }, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_RECONNECT_DELAY);
    }
};

/**
 * Disconnect WebSocket
 */
export const disconnectWebSocket = () => {
    if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
    }
    wsReconnectDelay = WS_INITIAL_RECONNECT_DELAY; // Reset delay
    if (wsConnection) {
        wsConnection.close();
        wsConnection = null;
    }
};

/**
 * Add WebSocket message listener (with cap to prevent memory leaks)
 */
export const addWsListener = (callback) => {
    // Cap listeners to prevent memory leak
    if (wsListeners.size >= MAX_LISTENERS) {
        console.warn('[Scheduler WS] Max listeners reached, removing oldest');
        const oldest = wsListeners.values().next().value;
        wsListeners.delete(oldest);
    }
    wsListeners.add(callback);
    return () => wsListeners.delete(callback);
};

/**
 * Notify all listeners
 */
const notifyListeners = (data) => {
    wsListeners.forEach(callback => {
        try {
            callback(data);
        } catch (e) {
            console.error('[Scheduler WS] Listener error:', e);
        }
    });
};

/**
 * Check if WebSocket is connected
 */
export const isWsConnected = () => {
    return wsConnection && wsConnection.readyState === WebSocket.OPEN;
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Format milliseconds to human readable time
 */
export const formatTimeRemaining = (ms) => {
    if (ms < 0) return 'Now';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
};

export default {
    getSchedulerStatus,
    startScheduler,
    stopScheduler,
    getSchedules,
    addSchedule,
    updateSchedule,
    deleteSchedule,
    toggleSchedule,
    importSchedules,
    getNextTriggers,
    connectWebSocket,
    disconnectWebSocket,
    addWsListener,
    isWsConnected,
    formatTimeRemaining
};
