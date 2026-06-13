import React, { useState, useEffect, useRef } from 'react';
import { copyToClipboard, formatDateToDDMMMYYYY } from '../utils/core-utils';
import { logKathaRefresh, logKathaVideoFound, logKathaLoadPlayer } from '../utils/logger';

const LOCAL_API_BASE = "http://localhost:3000";
const KATHA_CHANNEL_ID = "UCQXWP4gEdEwlb6vodwrU75A";

// Fetch full video description
async function fetchKathaVideoFullDescription(videoId) {
    try {
        const response = await fetch(
            `${LOCAL_API_BASE}/api/video-description?videoId=${encodeURIComponent(videoId)}`,
            { signal: AbortSignal.timeout(15000) }
        );
        if (!response.ok) {
            throw new Error(`Local API HTTP ${response.status}`);
        }
        const payload = await response.json();
        return payload.description || "";
    } catch (error) {
        console.error(`[Katha Monitor] Error fetching full description for ${videoId}:`, error);
        return `Error fetching description: ${error.message}`;
    }
}

// Extract ManglaCharan timestamp from description
function extractManglaCharanTimestamp(fullDescriptionText) {
    const timePattern = /(\d{1,2}:\d{2}(?::\d{2})?)/;

    // Priority 1: Mangla Charan variations
    const manglaCharanRegex = new RegExp(
        timePattern.source +
        "\\s*(?:manglacharan|mangalacharan|manglacharan|mangala\\s*charan|mangla\\s*charan|manglachhan|msnglachran|mangla\\s*chran|mnglacharan|mnglachharan)",
        "i"
    );
    const manglaMatch = fullDescriptionText.match(manglaCharanRegex);
    if (manglaMatch) {
        return { time: manglaMatch[1], word: "Mangla Charan" };
    }

    // Priority 2: katha
    const kathaRegex = new RegExp(timePattern.source + "\\s*katha", "i");
    const kathaMatch = fullDescriptionText.match(kathaRegex);
    if (kathaMatch) {
        return { time: kathaMatch[1], word: "katha" };
    }

    return { time: '00:00:00', word: 'Not Found' };
}

/**
 * Format milliseconds to human readable time
 */
