
import React, { useEffect, useState, useRef, useCallback } from 'react';
import MonitorCard from './MonitorCard';
import UpcomingEventMonitor from './UpcomingEventMonitor';
import { logLiveMonitorEvent, logVideoLoad } from '../utils/logger';
import { notifyEvent } from '../utils/notify';
import { useOBS } from '../context/OBSContext';

const LIVE_DETAILS_POLL_INTERVAL_MS = 20000;
const RETRY_DELAY_MS = 10000; // retry after 10s on failure
const LOCAL_API_BASE = import.meta.env.VITE_LOCAL_API_BASE || "http://localhost:3000";

const toDate = (value) => {
    if (!value) return null;
    const epochMs = typeof value === 'number' && value < 9_999_999_999 ? value * 1000 : value;
    const date = new Date(epochMs);
    return Number.isNaN(date.getTime()) ? null : date;
};

const getEventStartMs = (event) => {
    const startDate = event.startTime || toDate(event.startedAt) || toDate(event.publishedAt);
    return startDate ? startDate.getTime() : 0;
};

const normalizeLiveVideo = (video, overrides = {}) => {
    const startTime = toDate(video.startedAt) || toDate(video.scheduledStart) || toDate(video.publishedAt);

    return {
        title: video.title || 'No Title',
        videoId: video.videoId,
        thumbnailUrl:
            video.thumbnail ||
            `https://placehold.co/320x180/cccccc/333333?text=No+Image`,
        channelName: video.channelName || '',
        channelUrl: video.channelUrl || '',
        isLive: Boolean(video.isLive),
        isUpcoming: Boolean(video.upcoming || video.isUpcoming),
        startedAt: video.startedAt || null,
        publishedAt: video.publishedAt || null,
        startTime,
        ...overrides,
    };
};

// Helper: Find video matching search terms
const findMatchingVideoId = (searchTermsText, liveEvents) => {
    if (!searchTermsText || liveEvents.length === 0) return null;
    const searchTerms = searchTermsText.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (searchTerms.length === 0) return null;

    for (const event of liveEvents) {
        const title = event.title?.toLowerCase() || '';
        for (const term of searchTerms) {
            if (title.includes(term)) {
                return event.videoId;
            }
        }
    }
    return null;
};

