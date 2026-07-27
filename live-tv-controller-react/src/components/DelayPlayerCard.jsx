
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, timeToSeconds, secondsToHMS, DELAY_PLAYER_EVENT_KEY } from '../utils/core-utils';
import { usePlayerTime, usePlayerEvents } from '../utils/usePlayerHooks';
import { LOOP_AUTOMATION_LOCAL_KEY } from './LoopPlaylistAutomation';
import { useVideoInfo } from '../hooks/useVideoInfo';
import { logVideoLoad, logVideoPlay } from '../utils/logger';
import { setStateValue } from '../utils/state-api';
import PlayerControlBtn from './common/PlayerControlBtn';
import ThumbnailLoader from './common/ThumbnailLoader';

const LOCAL_API_BASE = import.meta.env.VITE_LOCAL_API_BASE || "http://localhost:3000";

async function fetchVideoDescription(videoId) {
    const response = await fetch(
        `${LOCAL_API_BASE}/api/video-description?videoId=${encodeURIComponent(videoId)}`,
        { signal: AbortSignal.timeout(15000), cache: 'no-store' }
    );
    if (!response.ok) throw new Error(`API HTTP ${response.status}`);
    const payload = await response.json();
    return payload.description || "";
}

// Finds the sections to skip, one per keyword: each section runs from the
// timestamp on the keyword's description line to the next timestamp in the
// description (end = null when the keyword is the last timestamp → finish there).
// Handles both "12:34 Keyword" and "Keyword 12:34" orderings.
// Overlapping/touching sections are merged so the player gets a clean sorted list.
function findKeywordSkipRanges(description, keywords) {
    const result = { ranges: [], notFound: [] };
    if (!description || keywords.length === 0) return result;
    const timePattern = /\d{1,2}:\d{2}(?::\d{2})?/;
    const stampLines = [];
    for (const line of description.split('\n')) {
        const timeMatch = line.match(timePattern);
        if (!timeMatch) continue;
        const seconds = timeToSeconds(timeMatch[0]);
        if (seconds === null) continue;
        stampLines.push({ seconds, lower: line.toLowerCase() });
    }
    const allStamps = stampLines.map(s => s.seconds);
    for (const keyword of keywords) {
        const lowerKeyword = keyword.toLowerCase();
        const hit = stampLines.find(s => s.lower.includes(lowerKeyword));
        if (!hit) {
            result.notFound.push(keyword);
            continue;
        }
        const later = allStamps.filter(s => s > hit.seconds);
        result.ranges.push({ start: hit.seconds, end: later.length > 0 ? Math.min(...later) : null });
    }
    result.ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of result.ranges) {
        const prev = merged[merged.length - 1];
        if (prev && (prev.end === null || range.start <= prev.end)) {
            if (prev.end !== null) {
                prev.end = range.end === null ? null : Math.max(prev.end, range.end);
            }
        } else {
            merged.push({ ...range });
        }
    }
    result.ranges = merged;
    return result;
}

