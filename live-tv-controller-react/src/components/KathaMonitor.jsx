import React, { useState, useEffect, useRef } from 'react';
import { copyToClipboard, formatDateToDDMMMYYYY } from '../utils/core-utils';
import { logKathaRefresh, logKathaVideoFound, logKathaLoadPlayer } from '../utils/logger';

const LOCAL_API_BASE = "http://localhost:3000";

async function fetchKathaVideoFullDescription(videoId) {
    try {
        const response = await fetch(
            `${LOCAL_API_BASE}/api/video-description?videoId=${encodeURIComponent(videoId)}`,
            { signal: AbortSignal.timeout(15000) }
        );
        if (!response.ok) throw new Error(`Local API HTTP ${response.status}`);
        const payload = await response.json();
        return payload.description || "";
    } catch (error) {
        console.error(`[Katha Monitor] Error fetching full description for ${videoId}:`, error);
        return `Error fetching description: ${error.message}`;
    }
}

function extractManglaCharanTimestamp(fullDescriptionText) {
    const timePattern = /(\d{1,2}:\d{2}(?::\d{2})?)/;
    const manglaCharanRegex = new RegExp(
        timePattern.source +
        "\\s*(?:manglacharan|mangalacharan|manglacharan|mangala\\s*charan|mangla\\s*charan|manglachhan|msnglachran|mangla\\s*chran|mnglacharan|mnglachharan)",
        "i"
    );
    const manglaMatch = fullDescriptionText.match(manglaCharanRegex);
    if (manglaMatch) return { time: manglaMatch[1], word: "Mangla Charan" };
    const kathaRegex = new RegExp(timePattern.source + "\\s*katha", "i");
    const kathaMatch = fullDescriptionText.match(kathaRegex);
    if (kathaMatch) return { time: kathaMatch[1], word: "katha" };
    return { time: '00:00:00', word: 'Not Found' };
}

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

// Pure local filter — zero API calls
function filterByMode(videos, mode) {
    const now = new Date();
    const todayStr = formatDateToDDMMMYYYY(now);
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = formatDateToDDMMMYYYY(yesterday);

    if (mode === 'today') return videos.filter(v => v.title?.includes(todayStr));
    if (mode === 'yesterday') return videos.filter(v => v.title?.includes(yesterdayStr));
    if (mode === 'auto') {
        const today = videos.filter(v => v.title?.includes(todayStr));
        return today.length > 0 ? today : videos.filter(v => v.title?.includes(yesterdayStr));
    }
    return videos; // 'all'
}

