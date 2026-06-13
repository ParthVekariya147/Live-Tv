/**
 * Live TV Controller Server
 * 
 * Express server with:
 * - Static file serving (React app, videos)
 * - Logging API
 * - Server-side Scheduler API with WebSocket events
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const app = express();
// Use 3004 for development (API only, Vite handles frontend)
// Use 3003 for production (EXE serves everything)
const PORT = process.env.PORT || (process.pkg ? 3003 : 3004);

// Create HTTP server for Express + WebSocket
const server = http.createServer(app);

// ============================================
// DIRECTORY SETUP
// ============================================

// Get the directory where static files are located
const distPath = path.join(__dirname, 'dist');

// Get data directory for scheduler persistence
const getDataDir = () => {
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'data');
    }
    return path.join(__dirname, 'data');
};

// Get logs directory - outside of bundled snapshot for EXE compatibility
const getLogsDir = () => {
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'logs');
    }
    return path.join(__dirname, 'logs');
};

// Get videos directory - external folder next to EXE or project folder
const getVideosDir = () => {
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'videos');
    }
    return path.join(__dirname, 'videos');
};

// Get recordings directory - next to EXE or project folder
const getRecordingsDir = () => {
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'live_recordings');
    }
    return path.join(__dirname, 'live_recordings');
};

// Get backups directory - next to EXE or project folder
const getBackupBaseDir = () => {
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'backups');
    }
    return path.join(__dirname, 'backups');
};

const dataDir = getDataDir();
const logsDir = getLogsDir();
const videosDir = getVideosDir();
const recordingsDir = getRecordingsDir();
const backupBaseDir = getBackupBaseDir();

// Ensure directories exist (backups sub-folders created by BackupService)
[dataDir, logsDir, videosDir, recordingsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
});

// ============================================
// LOGGING UTILITIES (must be before scheduler)
// ============================================

// Helper function to format date in local ISO format (YYYY-MM-DDTHH:mm:ss.sss+HH:MM)
const toLocalISOString = (date) => {
    const offset = date.getTimezoneOffset();
    const offsetSign = offset <= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
    const offsetMinutes = String(absOffset % 60).padStart(2, '0');

    const localDate = new Date(date.getTime() - offset * 60000);
    return localDate.toISOString().slice(0, -1) + offsetSign + offsetHours + ':' + offsetMinutes;
};

// Get current month's log file path (use local time for month calculation)
const getLogFilePath = (yearMonth) => {
    const now = new Date();
    const month = yearMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return path.join(logsDir, `logs-${month}.json`);
};

// Read logs from file
const readLogs = (yearMonth) => {
    const filePath = getLogFilePath(yearMonth);
    if (fs.existsSync(filePath)) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(content);
        } catch (e) {
            console.error('Error reading logs:', e);
            return [];
        }
    }
    return [];
};

// Write logs to file
const writeLogs = (logs, yearMonth) => {
    const filePath = getLogFilePath(yearMonth);
    fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), 'utf8');
};

// Write single log entry
const writeLog = (logEntry) => {
    const now = new Date();
    if (!logEntry.timestamp) {
        logEntry.timestamp = toLocalISOString(now);
        logEntry.date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        logEntry.time = now.toLocaleTimeString('en-GB', { hour12: false });
        logEntry.dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
    }
    if (!logEntry.id) {
        logEntry.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    const yearMonth = logEntry.timestamp.slice(0, 7);
    const logs = readLogs(yearMonth);
    logs.push(logEntry);
    writeLogs(logs, yearMonth);
};

// ============================================
// WEBSOCKET SERVER (24/7 Reliability)
// ============================================

const wss = new WebSocket.Server({ server, path: '/ws' });

// Track connected clients
const wsClients = new Set();

wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');
    wsClients.add(ws);

    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
        wsClients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error('[WebSocket] Error:', err.message);
        wsClients.delete(ws);
    });

    // Send initial state to newly connected client (merged from second handler)
    try {
        ws.send(JSON.stringify({ type: 'SCHEDULER_STATUS', data: scheduler.getStatus(), timestamp: new Date().toISOString() }));
        ws.send(JSON.stringify({ type: 'SCHEDULES_UPDATED', data: { schedules: scheduler.getAllSchedules() }, timestamp: new Date().toISOString() }));
        ws.send(JSON.stringify({ type: 'SCHEDULER_TICK', data: { nextTriggers: scheduler.getNextTriggers(10), serverTime: new Date().toISOString() }, timestamp: new Date().toISOString() }));
        ws.send(JSON.stringify({ type: 'STATE_SYNC', data: stateService.getAll(), timestamp: new Date().toISOString() }));
        const unackedAlerts = scheduler.getUnacknowledgedAlerts();
        if (unackedAlerts.length > 0) {
            ws.send(JSON.stringify({ type: 'SCHEDULER_ALERTS', data: { alerts: unackedAlerts }, timestamp: new Date().toISOString() }));
        }
    } catch (err) {
        console.error('[WebSocket] Error sending initial state:', err.message);
    }
});

// Broadcast to all connected clients
function broadcast(type, data) {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================
// 24/7 RELIABILITY: PERIODIC CLEANUP & MONITORING
// ============================================

// Dead client cleanup every 30 seconds
setInterval(() => {
    let removed = 0;
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
            wsClients.delete(client);
            removed++;
        }
    });
    if (removed > 0) {
        console.log(`[WebSocket] Cleaned up ${removed} dead client(s). Active: ${wsClients.size}`);
    }
}, 30000);

// Memory monitoring every 60 seconds
const MEMORY_WARNING_MB = 300;
const MEMORY_CRITICAL_MB = 1000;

setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);

    if (heapUsedMB > MEMORY_CRITICAL_MB) {
        console.error(`[MEMORY] CRITICAL: Heap ${heapUsedMB}MB, RSS ${rssMB}MB, Clients: ${wsClients.size}`);
    } else if (heapUsedMB > MEMORY_WARNING_MB) {
        console.warn(`[MEMORY] WARNING: Heap ${heapUsedMB}MB, RSS ${rssMB}MB, Clients: ${wsClients.size}`);
    }
}, 60000);

// ============================================
// SCHEDULER SERVICE INITIALIZATION
// ============================================

const SchedulerService = require('./scheduler-service.cjs');

const scheduler = new SchedulerService({
    dataDir: dataDir,
    logsDir: logsDir
});

// Handle scheduler triggers - broadcast to all clients
scheduler.onTrigger = (triggerData) => {
    console.log(`[Scheduler] Broadcasting trigger: ${triggerData.action} ${triggerData.source}`);

    // Broadcast to all WebSocket clients
    broadcast('SCHEDULER_TRIGGER', triggerData);

    // Also write to the main logs
    writeLog({
        level: 'info',
        type: 'SCHEDULER_TRIGGER',
        category: 'scheduler',
        message: `Schedule triggered: ${triggerData.action} ${triggerData.source} - ${triggerData.title}`,
        data: triggerData
    });
};

// After each successful execution, push updated schedules to all clients so
// React state always has the latest lastTriggered values.  Without this,
// drag-and-drop reorders send stale lastTriggered:null values back to the
// server via PUT /api/schedules, which wipes the tracking and causes
// every schedule to re-fire on the next restart (catch-up logic).
scheduler.onExecutionComplete = (execution) => {
    if (execution.status === 'success') {
        broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
    }
};

// Handle scheduler logs - write to main log file
scheduler.onLog = (logEntry) => {
    // Write scheduler logs to main logs (skip DEBUG level to reduce noise)
    if (logEntry.level !== 'DEBUG') {
        writeLog(logEntry);
    }
};

// Handle scheduler alerts - broadcast to all clients
scheduler.onAlert = (alert) => {
    console.log(`[Scheduler] 🚨 ALERT: ${alert.severity.toUpperCase()} - ${alert.title}`);

    // Broadcast alert to all WebSocket clients
    broadcast('SCHEDULER_ALERT', alert);

    // Write alert to main logs
    writeLog({
        level: alert.severity === 'critical' ? 'error' : 'warn',
        type: 'SCHEDULER_ALERT',
        category: 'scheduler',
        message: `ALERT: ${alert.title} - ${alert.message}`,
        data: alert
    });
};

// ============================================
// STATE SERVICE INITIALIZATION
// ============================================

const StateService = require('./state-service.cjs');

const stateService = new StateService({
    dataDir: dataDir
});

// Handle state changes - broadcast to all clients
stateService.onStateChange = (change) => {
    console.log(`[State] Broadcasting: ${change.type} ${change.key || ''}`);
    broadcast('STATE_CHANGE', change);
};

// Handle state logs
stateService.onLog = (logEntry) => {
    if (logEntry.level !== 'DEBUG') {
        writeLog(logEntry);
    }
};



// Start scheduler automatically
scheduler.start();

// ============================================
// WEBSOCKET TICK BROADCAST (1 second)
// ============================================
// Broadcast pending triggers and status every 1 second
// This enables 100% WebSocket architecture - no REST polling needed
let tickInterval = setInterval(() => {
    if (wsClients.size > 0) {
        const tickData = {
            nextTriggers: scheduler.getNextTriggers(10),
            serverTime: new Date().toISOString(),
            isRunning: scheduler.isRunning,
            schedulesCount: scheduler.schedules.length
        };

        const message = JSON.stringify({
            type: 'SCHEDULER_TICK',
            data: tickData,
            timestamp: new Date().toISOString()
        });

        wsClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}, 1000);

// Cleanup on server shutdown
process.on('SIGINT', () => {
    if (tickInterval) clearInterval(tickInterval);
});

// ============================================
// MIDDLEWARE
// ============================================

app.use(express.json());

// ============================================
// STATIC FILE SERVING
// ============================================

// Serve videos from external folder
app.use('/videos', express.static(videosDir, {
    setHeaders: (res, filePath) => {
        res.setHeader('Accept-Ranges', 'bytes');
    }
}));

// Serve static files from the dist directory
app.use(express.static(distPath));

// ============================================
// VIDEOS FOLDER SCAN API
// ============================================

// GET /api/videos/scan - List all MP4 files in the videos folder
app.get('/api/videos/scan', (req, res) => {
    try {
        const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'];
        if (!fs.existsSync(videosDir)) {
            return res.json({ success: true, files: [], folder: videosDir });
        }
        const entries = fs.readdirSync(videosDir, { withFileTypes: true });
        const files = entries
            .filter(e => e.isFile() && VIDEO_EXTS.includes(path.extname(e.name).toLowerCase()))
            .map(e => ({
                name: e.name,
                serverPath: `/videos/${e.name}`,
                size: fs.statSync(path.join(videosDir, e.name)).size
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, files, folder: videosDir });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/videos/scan-folder - Scan a custom folder path for video files
app.post('/api/videos/scan-folder', (req, res) => {
    try {
        const { folderPath } = req.body;
        if (!folderPath) return res.status(400).json({ success: false, error: 'folderPath is required' });
        const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'];
        if (!fs.existsSync(folderPath)) {
            return res.status(404).json({ success: false, error: 'Folder not found: ' + folderPath });
        }
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        const files = entries
            .filter(e => e.isFile() && VIDEO_EXTS.includes(path.extname(e.name).toLowerCase()))
            .map(e => ({
                name: e.name,
                absolutePath: path.join(folderPath, e.name),
                size: fs.statSync(path.join(folderPath, e.name)).size
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, files, folder: folderPath });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/videos/root-folder - Get the path of the videos folder (for display)
app.get('/api/videos/root-folder', (req, res) => {
    res.json({ success: true, folder: videosDir });
});

// ============================================
// STATE API ENDPOINTS
// ============================================

// GET /api/state - Get all state
app.get('/api/state', (req, res) => {
    res.json({
        success: true,
        state: stateService.getAll()
    });
});

// GET /api/state/:key - Get single state value
app.get('/api/state/:key(*)', (req, res) => {
    const key = req.params.key;
    const value = stateService.get(key);
    if (value !== null) {
        res.json({ success: true, key, value });
    } else {
        res.status(404).json({ success: false, error: 'Key not found' });
    }
});

// PUT /api/state/:key - Set single state value
app.put('/api/state/:key(*)', (req, res) => {
    const key = req.params.key;
    const { value } = req.body;
    if (value === undefined) {
        return res.status(400).json({ success: false, error: 'Value is required' });
    }
    stateService.set(key, value);
    res.json({ success: true, key, value });
});

// PATCH /api/state/:key - Merge into object state value
app.patch('/api/state/:key(*)', (req, res) => {
    const key = req.params.key;
    const { value } = req.body;
    if (typeof value !== 'object') {
        return res.status(400).json({ success: false, error: 'Value must be an object for merge' });
    }
    const merged = stateService.merge(key, value);
    res.json({ success: true, key, value: merged });
});

// DELETE /api/state/:key - Delete state key
app.delete('/api/state/:key(*)', (req, res) => {
    const key = req.params.key;
    const deleted = stateService.delete(key);
    if (deleted) {
        res.json({ success: true, message: `Deleted ${key}` });
    } else {
        res.status(404).json({ success: false, error: 'Key not found' });
    }
});

// POST /api/state/import - Import from localStorage (migration helper)
app.post('/api/state/import', (req, res) => {
    const { localStorageData } = req.body;
    const imported = stateService.importFromLocalStorage(localStorageData);
    res.json({ success: true, imported });
});

// POST /api/state/reset - Reset state to defaults
app.post('/api/state/reset', (req, res) => {
    stateService.reset();
    res.json({ success: true, message: 'State reset to defaults' });
});

// ============================================
// SETTINGS EXPORT / IMPORT
// ============================================

// GET /api/settings/export - Download all settings as a single JSON
app.get('/api/settings/export', (req, res) => {
    try {
        const payload = {
            exportedAt: new Date().toISOString(),
            version: '1.0',
            state: stateService.getAll(),
            schedules: scheduler.getAllSchedules(),
        };
        const filename = `live-tv-settings-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(payload);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/settings/import - Restore all settings from exported JSON
app.post('/api/settings/import', (req, res) => {
    try {
        const { state, schedules } = req.body;
        if (!state && !schedules) {
            return res.status(400).json({ success: false, error: 'Invalid settings file — missing state or schedules' });
        }
        if (state && typeof state === 'object') {
            // Skip runtime-only keys that should not be overwritten
            const skip = new Set(['obs.connected']);
            Object.entries(state).forEach(([k, v]) => {
                if (!skip.has(k)) stateService.set(k, v);
            });
        }
        if (Array.isArray(schedules) && schedules.length > 0) {
            scheduler.setAllSchedules(schedules);
            broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
        }
        broadcast('STATE_UPDATED', { state: stateService.getAll() });
        res.json({ success: true, stateKeys: Object.keys(state || {}).length, schedulesCount: (schedules || []).length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================
// OBS STATUS ENDPOINTS
// ============================================

// POST /api/obs/status - Update OBS connection status (called by frontend)
app.post('/api/obs/status', (req, res) => {
    const { connected } = req.body;

    // Update scheduler's OBS connection awareness
    scheduler.setObsConnected(connected);

    // Also update state service
    stateService.set('obs.connected', connected);

    console.log(`[OBS] Connection status updated: ${connected ? 'Connected' : 'Disconnected'}`);

    res.json({ success: true, connected });
});

// GET /api/obs/status - Get OBS connection status
app.get('/api/obs/status', (req, res) => {
    res.json({
        success: true,
        connected: scheduler.obsConnected,
        lastCheck: scheduler.lastObsCheck
    });
});

// ============================================
// SCHEDULER API ENDPOINTS
// ============================================

// GET /api/scheduler/next - Get next pending triggers
app.get('/api/scheduler/next', (req, res) => {
    const count = parseInt(req.query.count) || 5;
    res.json({
        success: true,
        nextTriggers: scheduler.getNextTriggers(count)
    });
});

// GET /api/scheduler/status - Get scheduler status
app.get('/api/scheduler/status', (req, res) => {
    res.json({
        success: true,
        ...scheduler.getStatus()
    });
});

// GET /api/scheduler/health - Comprehensive health check for monitoring
app.get('/api/scheduler/health', (req, res) => {
    const health = scheduler.getHealth();
    // Set status code based on health
    const statusCode = health.status === 'healthy' ? 200
        : health.status === 'degraded' ? 200
            : 503;
    res.status(statusCode).json({
        success: health.status !== 'unhealthy',
        ...health
    });
});

// GET /api/scheduler/alerts - Get all alerts
app.get('/api/scheduler/alerts', (req, res) => {
    const unackedOnly = req.query.unacked === 'true';
    const alerts = unackedOnly
        ? scheduler.getUnacknowledgedAlerts()
        : scheduler.alerts;
    res.json({
        success: true,
        alerts: alerts,
        unacknowledgedCount: scheduler.getUnacknowledgedAlerts().length
    });
});

// POST /api/scheduler/alerts/:id/acknowledge - Acknowledge an alert
app.post('/api/scheduler/alerts/:id/acknowledge', (req, res) => {
    const alertId = parseInt(req.params.id);
    const acknowledged = scheduler.acknowledgeAlert(alertId);
    if (acknowledged) {
        broadcast('ALERT_ACKNOWLEDGED', { alertId });
        res.json({ success: true, message: 'Alert acknowledged' });
    } else {
        res.status(404).json({ success: false, error: 'Alert not found' });
    }
});

// DELETE /api/scheduler/alerts - Clear acknowledged alerts
app.delete('/api/scheduler/alerts', (req, res) => {
    scheduler.clearAcknowledgedAlerts();
    res.json({ success: true, message: 'Acknowledged alerts cleared' });
});

// POST /api/scheduler/start - Start the scheduler
app.post('/api/scheduler/start', (req, res) => {
    scheduler.start();
    broadcast('SCHEDULER_STATUS', scheduler.getStatus());
    res.json({ success: true, message: 'Scheduler started' });
});

// POST /api/scheduler/stop - Stop the scheduler
app.post('/api/scheduler/stop', (req, res) => {
    scheduler.stop();
    broadcast('SCHEDULER_STATUS', scheduler.getStatus());
    res.json({ success: true, message: 'Scheduler stopped' });
});

// GET /api/scheduler/history - Get execution history
app.get('/api/scheduler/history', (req, res) => {
    const count = parseInt(req.query.count) || 20;
    res.json({
        success: true,
        history: scheduler.getExecutionHistory(count)
    });
});

// GET /api/scheduler/retries - Get retry queue status
app.get('/api/scheduler/retries', (req, res) => {
    res.json({
        success: true,
        retryQueue: scheduler.retryQueue,
        statistics: {
            totalRetries: scheduler.totalRetries,
            totalRetrySuccess: scheduler.totalRetrySuccess,
            pendingRetries: scheduler.retryQueue.length
        }
    });
});

// POST /api/scheduler/backup - Create manual backup
app.post('/api/scheduler/backup', (req, res) => {
    const backupFile = scheduler.createBackup();
    if (backupFile) {
        res.json({ success: true, backupFile: backupFile });
    } else {
        res.status(500).json({ success: false, error: 'Backup failed' });
    }
});

// GET /api/schedules - Get all schedules
app.get('/api/schedules', (req, res) => {
    res.json({
        success: true,
        schedules: scheduler.getAllSchedules(),
        isRunning: scheduler.isRunning
    });
});

// POST /api/schedules - Add a new schedule
app.post('/api/schedules', (req, res) => {
    try {
        const schedule = scheduler.addSchedule(req.body);
        broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
        res.json({ success: true, schedule });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// PUT /api/schedules/:id - Update a schedule
app.put('/api/schedules/:id', (req, res) => {
    const id = parseInt(req.params.id) || req.params.id;
    const schedule = scheduler.updateSchedule(id, req.body);
    if (schedule) {
        broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
        res.json({ success: true, schedule });
    } else {
        res.status(404).json({ success: false, error: 'Schedule not found' });
    }
});

// DELETE /api/schedules/:id - Delete a schedule
app.delete('/api/schedules/:id', (req, res) => {
    const id = parseInt(req.params.id) || req.params.id;
    const deleted = scheduler.deleteSchedule(id);
    if (deleted) {
        broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
        res.json({ success: true, deleted: true });
    } else {
        res.status(404).json({ success: false, error: 'Schedule not found' });
    }
});

// POST /api/schedules/:id/toggle - Toggle a schedule enabled state
app.post('/api/schedules/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id) || req.params.id;
    const schedule = scheduler.toggleSchedule(id);
    if (schedule) {
        broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
        res.json({ success: true, schedule });
    } else {
        res.status(404).json({ success: false, error: 'Schedule not found' });
    }
});

// POST /api/schedules/:id/fire - Immediately fire a schedule (for testing)
app.post('/api/schedules/:id/fire', (req, res) => {
    const id = parseInt(req.params.id) || req.params.id;
    const schedule = scheduler.getSchedule(id);
    if (!schedule) {
        return res.status(404).json({ success: false, error: 'Schedule not found' });
    }
    const triggerData = {
        id: schedule.id,
        source: schedule.source,
        action: schedule.action,
        title: schedule.title,
        time: schedule.time,
        triggerKey: `test-${Date.now()}`,
        reason: 'manual-test'
    };
    broadcast('SCHEDULER_TRIGGER', triggerData);
    console.log(`[Scheduler] Manual fire: ${schedule.action} ${schedule.source} (${schedule.title || 'no title'})`);
    res.json({ success: true, fired: triggerData });
});

// POST /api/schedules/:id/skip-day - Skip next trigger by 1 day
app.post('/api/schedules/:id/skip-day', (req, res) => {
    const id = parseInt(req.params.id) || req.params.id;
    const result = scheduler.skipOneDay(id);
    if (!result) return res.status(404).json({ success: false, error: 'Schedule not found or no next trigger' });
    broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
    res.json({ success: true, ...result });
});

// POST /api/schedules/:id/cancel-skip - Cancel an active skip
app.post('/api/schedules/:id/cancel-skip', (req, res) => {
    const id = parseInt(req.params.id) || req.params.id;
    const result = scheduler.cancelSkip(id);
    if (!result) return res.status(404).json({ success: false, error: 'Schedule not found' });
    broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
    res.json({ success: true });
});

// PUT /api/schedules - Replace all schedules (for import / drag-and-drop reorder)
app.put('/api/schedules', (req, res) => {
    try {
        const incoming = req.body.schedules || req.body;
        // Preserve lastTriggered from the server's current state when the
        // incoming value is null/undefined.  This prevents stale React state
        // (which never receives lastTriggered updates unless we push them) from
        // wiping the server's tracking and causing double-triggers on restart.
        const existingMap = new Map(scheduler.getAllSchedules().map(s => [String(s.id), s]));
        const merged = Array.isArray(incoming) ? incoming.map(s => {
            const existing = existingMap.get(String(s.id));
            if (!existing) return s;
            const patch = {};
            // Preserve server-side tracking fields that React state doesn't hold
            if (existing.lastTriggered && !s.lastTriggered) patch.lastTriggered = existing.lastTriggered;
            if (existing.skipUntil && !s.skipUntil) patch.skipUntil = existing.skipUntil;
            return Object.keys(patch).length ? { ...s, ...patch } : s;
        }) : incoming;
        const schedules = scheduler.setAllSchedules(merged);
        broadcast('SCHEDULES_UPDATED', { schedules });
        res.json({ success: true, schedules });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// ============================================
// LOGGING API ENDPOINTS
// ============================================

// POST /api/log - Add a new log entry
app.post('/api/log', (req, res) => {
    try {
        const logEntry = req.body;

        if (!logEntry.timestamp) {
            const now = new Date();
            logEntry.timestamp = toLocalISOString(now);
            logEntry.date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            logEntry.time = now.toLocaleTimeString('en-GB', { hour12: false });
            logEntry.dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
        }

        if (!logEntry.id) {
            logEntry.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        }

        const yearMonth = logEntry.timestamp.slice(0, 7);
        const logs = readLogs(yearMonth);
        logs.push(logEntry);
        writeLogs(logs, yearMonth);

        res.json({ success: true, id: logEntry.id });
    } catch (e) {
        console.error('Error writing log:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/logs - Get logs with optional filters
app.get('/api/logs', (req, res) => {
    try {
        const { month, category, type, search, limit, offset } = req.query;

        const now = new Date();
        const yearMonth = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        let logs = readLogs(yearMonth);

        if (category) {
            logs = logs.filter(log => log.category === category);
        }
        if (type) {
            logs = logs.filter(log => log.type === type);
        }
        if (search) {
            const searchLower = search.toLowerCase();
            logs = logs.filter(log =>
                log.message?.toLowerCase().includes(searchLower) ||
                JSON.stringify(log.data)?.toLowerCase().includes(searchLower)
            );
        }

        logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const total = logs.length;
        const offsetNum = parseInt(offset) || 0;
        const limitNum = parseInt(limit) || 50;
        logs = logs.slice(offsetNum, offsetNum + limitNum);

        res.json({ success: true, logs, total, offset: offsetNum, limit: limitNum });
    } catch (e) {
        console.error('Error reading logs:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/logs/months - Get list of available log months
app.get('/api/logs/months', (req, res) => {
    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => f.startsWith('logs-') && f.endsWith('.json'))
            .map(f => f.replace('logs-', '').replace('.json', ''))
            .sort()
            .reverse();
        res.json({ success: true, months: files });
    } catch (e) {
        res.json({ success: true, months: [] });
    }
});

// DELETE /api/logs/:id - Delete a specific log entry
app.delete('/api/logs/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { month } = req.query;
        const now = new Date();
        const yearMonth = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        let logs = readLogs(yearMonth);
        const initialLength = logs.length;
        logs = logs.filter(log => log.id !== id);

        if (logs.length < initialLength) {
            writeLogs(logs, yearMonth);
            res.json({ success: true, deleted: true });
        } else {
            res.json({ success: true, deleted: false, message: 'Log not found' });
        }
    } catch (e) {
        console.error('Error deleting log:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/logs - Clear logs for a month
app.delete('/api/logs', (req, res) => {
    try {
        const { month } = req.query;
        if (!month) {
            return res.status(400).json({ success: false, error: 'Month parameter required' });
        }

        const filePath = getLogFilePath(month);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true, deleted: true });
        } else {
            res.json({ success: true, deleted: false, message: 'Log file not found' });
        }
    } catch (e) {
        console.error('Error clearing logs:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================
// BACKUP SERVICE
// ============================================

class BackupService {
    constructor({ dataDir, backupBaseDir }) {
        this.dataDir = dataDir;
        this.manualDir = path.join(backupBaseDir, 'manual_backup');
        this.autoDir   = path.join(backupBaseDir, 'auto_backup');
        this.autoInterval = null;

        // Ensure both subdirectories exist
        [this.manualDir, this.autoDir].forEach(d => {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        });
    }

    // Collect all JSON files from data dir into one object
    // Excludes auto_backup_settings.json so restoring a backup doesn't reset the current backup schedule
    _collectData() {
        const EXCLUDE = new Set(['auto_backup_settings.json']);
        const files = {};
        try {
            for (const entry of fs.readdirSync(this.dataDir)) {
                if (!entry.endsWith('.json') || entry.endsWith('.bak')) continue;
                if (EXCLUDE.has(entry)) continue;
                try {
                    files[entry] = JSON.parse(fs.readFileSync(path.join(this.dataDir, entry), 'utf8'));
                } catch (_) { /* skip unreadable */ }
            }
        } catch (_) {}
        return files;
    }

    createBackup(type = 'manual') {
        const dir = type === 'manual' ? this.manualDir : this.autoDir;
        const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
        const filename = `backup_${ts}.json`;
        const filepath = path.join(dir, filename);

        const payload = {
            backedUpAt: new Date().toISOString(),
            type,
            files: this._collectData(),
        };
        fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');
        console.log(`[Backup] ${type} backup saved → ${filename}`);

        // Retention: manual=30 files, auto=14 files (2 weeks)
        this._pruneOld(dir, type === 'manual' ? 30 : 14);

        return { filename, backedUpAt: payload.backedUpAt, fileCount: Object.keys(payload.files).length };
    }

    listBackups(type = 'manual') {
        const dir = type === 'manual' ? this.manualDir : this.autoDir;
        try {
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.json'))
                .map(f => {
                    const fp  = path.join(dir, f);
                    const st  = fs.statSync(fp);
                    return { filename: f, size: st.size, modifiedAt: st.mtime.toISOString() };
                })
                .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
        } catch (_) { return []; }
    }

    restoreBackup(type, filename) {
        if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..') || !filename.endsWith('.json')) {
            throw new Error('Invalid backup filename');
        }
        const dir = type === 'manual' ? this.manualDir : this.autoDir;
        const filepath = path.join(dir, filename);
        if (!filepath.startsWith(dir + path.sep) && filepath !== path.join(dir, filename)) {
            throw new Error('Path traversal detected');
        }

        const payload = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        let restored = 0;
        for (const [fname, content] of Object.entries(payload.files || {})) {
            // Only restore .json files that don't contain path separators
            if (fname.includes('/') || fname.includes('\\') || !fname.endsWith('.json')) continue;
            fs.writeFileSync(path.join(this.dataDir, fname), JSON.stringify(content, null, 2), 'utf8');
            restored++;
        }
        return { restored, backedUpAt: payload.backedUpAt };
    }

    // ── Auto-backup settings ────────────────────────────────────────────
    // Stored in data/auto_backup_settings.json
    // Schema: { mode: 'hours'|'days'|'weekly', intervalHours, intervalDays, dayOfWeek }

    getAutoSettings() {
        try {
            const f = path.join(this.dataDir, 'auto_backup_settings.json');
            if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch (_) {}
        return { mode: 'hours', intervalHours: 12 }; // default: every 12 hours
    }

    saveAutoSettings(settings) {
        fs.writeFileSync(
            path.join(this.dataDir, 'auto_backup_settings.json'),
            JSON.stringify(settings, null, 2), 'utf8'
        );
    }

    // Hourly checker — resilient to server restarts for all modes
    startAutoBackup() {
        this.stopAutoBackup();
        const check = () => {
            try {
                const cfg     = this.getAutoSettings();
                const now     = new Date();
                const latest  = this.listBackups('auto')[0];
                const lastMs  = latest ? new Date(latest.modifiedAt).getTime() : 0;
                const elapsed = now.getTime() - lastMs;
                let fire = false;

                if (cfg.mode === 'hours') {
                    fire = elapsed >= (cfg.intervalHours || 12) * 3_600_000;
                } else if (cfg.mode === 'days') {
                    fire = elapsed >= (cfg.intervalDays  ||  1) * 86_400_000;
                } else if (cfg.mode === 'weekly') {
                    const todayKey = now.toISOString().slice(0, 10);
                    const lastKey  = latest?.modifiedAt?.slice(0, 10);
                    fire = now.getDay() === (cfg.dayOfWeek ?? 4) && todayKey !== lastKey;
                }

                if (fire) this.createBackup('auto');
            } catch (e) { console.error('[Backup] Auto-backup error:', e.message); }
        };

        check(); // run once on startup in case we missed an interval
        this.autoInterval = setInterval(check, 3_600_000); // re-check every hour
        const cfg = this.getAutoSettings();
        const desc = cfg.mode === 'hours'  ? `every ${cfg.intervalHours}h`
                   : cfg.mode === 'days'   ? `every ${cfg.intervalDays}d`
                   : `every ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][cfg.dayOfWeek ?? 4]}`;
        console.log(`[Backup] Auto-backup active (${desc}) — checks hourly`);
    }

    stopAutoBackup() {
        if (this.autoInterval) { clearInterval(this.autoInterval); this.autoInterval = null; }
    }

    _pruneOld(dir, keep) {
        try {
            const files = fs.readdirSync(dir)
                .filter(f => f.endsWith('.json'))
                .map(f => ({ f, mt: fs.statSync(path.join(dir, f)).mtime }))
                .sort((a, b) => b.mt - a.mt);
            files.slice(keep).forEach(({ f }) => {
                try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
            });
        } catch (_) {}
    }
}