const DelayPlayerCard = () => {
    const { sourceState, setSourceVisibility } = useOBS();
    const isVisible = sourceState["Delay Live"];
    const isInitialized = useRef(false);
    const hasUserData = useRef(false); // Track if we have actual user data to save

    const [videoId, setVideoId] = useState("");
    const [startTime, setStartTime] = useState("");
    const [endTime, setEndTime] = useState("");
    const videoIdRef = useRef(videoId);
    const startTimeRef = useRef(startTime);
    const endTimeRef = useRef(endTime);
    useEffect(() => { videoIdRef.current = videoId; }, [videoId]);
    useEffect(() => { startTimeRef.current = startTime; }, [startTime]);
    useEffect(() => { endTimeRef.current = endTime; }, [endTime]);

    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);
    const [loadingAction, setLoadingAction] = useState(false);

    const [keywordSkipEnabled, setKeywordSkipEnabled] = useState(false);
    const [skipKeyword, setSkipKeyword] = useState("");

    // "On Finish, Start Group" — when this video ends, automatically start the picked Loop
    // Playlist Automation Group (see LoopPlaylistAutomation.jsx's loopAutomationStartGroup
    // listener). Blank = do nothing, current behavior unchanged.
    const [endGroupId, setEndGroupId] = useState("");
    const endGroupIdRef = useRef(endGroupId);
    useEffect(() => { endGroupIdRef.current = endGroupId; }, [endGroupId]);
    const [automationGroups, setAutomationGroups] = useState([]);
    useEffect(() => {
        const loadGroups = () => {
            try {
                const saved = localStorage.getItem(LOOP_AUTOMATION_LOCAL_KEY);
                const parsed = saved ? JSON.parse(saved) : [];
                setAutomationGroups(Array.isArray(parsed) ? parsed : []);
            } catch { setAutomationGroups([]); }
        };
        loadGroups();
        const onStorage = (e) => { if (e.key === LOOP_AUTOMATION_LOCAL_KEY) loadGroups(); };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const { title: videoTitle, thumbnail: videoThumbnail, loading: thumbLoading } = useVideoInfo(videoId);
    const [statusText, setStatusText] = useState("Not loaded");

    // Use custom hook for time updates
    const timeInfo = usePlayerTime(DELAY_PLAYER_EVENT_KEY, 'delay');

    // Load saved state on mount
    useEffect(() => {
        const saved = localStorage.getItem('delayPlayerState');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (parsed.videoId) {
                    setVideoId(parsed.videoId);
                    setStartTime(parsed.startTime || "");
                    setEndTime(parsed.endTime || "");
                    setIsPlaying(parsed.isPlaying ?? true);
                    setIsMuted(parsed.isMuted ?? false);
                    setIsStopped(parsed.isStopped ?? false);
                    setKeywordSkipEnabled(parsed.keywordSkipEnabled ?? false);
                    setSkipKeyword(parsed.skipKeyword || "");
                    setEndGroupId(parsed.endGroupId || "");
                    hasUserData.current = true; // Mark that we have valid user data
                }
            } catch (e) { }
        }
        // Mark initialized after React state settles, then sync loaded state to server
        setTimeout(() => {
            isInitialized.current = true;
            flushStateRef.current?.();
        }, 50);
    }, []);

    // Listen for prefill data from KathaMonitor (custom event for same-tab communication)
    useEffect(() => {
        const handlePrefill = (e) => {
            const prefillData = e.detail;
            if (prefillData.videoId) {
                setVideoId(prefillData.videoId);
                hasUserData.current = true; // KathaMonitor prefill counts as user data
            }
            if (prefillData.startTime) {
                setStartTime(prefillData.startTime);
            }
            if (prefillData.endTime !== undefined) {
                setEndTime(prefillData.endTime || "");
            }
            setStatusText("Video loaded from Katha Monitor. Click Load to play.");
        };

        window.addEventListener('delayPlayerPrefill', handlePrefill);
        return () => window.removeEventListener('delayPlayerPrefill', handlePrefill);
    }, []);

    // Save state on change (only when we have actual user data)
    useEffect(() => {
        if (!isInitialized.current) return;
        if (!hasUserData.current && !videoId) return; // Don't save empty initial state

        // Mark that we have user data if videoId is not empty
        if (videoId) {
            hasUserData.current = true;
        }

        const state = { videoId, startTime, endTime, isPlaying, isMuted, isStopped, keywordSkipEnabled, skipKeyword, endGroupId };
        localStorage.setItem('delayPlayerState', JSON.stringify(state));
        setStateValue('player.delay', state);
    }, [videoId, startTime, endTime, isPlaying, isMuted, isStopped, keywordSkipEnabled, skipKeyword, endGroupId]);

    // Always-current ref to flush current state on demand (pre-backup / pre-export)
    const flushStateRef = useRef(null);
    useEffect(() => {
        flushStateRef.current = () => {
            if (!isInitialized.current) return;
            if (!hasUserData.current && !videoId) return;
            const state = { videoId, startTime, endTime, isPlaying, isMuted, isStopped, keywordSkipEnabled, skipKeyword, endGroupId };
            localStorage.setItem('delayPlayerState', JSON.stringify(state));
            setStateValue('player.delay', state);
        };
    });

    useEffect(() => {
        const handler = () => flushStateRef.current?.();
        window.addEventListener('flushPlayerState', handler);
        return () => window.removeEventListener('flushPlayerState', handler);
    }, []);

    // Track mount time to prevent visibility commands on initial mount
    const mountTime = useRef(Date.now());
    const prevIsVisible = useRef(undefined);

    // React to OBS visibility CHANGES only (not initial mount)
    useEffect(() => {
        // Guard: Ignore any visibility effects within 500ms of mount
        const timeSinceMount = Date.now() - mountTime.current;
        if (timeSinceMount < 500) {
            prevIsVisible.current = isVisible;
            return;
        }

        if (prevIsVisible.current === undefined) {
            prevIsVisible.current = isVisible;
            return;
        }

        if (prevIsVisible.current === isVisible) {
            return;
        }

        prevIsVisible.current = isVisible;

        if (isVisible) {
            resumePlayback();
            setStatusText("Delay Player Active");
        } else {
            sendPlayerCommand('delayLivePlayerCommand', 'pause');
            setIsPlaying(false);
            setIsStopped(false);
            setStatusText("Delay Player Paused");
        }
    }, [isVisible]);

    // Refs so the videoEnded handler below always sees the latest OBS state/setter without
    // being recreated on every OBS poll tick (same pattern as LocalPlayerCard/MonitorManager).
    const sourceStateRef = useRef(sourceState);
    useEffect(() => { sourceStateRef.current = sourceState; }, [sourceState]);
    const setSourceVisibilityRef = useRef(setSourceVisibility);
    useEffect(() => { setSourceVisibilityRef.current = setSourceVisibility; }, [setSourceVisibility]);

    // When the delayed video finishes, hand off to Loop Player (mirrors Local Player's
    // end-of-playlist scene switch) and tell the automation engine which Group to start,
    // if one was picked below. Blank selection = no-op, same as before this feature existed.
    const handleDelayVideoEnded = useCallback(() => {
        const groupId = endGroupIdRef.current;
        if (!groupId) return;
        const setSrcVis = setSourceVisibilityRef.current ?? setSourceVisibility;
        if (sourceStateRef.current["Live Player"]) setSrcVis("Live Player", false);
        setSrcVis("Loop Player", true);
        setStatusText("Finished — switched to Loop Player");
        window.dispatchEvent(new CustomEvent('loopAutomationStartGroup', {
            detail: { groupId, label: 'Delay Player finished' },
        }));
    }, [setSourceVisibility]);
    usePlayerEvents(DELAY_PLAYER_EVENT_KEY, 'delay', handleDelayVideoEnded);

    // Resume playback of existing video without modifying state
    const resumePlayback = () => {
        const vid = videoIdRef.current;
        if (vid) {
            const startSeconds = startTimeRef.current ? timeToSeconds(startTimeRef.current) : 0;
            const endSeconds = endTimeRef.current ? timeToSeconds(endTimeRef.current) : null;
            sendPlayerCommand('delayLivePlayerCommand', 'loadVideo', vid, startSeconds, endSeconds);
            // loadVideo resets the player's skip sections — re-send them for this video
            if (skipRangeRef.current && skipRangeRef.current.videoId === vid) {
                sendSkipRanges(skipRangeRef.current);
            }
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
        }
    };

    // Skip sections computed from the description — sent to the player after load.
    // Kept in a ref so resumePlayback can re-send them when the source becomes visible.
    const skipRangeRef = useRef(null); // { videoId, ranges: [{ start, end }] }

    const sendSkipRanges = (entry) => {
        sendPlayerCommand('delayLivePlayerCommand', 'setSkipRanges', null, null, null, null, {
            skipRanges: entry.ranges,
        });
    };

    // Fetch description in the background and tell the player which sections to skip.
    // Never delays or changes the normal load — video starts from Start Time as always.
    const applyKeywordSkip = async (vid, playerIsVisible) => {
        const keywords = skipKeyword.split(',').map(k => k.trim()).filter(Boolean);
        try {
            const description = await fetchVideoDescription(vid);
            const { ranges, notFound } = findKeywordSkipRanges(description, keywords);
            if (ranges.length === 0) {
                skipRangeRef.current = null;
                setStatusText(`Keyword${keywords.length > 1 ? 's' : ''} "${keywords.join(', ')}" not found in description — playing full video.`);
                return;
            }
            skipRangeRef.current = { videoId: vid, ranges };
            if (playerIsVisible) {
                sendSkipRanges(skipRangeRef.current);
            }
            const parts = ranges.map(r =>
                r.end === null
                    ? `${secondsToHMS(r.start)} → finish`
                    : `${secondsToHMS(r.start)} → ${secondsToHMS(r.end)}`
            );
            let msg = `Playing. Will skip ${parts.join(', ')}.`;
            if (notFound.length > 0) {
                msg += ` Not found: ${notFound.join(', ')}.`;
            }
            setStatusText(msg);
        } catch (err) {
            skipRangeRef.current = null;
            setStatusText(`Description fetch failed (${err.message}) — playing full video.`);
        }
    };

    const handleLoadAndPlay = () => {
        if (!videoId) {
            setStatusText("Please enter a YouTube Video ID.");
            return;
        }

        setLoadingAction(true);
        hasUserData.current = true;
        skipRangeRef.current = null;

        const startSeconds = startTime ? timeToSeconds(startTime) : 0;
        const endSeconds = endTime ? timeToSeconds(endTime) : null;

        if (isVisible) {
            sendPlayerCommand('delayLivePlayerCommand', 'loadVideo', videoId, startSeconds, endSeconds);
            sendPlayerCommand('delayLivePlayerCommand', 'unmute');
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText("Video loaded, playing.");
            logVideoLoad('Delay Live', videoId, videoTitle, 'manual', { startTime, endTime });
            logVideoPlay('Delay Live', videoId, 'manual');
        } else {
            setStatusText("Loaded - will play when source is visible.");
            logVideoLoad('Delay Live', videoId, videoTitle, 'manual_prepared', { startTime, endTime });
        }

        if (keywordSkipEnabled && skipKeyword.trim()) {
            applyKeywordSkip(videoId, isVisible);
        }

        setTimeout(() => setLoadingAction(false), 800);
    };

    const handlePlayPause = () => {
        if (isPlaying) {
            sendPlayerCommand('delayLivePlayerCommand', 'pause');
            setIsPlaying(false);
            setStatusText("Paused");
        } else {
            sendPlayerCommand('delayLivePlayerCommand', 'play');
            setIsPlaying(true);
            setStatusText("Playing");
        }
    };

    const handleStop = () => {
        sendPlayerCommand('delayLivePlayerCommand', 'stop');
        setIsPlaying(false);
        setIsStopped(true);
        setStatusText("Stopped");
    };

    const handleMute = () => {
        if (isMuted) {
            sendPlayerCommand('delayLivePlayerCommand', 'unmute');
            setIsMuted(false);
        } else {
            sendPlayerCommand('delayLivePlayerCommand', 'mute');
            setIsMuted(true);
        }
    };

    const handleExport = () => {
        const timestamp = new Date().toLocaleString();
        const data = `Video ID: ${videoId || "N/A"}\nStart Time: ${startTime || "00:00:00"}\nEnd Time: ${endTime || "N/A"}\nTimestamp: ${timestamp}`;
        const blob = new Blob([data], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `delay-player-export-${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatusText("Exported to file");
    };

    return (
        <div className="player-control-card">
            <h3>Delay Live Player</h3>
            <ThumbnailLoader src={videoThumbnail} alt="Delay Player Thumbnail" loading={thumbLoading} />
            <p className="video-title">{thumbLoading ? 'Loading...' : (videoTitle || 'No video loaded')}</p>
            <p className="video-time-display">{timeInfo.currentTime} / {timeInfo.remainingTime}</p>

            <input
                type="text"
                className="input-field mt-2"
                placeholder="YouTube Video ID"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
            />
            <input
                type="text"
                className="input-field mt-2"
                placeholder="Start Time (HH:MM:SS)"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
            />
            <input
                type="text"
                className="input-field mt-2"
                placeholder="End Time (HH:MM:SS)"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
            />

            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={keywordSkipEnabled}
                    onChange={() => setKeywordSkipEnabled(!keywordSkipEnabled)}
                    className="accent-cyan-500"
                />
                <span className={keywordSkipEnabled ? 'text-gray-200' : 'text-gray-500'}>
                    Skip section by keyword (keyword timestamp → next timestamp)
                </span>
            </label>
            {keywordSkipEnabled && (
                <input
                    type="text"
                    className="input-field mt-2"
                    placeholder="Keywords, comma separated (e.g. Kirtan, Dhun)"
                    value={skipKeyword}
                    onChange={(e) => setSkipKeyword(e.target.value)}
                />
            )}

            <label className="flex flex-col gap-1 mt-2 text-xs text-gray-400">
                On Finish, Start Group:
                <select
                    className="input-field"
                    value={endGroupId}
                    onChange={(e) => setEndGroupId(e.target.value)}
                >
                    <option value="">— None (do nothing) —</option>
                    {automationGroups.map(g => (
                        <option key={g.id} value={g.id}>{g.serial ? `${g.serial} - ` : ''}{g.name || 'Unnamed Group'}</option>
                    ))}
                </select>
            </label>

            <div className="btn-group mt-2">
                <PlayerControlBtn
                    className={`btn-primary${loadingAction ? ' btn-loading' : ''}`}
                    onClick={handleLoadAndPlay}
                    disabled={loadingAction}
                >
                    {loadingAction ? <><span className="btn-spinner" /> Loading</> : 'Load'}
                </PlayerControlBtn>
                <PlayerControlBtn className={isPlaying ? "btn-success" : "btn-danger"} onClick={handlePlayPause}>
                    {isPlaying ? "Playing" : "Paused"}
                </PlayerControlBtn>
                <PlayerControlBtn className={isStopped ? "btn-danger" : "btn-neutral"} onClick={handleStop}>Stop</PlayerControlBtn>
                <PlayerControlBtn className={!isMuted ? "btn-success" : "btn-danger"} onClick={handleMute}>
                    {!isMuted ? "Unmuted" : "Muted"}
                </PlayerControlBtn>
            </div>
            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-neutral" onClick={handleExport}>Export Data</PlayerControlBtn>
            </div>
            <p className="player-status">{statusText}</p>
        </div>
    );
};

export default DelayPlayerCard;
