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

const dataDir = getDataDir();
const logsDir = getLogsDir();
const videosDir = getVideosDir();

// Ensure directories exist
[dataDir, logsDir, videosDir].forEach(dir => {
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

// Send scheduler status and app state to newly connected WebSocket clients
wss.on('connection', (ws) => {
    // Send current scheduler status on connect
    ws.send(JSON.stringify({
        type: 'SCHEDULER_STATUS',
        data: scheduler.getStatus(),
        timestamp: new Date().toISOString()
    }));

    // Send full schedules list on connect
    ws.send(JSON.stringify({
        type: 'SCHEDULES_UPDATED',
        data: { schedules: scheduler.getAllSchedules() },
        timestamp: new Date().toISOString()
    }));

    // Send pending triggers immediately on connect
    ws.send(JSON.stringify({
        type: 'SCHEDULER_TICK',
        data: {
            nextTriggers: scheduler.getNextTriggers(10),
            serverTime: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
    }));

    // Send full app state on connect
    ws.send(JSON.stringify({
        type: 'STATE_SYNC',
        data: stateService.getAll(),
        timestamp: new Date().toISOString()
    }));

    // Also send any unacknowledged alerts
    const unackedAlerts = scheduler.getUnacknowledgedAlerts();
    if (unackedAlerts.length > 0) {
        ws.send(JSON.stringify({
            type: 'SCHEDULER_ALERTS',
            data: { alerts: unackedAlerts },
            timestamp: new Date().toISOString()
        }));
    }
});


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

// PUT /api/schedules - Replace all schedules (for import)
app.put('/api/schedules', (req, res) => {
    try {
        const schedules = scheduler.setAllSchedules(req.body.schedules || req.body);
        broadcast('SCHEDULES_UPDATED', { schedules });
        res.json({ success: true, schedules });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// GET /api/scheduler/next - Get next pending triggers
app.get('/api/scheduler/next', (req, res) => {
    const count = parseInt(req.query.count) || 5;
    res.json({
        success: true,
        nextTriggers: scheduler.getNextTriggers(count)
    });
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

server.listen(PORT, () => {
    console.log('');
    console.log('='.repeat(60));
    console.log('  Live TV Controller Server');
    console.log('='.repeat(60));
    console.log(`  Server:      http://localhost:${PORT}/`);
    console.log(`  WebSocket:   ws://localhost:${PORT}/ws`);
    console.log(`  Data dir:    ${dataDir}`);
    console.log(`  Logs dir:    ${logsDir}`);
    console.log(`  Videos dir:  ${videosDir}`);
    console.log('');
    console.log('  Scheduler:');
    console.log(`    Status:    ${scheduler.isRunning ? 'RUNNING' : 'STOPPED'}`);
    console.log(`    Schedules: ${scheduler.getAllSchedules().length}`);
    console.log('');
    console.log('  Press Ctrl+C to stop the server');
    console.log('='.repeat(60));
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    scheduler.stop();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