const KathaMonitor = () => {
    // allVideos: the full 30-video dataset fetched once from API (with descriptions)
    // displayVideos: locally-filtered subset shown to user — updated instantly on mode switch
    const [allVideos, setAllVideos] = useState([]);
    const [displayVideos, setDisplayVideos] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingToPlayer, setLoadingToPlayer] = useState(false);
    const [error, setError] = useState(null);
    const [statusText, setStatusText] = useState("Katha Monitor Ready");
    const [dateFilter, setDateFilter] = useState(() => localStorage.getItem('kathaLastFilter') || 'auto');
    const [fetchedAt, setFetchedAt] = useState(null);

    const [refreshSchedulerEnabled, setRefreshSchedulerEnabled] = useState(false);
    const [refreshSchedulerTime, setRefreshSchedulerTime] = useState("00:00");
    const [playerSchedulerEnabled, setPlayerSchedulerEnabled] = useState(false);
    const [playerSchedulerTime, setPlayerSchedulerTime] = useState("00:00");
    const [pendingTimeouts, setPendingTimeouts] = useState([]);

    const isInitialized = useRef(false);
    const fetchAllVideosRef = useRef(null);
    const loadToDelayPlayerRef = useRef(null);
    const wsRef = useRef(null);
    const wsReconnectRef = useRef(null);
    const wsReconnectDelayRef = useRef(3000);
    const WS_MAX_RECONNECT_DELAY = 30000;
    const WS_INITIAL_RECONNECT_DELAY = 3000;

    // Re-filter whenever allVideos or dateFilter changes — instant, zero API calls
    useEffect(() => {
        const filtered = filterByMode(allVideos, dateFilter);
        setDisplayVideos(filtered);

        if (allVideos.length === 0) return;

        const todayStr = formatDateToDDMMMYYYY(new Date());
        const minsAgo = fetchedAt ? Math.round((Date.now() - fetchedAt) / 60000) : 0;
        const agoStr = minsAgo === 0 ? 'just now' : `${minsAgo}m ago`;

        if (dateFilter === 'auto') {
            const isToday = filtered.some(v => v.title?.includes(todayStr));
            setStatusText(
                filtered.length === 0
                    ? 'No Katha videos found for today or yesterday.'
                    : `${filtered.length} video${filtered.length !== 1 ? 's' : ''} — ${isToday ? 'Today' : 'Yesterday'} (fetched ${agoStr})`
            );
        } else {
            const label = { today: 'Today', yesterday: 'Yesterday', all: 'All 30' }[dateFilter] || dateFilter;
            setStatusText(
                filtered.length === 0
                    ? `No videos for ${label}`
                    : `${filtered.length} video${filtered.length !== 1 ? 's' : ''} — ${label} (fetched ${agoStr})`
            );
        }
    }, [allVideos, dateFilter, fetchedAt]);

    // Fetch last 30 videos + all descriptions in parallel — called on mount and on Refresh
    const fetchAllVideos = async () => {
        setLoading(true);
        setError(null);
        setStatusText("Loading Katha videos...");

        try {
            const response = await fetch(`${LOCAL_API_BASE}/api/videos`, {
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) throw new Error(`Local API HTTP ${response.status}`);

            const payload = await response.json();
            const rawVideos = (payload.data || [])
                .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
                .slice(0, 30);

            setStatusText(`Fetching descriptions for ${rawVideos.length} videos...`);

            // Parallel description fetches — much faster than the old serial loop
            const processed = await Promise.all(rawVideos.map(async (video) => {
                const fullDescription = await fetchKathaVideoFullDescription(video.videoId);
                const manglaCharanTimestamp = fullDescription.startsWith("Error fetching description:")
                    ? { time: '00:00', word: 'Error' }
                    : extractManglaCharanTimestamp(fullDescription);
                return {
                    title: video.title || "No Title",
                    thumbnailUrl: video.thumbnail || "https://placehold.co/320x180/cccccc/333333?text=No+Image",
                    videoUrl: video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : "#",
                    videoId: video.videoId,
                    manglaCharanTimestamp,
                    publishedAt: video.publishedAt,
                };
            }));

            setFetchedAt(Date.now());
            setAllVideos(processed);

            logKathaRefresh(processed.length, 'all', 'fetch');
            for (const video of processed) {
                logKathaVideoFound(video.videoId, video.title, video.manglaCharanTimestamp?.time, video.manglaCharanTimestamp?.word);
            }
        } catch (err) {
            setError(`Failed to load Katha content: ${err.message}`);
            setStatusText(`Error: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    // WebSocket connection for scheduler triggers with exponential backoff
    useEffect(() => {
        const connectWebSocket = () => {
            if (wsReconnectRef.current) {
                clearTimeout(wsReconnectRef.current);
                wsReconnectRef.current = null;
            }

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            wsRef.current = new WebSocket(`${protocol}//${window.location.host}/ws`);

            wsRef.current.onopen = () => {
                wsReconnectDelayRef.current = WS_INITIAL_RECONNECT_DELAY;
            };

            wsRef.current.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.type === 'SCHEDULER_TRIGGER') {
                        const { action, source } = message.data;
                        if (action === 'katha_refresh' || source === 'Katha Refresh') {
                            // Re-fetch all 30 from API on scheduled refresh
                            fetchAllVideosRef.current?.();
                        } else if (action === 'katha_player' || source === 'Katha Player') {
                            loadToDelayPlayerRef.current?.();
                        }
                    }
                } catch {
                    // Ignore parse errors
                }
            };

            wsRef.current.onclose = () => {
                wsReconnectRef.current = setTimeout(connectWebSocket, wsReconnectDelayRef.current);
                wsReconnectDelayRef.current = Math.min(wsReconnectDelayRef.current * 1.5, WS_MAX_RECONNECT_DELAY);
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

    // Load Katha schedules and do the initial 30-video fetch on mount
    useEffect(() => {
        const loadSchedulesFromServer = async () => {
            try {
                const res = await fetch('/api/schedules');
                const data = await res.json();
                if (data.success && data.schedules) {
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
        fetchAllVideos();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const saveKathaSchedule = async (type, enabled, time) => {
        const scheduleData = {
            source: type === 'refresh' ? 'Katha Refresh' : 'Katha Player',
            action: type === 'refresh' ? 'katha_refresh' : 'katha_player',
            title: type === 'refresh' ? 'Refresh Katha Content' : 'Load Katha to Delay Player',
            time,
            enabled,
            recurrence: 'daily',
            skipIfLivePlaying: false
        };
        try {
            const res = await fetch('/api/schedules');
            const data = await res.json();
            const existing = data.schedules?.find(s => s.action === scheduleData.action);
            if (existing) {
                await fetch(`/api/schedules/${existing.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...existing, ...scheduleData })
                });
            } else {
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

    useEffect(() => {
        if (!isInitialized.current) return;
        saveKathaSchedule('refresh', refreshSchedulerEnabled, refreshSchedulerTime);
    }, [refreshSchedulerEnabled, refreshSchedulerTime]);

    useEffect(() => {
        if (!isInitialized.current) return;
        saveKathaSchedule('player', playerSchedulerEnabled, playerSchedulerTime);
    }, [playerSchedulerEnabled, playerSchedulerTime]);

    const [, forceUpdate] = useState(0);
    useEffect(() => {
        const fetchPendingTimeouts = async () => {
            try {
                const res = await fetch('/api/scheduler/status');
                const data = await res.json();
                if (data.nextTriggers) {
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

    // Load to Delay Player — filters from already-fetched allVideos, no API call
    const loadToDelayPlayer = async () => {
        setLoadingToPlayer(true);
        setStatusText("Attempting to load Katha to Delay Player...");
        try {
            const now = new Date();
            const todayStr = formatDateToDDMMMYYYY(now);
            const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
            const yesterdayStr = formatDateToDDMMMYYYY(yesterday);

            let kathaVideos = allVideos.filter(v => v.title?.includes(todayStr));
            let filter = "today";
            if (kathaVideos.length === 0) {
                kathaVideos = allVideos.filter(v => v.title?.includes(yesterdayStr));
                filter = "yesterday";
            }

            if (kathaVideos.length > 0) {
                const latestVideo = kathaVideos[0];
                const tsWord = latestVideo.manglaCharanTimestamp?.word || '';
                const startTime = (tsWord === 'Not Found' || tsWord.startsWith('Error'))
                    ? '00:00:00'
                    : latestVideo.manglaCharanTimestamp?.time;

                window.dispatchEvent(new CustomEvent('delayPlayerPrefill', {
                    detail: { videoId: latestVideo.videoId, startTime, endTime: "" }
                }));

                setStatusText(`Added "${latestVideo.title}" to Delay Player. Click Load in Delay Player to play.`);
                logKathaLoadPlayer(latestVideo.videoId, latestVideo.title, startTime, 'Delay Live', 'manual');
            } else {
                setStatusText(`No Katha videos found for today or yesterday. Try ↻ Refresh first.`);
            }
        } catch (err) {
            setStatusText(`Error loading Katha: ${err.message}`);
        } finally {
            setLoadingToPlayer(false);
        }
    };

    // Keep refs in sync so WS handler always calls the latest function versions
    useEffect(() => { fetchAllVideosRef.current = fetchAllVideos; });
    useEffect(() => { loadToDelayPlayerRef.current = loadToDelayPlayer; });

    // Card border: green for today, red for yesterday, blue for all
    const todayStr = formatDateToDDMMMYYYY(new Date());
    const cardBorderColor = dateFilter === 'all'
        ? 'border-blue-700'
        : displayVideos.some(v => v.title?.includes(todayStr))
            ? 'border-green-600'
            : 'border-red-600';

    return (
        <div className="player-control-card">
            <h3 className="live-monitor-card-h3">Katha Monitor</h3>

            {/* Filter row — local filtering only, zero API calls per click */}
            <div className="flex gap-1 mb-2 w-full">
                {[
                    { mode: 'auto', label: 'Auto' },
                    { mode: 'today', label: 'Today' },
                    { mode: 'yesterday', label: 'Yesterday' },
                    { mode: 'all', label: 'All' },
                ].map(({ mode, label }) => (
                    <button
                        key={mode}
                        type="button"
                        onClick={() => {
                            setDateFilter(mode);
                            localStorage.setItem('kathaLastFilter', mode);
                        }}
                        className={`flex-1 px-1 py-1 rounded text-xs font-medium transition-all ${
                            dateFilter === mode
                                ? 'bg-cyan-700 text-white'
                                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <div className="flex justify-center space-x-2 mb-2 w-full">
                <button
                    type="button"
                    className="common-btn-style btn-secondary flex-1"
                    onClick={fetchAllVideos}
                    disabled={loading}
                >
                    {loading ? "Loading..." : "↻ Refresh"}
                </button>
                <button
                    type="button"
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
                            const remaining = pt.nextTrigger.getTime() - Date.now();
                            return (
                                <div key={pt.id} className="flex justify-between items-center p-2 bg-gray-900 rounded border border-gray-700">
                                    <span className="text-white font-medium text-sm">{pt.title}</span>
                                    <div className="text-right">
                                        <div className="text-cyan-400 text-xs">
                                            {pt.nextTrigger.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}
                                        </div>
                                        <div className="text-yellow-400 text-xs">in {formatTimeRemaining(remaining)}</div>
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
                {!loading && !error && allVideos.length === 0 && (
                    <p className="text-center text-gray-600">No videos loaded — click ↻ Refresh to fetch.</p>
                )}
                {!loading && !error && allVideos.length > 0 && displayVideos.length === 0 && (
                    <p className="text-center text-gray-600">No videos found for this filter.</p>
                )}
                {displayVideos.map((video, index) => (
                    <div
                        key={video.videoId || index}
                        className={`katha-video-card border-[3px] ${cardBorderColor}`}
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
                                    {video.manglaCharanTimestamp?.word}: <span className="katha-timestamp">{video.manglaCharanTimestamp?.time}</span>
                                </p>
                                <div className="flex flex-wrap justify-center gap-2 mt-2">
                                    <button
                                        type="button"
                                        onClick={() => copyToClipboard(video.videoId)}
                                        className="katha-copy-btn"
                                    >
                                        Copy Video ID
                                    </button>
                                    {video.manglaCharanTimestamp?.word !== "Not Found" &&
                                        !video.manglaCharanTimestamp?.word?.startsWith("Error") && (
                                            <button
                                                type="button"
                                                onClick={() => copyToClipboard(video.manglaCharanTimestamp?.time)}
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
                            type="button"
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
                            type="button"
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