function formatTimeRemaining(ms) {
    if (ms < 0) return "Now";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

const KathaMonitor = () => {
    const [videos, setVideos] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingToPlayer, setLoadingToPlayer] = useState(false);
    const [error, setError] = useState(null);
    const [statusText, setStatusText] = useState("Katha Monitor Ready");
    const [dateFilter, setDateFilter] = useState("auto"); // auto | today | yesterday | week | all

    // Katha Schedulers
    const [refreshSchedulerEnabled, setRefreshSchedulerEnabled] = useState(false);
    const [refreshSchedulerTime, setRefreshSchedulerTime] = useState("00:00");
    const [playerSchedulerEnabled, setPlayerSchedulerEnabled] = useState(false);
    const [playerSchedulerTime, setPlayerSchedulerTime] = useState("00:00");

    // Pending Timeouts Display
    const [pendingTimeouts, setPendingTimeouts] = useState([]);

    const isInitialized = useRef(false);
    // Refs so WS handler always calls the latest version of these functions
    const loadKathaContentRef = useRef(null);
    const loadToDelayPlayerRef = useRef(null);
    // WebSocket connection for scheduler triggers (24/7 Reliability)
    const wsRef = useRef(null);
    const wsReconnectRef = useRef(null);
    const wsReconnectDelayRef = useRef(3000);
    const WS_MAX_RECONNECT_DELAY = 30000;
    const WS_INITIAL_RECONNECT_DELAY = 3000;

    // Connect to WebSocket for scheduler triggers with exponential backoff
    useEffect(() => {
        const connectWebSocket = () => {
            // Clear any pending reconnect timeout
            if (wsReconnectRef.current) {
                clearTimeout(wsReconnectRef.current);
                wsReconnectRef.current = null;
            }

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws`;

            wsRef.current = new WebSocket(wsUrl);

            wsRef.current.onopen = () => {
                // Reset reconnect delay on successful connection
                wsReconnectDelayRef.current = WS_INITIAL_RECONNECT_DELAY;
            };

            wsRef.current.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);

                    // Use refs so handler always calls the latest function (avoids stale closure)
                    if (message.type === 'SCHEDULER_TRIGGER') {
                        const { action, source } = message.data;
                        if (action === 'katha_refresh' || source === 'Katha Refresh') {
                            loadKathaContentRef.current?.();
                        } else if (action === 'katha_player' || source === 'Katha Player') {
                            loadToDelayPlayerRef.current?.();
                        }
                    }
                } catch {
                    // Ignore parse errors
                }
            };

            wsRef.current.onclose = () => {

                // Schedule reconnect with exponential backoff
                wsReconnectRef.current = setTimeout(() => {
                    connectWebSocket();
                }, wsReconnectDelayRef.current);

                // Increase delay for next time (exponential backoff)
                wsReconnectDelayRef.current = Math.min(
                    wsReconnectDelayRef.current * 1.5,
                    WS_MAX_RECONNECT_DELAY
                );
            };

            wsRef.current.onerror = (err) => {
                console.error('[KathaMonitor] WebSocket error:', err);
            };
        };

        connectWebSocket();

        return () => {
            if (wsRef.current) wsRef.current.close();
            if (wsReconnectRef.current) clearTimeout(wsReconnectRef.current);
        };
    }, []);

    // Load Katha schedules from server on mount
    useEffect(() => {
        const loadSchedulesFromServer = async () => {
            try {
                const res = await fetch('/api/schedules');
                const data = await res.json();

                if (data.success && data.schedules) {
                    // Find Katha schedules
                    const kathaRefresh = data.schedules.find(s => s.action === 'katha_refresh');
                    const kathaPlayer = data.schedules.find(s => s.action === 'katha_player');

                    if (kathaRefresh) {
                        setRefreshSchedulerEnabled(kathaRefresh.enabled);
                        setRefreshSchedulerTime(kathaRefresh.time);
                    }
                    if (kathaPlayer) {
                        setPlayerSchedulerEnabled(kathaPlayer.enabled);
                        setPlayerSchedulerTime(kathaPlayer.time);
                    }
                }

                isInitialized.current = true;
            } catch (e) {
                console.error('[KathaMonitor] Error loading schedules:', e);
                isInitialized.current = true;
            }
        };

        loadSchedulesFromServer();
        loadKathaContent();
    }, []);

    // Save scheduler state to server when changed
    const saveKathaSchedule = async (type, enabled, time) => {
        const scheduleData = {
            source: type === 'refresh' ? 'Katha Refresh' : 'Katha Player',
            action: type === 'refresh' ? 'katha_refresh' : 'katha_player',
            title: type === 'refresh' ? 'Refresh Katha Content' : 'Load Katha to Delay Player',
            time: time,
            enabled: enabled,
            recurrence: 'daily',
            skipIfLivePlaying: false
        };

        try {
            // Check if schedule already exists
            const res = await fetch('/api/schedules');
            const data = await res.json();
            const existing = data.schedules?.find(s => s.action === scheduleData.action);

            if (existing) {
                // Update existing
                await fetch(`/api/schedules/${existing.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...existing, ...scheduleData })
                });
            } else {
                // Create new
                await fetch('/api/schedules', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(scheduleData)
                });
            }
        } catch (e) {
            console.error(`[KathaMonitor] Error saving ${type} schedule:`, e);
        }
    };

    // Update server when refresh scheduler changes
    useEffect(() => {
        if (!isInitialized.current) return;
        saveKathaSchedule('refresh', refreshSchedulerEnabled, refreshSchedulerTime);
    }, [refreshSchedulerEnabled, refreshSchedulerTime]);

    // Update server when player scheduler changes
    useEffect(() => {
        if (!isInitialized.current) return;
        saveKathaSchedule('player', playerSchedulerEnabled, playerSchedulerTime);
    }, [playerSchedulerEnabled, playerSchedulerTime]);

    // Update display every 5 seconds (fetch pending timeouts from server)
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        const fetchPendingTimeouts = async () => {
            try {
                const res = await fetch('/api/scheduler/status');
                const data = await res.json();

                if (data.nextTriggers) {
                    // Filter to only show Katha-related triggers
                    const kathaTimeouts = data.nextTriggers
                        .filter(t => t.action === 'katha_refresh' || t.action === 'katha_player')
                        .map(t => ({
                            id: t.action,
                            title: t.title || t.source,
                            nextTrigger: new Date(t.nextTrigger),
                            delay: t.delay
                        }));
                    setPendingTimeouts(kathaTimeouts);
                }
            } catch {
                // Ignore errors
            }
            forceUpdate(n => n + 1);
        };

        fetchPendingTimeouts();
        const displayInterval = setInterval(fetchPendingTimeouts, 5000);
        return () => clearInterval(displayInterval);
    }, []);

    // Fetch Katha channel content
    // Returns videos filtered by the given mode
    // mode: "today" | "yesterday" | "week" | "all"
    const getKathaChannelContent = async (mode) => {
        const response = await fetch(`${LOCAL_API_BASE}/api/videos`, {
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Local API HTTP ${response.status}`);

        const payload = await response.json();
        // API already returns only Katha channel — sort newest first
        const rawVideoItems = (payload.data || [])
            .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

        const now = new Date();
        const todayStr = formatDateToDDMMMYYYY(now);
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        const yesterdayStr = formatDateToDDMMMYYYY(yesterday);
        const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);

        const videoMatchesMode = (video) => {
            if (mode === 'all') return true;
            const publishedDate = video.publishedAt ? new Date(video.publishedAt) : null;
            const pubStr = publishedDate && !isNaN(publishedDate) ? formatDateToDDMMMYYYY(publishedDate) : null;
            const title = video.title || '';

            if (mode === 'today')
                return title.includes(todayStr) || pubStr === todayStr;
            if (mode === 'yesterday')
                return title.includes(yesterdayStr) || pubStr === yesterdayStr;
            if (mode === 'week')
                return !publishedDate || publishedDate >= weekAgo;
            return false;
        };

        const matched = rawVideoItems.filter(videoMatchesMode);
        const processedData = [];

        for (const video of matched) {
            const videoId = video.videoId;
            let manglaCharanTimestamp = { time: '00:00', word: "Fetching..." };

            const fullDescription = await fetchKathaVideoFullDescription(videoId);
            if (fullDescription.startsWith("Error fetching description:")) {
                manglaCharanTimestamp = { time: '00:00', word: 'Error' };
            } else {
                manglaCharanTimestamp = extractManglaCharanTimestamp(fullDescription);
            }

            processedData.push({
                title: video.title || "No Title",
                thumbnailUrl: video.thumbnail || "https://placehold.co/320x180/cccccc/333333?text=No+Image",
                videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "#",
                videoId,
                manglaCharanTimestamp,
                publishedAt: video.publishedAt,
            });
        }

        return processedData;
    };

    const loadKathaContent = async (modeOverride) => {
        setLoading(true);
        setError(null);
        setStatusText("Refreshing Katha content list...");

        try {
            const requestedMode = modeOverride || dateFilter;
            let resolvedMode = requestedMode;
            let content = [];

            if (requestedMode === 'auto') {
                // Auto: try today first, fall back to yesterday
                content = await getKathaChannelContent('today');
                resolvedMode = 'today';
                if (content.length === 0) {
                    content = await getKathaChannelContent('yesterday');
                    resolvedMode = 'yesterday';
                }
            } else {
                content = await getKathaChannelContent(requestedMode);
                resolvedMode = requestedMode;
            }

            setVideos(content);
            const label = { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', all: 'All' }[resolvedMode] || resolvedMode;
            setStatusText(`Showing ${content.length} video${content.length !== 1 ? 's' : ''} — ${label}`);

            logKathaRefresh(content.length, resolvedMode, 'manual');
            for (const video of content) {
                logKathaVideoFound(video.videoId, video.title, video.manglaCharanTimestamp?.time, video.manglaCharanTimestamp?.word);
            }
        } catch (err) {
            setError(`Failed to load Katha content: ${err.message}`);
            setStatusText(`Error: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const loadToDelayPlayer = async () => {
        setLoadingToPlayer(true);
        setStatusText("Attempting to load Katha to Delay Player...");

        try {
            let filter = "today";
            let kathaVideos = await getKathaChannelContent(filter);

            if (kathaVideos.length === 0) {
                filter = "yesterday";
                kathaVideos = await getKathaChannelContent(filter);
            }

            if (kathaVideos.length > 0) {
                const latestVideo = kathaVideos[0];
                const videoId = latestVideo.videoId;
                const tsWord = latestVideo.manglaCharanTimestamp.word || '';
                let startTime = (tsWord === 'Not Found' || tsWord.startsWith('Error'))
                    ? '00:00:00'
                    : latestVideo.manglaCharanTimestamp.time;

                // Dispatch custom event to DelayPlayerCard (works in same tab)
                const prefillData = {
                    videoId: videoId,
                    startTime: startTime,
                    endTime: ""
                };
                window.dispatchEvent(new CustomEvent('delayPlayerPrefill', { detail: prefillData }));

                setStatusText(`Added "${latestVideo.title}" to Delay Player. Click Load in Delay Player to play.`);

                // Log the load to player
                logKathaLoadPlayer(videoId, latestVideo.title, startTime, 'Delay Live', 'manual');
            } else {
                setStatusText(`No Katha videos found for ${filter}.`);
            }
        } catch (err) {
            setStatusText(`Error loading Katha: ${err.message}`);
        } finally {
            setLoadingToPlayer(false);
        }
    };

    // Keep refs in sync so WS handler always calls the latest function versions
    useEffect(() => { loadKathaContentRef.current = loadKathaContent; });
    useEffect(() => { loadToDelayPlayerRef.current = loadToDelayPlayer; });

    return (
        <div className="player-control-card">
            <h3 className="live-monitor-card-h3">Katha Monitor</h3>

            {/* Filter row */}
            <div className="flex gap-1 mb-2 w-full">
                {['auto', 'today', 'yesterday', 'week', 'all'].map(mode => (
                    <button
                        key={mode}
                        onClick={() => {
                            setDateFilter(mode);
                            loadKathaContent(mode);
                        }}
                        className={`flex-1 px-1 py-1 rounded text-xs font-medium transition-all capitalize ${
                            dateFilter === mode
                                ? 'bg-cyan-700 text-white'
                                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                        }`}
                    >
                        {mode === 'auto' ? 'Auto' : mode === 'week' ? '7d' : mode === 'all' ? 'All' : mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                ))}
            </div>

            <div className="flex justify-center space-x-2 mb-2 w-full">
                <button
                    className="common-btn-style btn-secondary flex-1"
                    onClick={() => loadKathaContent()}
                    disabled={loading}
                >
                    {loading ? "Loading..." : "Refresh"}
                </button>
                <button
                    className={`common-btn-style btn-primary flex-1${loadingToPlayer ? ' btn-loading' : ''}`}
                    onClick={loadToDelayPlayer}
                    disabled={loadingToPlayer}
                >
                    {loadingToPlayer
                        ? <><span className="btn-spinner" /> Loading...</>
                        : 'Load to Player'
                    }
                </button>
            </div>

            <p className="player-status text-center mb-4">{statusText}</p>

            {/* Pending Timeouts Display */}
            {pendingTimeouts.length > 0 && (
                <div className="pending-timeouts-card mb-4 p-3 bg-gray-800 rounded-lg w-full border border-cyan-600">
                    <h4 className="text-sm font-semibold text-cyan-400 mb-2">
                        ⏰ Pending Katha Schedules ({pendingTimeouts.length})
                    </h4>
                    <div className="grid gap-2">
                        {pendingTimeouts.map((pt) => {
                            const now = new Date();
                            const remaining = pt.nextTrigger.getTime() - now.getTime();
                            return (
                                <div
                                    key={pt.id}
                                    className="flex justify-between items-center p-2 bg-gray-900 rounded border border-gray-700"
                                >
                                    <span className="text-white font-medium text-sm">
                                        {pt.title}
                                    </span>
                                    <div className="text-right">
                                        <div className="text-cyan-400 text-xs">
                                            {pt.nextTrigger.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}
                                        </div>
                                        <div className="text-yellow-400 text-xs">
                                            in {formatTimeRemaining(remaining)}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {loading && (
                <div className="flex flex-col justify-center items-center py-4 w-full">
                    <div className="katha-loading-spinner"></div>
                    <p className="mt-2 text-sm text-gray-400">Loading Katha content...</p>
                </div>
            )}

            {error && (
                <div className="katha-error-message w-full" role="alert">
                    <strong className="font-bold">Error!</strong>
                    <span className="block sm:inline"> {error}</span>
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 w-full mb-4">
                {!loading && !error && videos.length === 0 && (
                    <p className="text-center text-gray-600">No videos found — try a different filter or click Refresh.</p>
                )}
                {videos.map((video, index) => (
                    <div
                        key={video.videoId || index}
                        className={`katha-video-card border-[3px] ${dateFilter === "today" ? "border-green-600" : "border-red-600"}`}
                    >
                        <a href={video.videoUrl} target="_blank" rel="noopener noreferrer">
                            <img src={video.thumbnailUrl} alt={video.title} className="katha-video-thumbnail" />
                        </a>
                        <div className="p-3 flex-grow flex flex-col justify-between">
                            <h4 className="katha-video-title">
                                <a href={video.videoUrl} target="_blank" rel="noopener noreferrer" className="hover:text-blue-400">
                                    {video.title}
                                </a>
                            </h4>
                            <div className="mt-2 text-sm">
                                <p className="katha-video-info">
                                    {video.manglaCharanTimestamp.word}: <span className="katha-timestamp">{video.manglaCharanTimestamp.time}</span>
                                </p>
                                <div className="flex flex-wrap justify-center gap-2 mt-2">
                                    <button
                                        onClick={() => copyToClipboard(video.videoId)}
                                        className="katha-copy-btn"
                                    >
                                        Copy Video ID
                                    </button>
                                    {video.manglaCharanTimestamp?.word !== "Not Found" &&
                                        !video.manglaCharanTimestamp?.word?.startsWith("Error") && (
                                            <button
                                                onClick={() => copyToClipboard(video.manglaCharanTimestamp.time)}
                                                className="katha-copy-btn bg-purple-600 hover:bg-purple-700"
                                            >
                                                Copy Timestamp
                                            </button>
                                        )}
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Katha Schedulers Section */}
            <div className="w-full border-t border-gray-700 pt-4 mt-4">
                <h4 className="text-lg font-semibold text-cyan-400 text-center mb-3">
                    Katha Schedulers
                </h4>

                <div className="scheduler-item">
                    <label htmlFor="refreshScheduleTime" className="scheduler-label">
                        Refresh Content List:
                    </label>
                    <div className="scheduler-controls">
                        <input
                            type="time"
                            id="refreshScheduleTime"
                            className="input-field scheduler-time-input"
                            value={refreshSchedulerTime}
                            onChange={(e) => setRefreshSchedulerTime(e.target.value)}
                        />
                        <button
                            className={`common-btn-style btn-primary flex-1 ${refreshSchedulerEnabled ? "on-scheduler" : "off-scheduler"}`}
                            onClick={() => setRefreshSchedulerEnabled(!refreshSchedulerEnabled)}
                        >
                            {refreshSchedulerEnabled ? "On" : "Off"}
                        </button>
                    </div>
                </div>

                <div className="scheduler-item">
                    <label htmlFor="playerScheduleTime" className="scheduler-label">
                        Load to Delay Player:
                    </label>
                    <div className="scheduler-controls">
                        <input
                            type="time"
                            id="playerScheduleTime"
                            className="input-field scheduler-time-input"
                            value={playerSchedulerTime}
                            onChange={(e) => setPlayerSchedulerTime(e.target.value)}
                        />
                        <button
                            className={`common-btn-style btn-primary flex-1 ${playerSchedulerEnabled ? "on-scheduler" : "off-scheduler"}`}
                            onClick={() => setPlayerSchedulerEnabled(!playerSchedulerEnabled)}
                        >
                            {playerSchedulerEnabled ? "On" : "Off"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default KathaMonitor;
