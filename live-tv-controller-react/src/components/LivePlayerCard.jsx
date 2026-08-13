
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, LIVE_PLAYER_EVENT_KEY, secondsToHMS } from '../utils/core-utils';
import { usePlayerTime, usePlayerEvents, usePlayerRelayStatus } from '../utils/usePlayerHooks';
import { useVideoInfo } from '../hooks/useVideoInfo';
import { logVideoLoad, logVideoPlay, logError, LogCategory, LogType } from '../utils/logger';
import { setStateValue } from '../utils/state-api';
import PlayerControlBtn from './common/PlayerControlBtn';
import ThumbnailLoader from './common/ThumbnailLoader';
import LiveEndRulesManager from './LiveEndRulesManager';
import {
    LIVE_END_RULES_LOCAL_KEY, LIVE_END_RULES_UPDATED_EVENT, resolveLiveEndTarget, migrateLegacyEndGroup,
} from '../utils/liveEndRules';

const DEFAULT_LIVE_VIDEO_ID = "T3wvnwSSw8g";
const API_BASE = '';

const LivePlayerCard = () => {
    const { sourceState, setSourceVisibility } = useOBS();
    const isVisible = sourceState["Live Player"];
    const isInitialized = useRef(false);

    const [videoId, setVideoId] = useState(DEFAULT_LIVE_VIDEO_ID);
    const videoIdRef = useRef(videoId);
    useEffect(() => { videoIdRef.current = videoId; }, [videoId]);
    const videoTitleRef = useRef('');
    const [priority, setPriority] = useState("matchSearchTerms");

    // "Stream-End Rules" — when the live stream goes offline (YouTube reports ENDED), match
    // its ended title against saved keyword rules and hand off to Loop Player, starting
    // whichever Group/Playlist that rule points at. See LiveEndRulesManager.jsx for the
    // matching logic and the manager UI. No match (or an empty rule list) = do nothing, same
    // as leaving the old fixed dropdown on "None".
    const [liveEndRules, setLiveEndRules] = useState([]);
    const liveEndRulesRef = useRef(liveEndRules);
    useEffect(() => { liveEndRulesRef.current = liveEndRules; }, [liveEndRules]);
    useEffect(() => {
        const loadRules = () => {
            try {
                const saved = localStorage.getItem(LIVE_END_RULES_LOCAL_KEY);
                const parsed = saved ? JSON.parse(saved) : [];
                setLiveEndRules(Array.isArray(parsed) ? parsed : []);
            } catch { setLiveEndRules([]); }
        };
        loadRules();
        const onStorage = (e) => { if (e.key === LIVE_END_RULES_LOCAL_KEY) loadRules(); };
        window.addEventListener('storage', onStorage);
        window.addEventListener(LIVE_END_RULES_UPDATED_EVENT, loadRules);
        return () => {
            window.removeEventListener('storage', onStorage);
            window.removeEventListener(LIVE_END_RULES_UPDATED_EVENT, loadRules);
        };
    }, []);

    // Playback
    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);

    // Manual quality override — mirrors YouTube's own gear-icon quality picker. 'auto'
    // (default) keeps LivePlayer.html's existing behavior of always chasing the top
    // tier YouTube offers. Live streams in particular sometimes hold at a lower tier
    // regardless, since YouTube doesn't always publish every rendition for a live
    // broadcast — picking a specific tier here still only works if YouTube is actually
    // offering it (see LivePlayer.html's pickQualityTarget), but gives a manual lever
    // when the automatic top-tier chase isn't landing.
    const [desiredQuality, setDesiredQuality] = useState("auto");
    const desiredQualityRef = useRef(desiredQuality);
    useEffect(() => { desiredQualityRef.current = desiredQuality; }, [desiredQuality]);
    useEffect(() => {
        if (!isInitialized.current) return;
        sendPlayerCommand('livePlayerCommand', 'setQuality', null, null, null, null, { quality: desiredQuality });
    }, [desiredQuality]);

    // Direct Relay — bypasses the YouTube IFrame API's quality controls entirely
    // (setPlaybackQuality/getAvailableQualityLevels/suggestedQuality are confirmed
    // no-ops since ~2018) by having the server pull the actual HLS stream via
    // yt-dlp and playing it through hls.js on LivePlayer.html. Only takes effect
    // for streams that are actually LIVE right now — LivePlayer.html silently
    // stays on the normal YouTube iframe otherwise (upcoming/ended/VOD, or if the
    // relay fails for any reason), so leaving this on is safe even when it can't
    // apply. Off by default since it's a bigger architectural departure than the
    // Quality dropdown above.
    const [useRelay, setUseRelay] = useState(false);
    const useRelayRef = useRef(useRelay);
    useEffect(() => { useRelayRef.current = useRelay; }, [useRelay]);
    // Remembers whether Direct Relay was ON right before Live Player stopped being
    // the active OBS source, purely so it can be turned back on automatically if the
    // user switches back — see the isVisible effect below. Session-only, not persisted.
    const relayOnBeforeHideRef = useRef(false);
    // Ground truth for what relay is actually doing right now — see
    // LivePlayer.html's pushRelayStatus(). Independent of `useRelay` above,
    // which only records what was requested.
    const relayStatus = usePlayerRelayStatus(LIVE_PLAYER_EVENT_KEY, 'live');
    useEffect(() => {
        if (!isInitialized.current) return;
        sendPlayerCommand('livePlayerCommand', 'setRelayMode', null, null, null, null, { useRelay });
    }, [useRelay]);

    const { title: videoTitle, thumbnail: videoThumbnail, loading: thumbLoading } = useVideoInfo(videoId);
    useEffect(() => { videoTitleRef.current = videoTitle || ''; }, [videoTitle]);
    const [loadingAction, setLoadingAction] = useState(false);
    const [statusText, setStatusText] = useState("Not loaded");

    // Recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingFile, setRecordingFile] = useState(null);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const [, setAutoDeleteCount] = useState(0);
    const [autoDeleteInput, setAutoDeleteInput] = useState('0');
    const [recordingStatus, setRecordingStatus] = useState('');
    const recordingPollRef = useRef(null);

    // File manager state
    const [showFiles, setShowFiles] = useState(false);
    const [recordingsList, setRecordingsList] = useState([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [folderPath, setFolderPath] = useState('');

    // Auto-record master switch
    const [autoRecord, setAutoRecord] = useState(() => {
        try { return JSON.parse(localStorage.getItem('liveAutoRecord') ?? 'false'); }
        catch { return false; }
    });
    const autoRecordRef = useRef(autoRecord);
    useEffect(() => {
        autoRecordRef.current = autoRecord;
        localStorage.setItem('liveAutoRecord', JSON.stringify(autoRecord));
    }, [autoRecord]);

    // wasAutoStarted: true while current recording was started automatically.
    // Keep both a ref (for use in closures/callbacks) and state (for UI rendering).
    const wasAutoStartedRef = useRef(false);
    const [wasAutoStarted, setWasAutoStarted] = useState(false);

    const isRecordingRef = useRef(isRecording);
    useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

    // Use custom hook for time updates
    const timeInfo = usePlayerTime(LIVE_PLAYER_EVENT_KEY, 'live');

    // Load state from localStorage
    useEffect(() => {
        const saved = localStorage.getItem('livePlayerState');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                setVideoId(parsed.videoId || "");
                setPriority(parsed.priority || "matchSearchTerms");
                setIsPlaying(parsed.isPlaying ?? true);
                setIsMuted(parsed.isMuted ?? false);
                setIsStopped(parsed.isStopped ?? false);
                setDesiredQuality(parsed.desiredQuality || "auto");
                setUseRelay(parsed.useRelay ?? false);
                migrateLegacyEndGroup(parsed.endGroupId);
            } catch { /* ignore malformed localStorage */ }
        }
        isInitialized.current = true;
    }, []);

    // Save state to localStorage and server
    useEffect(() => {
        if (!isInitialized.current) return;
        const state = { videoId, priority, isPlaying, isMuted, isStopped, desiredQuality, useRelay };
        localStorage.setItem('livePlayerState', JSON.stringify(state));
        setStateValue('player.live', state);
    }, [videoId, priority, isPlaying, isMuted, isStopped, desiredQuality, useRelay]);

    // Always-current ref to flush current state on demand (pre-backup / pre-export)
    const flushStateRef = useRef(null);
    useEffect(() => {
        flushStateRef.current = () => {
            if (!isInitialized.current) return;
            const state = { videoId, priority, isPlaying, isMuted, isStopped, desiredQuality, useRelay };
            localStorage.setItem('livePlayerState', JSON.stringify(state));
            setStateValue('player.live', state);
        };
    });

    useEffect(() => {
        const handler = () => flushStateRef.current?.();
        window.addEventListener('flushPlayerState', handler);
        return () => window.removeEventListener('flushPlayerState', handler);
    }, []);

    // Load recording settings from server and restore active recording state
    useEffect(() => {
        fetch(`${API_BASE}/api/recording/settings`)
            .then(r => r.json())
            .then(d => {
                if (d.success) {
                    const count = d.settings.autoDeleteCount || 0;
                    setAutoDeleteCount(count);
                    setAutoDeleteInput(String(count));
                }
            })
            .catch(() => { });

        // [FIX A2] Restore recording state after page refresh.
        // Also restore wasAutoStartedRef so auto-stop works correctly after refresh.
        fetch(`${API_BASE}/api/recording/status`)
            .then(r => r.json())
            .then(d => {
                if (d.success && d.isRecording) {
                    setIsRecording(true);
                    setRecordingFile(d.currentFile);
                    setRecordingDuration(d.durationSeconds || 0);
                    // If autoRecord is on, the in-progress recording was almost certainly
                    // auto-started — restore the flag so switching players will stop it.
                    if (autoRecordRef.current) {
                        wasAutoStartedRef.current = true;
                        setWasAutoStarted(true);
                    }
                }
            })
            .catch(() => { });
    }, []);

    // Poll recording status while recording is active
    const startStatusPoll = useCallback(() => {
        if (recordingPollRef.current) return;
        recordingPollRef.current = setInterval(() => {
            fetch(`${API_BASE}/api/recording/status`)
                .then(r => r.json())
                .then(d => {
                    if (d.success) {
                        setIsRecording(d.isRecording);
                        setRecordingDuration(d.durationSeconds || 0);
                        // [FIX G1] yt-dlp finished naturally — clear auto-start flag
                        if (!d.isRecording) {
                            clearInterval(recordingPollRef.current);
                            recordingPollRef.current = null;
                            setRecordingFile(null);
                            setRecordingDuration(0);
                            setRecordingStatus('Recording saved');
                            wasAutoStartedRef.current = false;
                            setWasAutoStarted(false);
                        }
                    }
                })
                .catch(() => { });
        }, 2000);
    }, []);

    const stopStatusPoll = useCallback(() => {
        if (recordingPollRef.current) {
            clearInterval(recordingPollRef.current);
            recordingPollRef.current = null;
        }
    }, []);

    // [FIX A3] Let this effect be the single place that starts/stops the poll.
    // startRecording() no longer calls startStatusPoll() directly to avoid the
    // double-start/stop cycle that happened across the render boundary.
    useEffect(() => {
        if (isRecording) {
            startStatusPoll();
            return () => stopStatusPoll();
        }
    }, [isRecording, startStatusPoll, stopStatusPoll]);

    // Cleanup poll on unmount
    useEffect(() => () => stopStatusPoll(), [stopStatusPoll]);

    // [FIX A1] Stop recording when tab/window is closed so yt-dlp doesn't run forever.
    useEffect(() => {
        const handleBeforeUnload = () => {
            if (isRecordingRef.current) {
                navigator.sendBeacon(`${API_BASE}/api/recording/stop`);
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, []);

    // ── Recording helpers (shared by manual button + auto-record logic) ──────
    const startRecording = useCallback(async (vid, title) => {
        // [FIX D1] Guard against double-start race (e.g. auto + manual fire at same time)
        if (isRecordingRef.current) { setRecordingStatus('Already recording'); return false; }
        if (!vid) { setRecordingStatus('No video ID — cannot record'); return false; }
        setRecordingStatus('Starting...');
        try {
            const res = await fetch(`${API_BASE}/api/recording/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId: vid, title: title || undefined }),
            });
            const data = await res.json();
            if (data.success) {
                setIsRecording(true); // triggers the isRecording effect → startStatusPoll()
                setRecordingFile(data.filename);
                setRecordingDuration(0);
                setRecordingStatus('Recording...');
                return true;
            }
            setRecordingStatus(`Start failed: ${data.error}`);
            return false;
        } catch (e) {
            setRecordingStatus(`Error: ${e.message}`);
            return false;
        }
    }, []); // no deps — isRecordingRef is a ref, setters are stable

    const stopRecording = useCallback(async () => {
        setRecordingStatus('Stopping...');
        try {
            const res = await fetch(`${API_BASE}/api/recording/stop`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setIsRecording(false);
                setRecordingFile(null);
                setRecordingDuration(0);
                setRecordingStatus('Recording saved');
                stopStatusPoll();
                return true;
            }
            setRecordingStatus(`Stop failed: ${data.error}`);
            return false;
        } catch (e) {
            setRecordingStatus(`Error: ${e.message}`);
            return false;
        }
    }, [stopStatusPoll]);

    // Listen for auto-load events from MonitorManager
    useEffect(() => {
        // [FIX Bug4] Stop active recording before switching to a new video via auto-load
        const handleAutoLoad = async (event) => {
            const { videoId: newVideoId } = event.detail;
            if (newVideoId) {
                if (isRecordingRef.current) {
                    wasAutoStartedRef.current = false;
                    setWasAutoStarted(false);
                    await stopRecording();
                }
                setVideoId(newVideoId);
                sendPlayerCommand('livePlayerCommand', 'loadVideo', newVideoId);
                sendPlayerCommand('livePlayerCommand', 'setQuality', null, null, null, null, { quality: desiredQualityRef.current });
                sendPlayerCommand('livePlayerCommand', 'setRelayMode', null, null, null, null, { useRelay: useRelayRef.current });
                sendPlayerCommand('livePlayerCommand', 'play');
                sendPlayerCommand('livePlayerCommand', 'unmute');
                setIsPlaying(true);
                setIsStopped(false);
                setIsMuted(false);
                setStatusText("Auto-loaded from Monitor");
            }
        };

        window.addEventListener('livePlayerAutoLoad', handleAutoLoad);
        return () => window.removeEventListener('livePlayerAutoLoad', handleAutoLoad);
    }, [stopRecording]);

    // Refs so the videoEnded handler below always sees the latest OBS state/setter without
    // being recreated on every OBS poll tick (same pattern as Local/Delay Player cards).
    const sourceStateRef = useRef(sourceState);
    useEffect(() => { sourceStateRef.current = sourceState; }, [sourceState]);
    const setSourceVisibilityRef = useRef(setSourceVisibility);
    useEffect(() => { setSourceVisibilityRef.current = setSourceVisibility; }, [setSourceVisibility]);

    // When the live stream goes offline (YouTube reports ENDED), hand off to Loop Player and
    // tell the automation engine which Group to start, if one was picked below.
    const handleLiveVideoEnded = useCallback(() => {
        const target = resolveLiveEndTarget(liveEndRulesRef.current, videoTitleRef.current);
        if (!target) return;
        const setSrcVis = setSourceVisibilityRef.current ?? setSourceVisibility;
        setSrcVis("Live Player", false);
        setSrcVis("Loop Player", true);
        setStatusText("Stream ended — switched to Loop Player");
        window.dispatchEvent(new CustomEvent('loopAutomationStartGroup', {
            detail: { groupId: target.groupId, listId: target.listId, label: 'Live Player stream ended' },
        }));
    }, [setSourceVisibility]);
    usePlayerEvents(LIVE_PLAYER_EVENT_KEY, 'live', handleLiveVideoEnded);

    // Resume playback when OBS visibility changes
    const resumePlayback = () => {
        const vid = videoIdRef.current;
        if (vid) {
            sendPlayerCommand('livePlayerCommand', 'loadVideo', vid);
            sendPlayerCommand('livePlayerCommand', 'setQuality', null, null, null, null, { quality: desiredQualityRef.current });
            sendPlayerCommand('livePlayerCommand', 'setRelayMode', null, null, null, null, { useRelay: useRelayRef.current });
            sendPlayerCommand('livePlayerCommand', 'play');
            sendPlayerCommand('livePlayerCommand', 'unmute');
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText("Playing");
        } else {
            logError(
                LogType.PLAYER_ERROR,
                LogCategory.SYSTEM,
                { function: 'resumePlayback', videoId, isVisible },
                'Live Player became visible but videoIdRef is empty — no playback command sent'
            );
        }
    };

    const mountTime = useRef(Date.now());
    const prevIsVisible = useRef(undefined);

    useEffect(() => {
        const timeSinceMount = Date.now() - mountTime.current;

        if (timeSinceMount < 500) {
            prevIsVisible.current = isVisible;
            return;
        }

        if (prevIsVisible.current === undefined) {
            prevIsVisible.current = isVisible;
            return;
        }

        if (prevIsVisible.current === isVisible) return;

        prevIsVisible.current = isVisible;

        if (isVisible) {
            // Coming back to Live Player — restore Direct Relay automatically if it
            // was on right before we left, instead of making the user re-toggle it.
            if (relayOnBeforeHideRef.current) {
                relayOnBeforeHideRef.current = false;
                // Set the ref synchronously (not just the state) so resumePlayback()
                // below — which reads useRelayRef.current right now, before this
                // render's effects have had a chance to run — already sees the
                // restored value instead of sending a stale `false` first.
                useRelayRef.current = true;
                setUseRelay(true);
            }
            resumePlayback();
        } else {
            // Validation: Direct Relay must not keep running once Live Player stops
            // being the active OBS source — remember it was on, then turn it off.
            // The [useRelay] effect above does the actual teardown (client playback
            // + the server's yt-dlp/ffmpeg pipeline — see stopRelayCompletely() in
            // LivePlayer.html) as soon as useRelay flips to false.
            if (useRelayRef.current) {
                relayOnBeforeHideRef.current = true;
                setUseRelay(false);
            }
            sendPlayerCommand('livePlayerCommand', 'pause');
            setIsPlaying(false);
            setIsStopped(false);
            setStatusText("Live Player Paused");
        }
    }, [isVisible]);

    // [FIX Bug4] Stop active recording before loading a new video manually
    const handleLoadAndPlay = async () => {
        if (!videoId) {
            logError(
                LogType.PLAYER_ERROR,
                LogCategory.SYSTEM,
                { function: 'handleLoadAndPlay', videoId, isVisible },
                'Live Player load attempted with no videoId'
            );
            setStatusText("Please enter a YouTube Video ID.");
            return;
        }

        setLoadingAction(true);

        if (isRecordingRef.current) {
            wasAutoStartedRef.current = false;
            setWasAutoStarted(false);
            await stopRecording();
        }

        if (isVisible) {
            sendPlayerCommand('livePlayerCommand', 'loadVideo', videoId);
            sendPlayerCommand('livePlayerCommand', 'setQuality', null, null, null, null, { quality: desiredQualityRef.current });
            sendPlayerCommand('livePlayerCommand', 'setRelayMode', null, null, null, null, { useRelay: useRelayRef.current });
            sendPlayerCommand('livePlayerCommand', 'play');
            sendPlayerCommand('livePlayerCommand', 'unmute');
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText("Video loaded, playing.");
            logVideoLoad('Live Player', videoId, videoTitle, 'manual');
            logVideoPlay('Live Player', videoId, 'manual');
        } else {
            setStatusText("Loaded - will play when source is visible.");
            logVideoLoad('Live Player', videoId, videoTitle, 'manual_prepared');
        }

        setTimeout(() => setLoadingAction(false), 800);
    };

    const handlePlayPause = () => {
        if (isPlaying) {
            sendPlayerCommand('livePlayerCommand', 'pause');
            setIsPlaying(false);
            setStatusText("Paused");
        } else {
            sendPlayerCommand('livePlayerCommand', 'play');
            setIsPlaying(true);
            setStatusText("Playing");
        }
    };

    const handleStop = () => {
        sendPlayerCommand('livePlayerCommand', 'stop');
        setIsPlaying(false);
        setIsStopped(true);
        setStatusText("Stopped");
    };

    const handleMute = () => {
        if (isMuted) {
            sendPlayerCommand('livePlayerCommand', 'unmute');
            setIsMuted(false);
        } else {
            sendPlayerCommand('livePlayerCommand', 'mute');
            setIsMuted(true);
        }
    };

    const handleExport = () => {
        const timestamp = new Date().toLocaleString();
        const data = `Video ID: ${videoId || "N/A"}\nPriority: ${priority}\nTimestamp: ${timestamp}`;
        const blob = new Blob([data], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `live-player-export-${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatusText("Exported to file");
    };

    // ── Manual toggle (REC button) ────────────────────────────────────────────
    const handleToggleRecording = async () => {
        if (isRecording) {
            wasAutoStartedRef.current = false;
            setWasAutoStarted(false);
            await stopRecording();
        } else {
            wasAutoStartedRef.current = false; // manual start — never auto-stop on player switch
            setWasAutoStarted(false);
            await startRecording(videoId, videoTitle);
        }
    };

    // ── [FIX Bug1] Post-mount check: if Live Player was already visible when the
    // page loaded, the isVisible transition never fires so we check once after the
    // 500ms guard window expires.
    useEffect(() => {
        const timer = setTimeout(() => {
            if (autoRecordRef.current && isVisible && !isRecordingRef.current) {
                wasAutoStartedRef.current = true;
                setWasAutoStarted(true);
                startRecording(videoIdRef.current, videoTitleRef.current);
            }
        }, 600);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // intentionally run once on mount only

    // ── [FIX Bug2] Auto-record on visibility change ───────────────────────────
    // Auto-START is gated on autoRecord switch.
    // Auto-STOP always fires when Live Player hides and recording was auto-started,
    // even if the user has since turned autoRecord OFF.
    useEffect(() => {
        const timeSinceMount = Date.now() - mountTime.current;
        if (timeSinceMount < 500) return; // ignore on initial mount

        if (isVisible) {
            // Live Player just became visible — auto-start if switch is ON and not already recording
            if (autoRecordRef.current && !isRecordingRef.current) {
                const vid = videoIdRef.current;
                const t = videoTitleRef.current;
                wasAutoStartedRef.current = true;
                setWasAutoStarted(true);
                startRecording(vid, t);
            }
        } else {
            // Live Player just became hidden — auto-stop regardless of switch state,
            // but only if WE started this recording automatically
            if (isRecordingRef.current && wasAutoStartedRef.current) {
                wasAutoStartedRef.current = false;
                setWasAutoStarted(false);
                stopRecording();
            }
        }
    }, [isVisible, startRecording, stopRecording]);

    const handleAutoDeleteChange = (e) => {
        const raw = e.target.value.replace(/[^0-9]/g, '');
        setAutoDeleteInput(raw);
    };

    const handleAutoDeleteBlur = async () => {
        const count = Math.max(0, parseInt(autoDeleteInput, 10) || 0);
        setAutoDeleteCount(count);
        setAutoDeleteInput(String(count));
        try {
            await fetch(`${API_BASE}/api/recording/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoDeleteCount: count }),
            });
        } catch { /* silent */ }
    };

    // ── File Manager ─────────────────────────────────────────────────────────
    const fetchRecordingsList = useCallback(async () => {
        setFilesLoading(true);
        try {
            const [listRes, pathRes] = await Promise.all([
                fetch(`${API_BASE}/api/recording/list`),
                fetch(`${API_BASE}/api/recording/folder-path`),
            ]);
            const listData = await listRes.json();
            const pathData = await pathRes.json();
            if (listData.success) setRecordingsList(listData.recordings || []);
            if (pathData.success) setFolderPath(pathData.path || '');
        } catch { /* ignore */ }
        finally { setFilesLoading(false); }
    }, []);

    const handleToggleFiles = useCallback(async () => {
        const next = !showFiles;
        setShowFiles(next);
        if (next) await fetchRecordingsList();
    }, [showFiles, fetchRecordingsList]);

    const handleOpenFolder = useCallback(async () => {
        try { await fetch(`${API_BASE}/api/recording/open-folder`, { method: 'POST' }); }
        catch { /* ignore */ }
    }, []);

    const handleDeleteRecording = useCallback(async (filename) => {
        if (!window.confirm(`Delete "${filename}"?`)) return;
        try {
            const res = await fetch(`${API_BASE}/api/recording/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) setRecordingsList(prev => prev.filter(r => r.filename !== filename));
        } catch { /* ignore */ }
    }, []);

    const recordingDurationLabel = secondsToHMS(recordingDuration);

    return (
        <div className="player-control-card">
            <h3>Live Player</h3>
            <ThumbnailLoader src={videoThumbnail} alt="Live Player Thumbnail" loading={thumbLoading} />
            <p className="video-title">{thumbLoading ? 'Loading...' : (videoTitle || 'No video loaded')}</p>
            <p className="video-time-display">{timeInfo.currentTime} / {timeInfo.remainingTime}</p>

            <input
                type="text"
                className="input-field"
                placeholder="YouTube Video ID"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
            />

            <div className="flex flex-col w-full px-2 mt-2">
                <label className="live-monitor-label mb-1 text-center">Auto-Load Priority:</label>
                <select
                    className="input-field"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                >
                    <option value="firstLive">First Live Event</option>
                    <option value="secondLive">Second Live Event</option>
                    <option value="matchSearchTerms">Match Search Terms</option>
                </select>
            </div>

            <div className="flex flex-col w-full px-2 mt-2">
                <label className="live-monitor-label mb-1 text-center" title="Mirrors YouTube's own quality picker. 'Auto' keeps always chasing the highest tier YouTube offers (default). Picking a specific tier only takes effect when YouTube is actually offering it for this stream right now — check the browser console on the Live Player page (filter for &quot;[Quality]&quot;) to see what's actually available.">
                    Quality:
                </label>
                <select
                    className="input-field"
                    value={desiredQuality}
                    onChange={(e) => setDesiredQuality(e.target.value)}
                >
                    <option value="auto">Auto (always highest available)</option>
                    <option value="hd2160">2160p (4K)</option>
                    <option value="hd1440">1440p (2K)</option>
                    <option value="hd1080">1080p (HD)</option>
                    <option value="hd720">720p (HD)</option>
                    <option value="large">480p</option>
                    <option value="medium">360p</option>
                    <option value="small">240p</option>
                    <option value="tiny">144p</option>
                </select>
            </div>

            <div
                className={`w-full mt-2 px-3 py-2 rounded-lg border flex items-center justify-between gap-2 select-none transition-all ${
                    !isVisible ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                } ${
                    useRelay
                        ? 'bg-blue-900/40 border-blue-500/60'
                        : 'bg-gray-800/60 border-gray-600/60'
                }`}
                onClick={() => { if (isVisible) setUseRelay(v => !v); }}
                title={!isVisible
                    ? "Only available while Live Player is the active OBS source — switch to it first"
                    : "Bypasses the YouTube iframe player's quality controls (setPlaybackQuality etc. do nothing — confirmed deprecated by YouTube since ~2018) by pulling the actual stream via yt-dlp and playing it directly. Only takes effect while the video is actually LIVE right now; otherwise LivePlayer.html silently stays on the normal YouTube player, so it's safe to leave on."}
            >
                <div className="flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full flex-shrink-0 ${useRelay ? 'bg-blue-400' : 'bg-gray-500'}`} />
                    <span className="text-sm font-semibold text-white">Direct Relay</span>
                    <span className="text-xs text-gray-400">
                        {!isVisible ? '— Live Player not active' : useRelay ? '— max quality, live only' : '— disabled'}
                    </span>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${useRelay ? 'bg-blue-600 text-white' : 'bg-gray-600 text-gray-300'}`}>
                    {useRelay ? 'ON' : 'OFF'}
                </span>
            </div>

            {useRelay && (
                <p className={`text-xs mt-1 px-2 ${relayStatus.active ? 'text-green-400' : 'text-yellow-400'}`}>
                    {relayStatus.active
                        ? `● RELAY LIVE — ${relayStatus.resolution || '?'}${relayStatus.mode ? ` (${relayStatus.mode})` : ''}`
                        : `○ Falling back to YouTube player${
                            relayStatus.reason ? ` — ${relayStatus.reason}` :
                            relayStatus.lastError ? ` — ${relayStatus.lastError}` :
                            relayStatus.updatedAt ? '' : ' — not started yet'
                          }`}
                </p>
            )}

            <div className="flex flex-col gap-1 mt-2 px-2 text-xs text-gray-400 w-full">
                On Stream End:
                <LiveEndRulesManager />
            </div>

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

            {/* Auto-Record master switch */}
            <div
                className={`w-full mt-3 px-3 py-2 rounded-lg border flex items-center justify-between gap-2 cursor-pointer select-none transition-all ${
                    autoRecord
                        ? 'bg-red-900/40 border-red-500/60'
                        : 'bg-gray-800/60 border-gray-600/60'
                }`}
                onClick={() => setAutoRecord(v => !v)}
                title="When ON: recording auto-starts when Live Player becomes visible and auto-stops when it hides"
            >
                <div className="flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full flex-shrink-0 ${autoRecord ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`} />
                    <span className="text-sm font-semibold text-white">Auto-Record</span>
                    <span className="text-xs text-gray-400">
                        {autoRecord ? '— will record when Live is active' : '— disabled'}
                    </span>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${autoRecord ? 'bg-red-600 text-white' : 'bg-gray-600 text-gray-300'}`}>
                    {autoRecord ? 'ON' : 'OFF'}
                </span>
            </div>

            {/* Recording section */}
            <div className="recording-section">
                <div className="recording-row">
                    <button
                        className={`recording-toggle-btn${isRecording ? ' recording-active' : ''}`}
                        onClick={handleToggleRecording}
                        title={isRecording ? 'Stop Recording' : 'Start Recording'}
                    >
                        <span className={`rec-dot${isRecording ? ' rec-dot-pulse' : ''}`} />
                        {/* [FIX G2] Use wasAutoStarted state (not ref) so badge renders instantly */}
                        {isRecording
                            ? `REC  ${recordingDurationLabel}${wasAutoStarted ? ' (auto)' : ''}`
                            : 'REC'}
                    </button>

                    <button
                        onClick={handleToggleFiles}
                        title="View saved recordings"
                        className={`px-2 py-1 rounded text-xs font-medium transition-all ${showFiles ? 'bg-blue-700 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
                    >
                        📁 Files
                    </button>

                    <div className="auto-delete-field">
                        <label className="auto-delete-label">Keep last</label>
                        <input
                            type="text"
                            className="auto-delete-input"
                            value={autoDeleteInput}
                            onChange={handleAutoDeleteChange}
                            onBlur={handleAutoDeleteBlur}
                            title="Auto-delete oldest recordings, keeping only this many (0 = keep all)"
                        />
                        <label className="auto-delete-label">recordings</label>
                    </div>
                </div>

                {recordingStatus ? (
                    <p className="recording-status-text">{recordingStatus}</p>
                ) : null}

                {isRecording && recordingFile ? (
                    <p className="recording-filename" title={recordingFile}>
                        {recordingFile.length > 40 ? '…' + recordingFile.slice(-38) : recordingFile}
                    </p>
                ) : null}

                {/* File Manager Panel */}
                {showFiles && (
                    <div className="mt-2 border border-gray-600 rounded-lg bg-gray-900/60 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-gray-800/80 border-b border-gray-700">
                            <span className="text-xs font-semibold text-blue-300">📁 live_recordings</span>
                            <div className="flex gap-1.5">
                                <button
                                    onClick={handleOpenFolder}
                                    title="Open folder in Explorer / Finder"
                                    className="px-2 py-0.5 rounded text-xs bg-blue-800 hover:bg-blue-700 text-white font-medium"
                                >
                                    Open Folder ↗
                                </button>
                                <button
                                    onClick={fetchRecordingsList}
                                    title="Refresh list"
                                    className="px-2 py-0.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                                >
                                    ↻
                                </button>
                            </div>
                        </div>
                        {folderPath && (
                            <p className="px-3 py-1 text-xs text-gray-500 border-b border-gray-800 truncate" title={folderPath}>
                                {folderPath}
                            </p>
                        )}
                        <div className="max-h-48 overflow-y-auto">
                            {filesLoading ? (
                                <p className="px-3 py-3 text-xs text-gray-400">Loading...</p>
                            ) : recordingsList.length === 0 ? (
                                <p className="px-3 py-3 text-xs text-gray-500">No recordings found</p>
                            ) : recordingsList.map(r => (
                                <div key={r.filename} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800/60 hover:bg-gray-800/40 group">
                                    <span className="flex-1 text-xs text-gray-300 truncate" title={r.filename}>{r.filename}</span>
                                    <span className="text-xs text-gray-500 flex-shrink-0">{r.sizeFormatted}</span>
                                    <button
                                        onClick={() => handleDeleteRecording(r.filename)}
                                        className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 text-xs px-1 flex-shrink-0"
                                        title="Delete"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-neutral" onClick={handleExport}>Export Data</PlayerControlBtn>
            </div>
            <p className="player-status">{statusText}</p>
        </div>
    );
};

export default LivePlayerCard;
