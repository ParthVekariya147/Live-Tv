/**
 * Logger Utility for Live TV Controller
 * Sends logs to Express server which saves to monthly JSON files
 */

// API endpoint - works both in dev and production
const API_BASE = '';

// Log levels
export const LogLevel = {
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
    DEBUG: 'debug'
};

// Log categories
export const LogCategory = {
    VIDEO: 'video',
    SOURCE: 'source',
    SCHEDULER: 'scheduler',
    KATHA: 'katha',
    MONITOR: 'monitor',
    SYSTEM: 'system'
};

// Log types
export const LogType = {
    VIDEO_LOAD: 'VIDEO_LOAD',
    VIDEO_PLAY: 'VIDEO_PLAY',
    VIDEO_END: 'VIDEO_END',
    VIDEO_ERROR: 'VIDEO_ERROR',
    SOURCE_VISIBLE: 'SOURCE_VISIBLE',
    SOURCE_HIDDEN: 'SOURCE_HIDDEN',
    SCHEDULER_TRIGGER: 'SCHEDULER_TRIGGER',
    SCHEDULER_SKIP: 'SCHEDULER_SKIP',
    KATHA_REFRESH: 'KATHA_REFRESH',
    KATHA_VIDEO_FOUND: 'KATHA_VIDEO_FOUND',
    KATHA_LOAD_PLAYER: 'KATHA_LOAD_PLAYER',
    LIVE_MONITOR_EVENT: 'LIVE_MONITOR_EVENT',
    PLAYLIST_ACTION: 'PLAYLIST_ACTION',
    OBS_CONNECTED: 'OBS_CONNECTED',
    OBS_DISCONNECTED: 'OBS_DISCONNECTED'
};

// Day names for formatting
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// State tracking for deduplication
const lastLoggedState = {
    monitor1VideoId: null,
    monitor2VideoId: null,
    kathaVideoIds: new Set(),
    lastKathaRefresh: null, // Track last refresh to avoid duplicates
    lastSourceStates: {}
};

/**
 * Format timestamp for log entry
 */
const formatTimestamp = () => {
    const now = new Date();
    return {
        timestamp: now.toISOString(),
        date: `${now.getDate()} ${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`,
        time: now.toLocaleTimeString('en-GB', { hour12: false }),
        dayName: DAY_NAMES[now.getDay()]
    };
};

/**
 * Send log entry to server
 */