// ============================================
// RECORDING SERVICE
// ============================================

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

class RecordingService {
    constructor({ recordingsDir }) {
        this.recordingsDir = recordingsDir;
        this.settingsFile = path.join(recordingsDir, 'settings.json');
        this.currentProcess = null;
        this.currentRecording = null;
        this.recordingStartTime = null;
        this.currentVideoId = null;
    }

    getSettings() {
        try {
            if (fs.existsSync(this.settingsFile)) {
                return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
            }
        } catch (e) { /* ignore */ }
        return { autoDeleteCount: 0 };
    }

    saveSettings(settings) {
        fs.writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    }

    getStatus() {
        const durationSecs = this.recordingStartTime
            ? Math.floor((Date.now() - this.recordingStartTime) / 1000)
            : 0;
        return {
            isRecording: !!this.currentProcess,
            currentFile: this.currentRecording,
            videoId: this.currentVideoId,
            startTime: this.recordingStartTime,
            durationSeconds: durationSecs,
        };
    }

    listRecordings() {
        try {
            return fs.readdirSync(this.recordingsDir)
                .filter(f => /\.(mp4|mkv|ts|webm)$/.test(f))
                .map(f => {
                    const fp = path.join(this.recordingsDir, f);
                    const stat = fs.statSync(fp);
                    return {
                        filename: f,
                        size: stat.size,
                        sizeFormatted: formatFileSize(stat.size),
                        createdAt: stat.birthtime.toISOString(),
                        modifiedAt: stat.mtime.toISOString(),
                    };
                })
                .sort((a, b) => {
                    // Use birthtime when valid, fall back to mtime (Linux ext3/ext4 may report epoch for birthtime)
                    const aTime = a.createdAt > '1970-01-02' ? a.createdAt : a.modifiedAt;
                    const bTime = b.createdAt > '1970-01-02' ? b.createdAt : b.modifiedAt;
                    return new Date(bTime) - new Date(aTime);
                });
        } catch (e) {
            return [];
        }
    }

