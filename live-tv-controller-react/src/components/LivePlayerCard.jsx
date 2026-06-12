
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, LIVE_PLAYER_EVENT_KEY, secondsToHMS } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { useVideoInfo } from '../hooks/useVideoInfo';
import { logVideoLoad, logVideoPlay } from '../utils/logger';
import PlayerControlBtn from './common/PlayerControlBtn';
import ThumbnailLoader from './common/ThumbnailLoader';

const DEFAULT_LIVE_VIDEO_ID = "T3wvnwSSw8g";
const API_BASE = '';

const LivePlayerCard = () => {
    const { sourceState } = useOBS();
    const isVisible = sourceState["Live Player"];
    const isInitialized = useRef(false);

    const [videoId, setVideoId] = useState(DEFAULT_LIVE_VIDEO_ID);
    const videoIdRef = useRef(videoId);
    useEffect(() => { videoIdRef.current = videoId; }, [videoId]);
    const videoTitleRef = useRef('');
    const [priority, setPriority] = useState("matchSearchTerms");

    // Playback
    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);

    const { title: videoTitle, thumbnail: videoThumbnail, loading: thumbLoading } = useVideoInfo(videoId);
    useEffect(() => { videoTitleRef.current = videoTitle || ''; }, [videoTitle]);
    const [loadingAction, setLoadingAction] = useState(false);
    const [statusText, setStatusText] = useState("Not loaded");

    // Recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingFile, setRecordingFile] = useState(null);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const [autoDeleteCount, setAutoDeleteCount] = useState(0);
    const [autoDeleteInput, setAutoDeleteInput] = useState('0');
    const [recordingStatus, setRecordingStatus] = useState('');
    const recordingPollRef = useRef(null);

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
    // true while the current recording was started automatically (not by the user)
    const wasAutoStartedRef = useRef(false);
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
            } catch (e) { }
        }
        isInitialized.current = true;
    }, []);

    // Save state to localStorage
    useEffect(() => {
        if (!isInitialized.current) return;
        const state = { videoId, priority, isPlaying, isMuted, isStopped };
        localStorage.setItem('livePlayerState', JSON.stringify(state));
    }, [videoId, priority, isPlaying, isMuted, isStopped]);

    // Load recording settings from server
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

        // Check if a recording is already active (e.g. server restarted while recording)
        fetch(`${API_BASE}/api/recording/status`)
            .then(r => r.json())
            .then(d => {
                if (d.success && d.isRecording) {
                    setIsRecording(true);
                    setRecordingFile(d.currentFile);
                    setRecordingDuration(d.durationSeconds || 0);
                }
            })
            .catch(() => { });
    }, []);

    // Poll recording status while recording
    const startStatusPoll = useCallback(() => {
        if (recordingPollRef.current) return;
        recordingPollRef.current = setInterval(() => {
            fetch(`${API_BASE}/api/recording/status`)
                .then(r => r.json())
                .then(d => {
                    if (d.success) {
                        setIsRecording(d.isRecording);
                        setRecordingDuration(d.durationSeconds || 0);
                        if (!d.isRecording) {
                            clearInterval(recordingPollRef.current);
                            recordingPollRef.current = null;
                            setRecordingFile(null);
                            setRecordingDuration(0);
                            setRecordingStatus('Recording saved');
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

    useEffect(() => {
        if (isRecording) {
            startStatusPoll();
        }
        return () => { if (!isRecording) stopStatusPoll(); };
    }, [isRecording, startStatusPoll, stopStatusPoll]);

    // Cleanup on unmount
    useEffect(() => () => stopStatusPoll(), [stopStatusPoll]);

    // Listen for auto-load events from MonitorManager
    useEffect(() => {
        const handleAutoLoad = (event) => {
            const { videoId: newVideoId } = event.detail;
            if (newVideoId) {
                setVideoId(newVideoId);
                sendPlayerCommand('livePlayerCommand', 'loadVideo', newVideoId);
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
    }, []);

    // Resume playback when OBS visibility changes
    const resumePlayback = () => {
        const vid = videoIdRef.current;
        if (vid) {
            sendPlayerCommand('livePlayerCommand', 'loadVideo', vid);
            sendPlayerCommand('livePlayerCommand', 'play');
            sendPlayerCommand('livePlayerCommand', 'unmute');
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText("Playing");
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
            resumePlayback();
        } else {
            sendPlayerCommand('livePlayerCommand', 'pause');
            setIsPlaying(false);
            setIsStopped(false);
            setStatusText("Live Player Paused");
        }
    }, [isVisible]);

    const handleLoadAndPlay = () => {
        if (!videoId) {
            setStatusText("Please enter a YouTube Video ID.");
            return;
        }

        setLoadingAction(true);

        if (isVisible) {
            sendPlayerCommand('livePlayerCommand', 'loadVideo', videoId);
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

    const handleExport = async () => {
        const timestamp = new Date().toLocaleString();
        const data = `Video ID: ${videoId || "N/A"}\nPriority: ${priority}\nTimestamp: ${timestamp}`;
        try {
            await navigator.clipboard.writeText(data);
            setStatusText("Data copied to clipboard!");
        } catch (err) {
            setStatusText("Failed to copy");
        }
    };

    // ── Recording helpers (shared by manual button + auto-record logic) ──────
    const startRecording = useCallback(async (vid, title) => {
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
                setIsRecording(true);
                setRecordingFile(data.filename);
                setRecordingDuration(0);
                setRecordingStatus('Recording...');
                startStatusPoll();
                return true;
            }
            setRecordingStatus(`Start failed: ${data.error}`);
            return false;
        } catch (e) {
            setRecordingStatus(`Error: ${e.message}`);
            return false;
        }
    }, [startStatusPoll]);

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

    // ── Manual toggle (REC button) ────────────────────────────────────────────
    const handleToggleRecording = async () => {
        if (isRecording) {
            wasAutoStartedRef.current = false;
            await stopRecording();
        } else {
            wasAutoStartedRef.current = false; // manual start
            await startRecording(videoId, videoTitle);
        }
    };

    // ── Auto-record: start when Live Player becomes visible, stop when hidden ─
    useEffect(() => {
        const timeSinceMount = Date.now() - mountTime.current;
        if (timeSinceMount < 500) return; // ignore on initial mount
        if (!autoRecordRef.current) return; // master switch is OFF

        if (isVisible) {
            // Live Player just became visible — auto-start if not already recording
            if (!isRecordingRef.current) {
                const vid = videoIdRef.current;
                const t = videoTitleRef.current;
                wasAutoStartedRef.current = true;
                startRecording(vid, t);
            }
        } else {
            // Live Player just became hidden — auto-stop only if WE started it
            if (isRecordingRef.current && wasAutoStartedRef.current) {
                wasAutoStartedRef.current = false;
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
        } catch (e) { /* silent */ }
    };

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
                        {isRecording
                            ? `REC  ${recordingDurationLabel}${wasAutoStartedRef.current ? ' (auto)' : ''}`
                            : 'REC'}
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
            </div>

            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-neutral" onClick={handleExport}>Export Data</PlayerControlBtn>
            </div>
            <p className="player-status">{statusText}</p>
        </div>
    );
};

export default LivePlayerCard;
