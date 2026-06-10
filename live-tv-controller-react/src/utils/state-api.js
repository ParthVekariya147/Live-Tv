/**
 * State API - Frontend utility for backend state management
 * 
 * Replaces localStorage with server-side persistence.
 * Uses WebSocket for real-time sync across all tabs/windows.
 */

const API_BASE = '';

// ============================================
// REST API CALLS
// ============================================

/**
 * Get all state from server
 */
export async function getState() {
    try {
        const res = await fetch(`${API_BASE}/api/state`);
        const data = await res.json();
        return data.state || {};
    } catch (error) {
        console.error('[StateAPI] Error getting state:', error);
        return {};
    }
}

/**
 * Get a single state value
 */
export async function getStateValue(key) {
    try {
        const res = await fetch(`${API_BASE}/api/state/${key}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.value;
    } catch (error) {
        console.error(`[StateAPI] Error getting ${key}:`, error);
        return null;
    }
}

/**
 * Set a single state value
 */
export async function setStateValue(key, value) {
    try {
        const res = await fetch(`${API_BASE}/api/state/${key}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });
        const data = await res.json();
        return data.success;
    } catch (error) {
        console.error(`[StateAPI] Error setting ${key}:`, error);
        return false;
    }
}

/**
 * Merge into an object state value
 */
export async function mergeStateValue(key, partialValue) {
    try {
        const res = await fetch(`${API_BASE}/api/state/${key}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: partialValue })
        });
        const data = await res.json();
        return data.value;
    } catch (error) {
        console.error(`[StateAPI] Error merging ${key}:`, error);
        return null;
    }
}

/**
 * Delete a state key
 */
export async function deleteStateValue(key) {
    try {
        const res = await fetch(`${API_BASE}/api/state/${key}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        return data.success;
    } catch (error) {
        console.error(`[StateAPI] Error deleting ${key}:`, error);
        return false;
    }
}

/**
 * Import localStorage data to server (one-time migration)
 */
export async function importFromLocalStorage() {
    // Collect all relevant localStorage data
    const keysToImport = [
        'loopPlayerState',
        'livePlayerState',
        'delayPlayerState',
        'localPCPlayerState',
        'localPCPlayerEndActions',
        'liveMonitorEnabled1',
        'liveMonitorEnabled2',
        'savedSearchTitles1',
        'savedSearchTitles2',
        'kathaRefreshSchedulerEnabled',
        'kathaRefreshSchedulerTime',
        'kathaRefreshSchedulerLastTriggered',
        'kathaPlayerSchedulerEnabled',
        'kathaPlayerSchedulerTime',
        'kathaPlayerSchedulerLastTriggered',
        'obsActiveSource'
    ];

    const localStorageData = {};
    for (const key of keysToImport) {
        const value = localStorage.getItem(key);
        if (value !== null) {
            localStorageData[key] = value;
        }
    }

    try {
        const res = await fetch(`${API_BASE}/api/state/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ localStorageData })
        });
        const data = await res.json();
        console.log(`[StateAPI] Imported ${data.imported} keys from localStorage`);
        return data.imported;
    } catch (error) {
        console.error('[StateAPI] Error importing from localStorage:', error);
        return 0;
    }
}

/**
 * Reset state to defaults
 */
export async function resetState() {
    try {
        const res = await fetch(`${API_BASE}/api/state/reset`, { method: 'POST' });
        return (await res.json()).success;
    } catch (error) {
        console.error('[StateAPI] Error resetting state:', error);
        return false;
    }
}

// ============================================
// STATE KEYS (for reference)
// ============================================

export const StateKeys = {
    // Player States
    LOOP_PLAYER: 'player.loop',
    LIVE_PLAYER: 'player.live',
    DELAY_PLAYER: 'player.delay',
    LOCAL_PLAYER: 'player.local',
    LOCAL_PLAYER_END_ACTIONS: 'player.local.endActions',

    // Monitor Settings
    MONITOR_1_ENABLED: 'monitor.1.enabled',
    MONITOR_1_SEARCH: 'monitor.1.searchTerms',
    MONITOR_2_ENABLED: 'monitor.2.enabled',
    MONITOR_2_SEARCH: 'monitor.2.searchTerms',

    // Katha Scheduler
    KATHA_REFRESH_ENABLED: 'katha.refresh.enabled',
    KATHA_REFRESH_TIME: 'katha.refresh.time',
    KATHA_REFRESH_LAST: 'katha.refresh.lastTriggered',
    KATHA_PLAYER_ENABLED: 'katha.player.enabled',
    KATHA_PLAYER_TIME: 'katha.player.time',
    KATHA_PLAYER_LAST: 'katha.player.lastTriggered',

    // OBS State
    OBS_ACTIVE_SOURCE: 'obs.activeSource',

    // App Settings
    APP_VERSION: 'app.version'
};

// ============================================
// DEFAULT EXPORT
// ============================================

export default {
    getState,
    getStateValue,
    setStateValue,
    mergeStateValue,
    deleteStateValue,
    importFromLocalStorage,
    resetState,
    StateKeys
};