    _findYtDlp() {
        if (process.pkg) {
            const exeDir = path.dirname(process.execPath);
            const candidates = [
                path.join(exeDir, 'yt-dlp.exe'),
                path.join(exeDir, 'yt-dlp'),
            ];
            for (const c of candidates) {
                if (fs.existsSync(c)) return c;
            }
        }
        return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    }

    start(videoId, onEvent, title) {
        if (this.currentProcess) {
            return { success: false, error: 'Recording already in progress' };
        }
        if (!videoId) {
            return { success: false, error: 'videoId is required' };
        }

        const ytDlp = this._findYtDlp();
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 16); // YYYY-MM-DDTHH-MM
        const safeTitle = title
            ? title.replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
            : null;
        const filename = safeTitle
            ? `${safeTitle}_${ts}.mp4`
            : `recording_${ts}_${videoId}.mp4`;
        const outputPath = path.join(this.recordingsDir, filename);

        const args = [
            '--no-part',
            '--no-continue',
            '-f', 'bestvideo+bestaudio/best',
            '--merge-output-format', 'mp4',
            '-o', outputPath,
            `https://www.youtube.com/watch?v=${videoId}`,
        ];

        let proc;
        try {
            proc = spawn(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            return { success: false, error: `Failed to start yt-dlp: ${err.message}` };
        }

        this.currentProcess = proc;
        this.currentRecording = filename;
        this.recordingStartTime = Date.now();
        this.currentVideoId = videoId;

        const logLine = (level, msg) => {
            const trimmed = msg.trim();
            if (!trimmed) return;
            console.log(`[Recording][${level}] ${trimmed}`);
            if (onEvent) onEvent({ type: 'log', level, message: trimmed });
        };

        proc.stdout.on('data', d => logLine('info', d.toString()));
        proc.stderr.on('data', d => logLine('info', d.toString()));

        proc.on('error', err => {
            console.error('[Recording] Process error:', err.message);
            this.currentProcess = null;
            this.currentRecording = null;
            this.recordingStartTime = null;
            this.currentVideoId = null;
            if (onEvent) onEvent({ type: 'error', message: err.message });
        });

        proc.on('close', code => {
            console.log(`[Recording] Process exited with code ${code}`);
            const stoppedFile = this.currentRecording;
            this.currentProcess = null;
            this.currentRecording = null;
            this.recordingStartTime = null;
            this.currentVideoId = null;

            // Auto-delete enforcement
            const { autoDeleteCount } = this.getSettings();
            if (autoDeleteCount > 0) {
                this._enforceAutoDelete(autoDeleteCount);
            }

            if (onEvent) onEvent({ type: 'stopped', filename: stoppedFile, exitCode: code });
        });

        return { success: true, filename, outputPath };
    }

