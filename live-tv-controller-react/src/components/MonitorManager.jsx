
import React, { useEffect, useState, useRef, useCallback } from 'react';
import MonitorCard from './MonitorCard';
import UpcomingEventMonitor from './UpcomingEventMonitor';
import { logLiveMonitorEvent, logVideoLoad } from '../utils/logger';
import { useOBS } from '../context/OBSContext';

const LIVE_DETAILS_POLL_INTERVAL_MS = 30000;
const RETRY_DELAY_MS = 10000; // retry after 10s on failure
const LOCAL_API_BASE = "http://localhost:3000";
const LIVE_CHANNEL_SELECT_KEY = "liveSelectedChannelId";

const CHANNEL_OPTIONS = [
    { id: "UC7HQ3mzdsyvLU0Y7a2t3N7A", name: "Swaminarayan" },
    { id: "UCQXWP4gEdEwlb6vodwrU75A", name: "Swaminarayan Bhagwan" },
];

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
        channelName: video.channelName || 'Swaminarayan',
        channelUrl: video.channelUrl || 'https://www.youtube.com/channel/UC7HQ3mzdsyvLU0Y7a2t3N7A',
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

const MonitorManager = ({ monitor1Enabled, monitor2Enabled }) => {
    const { setSourceVisibility } = useOBS();
    const [monitor1Data, setMonitor1Data] = useState(null);
    const [monitor2Data, setMonitor2Data] = useState(null);
    const [upcomingEventData, setUpcomingEventData] = useState(null);
    const [error, setError] = useState(null);
    const [stale, setStale] = useState(false);
    const retryTimerRef = useRef(null);
    // Keep last known good data so UI never goes blank on transient failures
    const lastGoodData = useRef({ m1: null, m2: null, upcoming: null });
    const [selectedChannelId, setSelectedChannelId] = useState(
        () => localStorage.getItem(LIVE_CHANNEL_SELECT_KEY) || CHANNEL_OPTIONS[0].id
    );

    const handleChannelChange = useCallback((newId) => {
        setSelectedChannelId(newId);
        localStorage.setItem(LIVE_CHANNEL_SELECT_KEY, newId);
        lastAutoLoadedIdRef.current = null;
    }, []);

    // Use a ref for lastAutoLoadedId so it doesn't trigger effect re-runs
    const lastAutoLoadedIdRef = useRef(null);

    const fetchLiveVideoDetails = useCallback(async () => {
        if (!monitor1Enabled && !monitor2Enabled) {
            setMonitor1Data(null);
            setMonitor2Data(null);
            setUpcomingEventData(null);
            return;
        }

        try {
            setError(null);

            const response = await fetch(`${LOCAL_API_BASE}/api/live?channelId=${encodeURIComponent(selectedChannelId)}`, {
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) {
                throw new Error(`API error ${response.status}`);
            }

            const payload = await response.json();
            setStale(payload.stale === true);

            const liveEvents = (payload.live || [])
                .map((video) =>
                    normalizeLiveVideo(video, { isLive: true, isUpcoming: false })
                )
                .sort((a, b) => getEventStartMs(b) - getEventStartMs(a));
            const upcomingEvents = (payload.upcoming || []).map((video) =>
                normalizeLiveVideo(video, {
                    isLive: false,
                    isUpcoming: true,
                    startTime: video.scheduledStart ? new Date(video.scheduledStart) : null,
                })
            );

            upcomingEvents.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

            const liveEvent1 = liveEvents.length > 0 ? liveEvents[0] : null;
            const liveEvent2 = liveEvents.length > 1 ? liveEvents[1] : null;
            const nextUpcomingEvent = upcomingEvents.length > 0 ? upcomingEvents[0] : null;

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
                videoIdToAutoLoad = findMatchingVideoId(searchTerms1, liveEvents);
            }

            // Only auto-load if found a new video (different from current and last auto-loaded)
            if (
                videoIdToAutoLoad &&
                videoIdToAutoLoad !== currentLoadedId &&
                videoIdToAutoLoad !== lastAutoLoadedIdRef.current
            ) {
                console.log(`[MonitorManager] Auto-loading "${videoIdToAutoLoad}" (priority: ${livePlayerPriority})`);
                lastAutoLoadedIdRef.current = videoIdToAutoLoad;

                const videoTitle = liveEvents.find(e => e.videoId === videoIdToAutoLoad)?.title || 'Unknown';
                const channelName = liveEvents.find(e => e.videoId === videoIdToAutoLoad)?.channelName || 'Swaminarayan';
                logLiveMonitorEvent(1, videoIdToAutoLoad, videoTitle, channelName);
                logVideoLoad('Live Player', videoIdToAutoLoad, videoTitle, 'monitor_autoload');

                window.dispatchEvent(new CustomEvent('livePlayerAutoLoad', {
                    detail: { videoId: videoIdToAutoLoad }
                }));

                setSourceVisibility('Live Player', true);
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
            lastAutoLoadedIdRef.current = null;
        }
    }, [monitor1Enabled, monitor2Enabled, fetchLiveVideoDetails, selectedChannelId]);

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
                    channelOptions={CHANNEL_OPTIONS}
                    selectedChannelId={selectedChannelId}
                    onChannelChange={handleChannelChange}
                />
            </div>
            <div className="table-cell-wrapper"><MonitorCard id={2} title="Live Event Monitor 2" enabled={monitor2Enabled} data={monitor2Data} error={error} stale={stale} /></div>
            <div className="table-cell-wrapper"><UpcomingEventMonitor enabled={monitor1Enabled || monitor2Enabled} data={upcomingEventData} error={error} /></div>
        </>
    );
};

export default MonitorManager;