const MonitorManager = ({ monitor1Enabled, monitor2Enabled, channelOptions, selectedChannelId, onChannelChange }) => {
    const { setSourceVisibility, sourceState } = useOBS();
    // Ref so the guard inside fetchLiveVideoDetails always sees the latest sourceState
    // without adding sourceState to the useCallback deps (which would recreate the callback
    // every 1s from the OBS poll and destroy the 20s interval cadence).
    const sourceStateRef = useRef(sourceState);
    useEffect(() => { sourceStateRef.current = sourceState; }, [sourceState]);
    const [monitor1Data, setMonitor1Data] = useState(null);
    const [monitor2Data, setMonitor2Data] = useState(null);
    const [upcomingEventData, setUpcomingEventData] = useState(null);
    const [error, setError] = useState(null);
    const [stale, setStale] = useState(false);
    const retryTimerRef = useRef(null);
    // Keep last known good data so UI never goes blank on transient failures
    const lastGoodData = useRef({ m1: null, m2: null, upcoming: null });

    const fetchLiveVideoDetails = useCallback(async () => {
        if (!monitor1Enabled && !monitor2Enabled) {
            setMonitor1Data(null);
            setMonitor2Data(null);
            setUpcomingEventData(null);
            return;
        }
        if (!selectedChannelId) return; // no channel configured/selected yet

        try {
            setError(null);
            if (retryTimerRef.current) {
                clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }

            const response = await fetch(`${LOCAL_API_BASE}/api/live?channelId=${encodeURIComponent(selectedChannelId)}`, {
                signal: AbortSignal.timeout(15000),
                cache: 'no-store',
            });
            if (!response.ok) throw new Error(`API error ${response.status}`);
            const payload = await response.json();

            setStale(Boolean(payload?.stale));

            const toLiveEvents = (payload) => (payload?.live || [])
                .map((video) => normalizeLiveVideo(video, { isLive: true, isUpcoming: false }))
                .sort((a, b) => getEventStartMs(b) - getEventStartMs(a));
            const toUpcomingEvents = (payload) => (payload?.upcoming || []).map((video) =>
                normalizeLiveVideo(video, {
                    isLive: false,
                    isUpcoming: true,
                    startTime: video.scheduledStart ? new Date(video.scheduledStart) : null,
                })
            );

            // One channel feeds both monitors: Monitor 1 gets the most recent
            // live stream, Monitor 2 the next one — both from a single fetch.
            const combinedLiveEvents = toLiveEvents(payload);
            const combinedUpcoming = toUpcomingEvents(payload);
            const liveEvent1 = combinedLiveEvents[0] || null;
            const liveEvent2 = combinedLiveEvents[1] || null;

            combinedUpcoming.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
            const nextUpcomingEvent = combinedUpcoming.length > 0 ? combinedUpcoming[0] : null;

            // Save as last good data
            lastGoodData.current = { m1: liveEvent1, m2: liveEvent2, upcoming: nextUpcomingEvent };

            setMonitor1Data(liveEvent1);
            setMonitor2Data(liveEvent2);
            setUpcomingEventData(nextUpcomingEvent);

            // ── Auto-load logic ──────────────────────────────────────────────────
            const savedState = localStorage.getItem('livePlayerState');
            let livePlayerPriority = 'matchSearchTerms';
            let currentLoadedId = null;
            try {
                if (savedState) {
                    const parsed = JSON.parse(savedState);
                    livePlayerPriority = parsed.priority || 'matchSearchTerms';
                    currentLoadedId = parsed.videoId || null;
                }
            } catch { /* ignore */ }

            let videoIdToAutoLoad = null;

            if (livePlayerPriority === 'firstLive' && liveEvent1) {
                videoIdToAutoLoad = liveEvent1.videoId;
            } else if (livePlayerPriority === 'secondLive' && liveEvent2) {
                videoIdToAutoLoad = liveEvent2.videoId;
            } else if (livePlayerPriority === 'matchSearchTerms') {
                const searchTerms1 = localStorage.getItem('savedSearchTitles1') || '';
                const searchTerms2 = localStorage.getItem('savedSearchTitles2') || '';
                videoIdToAutoLoad =
                    findMatchingVideoId(searchTerms1, combinedLiveEvents) ||
                    findMatchingVideoId(searchTerms2, combinedLiveEvents);
            }

            // Auto-load whenever the match differs from what the Live Player actually
            // has loaded (read fresh from localStorage above) — this must NOT also be
            // gated on "have we already auto-loaded this id before", since the Live
            // Player can drift away from the match (manual override, restart, etc.)
            // while the matched id itself stays the same, and it needs to resync.
            if (videoIdToAutoLoad && videoIdToAutoLoad !== currentLoadedId) {
                const videoTitle = combinedLiveEvents.find(e => e.videoId === videoIdToAutoLoad)?.title || 'Unknown';
                const channelName = combinedLiveEvents.find(e => e.videoId === videoIdToAutoLoad)?.channelName || '';
                logLiveMonitorEvent(1, videoIdToAutoLoad, videoTitle, channelName);
                logVideoLoad('Live Player', videoIdToAutoLoad, videoTitle, 'monitor_autoload');

                window.dispatchEvent(new CustomEvent('livePlayerAutoLoad', {
                    detail: { videoId: videoIdToAutoLoad }
                }));

                // Skip redundant OBS command if Live Player is already visible.
                // Use the ref (not sourceState) so this guard never causes fetchLiveVideoDetails
                // to be recreated — adding sourceState to the callback's deps would reset the
                // 20-second interval every ~1s because the OBS poll updates sourceState every tick.
                if (!sourceStateRef.current["Live Player"]) {
                    // 'monitor' keeps the generic switch notification quiet here so the
                    // operator gets the MONITOR_LIVE one below instead — same event,
                    // but it can name the channel and the stream title.
                    setSourceVisibility('Live Player', true, 'monitor');
                }

                notifyEvent('MONITOR_LIVE', {
                    channelName: channelName || 'Monitored channel',
                    title: videoTitle,
                    videoId: videoIdToAutoLoad,
                });
            }

        } catch (err) {
            if (err.name === 'AbortError') return; // component unmounted, ignore
            console.warn('[MonitorManager] Fetch failed:', err.message);

            // Keep last known good data visible — do NOT wipe the UI
            if (lastGoodData.current.m1 !== undefined) {
                setMonitor1Data(lastGoodData.current.m1);
                setMonitor2Data(lastGoodData.current.m2);
                setUpcomingEventData(lastGoodData.current.upcoming);
            }
            setStale(true);
            setError(`Retrying... (${err.message})`);

            // Auto-retry after 10s (in addition to the normal poll interval)
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            retryTimerRef.current = setTimeout(() => {
                setError(null);
                fetchLiveVideoDetails();
            }, RETRY_DELAY_MS);
        }
    }, [monitor1Enabled, monitor2Enabled, setSourceVisibility, selectedChannelId]);

    useEffect(() => {
        if (monitor1Enabled || monitor2Enabled) {
            fetchLiveVideoDetails();
            const intervalId = setInterval(fetchLiveVideoDetails, LIVE_DETAILS_POLL_INTERVAL_MS);
            return () => clearInterval(intervalId);
        } else {
            setMonitor1Data(null);
            setMonitor2Data(null);
            setUpcomingEventData(null);
            setError(null);
        }
    }, [monitor1Enabled, monitor2Enabled, fetchLiveVideoDetails]);

    return (
        <>
            <div className="table-cell-wrapper">
                <MonitorCard
                    id={1}
                    title="Live Event Monitor 1"
                    enabled={monitor1Enabled}
                    data={monitor1Data}
                    error={error}
                    stale={stale}
                    channelOptions={channelOptions}
                    selectedChannelId={selectedChannelId}
                    onChannelChange={onChannelChange}
                />
            </div>
            <div className="table-cell-wrapper">
                <MonitorCard
                    id={2}
                    title="Live Event Monitor 2"
                    enabled={monitor2Enabled}
                    data={monitor2Data}
                    error={error}
                    stale={stale}
                />
            </div>
            <div className="table-cell-wrapper"><UpcomingEventMonitor enabled={monitor1Enabled || monitor2Enabled} data={upcomingEventData} error={error} /></div>
        </>
    );
};

export default MonitorManager;