    stop() {
        if (!this.currentProcess) {
            return { success: false, error: 'No recording in progress' };
        }
        const filename = this.currentRecording;
        const pid = this.currentProcess.pid;

        if (process.platform === 'win32') {
            try {
                require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
            } catch (e) {
                try { this.currentProcess.kill(); } catch (_) { /* ignore */ }
            }
        } else {
            try { this.currentProcess.kill('SIGINT'); } catch (_) { /* ignore */ }
        }

        return { success: true, filename };
    }

    _enforceAutoDelete(maxCount) {
        const recordings = this.listRecordings();
        if (recordings.length <= maxCount) return;
        const toDelete = recordings.slice(maxCount); // oldest are at the end (sorted newest-first)
        for (const rec of toDelete) {
            try {
                fs.unlinkSync(path.join(this.recordingsDir, rec.filename));
                console.log(`[Recording] Auto-deleted: ${rec.filename}`);
            } catch (e) {
                console.error(`[Recording] Failed to auto-delete ${rec.filename}:`, e.message);
            }
        }
    }

    deleteRecording(filename) {
        const safe = path.basename(filename);
        const fp = path.join(this.recordingsDir, safe);
        if (!fp.startsWith(this.recordingsDir + path.sep) && fp !== path.join(this.recordingsDir, safe)) {
            return { success: false, error: 'Invalid filename' };
        }
        if (!fs.existsSync(fp)) {
            return { success: false, error: 'File not found' };
        }
        try {
            fs.unlinkSync(fp);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
}

const recordingService = new RecordingService({ recordingsDir });
const backupService = new BackupService({ dataDir, backupBaseDir });

// ============================================
// BACKUP API ENDPOINTS
// ============================================

// POST /api/backup/manual — save a manual backup right now
app.post('/api/backup/manual', (req, res) => {
    try {
        const result = backupService.createBackup('manual');
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/backup/list?type=manual|auto — list backup files
app.get('/api/backup/list', (req, res) => {
    const type = req.query.type === 'auto' ? 'auto' : 'manual';
    const backups = backupService.listBackups(type);
    res.json({ success: true, type, backups });
});

// POST /api/backup/restore — restore from a backup file
// body: { type: 'manual'|'auto', filename: 'backup_YYYY-MM-DDTHH-MM.json' }
app.post('/api/backup/restore', (req, res) => {
    const { type, filename } = req.body || {};
    if (!filename) return res.status(400).json({ success: false, error: 'filename required' });
    try {
        const result = backupService.restoreBackup(type || 'manual', filename);
        // Reload scheduler with the restored schedules
        scheduler.loadSchedules();
        broadcast('SCHEDULES_UPDATED', { schedules: scheduler.getAllSchedules() });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// GET /api/backup/status — last backup timestamps for both types
app.get('/api/backup/status', (req, res) => {
    const manual = backupService.listBackups('manual');
    const auto   = backupService.listBackups('auto');
    res.json({
        success: true,
        manual: { count: manual.length, latest: manual[0] || null },
        auto:   { count: auto.length,   latest: auto[0]   || null },
        autoSettings: backupService.getAutoSettings(),
    });
});

// GET /api/backup/auto-settings — get current auto-backup schedule config
app.get('/api/backup/auto-settings', (req, res) => {
    res.json({ success: true, settings: backupService.getAutoSettings() });
});

// PUT /api/backup/auto-settings — update auto-backup schedule and restart the timer
app.put('/api/backup/auto-settings', (req, res) => {
    const { mode, intervalHours, intervalDays, dayOfWeek } = req.body || {};
    const VALID_MODES = ['hours', 'days', 'weekly'];
    if (!VALID_MODES.includes(mode)) {
        return res.status(400).json({ success: false, error: 'mode must be hours | days | weekly' });
    }
    const settings = { mode };
    if (mode === 'hours') settings.intervalHours = Math.max(1, parseInt(intervalHours) || 12);
    if (mode === 'days')  settings.intervalDays  = Math.max(1, parseInt(intervalDays)  ||  1);
    if (mode === 'weekly') settings.dayOfWeek    = Math.min(6, Math.max(0, parseInt(dayOfWeek) ?? 4));

    backupService.saveAutoSettings(settings);
    backupService.startAutoBackup(); // restart with new schedule
    res.json({ success: true, settings });
});

// POST /api/backup/open-folder — open the backups folder in OS file manager
app.post('/api/backup/open-folder', (req, res) => {
    const { exec } = require('child_process');
    const subFolder = req.body?.sub; // 'manual_backup' | 'auto_backup' | undefined (opens root)
    const target = subFolder === 'manual_backup' ? backupService.manualDir
                 : subFolder === 'auto_backup'   ? backupService.autoDir
                 : backupBaseDir;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    let cmd;
    if (process.platform === 'win32') cmd = `explorer "${target}"`;
    else if (process.platform === 'darwin') cmd = `open "${target}"`;
    else cmd = `xdg-open "${target}"`;
    exec(cmd, () => {});
    res.json({ success: true, path: target });
});

// ============================================
// RECORDING API ENDPOINTS
// ============================================

// GET /api/recording/status
app.get('/api/recording/status', (req, res) => {
    res.json({ success: true, ...recordingService.getStatus() });
});

// POST /api/recording/start
app.post('/api/recording/start', (req, res) => {
    const { videoId, title } = req.body;
    const result = recordingService.start(videoId, (event) => {
        broadcast('RECORDING_EVENT', event);
        if (event.type === 'stopped') {
            broadcast('RECORDING_STATUS', recordingService.getStatus());
        }
    }, title);
    if (result.success) {
        broadcast('RECORDING_STATUS', recordingService.getStatus());
        writeLog({
            level: 'info',
            type: 'RECORDING_START',
            category: 'recording',
            message: `Recording started: ${result.filename}`,
            data: { videoId, filename: result.filename },
        });
    }
    res.json(result);
});

// POST /api/recording/stop
app.post('/api/recording/stop', (req, res) => {
    const result = recordingService.stop();
    if (result.success) {
        writeLog({
            level: 'info',
            type: 'RECORDING_STOP',
            category: 'recording',
            message: `Recording stopped: ${result.filename}`,
            data: { filename: result.filename },
        });
    }
    res.json(result);
});

// GET /api/recording/list
app.get('/api/recording/list', (req, res) => {
    res.json({ success: true, recordings: recordingService.listRecordings() });
});

// GET /api/recording/settings
app.get('/api/recording/settings', (req, res) => {
    res.json({ success: true, settings: recordingService.getSettings() });
});

// PUT /api/recording/settings
app.put('/api/recording/settings', (req, res) => {
    const current = recordingService.getSettings();
    const updated = { ...current, ...req.body };
    if (typeof updated.autoDeleteCount !== 'number' || updated.autoDeleteCount < 0) {
        return res.status(400).json({ success: false, error: 'autoDeleteCount must be a non-negative number' });
    }
    recordingService.saveSettings(updated);
    res.json({ success: true, settings: updated });
});

// DELETE /api/recording/:filename
app.delete('/api/recording/:filename', (req, res) => {
    const result = recordingService.deleteRecording(req.params.filename);
    res.json(result);
});

// POST /api/recording/open-folder — open the live_recordings folder in OS file manager
app.post('/api/recording/open-folder', (req, res) => {
    if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
    const { exec } = require('child_process');
    let cmd;
    if (process.platform === 'win32') cmd = `explorer "${recordingsDir}"`;
    else if (process.platform === 'darwin') cmd = `open "${recordingsDir}"`;
    else cmd = `xdg-open "${recordingsDir}"`;
    exec(cmd, () => {});
    res.json({ success: true, path: recordingsDir });
});

// GET /api/recording/folder-path — return path for display
app.get('/api/recording/folder-path', (req, res) => {
    res.json({ success: true, path: recordingsDir });
});

// Serve recordings as static files
app.use('/live_recordings', express.static(recordingsDir, {
    setHeaders: (res) => { res.setHeader('Accept-Ranges', 'bytes'); }
}));

// ============================================
// SPA ROUTING (must be after API routes)
// ============================================

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }

    if (req.path.endsWith('.html')) {
        const filePath = path.join(distPath, req.path);
        res.sendFile(filePath, (err) => {
            if (err) {
                res.sendFile(path.join(distPath, 'index.html'));
            }
        });
    } else {
        res.sendFile(path.join(distPath, 'index.html'));
    }
});

// ============================================
// SERVER STARTUP
// ============================================

let _portRetries = 0;
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        if (_portRetries < 3) {
            _portRetries++;
            console.warn(`[Server] Port ${PORT} in use — killing conflicting process and retrying (attempt ${_portRetries}/3)...`);
            try {
                require('child_process').execSync(
                    `lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`,
                    { stdio: 'ignore' }
                );
            } catch (_) { /* ignore */ }
            setTimeout(() => server.listen(PORT), 1500);
        } else {
            console.error(`[Server] Port ${PORT} still in use after ${_portRetries} retries. Exiting.`);
            process.exit(1);
        }
    } else {
        console.error('[Server] Startup error:', err.message);
        process.exit(1);
    }
});

server.listen(PORT, () => {
    // Start 12-hour auto-backup
    backupService.startAutoBackup();

    console.log('');
    console.log('='.repeat(60));
    console.log('  Live TV Controller Server');
    console.log('='.repeat(60));
    console.log(`  Server:         http://localhost:${PORT}/`);
    console.log(`  WebSocket:      ws://localhost:${PORT}/ws`);
    console.log(`  Data dir:       ${dataDir}`);
    console.log(`  Logs dir:       ${logsDir}`);
    console.log(`  Videos dir:     ${videosDir}`);
    console.log(`  Recordings dir: ${recordingsDir}`);
    console.log(`  Backups dir:    ${backupBaseDir}`);
    console.log('');
    console.log('  Scheduler:');
    console.log(`    Status:    ${scheduler.isRunning ? 'RUNNING' : 'STOPPED'}`);
    console.log(`    Schedules: ${scheduler.getAllSchedules().length}`);
    console.log('  Backup: auto every 12h | manual via UI');
    console.log('');
    console.log('  Press Ctrl+C to stop the server');
    console.log('='.repeat(60));
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (recordingService.getStatus().isRecording) {
        console.log('[Recording] Stopping active recording...');
        recordingService.stop();
    }
    backupService.stopAutoBackup();
    scheduler.stop();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
