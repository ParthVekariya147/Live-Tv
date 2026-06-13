/**
 * Scheduler Service - Server-Side Scheduler for Live TV Controller
 * 
 * This module provides reliable, server-side scheduling that:
 * - Runs a 1-second check loop for accurate timing
 * - Persists schedules to JSON file
 * - Tracks last execution to prevent duplicates
 * - Catches up on missed schedules after restart
 * - Provides strict logging for debugging
 * - Health check endpoint for monitoring
 * - Alert system for missed triggers
 */

const fs = require('fs');
const path = require('path');

// Day names for logging
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class SchedulerService {
    constructor(options = {}) {
        // Configuration
        this.dataDir = options.dataDir || path.join(__dirname, 'data');
        this.schedulesFile = path.join(this.dataDir, 'schedules.json');
        this.logsDir = options.logsDir || path.join(__dirname, 'logs');
        this.checkIntervalMs = options.checkIntervalMs || 1000; // Default 1 second
        this.maxRetries = options.maxRetries || 3; // Max retry attempts for failed triggers
        this.retryDelayMs = options.retryDelayMs || 5000; // 5 seconds between retries

        // State
        this.schedules = [];
        this.isRunning = false;
        this.checkInterval = null;
        this.lastCheck = null;
        this.backupInterval = null;

        // Execution history (persisted)
        this.executionHistory = [];
        this.maxExecutionHistory = 100;

        // Retry queue for failed triggers
        this.retryQueue = [];
        this.retryInterval = null;

        // OBS connection awareness
        this.obsConnected = false;
        this.lastObsCheck = null;

        // Health tracking
        this.startedAt = null;
        this.lastHealthCheck = null;
        this.totalTriggers = 0;
        this.totalMissed = 0;
        this.totalSkipped = 0;
        this.totalRetries = 0;
        this.totalRetrySuccess = 0;
        this.lastTriggerAt = null;
        this.errors = [];
        this.maxErrors = 100;

        // Alerts (notifications)
        this.alerts = [];
        this.maxAlerts = 50;
        this.onAlert = null;

        // Event handlers (set by server)
        this.onTrigger = null;
        this.onLog = null;
        this.onExecutionComplete = null; // Called when execution is confirmed

        // Ensure directories exist
        this.ensureDirectories();

        // Load schedules
        this.loadSchedules();

        this.log('INFO', 'SCHEDULER_INIT', 'Scheduler service initialized', {
            schedulesCount: this.schedules.length,
            dataDir: this.dataDir,
            checkIntervalMs: this.checkIntervalMs,
            features: ['atomic-writes', 'auto-backup', 'retry-queue', 'execution-history']
        });
    }

    // ============================================
    // DIRECTORY & FILE MANAGEMENT (Atomic + Backup)
    // ============================================

    ensureDirectories() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        // Create backup directory
        const backupDir = path.join(this.dataDir, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
    }

    loadSchedules() {
        try {
            if (fs.existsSync(this.schedulesFile)) {
                const content = fs.readFileSync(this.schedulesFile, 'utf8');
                const data = JSON.parse(content);
                this.schedules = data.schedules || [];
                this.executionHistory = data.executionHistory || [];
                this.log('INFO', 'SCHEDULES_LOADED', `Loaded ${this.schedules.length} schedules from file`);
            } else {
                // Try to recover from backup
                const recovered = this.recoverFromBackup();
                if (!recovered) {
                    this.schedules = [];
                    this.executionHistory = [];
                    this.saveSchedules();
                    this.log('INFO', 'SCHEDULES_CREATED', 'Created new empty schedules file');
                }
            }
        } catch (error) {
            this.log('ERROR', 'SCHEDULES_LOAD_ERROR', `Error loading schedules: ${error.message}`);
            // Try to recover from backup
            const recovered = this.recoverFromBackup();
            if (!recovered) {
                this.schedules = [];
                this.executionHistory = [];
            }
        }
    }

    /**
     * Atomic save with backup - prevents corruption
     */
    saveSchedules() {
        try {
            const data = {
                version: 2, // Schema version for future migrations
                lastModified: new Date().toISOString(),
                schedulerEnabled: this.isRunning,
                schedules: this.schedules,
                executionHistory: this.executionHistory.slice(-100) // Keep last 100 executions
            };

            const jsonData = JSON.stringify(data, null, 2);
            const tempFile = this.schedulesFile + '.tmp';
            const backupFile = this.schedulesFile + '.bak';

            // Step 1: Write to temp file
            fs.writeFileSync(tempFile, jsonData, 'utf8');

            // Step 2: Verify temp file is valid JSON
            const verifyContent = fs.readFileSync(tempFile, 'utf8');
            JSON.parse(verifyContent); // Will throw if invalid

            // Step 3: Backup existing file (if exists)
            if (fs.existsSync(this.schedulesFile)) {
                fs.copyFileSync(this.schedulesFile, backupFile);
            }

            // Step 4: Atomic rename (replaces original)
            fs.renameSync(tempFile, this.schedulesFile);

            this.log('DEBUG', 'SCHEDULES_SAVED', `Saved ${this.schedules.length} schedules (atomic write)`);
        } catch (error) {
            this.log('ERROR', 'SCHEDULES_SAVE_ERROR', `Error saving schedules: ${error.message}`);
            this.trackError('SAVE_ERROR', error.message);

            // Clean up temp file if it exists
            const tempFile = this.schedulesFile + '.tmp';
            if (fs.existsSync(tempFile)) {
                try { fs.unlinkSync(tempFile); } catch (e) { }
            }
        }
    }

    /**
     * Create a timestamped backup
     */
    createBackup() {
        try {
            if (!fs.existsSync(this.schedulesFile)) return;

            const backupDir = path.join(this.dataDir, 'backups');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(backupDir, `schedules-${timestamp}.json`);

            fs.copyFileSync(this.schedulesFile, backupFile);
            this.log('INFO', 'BACKUP_CREATED', `Created backup: ${backupFile}`);

            // Clean up old backups (keep last 10)
            this.cleanupOldBackups(backupDir, 10);

            return backupFile;
        } catch (error) {
            this.log('ERROR', 'BACKUP_ERROR', `Error creating backup: ${error.message}`);
            return null;
        }
    }

    /**
     * Clean up old backup files
     */
    cleanupOldBackups(backupDir, keepCount) {
        try {
            const files = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('schedules-') && f.endsWith('.json'))
                .map(f => ({ name: f, path: path.join(backupDir, f) }))
                .sort((a, b) => b.name.localeCompare(a.name)); // Newest first

            // Delete old backups beyond keepCount
            files.slice(keepCount).forEach(f => {
                fs.unlinkSync(f.path);
            });
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    /**
     * Recover from backup file
     */
    recoverFromBackup() {
        const backupFile = this.schedulesFile + '.bak';
        const backupDir = path.join(this.dataDir, 'backups');

        // Try .bak file first
        if (fs.existsSync(backupFile)) {
            try {
                const content = fs.readFileSync(backupFile, 'utf8');
                const data = JSON.parse(content);
                this.schedules = data.schedules || [];
                this.executionHistory = data.executionHistory || [];
                this.log('WARN', 'RECOVERED_FROM_BACKUP', `Recovered ${this.schedules.length} schedules from .bak file`);
                this.raiseAlert('recovery', 'warning', 'Recovered from Backup',
                    'Main schedule file was corrupted. Recovered from backup.', {});
                return true;
            } catch (e) {
                this.log('ERROR', 'BACKUP_RECOVERY_FAILED', `Could not recover from .bak: ${e.message}`);
            }
        }

        // Try timestamped backups
        if (fs.existsSync(backupDir)) {
            const backups = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('schedules-') && f.endsWith('.json'))
                .sort()
                .reverse(); // Newest first

            for (const backup of backups) {
                try {
                    const content = fs.readFileSync(path.join(backupDir, backup), 'utf8');
                    const data = JSON.parse(content);
                    this.schedules = data.schedules || [];
                    this.executionHistory = data.executionHistory || [];
                    this.log('WARN', 'RECOVERED_FROM_BACKUP', `Recovered ${this.schedules.length} schedules from ${backup}`);
                    this.raiseAlert('recovery', 'warning', 'Recovered from Backup',
                        `Main schedule file was corrupted. Recovered from ${backup}.`, {});
                    return true;
                } catch (e) {
                    // Try next backup
                }
            }
        }

        return false;
    }


    // ============================================
    // LOGGING
    // ============================================

    log(level, type, message, data = {}) {
        const now = new Date();
        const logEntry = {
            timestamp: now.toISOString(),
            date: now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
            time: now.toLocaleTimeString('en-GB', { hour12: false }),
            dayName: DAY_NAMES[now.getDay()],
            level,
            type,
            category: 'scheduler',
            message,
            data
        };

        // Console output with colors
        const colors = {
            INFO: '\x1b[36m',    // Cyan
            WARN: '\x1b[33m',    // Yellow
            ERROR: '\x1b[31m',   // Red
            DEBUG: '\x1b[90m',   // Gray
            TRIGGER: '\x1b[32m', // Green
            SKIP: '\x1b[33m'     // Yellow
        };
        const reset = '\x1b[0m';
        const color = colors[level] || '';

        console.log(`${color}[SCHEDULER][${logEntry.time}][${type}]${reset} ${message}`);
        if (Object.keys(data).length > 0 && level !== 'DEBUG') {
            console.log(`  → Data:`, JSON.stringify(data));
        }

        // Call external log handler if set
        if (this.onLog) {
            this.onLog(logEntry);
        }

        // Write to scheduler-specific log file
        this.writeToLogFile(logEntry);
    }

    writeToLogFile(logEntry) {
        try {
            const month = logEntry.timestamp.slice(0, 7);
            const logFile = path.join(this.logsDir, `scheduler-${month}.json`);

            let logs = [];
            if (fs.existsSync(logFile)) {
                try {
                    logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
                } catch (e) {
                    logs = [];
                }
            }

            logs.push(logEntry);
            fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf8');
        } catch (error) {
            console.error('Error writing scheduler log:', error.message);
        }
    }

    // ============================================
    // SCHEDULER CONTROL
    // ============================================

    start() {
        if (this.isRunning) {
            this.log('WARN', 'SCHEDULER_ALREADY_RUNNING', 'Scheduler is already running');
            return;
        }

        this.isRunning = true;
        this.startedAt = new Date().toISOString();
        this.log('INFO', 'SCHEDULER_STARTED', `Scheduler started - checking every ${this.checkIntervalMs}ms`);

        // Create initial backup
        this.createBackup();

        // Check for missed schedules on startup
        this.catchUpMissedSchedules();

        // Start the check loop (configurable interval)
        this.checkInterval = setInterval(() => {
            this.checkSchedules();
        }, this.checkIntervalMs);

        // Start hourly backup
        this.backupInterval = setInterval(() => {
            this.createBackup();
        }, 60 * 60 * 1000); // Every hour

        // Start retry queue processor
        this.startRetryProcessor();

        this.saveSchedules();
    }

    stop() {
        if (!this.isRunning) {
            this.log('WARN', 'SCHEDULER_NOT_RUNNING', 'Scheduler is not running');
            return;
        }

        this.isRunning = false;

        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        if (this.backupInterval) {
            clearInterval(this.backupInterval);
            this.backupInterval = null;
        }

        if (this.retryInterval) {
            clearInterval(this.retryInterval);
            this.retryInterval = null;
        }

        // Create final backup before stopping
        this.createBackup();

        this.log('INFO', 'SCHEDULER_STOPPED', 'Scheduler stopped');
        this.saveSchedules();
    }

    // ============================================
    // RETRY QUEUE SYSTEM
    // ============================================

    startRetryProcessor() {
        this.retryInterval = setInterval(() => {
            this.processRetryQueue();
        }, this.retryDelayMs);
    }

    /**
     * Add a failed trigger to retry queue
     */
    addToRetryQueue(schedule, triggerKey, error, attempts = 0) {
        const retryItem = {
            id: Date.now(),
            scheduleId: schedule.id,
            source: schedule.source,
            action: schedule.action,
            title: schedule.title,
            time: schedule.time,
            triggerKey: triggerKey,
            error: error,
            attempts: attempts + 1,
            addedAt: new Date().toISOString(),
            nextRetryAt: new Date(Date.now() + this.retryDelayMs).toISOString()
        };

        this.retryQueue.push(retryItem);
        this.log('WARN', 'ADDED_TO_RETRY', `Added to retry queue: ${schedule.source} (attempt ${retryItem.attempts}/${this.maxRetries})`, retryItem);
    }

    /**
     * Process retry queue - attempt failed triggers again
     */
    processRetryQueue() {
        if (this.retryQueue.length === 0) return;

        const now = new Date();
        const itemsToProcess = this.retryQueue.filter(item => new Date(item.nextRetryAt) <= now);

        for (const item of itemsToProcess) {
            // Remove from queue
            this.retryQueue = this.retryQueue.filter(i => i.id !== item.id);

            if (item.attempts >= this.maxRetries) {
                // Max retries reached - give up and alert
                this.log('ERROR', 'RETRY_FAILED', `Max retries (${this.maxRetries}) reached for: ${item.source}`, item);
                this.raiseAlert('retry_failed', 'critical', 'Schedule Retry Failed',
                    `Failed to execute "${item.title || item.source}" after ${this.maxRetries} attempts.`,
                    item);
                continue;
            }

            // Try again
            this.log('INFO', 'RETRYING', `Retrying trigger: ${item.source} (attempt ${item.attempts + 1}/${this.maxRetries})`);
            this.totalRetries++;

            if (this.onTrigger) {
                try {
                    this.onTrigger({
                        id: item.scheduleId,
                        source: item.source,
                        action: item.action,
                        title: item.title,
                        time: item.time,
                        triggerKey: item.triggerKey,
                        reason: 'retry',
                        retryAttempt: item.attempts + 1
                    });

                    // Success!
                    this.totalRetrySuccess++;
                    this.log('INFO', 'RETRY_SUCCESS', `Retry successful: ${item.source}`, item);

                    // Record in execution history
                    this.recordExecution(item, 'success', 'Retry successful');

                } catch (error) {
                    // Failed again - re-add to queue
                    this.addToRetryQueue({
                        id: item.scheduleId,
                        source: item.source,
                        action: item.action,
                        title: item.title,
                        time: item.time
                    }, item.triggerKey, error.message, item.attempts);
                }
            }
        }
    }

    // ============================================
    // SCHEDULE CHECKING (Core Logic)
    // ============================================

    checkSchedules() {
        const now = new Date();
        const currentTime = this.formatTime(now);
        const currentDay = now.getDay();
        const todayKey = now.toISOString().split('T')[0]; // YYYY-MM-DD

        // Only log every minute to avoid spam
        const currentMinute = `${currentTime.slice(0, 5)}`;
        if (this.lastCheck !== currentMinute) {
            this.lastCheck = currentMinute;

            const enabledSchedules = this.schedules.filter(s => s.enabled);
            const matchingSchedules = enabledSchedules.filter(s =>
                s.time === currentMinute && this.isDayMatch(s, currentDay)
            );

            if (matchingSchedules.length > 0) {
                this.log('INFO', 'SCHEDULE_CHECK', `Minute ${currentMinute} - Found ${matchingSchedules.length} matching schedule(s)`, {
                    currentTime: currentMinute,
                    currentDay: DAY_SHORT[currentDay],
                    matchingSchedules: matchingSchedules.map(s => s.title || s.source)
                });
            }
        }

        // Check each schedule
        for (const schedule of this.schedules) {
            if (!schedule.enabled) continue;

            // Check if time matches (HH:MM format)
            if (schedule.time !== currentTime.slice(0, 5)) continue;

            // Check if day matches
            if (!this.isDayMatch(schedule, currentDay)) continue;

            // Check if already triggered today at this time
            const triggerKey = `${todayKey}-${schedule.time}`;
            if (schedule.lastTriggered === triggerKey) continue;

            // Check if "Skip 1 Day" is active
            if (schedule.skipUntil) {
                const skipUntilDate = new Date(schedule.skipUntil);
                if (now < skipUntilDate) {
                    // Only mark + save once per trigger-key (not every second)
                    if (schedule.lastTriggered !== triggerKey) {
                        this.log('INFO', 'SKIP_ACTIVE', `Skipping "${schedule.title || schedule.source}" — skip active until ${skipUntilDate.toLocaleTimeString()}`, { id: schedule.id });
                        schedule.lastTriggered = triggerKey;
                        this.saveSchedules();
                    }
                    continue;
                } else {
                    // Skip window has passed — clear it and fire normally
                    schedule.skipUntil = null;
                    this.saveSchedules();
                }
            }

            // TRIGGER!
            this.executeSchedule(schedule, triggerKey, 'scheduled');
        }
    }

    isDayMatch(schedule, currentDay) {
        if (schedule.recurrence === 'daily') {
            return true;
        } else if (schedule.recurrence === 'weekly') {
            return schedule.scheduledDay === currentDay;
        } else if (schedule.recurrence === 'days' && Array.isArray(schedule.days)) {
            return schedule.days.includes(currentDay);
        }
        return false;
    }

    formatTime(date) {
        return date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // ============================================
    // SCHEDULE EXECUTION
    // ============================================

    executeSchedule(schedule, triggerKey, reason = 'scheduled') {
        const startTime = Date.now();

        this.log('TRIGGER', 'SCHEDULE_TRIGGERED',
            `🎯 EXECUTING: ${schedule.action.toUpperCase()} "${schedule.source}" - ${schedule.title || 'No title'}`,
            {
                id: schedule.id,
                source: schedule.source,
                action: schedule.action,
                time: schedule.time,
                title: schedule.title,
                recurrence: schedule.recurrence,
                reason: reason,
                triggerKey: triggerKey,
                obsConnected: this.obsConnected
            }
        );

        // Update lastTriggered
        schedule.lastTriggered = triggerKey;
        schedule.lastTriggeredAt = new Date().toISOString();
        this.saveSchedules();

        // Track statistics
        this.totalTriggers++;
        this.lastTriggerAt = new Date().toISOString();

        // Call the trigger handler
        if (this.onTrigger) {
            try {
                this.onTrigger({
                    id: schedule.id,
                    source: schedule.source,
                    action: schedule.action,
                    title: schedule.title,
                    time: schedule.time,
                    triggerKey: triggerKey,
                    reason: reason
                });

                const executionTime = Date.now() - startTime;
                this.log('INFO', 'TRIGGER_SUCCESS', `Successfully triggered action for "${schedule.source}" (${executionTime}ms)`);

                // Record successful execution
                this.recordExecution(schedule, 'success', reason, executionTime);

            } catch (error) {
                this.log('ERROR', 'TRIGGER_ERROR', `Error executing trigger: ${error.message}`, {
                    scheduleId: schedule.id,
                    error: error.message
                });
                this.trackError('TRIGGER_ERROR', error.message, { scheduleId: schedule.id });

                // Record failed execution
                this.recordExecution(schedule, 'failed', reason, Date.now() - startTime, error.message);

                // Add to retry queue
                this.addToRetryQueue(schedule, triggerKey, error.message, 0);
            }
        } else {
            this.log('WARN', 'NO_TRIGGER_HANDLER', 'No trigger handler set - schedule executed but no action taken');
            this.recordExecution(schedule, 'no_handler', reason, 0, 'No trigger handler configured');
        }
    }

    /**
     * Record an execution in history
     */
    recordExecution(schedule, status, reason, executionTimeMs = 0, error = null) {
        const execution = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            scheduleId: schedule.id || schedule.scheduleId,
            source: schedule.source,
            action: schedule.action,
            title: schedule.title,
            status: status, // 'success', 'failed', 'no_handler', 'skipped'
            reason: reason, // 'scheduled', 'catch-up', 'retry', 'manual'
            executionTimeMs: executionTimeMs,
            error: error
        };

        this.executionHistory.push(execution);

        // Keep only recent history
        if (this.executionHistory.length > this.maxExecutionHistory) {
            this.executionHistory = this.executionHistory.slice(-this.maxExecutionHistory);
        }

        // Notify if handler is set
        if (this.onExecutionComplete) {
            this.onExecutionComplete(execution);
        }

        return execution;
    }

    /**
     * Get execution history
     */
    getExecutionHistory(count = 20) {
        return this.executionHistory.slice(-count).reverse();
    }

    /**
     * Update OBS connection status
     */
    setObsConnected(connected) {
        const wasConnected = this.obsConnected;
        this.obsConnected = connected;
        this.lastObsCheck = new Date().toISOString();

        if (wasConnected !== connected) {
            this.log(connected ? 'INFO' : 'WARN', 'OBS_CONNECTION_CHANGED',
                `OBS connection: ${connected ? 'CONNECTED' : 'DISCONNECTED'}`);

            if (!connected) {
                this.raiseAlert('obs_disconnected', 'warning', 'OBS Disconnected',
                    'OBS WebSocket is disconnected. Scheduled actions may not execute properly.',
                    { lastObsCheck: this.lastObsCheck });
            }
        }
    }

    // ============================================
    // MISSED SCHEDULE CATCH-UP
    // ============================================

    catchUpMissedSchedules() {
        const now = new Date();
        const todayKey = now.toISOString().split('T')[0];
        const currentTime = this.formatTime(now).slice(0, 5);
        const currentDay = now.getDay();

        this.log('INFO', 'CATCHUP_CHECK', 'Checking for missed schedules since last run...');

        let caughtUp = 0;
        const missedSchedules = [];

        for (const schedule of this.schedules) {
            if (!schedule.enabled) continue;

            // Check if this schedule should have run today
            if (!this.isDayMatch(schedule, currentDay)) continue;

            // Check if scheduled time has passed today
            if (schedule.time >= currentTime) continue;

            // Check if it was already triggered
            const triggerKey = `${todayKey}-${schedule.time}`;
            if (schedule.lastTriggered === triggerKey) continue;

            // Check if a "Skip 1 Day" covers this trigger — mark as skipped, don't fire
            if (schedule.skipUntil) {
                const skipUntilDate = new Date(schedule.skipUntil);
                if (new Date() < skipUntilDate) {
                    schedule.lastTriggered = triggerKey;
                    this.saveSchedules();
                    continue;
                } else {
                    schedule.skipUntil = null;
                    this.saveSchedules();
                }
            }

            // This schedule was missed - catch up!
            this.log('WARN', 'MISSED_SCHEDULE_FOUND',
                `Found missed schedule: "${schedule.title || schedule.source}" was scheduled for ${schedule.time}`,
                { scheduleId: schedule.id, scheduledTime: schedule.time, currentTime }
            );

            missedSchedules.push({
                title: schedule.title || schedule.source,
                time: schedule.time,
                source: schedule.source,
                action: schedule.action
            });

            this.executeSchedule(schedule, triggerKey, 'catch-up');
            caughtUp++;
        }

        // Track missed schedules
        this.totalMissed += caughtUp;

        if (caughtUp > 0) {
            this.log('INFO', 'CATCHUP_COMPLETE', `Caught up on ${caughtUp} missed schedule(s)`);

            // Raise alert for missed schedules
            this.raiseAlert(
                'missed_schedule',
                caughtUp >= 3 ? 'critical' : 'warning',
                `${caughtUp} Missed Schedule(s) Detected`,
                `Found ${caughtUp} schedule(s) that should have run earlier. They have been executed now.`,
                { missedSchedules: missedSchedules }
            );
        } else {
            this.log('INFO', 'CATCHUP_COMPLETE', 'No missed schedules found');
        }
    }

    // ============================================
    // SCHEDULE CRUD OPERATIONS
    // ============================================

    getAllSchedules() {
        return this.schedules;
    }

    getSchedule(id) {
        return this.schedules.find(s => s.id === id);
    }

    addSchedule(scheduleData) {
        const newSchedule = {
            id: scheduleData.id || Date.now(),
            time: scheduleData.time,
            source: scheduleData.source,
            action: scheduleData.action,
            recurrence: scheduleData.recurrence || 'daily',
            days: scheduleData.days || [],
            scheduledDay: scheduleData.scheduledDay,
            title: scheduleData.title || '',
            enabled: scheduleData.enabled !== false,
            lastTriggered: null,
            lastTriggeredAt: null,
            createdAt: new Date().toISOString()
        };

        this.schedules.push(newSchedule);
        this.saveSchedules();

        this.log('INFO', 'SCHEDULE_ADDED', `Added new schedule: "${newSchedule.title || newSchedule.source}"`, {
            id: newSchedule.id,
            time: newSchedule.time,
            source: newSchedule.source,
            action: newSchedule.action
        });

        return newSchedule;
    }

    updateSchedule(id, updates) {
        const index = this.schedules.findIndex(s => s.id === id);
        if (index === -1) {
            this.log('WARN', 'SCHEDULE_NOT_FOUND', `Schedule ${id} not found for update`);
            return null;
        }

        // Reset lastTriggered if time or days changed (compare arrays by value, not reference)
        const daysChanged = JSON.stringify(updates.days ?? null) !== JSON.stringify(this.schedules[index].days ?? null);
        if (updates.time !== this.schedules[index].time || daysChanged) {
            updates.lastTriggered = null;
        }

        this.schedules[index] = { ...this.schedules[index], ...updates };
        this.saveSchedules();

        this.log('INFO', 'SCHEDULE_UPDATED', `Updated schedule: "${this.schedules[index].title || this.schedules[index].source}"`, {
            id: id,
            updates: Object.keys(updates)
        });

        return this.schedules[index];
    }

    deleteSchedule(id) {
        const index = this.schedules.findIndex(s => s.id === id);
        if (index === -1) {
            this.log('WARN', 'SCHEDULE_NOT_FOUND', `Schedule ${id} not found for deletion`);
            return false;
        }

        const deleted = this.schedules.splice(index, 1)[0];
        this.saveSchedules();

        this.log('INFO', 'SCHEDULE_DELETED', `Deleted schedule: "${deleted.title || deleted.source}"`, {
            id: id
        });

        return true;
    }

    toggleSchedule(id) {
        const schedule = this.getSchedule(id);
        if (!schedule) {
            this.log('WARN', 'SCHEDULE_NOT_FOUND', `Schedule ${id} not found for toggle`);
            return null;
        }

        schedule.enabled = !schedule.enabled;
        schedule.lastTriggered = null; // Reset to allow trigger after re-enable
        this.saveSchedules();

        this.log('INFO', 'SCHEDULE_TOGGLED',
            `Schedule "${schedule.title || schedule.source}" ${schedule.enabled ? 'ENABLED' : 'DISABLED'}`,
            { id: id, enabled: schedule.enabled }
        );

        return schedule;
    }

    setAllSchedules(schedules) {
        this.schedules = schedules.map(s => ({
            ...s,
            id: s.id || Date.now() + Math.random(),
            enabled: s.enabled !== false,
            lastTriggered: s.lastTriggered || null
        }));
        this.saveSchedules();

        this.log('INFO', 'SCHEDULES_REPLACED', `Replaced all schedules with ${this.schedules.length} new schedules`);

        return this.schedules;
    }

    // ============================================
    // UTILITY METHODS
    // ============================================

    getNextTriggers(count = 5) {
        const now = new Date();
        const upcoming = [];

        for (const schedule of this.schedules) {
            if (!schedule.enabled) continue;

            const nextTrigger = this.calculateNextTriggerTime(schedule);
            if (nextTrigger) {
                upcoming.push({
                    id: schedule.id,
                    title: schedule.title || `${schedule.source} - ${schedule.action}`,
                    source: schedule.source,
                    action: schedule.action,
                    nextTrigger: nextTrigger,
                    delay: nextTrigger.getTime() - now.getTime()
                });
            }
        }

        // Sort by next trigger time and return top N
        upcoming.sort((a, b) => a.nextTrigger - b.nextTrigger);
        return upcoming.slice(0, count);
    }

    calculateNextTriggerTime(schedule) {
        if (!schedule.enabled || !schedule.time) return null;

        const now = new Date();
        const [scheduleHour, scheduleMinute] = schedule.time.split(':').map(Number);

        let nextTrigger = new Date();
        nextTrigger.setHours(scheduleHour, scheduleMinute, 0, 0);

        // If time has passed today, start checking from tomorrow
        if (nextTrigger <= now) {
            nextTrigger.setDate(nextTrigger.getDate() + 1);
        }

        // Find the next valid day based on recurrence
        if (schedule.recurrence === 'weekly') {
            const targetDay = schedule.scheduledDay;
            while (nextTrigger.getDay() !== targetDay) {
                nextTrigger.setDate(nextTrigger.getDate() + 1);
            }
        } else if (schedule.recurrence === 'days' && schedule.days?.length > 0) {
            for (let i = 0; i < 7; i++) {
                if (schedule.days.includes(nextTrigger.getDay())) break;
                nextTrigger.setDate(nextTrigger.getDate() + 1);
            }
        }

        // If "Skip 1 Day" is active, return the skip-until time as the effective next trigger
        if (schedule.skipUntil) {
            const skipUntilDate = new Date(schedule.skipUntil);
            if (skipUntilDate > now && nextTrigger < skipUntilDate) {
                return skipUntilDate;
            }
        }

        return nextTrigger;
    }

    skipOneDay(id) {
        const schedule = this.schedules.find(s => s.id === id);
        if (!schedule) return null;

        const nextTrigger = this.calculateNextTriggerTime(schedule);
        if (!nextTrigger) return null;

        // Skip 1 day = delay next trigger by 24 hours
        const skipUntil = new Date(nextTrigger.getTime() + 24 * 60 * 60 * 1000);
        schedule.skipUntil = skipUntil.toISOString();
        this.saveSchedules();
        return { skipUntil: schedule.skipUntil, nextNormalTrigger: nextTrigger.toISOString() };
    }

    cancelSkip(id) {
        const schedule = this.schedules.find(s => s.id === id);
        if (!schedule) return null;
        schedule.skipUntil = null;
        this.saveSchedules();
        return true;
    }

    getStatus() {
        const now = new Date();
        const uptime = this.startedAt
            ? Math.floor((now - new Date(this.startedAt)) / 1000)
            : 0;

        return {
            isRunning: this.isRunning,
            schedulesCount: this.schedules.length,
            enabledCount: this.schedules.filter(s => s.enabled).length,
            nextTriggers: this.getNextTriggers(3),
            uptime: uptime,
            startedAt: this.startedAt
        };
    }

    // ============================================
    // HEALTH CHECK SYSTEM
    // ============================================

    /**
     * Get comprehensive health status for monitoring
     */
    getHealth() {
        const now = new Date();
        this.lastHealthCheck = now.toISOString();

        const uptime = this.startedAt
            ? Math.floor((now - new Date(this.startedAt)) / 1000)
            : 0;

        const enabledSchedules = this.schedules.filter(s => s.enabled);
        const nextTriggers = this.getNextTriggers(5);

        // Calculate health score (0-100)
        let healthScore = 100;
        let healthIssues = [];

        if (!this.isRunning) {
            healthScore -= 50;
            healthIssues.push('Scheduler is not running');
        }

        if (this.errors.length > 10) {
            healthScore -= 20;
            healthIssues.push(`${this.errors.length} recent errors`);
        }

        if (this.totalMissed > 0) {
            healthScore -= Math.min(this.totalMissed * 5, 30);
            healthIssues.push(`${this.totalMissed} missed schedules today`);
        }

        if (this.retryQueue.length > 0) {
            healthScore -= Math.min(this.retryQueue.length * 10, 20);
            healthIssues.push(`${this.retryQueue.length} triggers in retry queue`);
        }

        if (!this.obsConnected) {
            healthScore -= 10;
            healthIssues.push('OBS is not connected');
        }

        if (enabledSchedules.length === 0) {
            healthIssues.push('No enabled schedules');
        }

        // Recent execution success rate
        const recentExecutions = this.executionHistory.slice(-20);
        const successCount = recentExecutions.filter(e => e.status === 'success').length;
        const successRate = recentExecutions.length > 0
            ? Math.round((successCount / recentExecutions.length) * 100)
            : 100;

        return {
            status: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'degraded' : 'unhealthy',
            healthScore: Math.max(0, healthScore),
            healthIssues: healthIssues,
            isRunning: this.isRunning,
            uptime: uptime,
            uptimeFormatted: this.formatUptime(uptime),
            startedAt: this.startedAt,
            lastHealthCheck: this.lastHealthCheck,
            obsConnected: this.obsConnected,
            lastObsCheck: this.lastObsCheck,
            statistics: {
                totalTriggers: this.totalTriggers,
                totalMissed: this.totalMissed,
                totalSkipped: this.totalSkipped,
                totalRetries: this.totalRetries,
                totalRetrySuccess: this.totalRetrySuccess,
                lastTriggerAt: this.lastTriggerAt,
                successRate: successRate
            },
            schedules: {
                total: this.schedules.length,
                enabled: enabledSchedules.length,
                disabled: this.schedules.length - enabledSchedules.length
            },
            retryQueue: {
                pending: this.retryQueue.length,
                items: this.retryQueue.slice(0, 5)
            },
            recentExecutions: this.executionHistory.slice(-5).reverse(),
            nextTriggers: nextTriggers.map(t => ({
                title: t.title,
                source: t.source,
                action: t.action,
                nextTrigger: t.nextTrigger,
                delay: t.delay,
                delayFormatted: this.formatDelay(t.delay)
            })),
            recentErrors: this.errors.slice(-5),
            recentAlerts: this.alerts.slice(-5)
        };
    }

    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (days > 0) return `${days}d ${hours}h ${mins}m`;
        if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
        if (mins > 0) return `${mins}m ${secs}s`;
        return `${secs}s`;
    }

    formatDelay(ms) {
        if (ms < 0) return 'Now';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    // ============================================
    // ALERT SYSTEM
    // ============================================

    /**
     * Raise an alert for important events
     */
    raiseAlert(type, severity, title, message, data = {}) {
        const alert = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            type: type,          // 'missed_schedule', 'error', 'warning', 'info'
            severity: severity,  // 'critical', 'warning', 'info'
            title: title,
            message: message,
            data: data,
            acknowledged: false
        };

        this.alerts.push(alert);

        // Keep only recent alerts
        if (this.alerts.length > this.maxAlerts) {
            this.alerts = this.alerts.slice(-this.maxAlerts);
        }

        // Log the alert
        this.log(severity === 'critical' ? 'ERROR' : 'WARN', 'ALERT_RAISED',
            `🚨 ALERT: ${title} - ${message}`, data);

        // Call alert handler if set
        if (this.onAlert) {
            try {
                this.onAlert(alert);
            } catch (e) {
                console.error('Error in alert handler:', e.message);
            }
        }

        return alert;
    }

    /**
     * Acknowledge an alert
     */
    acknowledgeAlert(alertId) {
        const alert = this.alerts.find(a => a.id === alertId);
        if (alert) {
            alert.acknowledged = true;
            alert.acknowledgedAt = new Date().toISOString();
            return true;
        }
        return false;
    }

    /**
     * Get all unacknowledged alerts
     */
    getUnacknowledgedAlerts() {
        return this.alerts.filter(a => !a.acknowledged);
    }

    /**
     * Clear all acknowledged alerts
     */
    clearAcknowledgedAlerts() {
        this.alerts = this.alerts.filter(a => !a.acknowledged);
    }

    /**
     * Track an error
     */
    trackError(type, message, data = {}) {
        const error = {
            timestamp: new Date().toISOString(),
            type: type,
            message: message,
            data: data
        };

        this.errors.push(error);

        // Keep only recent errors
        if (this.errors.length > this.maxErrors) {
            this.errors = this.errors.slice(-this.maxErrors);
        }

        // Raise alert for critical errors
        if (type === 'TRIGGER_ERROR' || type === 'CATCHUP_ERROR') {
            this.raiseAlert('error', 'critical', 'Scheduler Error', message, data);
        }
    }
}

module.exports = SchedulerService;

