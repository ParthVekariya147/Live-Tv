
import React, { useState, useEffect, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, timeToSeconds, DELAY_PLAYER_EVENT_KEY } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { useVideoInfo } from '../hooks/useVideoInfo';
import { logVideoLoad, logVideoPlay } from '../utils/logger';
import PlayerControlBtn from './common/PlayerControlBtn';
import ThumbnailLoader from './common/ThumbnailLoader';

const DelayPlayerCard = () => {
    const { sourceState } = useOBS();
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
                    hasUserData.current = true; // Mark that we have valid user data
                }
            } catch (e) { }
        }
        // Use setTimeout to mark initialized after React state settles
        setTimeout(() => {
            isInitialized.current = true;
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

        const state = { videoId, startTime, endTime, isPlaying, isMuted, isStopped };
        localStorage.setItem('delayPlayerState', JSON.stringify(state));
    }, [videoId, startTime, endTime, isPlaying, isMuted, isStopped]);

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

    // Resume playback of existing video without modifying state
    const resumePlayback = () => {
        const vid = videoIdRef.current;
        if (vid) {
            const startSeconds = startTimeRef.current ? timeToSeconds(startTimeRef.current) : 0;
            const endSeconds = endTimeRef.current ? timeToSeconds(endTimeRef.current) : null;
            sendPlayerCommand('delayLivePlayerCommand', 'loadVideo', vid, startSeconds, endSeconds);
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
        }
    };

    const handleLoadAndPlay = () => {
        if (!videoId) {
            setStatusText("Please enter a YouTube Video ID.");
            return;
        }

        setLoadingAction(true);
        hasUserData.current = true;

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

    const handleExport = async () => {
        const timestamp = new Date().toLocaleString();
        const data = `Video ID: ${videoId || "N/A"}\nStart Time: ${startTime || "00:00:00"}\nEnd Time: ${endTime || "N/A"}\nTimestamp: ${timestamp}`;
        try {
            await navigator.clipboard.writeText(data);
            setStatusText("Data copied to clipboard!");
        } catch (err) {
            setStatusText("Failed to copy");
        }
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
