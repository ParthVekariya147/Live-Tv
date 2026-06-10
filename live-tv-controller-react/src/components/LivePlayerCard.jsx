
import React, { useState, useEffect, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, LIVE_PLAYER_EVENT_KEY } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { useVideoInfo } from '../hooks/useVideoInfo';
import { logVideoLoad, logVideoPlay } from '../utils/logger';
import PlayerControlBtn from './common/PlayerControlBtn';
import ThumbnailLoader from './common/ThumbnailLoader';

const DEFAULT_LIVE_VIDEO_ID = "T3wvnwSSw8g";

const LivePlayerCard = () => {
    const { sourceState, setSourceVisibility } = useOBS();
    const isVisible = sourceState["Live Player"];
    const isInitialized = useRef(false);

    const [videoId, setVideoId] = useState(DEFAULT_LIVE_VIDEO_ID);
    const [priority, setPriority] = useState("matchSearchTerms");

    // Playback
    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);

    const { title: videoTitle, thumbnail: videoThumbnail, loading: thumbLoading } = useVideoInfo(videoId);
    const [loadingAction, setLoadingAction] = useState(false);
    const [statusText, setStatusText] = useState("Not loaded");

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

    // Resume playback when OBS visibility changes - sends actual player commands
    const resumePlayback = () => {
        if (videoId) {
            sendPlayerCommand('livePlayerCommand', 'loadVideo', videoId);
            sendPlayerCommand('livePlayerCommand', 'play');
            sendPlayerCommand('livePlayerCommand', 'unmute');
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText("Playing");
        }
    };

    // Track mount time to prevent visibility commands on initial mount
    const mountTime = useRef(Date.now());
    const prevIsVisible = useRef(undefined);

    // Visibility Reaction - ONLY react to actual changes, not initial mount
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
            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-neutral" onClick={handleExport}>Export Data</PlayerControlBtn>
            </div>
            <p className="player-status">{statusText}</p>
        </div>
    );
};

export default LivePlayerCard;