const sendLog = async (logEntry) => {
    try {
        const response = await fetch(`${API_BASE}/api/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logEntry)
        });
        const result = await response.json();
        if (!result.success) {
            console.error('Failed to save log:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending log:', error);
        // Fallback: log to console
        return { success: false, error: error.message };
    }
};

/**
 * Main logging function
 */
export const log = async (level, type, category, data, message) => {
    const timeInfo = formatTimestamp();

    const logEntry = {
        ...timeInfo,
        level,
        type,
        category,
        message,
        data
    };

    // Also log to console in development
    if (import.meta.env.DEV) {
        const consoleMethod = level === LogLevel.ERROR ? 'error' : level === LogLevel.WARN ? 'warn' : 'log';
        console[consoleMethod](`[${type}]`, message, data);
    }

    return sendLog(logEntry);
};

// Convenience methods
export const logInfo = (type, category, data, message) => log(LogLevel.INFO, type, category, data, message);
export const logWarn = (type, category, data, message) => log(LogLevel.WARN, type, category, data, message);
export const logError = (type, category, data, message) => log(LogLevel.ERROR, type, category, data, message);

// ============================================
// SPECIFIC LOGGING FUNCTIONS
// ============================================

/**
 * Log video load event
 */
export const logVideoLoad = (player, videoId, videoTitle, trigger, extraData = {}) => {
    return logInfo(
        LogType.VIDEO_LOAD,
        LogCategory.VIDEO,
        { player, videoId, videoTitle, trigger, ...extraData },
        `${player} loaded video '${videoId}'${trigger ? ` via ${trigger}` : ''}`
    );
};

/**
 * Log video play event
 */
export const logVideoPlay = (player, videoId, trigger) => {
    return logInfo(
        LogType.VIDEO_PLAY,
        LogCategory.VIDEO,
        { player, videoId, trigger },
        `${player} started playing video '${videoId}'`
    );
};

/**
 * Log video end event
 */
export const logVideoEnd = (player, videoId, nextAction) => {
    return logInfo(
        LogType.VIDEO_END,
        LogCategory.VIDEO,
        { player, videoId, nextAction },
        `${player} video ended. Next: ${nextAction}`
    );
};

/**
 * Log video error event
 */
export const logVideoError = (player, videoId, errorCode, errorMessage, nextAction) => {
    return logError(
        LogType.VIDEO_ERROR,
        LogCategory.VIDEO,
        { player, videoId, errorCode, errorMessage, nextAction },
        `${player} error: ${errorMessage} (code ${errorCode})`
    );
};

/**
 * Get current video ID for a player from localStorage
 */
const getCurrentVideoId = (source) => {
    try {
        const storageKeyMap = {
            'Live Player': 'livePlayerState',
            'Delay Live': 'delayLivePlayerState',
            'Loop Player': 'loopPlayerState',
            'Local Player': 'localPCPlayerState'
        };
        const key = storageKeyMap[source];
        if (!key) return null;

        const saved = localStorage.getItem(key);
        if (!saved) return null;

        const parsed = JSON.parse(saved);
        // For Local Player, get current playlist item path
        if (source === 'Local Player' && parsed.playlist && parsed.playlist.length > 0) {
            const currentIdx = parsed.currentIndex || 0;
            return parsed.playlist[currentIdx]?.path?.split(/[\\/]/).pop() || null;
        }
        return parsed.videoId || null;
    } catch {
        return null;
    }
};

/**
 * Log source visibility change (includes current video ID)
 */
export const logSourceChange = (source, visible, trigger, previousSource = null) => {
    const type = visible ? LogType.SOURCE_VISIBLE : LogType.SOURCE_HIDDEN;
    const action = visible ? 'shown' : 'hidden';

    // Get current video ID for the source being shown
    const videoId = visible ? getCurrentVideoId(source) : null;

    const videoInfo = videoId ? ` [Video: ${videoId}]` : '';

    return logInfo(
        type,
        LogCategory.SOURCE,
        { source, visible, trigger, previousSource, videoId },
        `${source} ${action}${videoInfo}${previousSource ? ` (was: ${previousSource})` : ''}${trigger ? ` - ${trigger}` : ''}`
    );
};

/**
 * Log scheduler trigger
 */
export const logSchedulerTrigger = (scheduleId, scheduledTime, action, targetSource, title) => {
    return logInfo(
        LogType.SCHEDULER_TRIGGER,
        LogCategory.SCHEDULER,
        { scheduleId, scheduledTime, action, targetSource, title },
        `Schedule triggered: ${action} ${targetSource} at ${scheduledTime}${title ? ` - ${title}` : ''}`
    );
};

/**
 * Log scheduler skip (when a schedule is skipped due to conditions like Live Player active)
 */
export const logSchedulerSkip = (scheduleId, scheduledTime, action, targetSource, title, reason) => {
    return logInfo(
        LogType.SCHEDULER_SKIP,
        LogCategory.SCHEDULER,
        { scheduleId, scheduledTime, action, targetSource, title, reason },
        `Schedule skipped: ${action} ${targetSource} at ${scheduledTime}${title ? ` - ${title}` : ''} (Reason: ${reason})`
    );
};


/**
 * Log Katha content refresh (with deduplication)
 */
export const logKathaRefresh = (videosFound, dateFilter, trigger) => {
    // Create a unique key for this refresh result
    const refreshKey = `${videosFound}-${dateFilter}`;
    const now = Date.now();

    // Deduplicate - don't log same refresh result within 30 seconds
    if (lastLoggedState.lastKathaRefresh) {
        const { key, time } = lastLoggedState.lastKathaRefresh;
        if (key === refreshKey && (now - time) < 30000) {
            return Promise.resolve({ success: true, skipped: true });
        }
    }
    lastLoggedState.lastKathaRefresh = { key: refreshKey, time: now };

    return logInfo(
        LogType.KATHA_REFRESH,
        LogCategory.KATHA,
        { videosFound, dateFilter, trigger },
        `Katha content refreshed: ${videosFound} videos found for ${dateFilter}`
    );
};

/**
 * Log Katha video found (with deduplication)
 */
export const logKathaVideoFound = (videoId, videoTitle, manglaCharanTime, manglaCharanWord) => {
    // Deduplicate - don't log same video twice
    if (lastLoggedState.kathaVideoIds.has(videoId)) {
        return Promise.resolve({ success: true, skipped: true });
    }
    lastLoggedState.kathaVideoIds.add(videoId);

    return logInfo(
        LogType.KATHA_VIDEO_FOUND,
        LogCategory.KATHA,
        { videoId, videoTitle, manglaCharanTime, manglaCharanWord },
        `Katha found: "${videoTitle}" - ${manglaCharanWord}: ${manglaCharanTime}`
    );
};

/**
 * Log Katha loaded to player
 */
export const logKathaLoadPlayer = (videoId, videoTitle, manglaCharanTime, targetPlayer, trigger) => {
    return logInfo(
        LogType.KATHA_LOAD_PLAYER,
        LogCategory.KATHA,
        { videoId, videoTitle, manglaCharanTime, targetPlayer, trigger },
        `Katha loaded to ${targetPlayer}: "${videoTitle}" starting at ${manglaCharanTime}`
    );
};

/**
 * Log live monitor event (with deduplication)
 */
export const logLiveMonitorEvent = (monitorId, newVideoId, videoTitle, channelName) => {
    const stateKey = `monitor${monitorId}VideoId`;
    const previousVideoId = lastLoggedState[stateKey];

    // Deduplicate - don't log same video
    if (previousVideoId === newVideoId) {
        return Promise.resolve({ success: true, skipped: true });
    }
    lastLoggedState[stateKey] = newVideoId;

    return logInfo(
        LogType.LIVE_MONITOR_EVENT,
        LogCategory.MONITOR,
        { monitorId, previousVideoId, newVideoId, videoTitle, channelName },
        `Monitor ${monitorId}: New live event "${videoTitle}" from ${channelName}`
    );
};

/**
 * Log playlist action
 */
export const logPlaylistAction = (player, action, fromIndex, toIndex, videoId) => {
    return logInfo(
        LogType.PLAYLIST_ACTION,
        LogCategory.VIDEO,
        { player, action, fromIndex, toIndex, videoId },
        `${player} playlist: ${action} from #${fromIndex + 1} to #${toIndex + 1}`
    );
};

/**
 * Log OBS connection status
 */
export const logOBSConnection = (connected, address) => {
    const type = connected ? LogType.OBS_CONNECTED : LogType.OBS_DISCONNECTED;
    const message = connected ? `OBS connected to ${address}` : 'OBS disconnected';

    return logInfo(type, LogCategory.SYSTEM, { connected, address }, message);
};

// ============================================
// LOG RETRIEVAL FUNCTIONS
// ============================================

/**
 * Get logs from server
 */
export const getLogs = async (options = {}) => {
    const { month, category, type, search, limit = 50, offset = 0 } = options;

    const params = new URLSearchParams();
    if (month) params.append('month', month);
    if (category) params.append('category', category);
    if (type) params.append('type', type);
    if (search) params.append('search', search);
    params.append('limit', limit);
    params.append('offset', offset);

    try {
        const response = await fetch(`${API_BASE}/api/logs?${params}`);
        return await response.json();
    } catch (error) {
        console.error('Error fetching logs:', error);
        return { success: false, logs: [], total: 0 };
    }
};

/**
 * Get available log months
 */
export const getLogMonths = async () => {
    try {
        const response = await fetch(`${API_BASE}/api/logs/months`);
        return await response.json();
    } catch (error) {
        console.error('Error fetching log months:', error);
        return { success: false, months: [] };
    }
};

/**
 * Delete a specific log
 */
export const deleteLog = async (id, month) => {
    try {
        const params = month ? `?month=${month}` : '';
        const response = await fetch(`${API_BASE}/api/logs/${id}${params}`, { method: 'DELETE' });
        return await response.json();
    } catch (error) {
        console.error('Error deleting log:', error);
        return { success: false };
    }
};

/**
 * Clear all logs for a month
 */
export const clearLogs = async (month) => {
    try {
        const response = await fetch(`${API_BASE}/api/logs?month=${month}`, { method: 'DELETE' });
        return await response.json();
    } catch (error) {
        console.error('Error clearing logs:', error);
        return { success: false };
    }
};

/**
 * Reset deduplication state (useful for testing)
 */
export const resetDeduplicationState = () => {
    lastLoggedState.monitor1VideoId = null;
    lastLoggedState.monitor2VideoId = null;
    lastLoggedState.kathaVideoIds.clear();
};

export default {
    log,
    logInfo,
    logWarn,
    logError,
    logVideoLoad,
    logVideoPlay,
    logVideoEnd,
    logVideoError,
    logSourceChange,
    logSchedulerTrigger,
    logSchedulerSkip,
    logKathaRefresh,
    logKathaVideoFound,
    logKathaLoadPlayer,
    logLiveMonitorEvent,
    logPlaylistAction,
    logOBSConnection,
    getLogs,
    getLogMonths,
    deleteLog,
    clearLogs,
    LogLevel,
    LogCategory,
    LogType
};
