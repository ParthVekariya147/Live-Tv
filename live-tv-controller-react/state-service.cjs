/**
 * State Service - Backend State Management
 * 
 * Replaces localStorage with server-side persistence.
 * All state changes broadcast via WebSocket for real-time sync.
 * 
 * Features:
 * - Atomic file writes (like scheduler-service)
 * - In-memory cache for fast access
 * - WebSocket broadcast on changes
 * - Namespaced state keys
 */

const fs = require('fs');
const path = require('path');

class StateService {
    constructor(options = {}) {
        // Configuration
        this.dataDir = options.dataDir || path.join(__dirname, 'data');
        this.stateFile = path.join(this.dataDir, 'app-state.json');

        // In-memory state cache
        this.state = {};

        // Event handlers (set by server)
        this.onStateChange = null;  // Called when state changes
        this.onLog = null;          // Called for logging

        // Ensure directories exist
        this.ensureDirectories();

        // Load initial state
        this.loadState();

        this.log('INFO', 'STATE_INIT', 'State service initialized', {
            stateFile: this.stateFile,
            keyCount: Object.keys(this.state).length
        });
    }

    // ============================================
    // DIRECTORY & FILE MANAGEMENT
    // ============================================

    ensureDirectories() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const content = fs.readFileSync(this.stateFile, 'utf8');
                const data = JSON.parse(content);
                this.state = data.state || {};
                this.log('INFO', 'STATE_LOADED', `Loaded ${Object.keys(this.state).length} state keys`);
            } else {
                this.state = this.getDefaultState();
                this.saveState();
                this.log('INFO', 'STATE_CREATED', 'Created new state file with defaults');
            }
        } catch (error) {
            this.log('ERROR', 'STATE_LOAD_ERROR', `Error loading state: ${error.message}`);
            // Try to recover from backup
            if (!this.recoverFromBackup()) {
                this.state = this.getDefaultState();
            }
        }
    }

    getDefaultState() {
        return {
            // Player States
            'player.loop': { videoId: null, startSeconds: 0, muted: true },
            'player.live': { videoId: null, startSeconds: 0, muted: true },
            'player.delay': { videoId: null, startSeconds: 0, muted: true },
            'player.local': { playlist: [], currentIndex: 0, muted: true },
            'player.local.endActions': {
                0: 'Loop Player', 1: 'Loop Player', 2: 'Loop Player',
                3: 'Loop Player', 4: 'Loop Player', 5: 'Loop Player', 6: 'Loop Player'
            },

            // Monitor Settings
            'monitor.1.enabled': true,
            'monitor.1.searchTerms': '',
            'monitor.2.enabled': true,
            'monitor.2.searchTerms': '',

            // Katha Scheduler (to be migrated to main scheduler)
            'katha.refresh.enabled': false,
            'katha.refresh.time': '06:00',
            'katha.refresh.lastTriggered': null,
            'katha.player.enabled': false,
            'katha.player.time': '07:00',
            'katha.player.lastTriggered': null,

            // OBS State
            'obs.activeSource': null,

            // App Settings
            'app.version': '1.0.0'
        };
    }

    /**
     * Atomic save with backup
     */
    saveState() {
        try {
            const data = {
                version: 1,
                lastModified: new Date().toISOString(),
                state: this.state
            };

            const jsonData = JSON.stringify(data, null, 2);
            const tempFile = this.stateFile + '.tmp';
            const backupFile = this.stateFile + '.bak';

            // Step 1: Write to temp file
            fs.writeFileSync(tempFile, jsonData, 'utf8');

            // Step 2: Verify temp file is valid JSON
            JSON.parse(fs.readFileSync(tempFile, 'utf8'));

            // Step 3: Backup existing file
            if (fs.existsSync(this.stateFile)) {
                fs.copyFileSync(this.stateFile, backupFile);
            }

            // Step 4: Atomic rename
            fs.renameSync(tempFile, this.stateFile);

            this.log('DEBUG', 'STATE_SAVED', `Saved ${Object.keys(this.state).length} state keys`);
        } catch (error) {
            this.log('ERROR', 'STATE_SAVE_ERROR', `Error saving state: ${error.message}`);

            // Clean up temp file
            const tempFile = this.stateFile + '.tmp';
            if (fs.existsSync(tempFile)) {
                try { fs.unlinkSync(tempFile); } catch (e) { }
            }
        }
    }

    recoverFromBackup() {
        const backupFile = this.stateFile + '.bak';
        if (fs.existsSync(backupFile)) {
            try {
                const content = fs.readFileSync(backupFile, 'utf8');
                const data = JSON.parse(content);
                this.state = data.state || {};
                this.log('WARN', 'STATE_RECOVERED', `Recovered state from backup`);
                return true;
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    // ============================================
    // LOGGING
    // ============================================

    log(level, type, message, data = {}) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
            level,
            type,
            message,
            data,
            source: 'StateService'
        };

        // Console output
        const colors = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', DEBUG: '\x1b[90m' };
        const reset = '\x1b[0m';
        const color = colors[level] || '';

        if (level !== 'DEBUG') {
            console.log(`${color}[STATE][${logEntry.time}][${type}]${reset} ${message}`);
        }

        // External log handler
        if (this.onLog) {
            this.onLog(logEntry);
        }
    }

    // ============================================
    // STATE OPERATIONS
    // ============================================

    /**
     * Get a single state value
     */
    get(key, defaultValue = null) {
        return this.state.hasOwnProperty(key) ? this.state[key] : defaultValue;
    }

    /**
     * Get multiple state values at once
     */
    getMultiple(keys) {
        const result = {};
        for (const key of keys) {
            result[key] = this.state[key];
        }
        return result;
    }

    /**
     * Get all state
     */
    getAll() {
        return { ...this.state };
    }

    /**
     * Get state keys matching a prefix
     */
    getByPrefix(prefix) {
        const result = {};
        for (const key of Object.keys(this.state)) {
            if (key.startsWith(prefix)) {
                result[key] = this.state[key];
            }
        }
        return result;
    }

    /**
     * Set a single state value
     */
    set(key, value, broadcast = true) {
        const oldValue = this.state[key];
        this.state[key] = value;
        this.saveState();

        this.log('INFO', 'STATE_SET', `Set ${key}`, { key, changed: oldValue !== value });

        // Broadcast change
        if (broadcast && this.onStateChange) {
            this.onStateChange({
                type: 'SET',
                key,
                value,
                oldValue
            });
        }

        return value;
    }

    /**
     * Set multiple state values at once
     */
    setMultiple(updates, broadcast = true) {
        const changes = [];

        for (const [key, value] of Object.entries(updates)) {
            const oldValue = this.state[key];
            this.state[key] = value;
            changes.push({ key, value, oldValue });
        }

        this.saveState();

        this.log('INFO', 'STATE_SET_MULTIPLE', `Set ${changes.length} keys`, {
            keys: changes.map(c => c.key)
        });

        // Broadcast changes
        if (broadcast && this.onStateChange) {
            this.onStateChange({
                type: 'SET_MULTIPLE',
                changes
            });
        }

        return changes;
    }

    /**
     * Merge into an object state value
     */
    merge(key, partialValue, broadcast = true) {
        const current = this.state[key] || {};
        const merged = { ...current, ...partialValue };
        return this.set(key, merged, broadcast);
    }

    /**
     * Delete a state key
     */
    delete(key, broadcast = true) {
        if (this.state.hasOwnProperty(key)) {
            const oldValue = this.state[key];
            delete this.state[key];
            this.saveState();

            this.log('INFO', 'STATE_DELETE', `Deleted ${key}`);

            if (broadcast && this.onStateChange) {
                this.onStateChange({
                    type: 'DELETE',
                    key,
                    oldValue
                });
            }

            return true;
        }
        return false;
    }

    /**
     * Reset state to defaults
     */
    reset(broadcast = true) {
        this.state = this.getDefaultState();
        this.saveState();

        this.log('WARN', 'STATE_RESET', 'State reset to defaults');

        if (broadcast && this.onStateChange) {
            this.onStateChange({
                type: 'RESET',
                state: this.state
            });
        }
    }

    // ============================================
    // MIGRATION HELPERS
    // ============================================

    /**
     * Import state from client localStorage (for migration)
     */
    importFromLocalStorage(localStorageData) {
        const keyMapping = {
            'loopPlayerState': 'player.loop',
            'livePlayerState': 'player.live',
            'delayPlayerState': 'player.delay',
            'localPCPlayerState': 'player.local',
            'localPCPlayerEndActions': 'player.local.endActions',
            'liveMonitorEnabled1': 'monitor.1.enabled',
            'liveMonitorEnabled2': 'monitor.2.enabled',
            'savedSearchTitles1': 'monitor.1.searchTerms',
            'savedSearchTitles2': 'monitor.2.searchTerms',
            'kathaRefreshSchedulerEnabled': 'katha.refresh.enabled',
            'kathaRefreshSchedulerTime': 'katha.refresh.time',
            'kathaRefreshSchedulerLastTriggered': 'katha.refresh.lastTriggered',
            'kathaPlayerSchedulerEnabled': 'katha.player.enabled',
            'kathaPlayerSchedulerTime': 'katha.player.time',
            'kathaPlayerSchedulerLastTriggered': 'katha.player.lastTriggered',
            'obsActiveSource': 'obs.activeSource'
        };

        let imported = 0;
        for (const [oldKey, newKey] of Object.entries(keyMapping)) {
            if (localStorageData.hasOwnProperty(oldKey)) {
                let value = localStorageData[oldKey];

                // Parse if string
                if (typeof value === 'string') {
                    try {
                        value = JSON.parse(value);
                    } catch (e) {
                        // Keep as string (for boolean strings like "true")
                        if (value === 'true') value = true;
                        else if (value === 'false') value = false;
                    }
                }

                this.state[newKey] = value;
                imported++;
            }
        }

        this.saveState();
        this.log('INFO', 'STATE_IMPORTED', `Imported ${imported} keys from localStorage`);

        return imported;
    }
}

module.exports = StateService;
