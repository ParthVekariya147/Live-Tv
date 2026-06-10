
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { fetchVideoDetails, sendPlayerCommand, PLAYER_EVENT_KEY } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { logVideoLoad, logVideoPlay, logPlaylistAction } from '../utils/logger';
import PlayerControlBtn from './common/PlayerControlBtn';

const LoopPlayerCard = () => {
    const { sourceState, setSourceVisibility } = useOBS();
    const isVisible = sourceState["Loop Player"];
    const isInitialized = useRef(false);
    const hasUserData = useRef(false); // Track if we have actual user data to save

    const [playlist, setPlaylist] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [inputValue, setInputValue] = useState("");
    const [jumpIndex, setJumpIndex] = useState(""); // For jump to index feature

    // Playback State
    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);

    // Video Info
    const [videoInfo, setVideoInfo] = useState({
        title: "No video loaded",
        thumbnail: "https://placehold.co/300x170?text=No+Video",
        currentTime: "00:00:00",
        remainingTime: "00:00:00"
    });
    const [statusText, setStatusText] = useState("Not loaded");

    // Use custom hook for time updates
    const timeInfo = usePlayerTime(PLAYER_EVENT_KEY, 'loop');

    // Load saved state on mount
    useEffect(() => {
        const saved = localStorage.getItem('loopPlayerState');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (parsed.playlist && parsed.playlist.length > 0) {
                    setPlaylist(parsed.playlist);
                    setCurrentIndex(parsed.currentIndex || 0);
                    setInputValue(parsed.playlist.join(','));
                    setIsPlaying(parsed.isPlaying ?? true);
                    setIsMuted(parsed.isMuted ?? false);
                    setIsStopped(parsed.isStopped ?? false);
                    updateVideoInfo(parsed.playlist[parsed.currentIndex || 0]);
                    hasUserData.current = true; // Mark that we have valid user data
                }
            } catch (e) {
                console.error("Error loading loop saved state", e);
            }
        }
        // Use setTimeout to mark initialized after React state settles
        setTimeout(() => {
            isInitialized.current = true;
        }, 50);
    }, []);

    // Save state on change (only when we have actual user data)
    useEffect(() => {
        if (!isInitialized.current) return;
        if (!hasUserData.current && playlist.length === 0) return; // Don't save empty initial state

        // Mark that we have user data if playlist is not empty
        if (playlist.length > 0) {
            hasUserData.current = true;
        }

        const state = {
            playlist,
            currentIndex,
            isPlaying,
            isMuted,
            isStopped,
            videoId: playlist[currentIndex] || ""
        };
        localStorage.setItem('loopPlayerState', JSON.stringify(state));
    }, [playlist, currentIndex, isPlaying, isMuted, isStopped]);

    // Track mount time to prevent visibility commands on initial mount
    const mountTime = useRef(Date.now());
    const prevIsVisible = useRef(undefined);

    // React to OBS visibility CHANGES only (not initial mount)
    useEffect(() => {
        // Guard: Ignore any visibility effects within 500ms of mount
        const timeSinceMount = Date.now() - mountTime.current;
        if (timeSinceMount < 500) {
            console.log('LoopPlayer: Ignoring visibility effect within 500ms of mount, time:', timeSinceMount);
            prevIsVisible.current = isVisible;
            return;
        }

        if (prevIsVisible.current === undefined) {
            console.log('LoopPlayer: Initial mount, visibility:', isVisible, '- not sending commands');
            prevIsVisible.current = isVisible;
            return;
        }

        if (prevIsVisible.current === isVisible) {
            return;
        }

        prevIsVisible.current = isVisible;

        if (isVisible) {
            resumePlayback();
            setStatusText("Loop Player Active");
        } else {
            sendPlayerCommand('loopPlayerCommand', 'pause');
            setIsPlaying(false);
            setIsStopped(false);
            setStatusText("Loop Player Paused");
        }
    }, [isVisible]);

    // Resume playback of existing playlist without parsing inputValue
    const resumePlayback = async () => {
        if (playlist.length > 0) {
            const vid = playlist[currentIndex] || playlist[0];
            if (vid) {
                await updateVideoInfo(vid);
                sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
                sendPlayerCommand('loopPlayerCommand', 'play');
                sendPlayerCommand('loopPlayerCommand', 'unmute');
                setIsPlaying(true);
                setIsStopped(false);
                setIsMuted(false);
            }
        }
    };

    // Listen to player events (time update, ended)
    useEffect(() => {
        const handleStorage = (e) => {
            if (e.key === PLAYER_EVENT_KEY && e.newValue) {
                try {
                    const data = JSON.parse(e.newValue);
                    if (data.event === 'timeUpdate') {
                        // TODO: helper for HMS
                        // We can just format specific stats if needed, or pass raw
                    }
                    if (data.playerType === 'loop' && (data.event === 'videoEnded' || data.event === 'videoError')) {
                        console.log("Loop Video Ended/Error, next...");
                        handleNext();
                    }
                } catch (err) { }
            }
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, [currentIndex, playlist]); // Dependencies might need check

    const updateVideoInfo = async (videoId) => {
        const details = await fetchVideoDetails(videoId);
        setVideoInfo(prev => ({
            ...prev,
            title: details.title,
            thumbnail: details.thumbnail
        }));
    };

    const handleLoadAndPlay = async () => {
        // Load video - only play if source is visible
        let currentList = playlist;
        if (inputValue) {
            currentList = inputValue.split(',').map(s => s.trim()).filter(Boolean);
            setPlaylist(currentList);
            hasUserData.current = true;
        }

        if (currentList.length > 0) {
            const vid = currentList[currentIndex] || currentList[0];
            if (vid) {
                await updateVideoInfo(vid);

                if (isVisible) {
                    // Source is visible - load and play immediately
                    sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
                    sendPlayerCommand('loopPlayerCommand', 'play');
                    sendPlayerCommand('loopPlayerCommand', 'unmute');
                    setIsPlaying(true);
                    setIsStopped(false);
                    setIsMuted(false);
                    setStatusText("Video loaded, playing.");

                    // Log the video load
                    logVideoLoad('Loop Player', vid, videoInfo.title, 'manual', { playlistIndex: currentIndex, playlistSize: currentList.length });
                    logVideoPlay('Loop Player', vid, 'manual');
                } else {
                    // Source is hidden - just prepare, don't play
                    setStatusText("Loaded - will play when source is visible.");
                    logVideoLoad('Loop Player', vid, videoInfo.title, 'manual_prepared', { playlistIndex: currentIndex, playlistSize: currentList.length });
                }
            }
        } else {
            setStatusText("No videos in playlist");
        }
    };

    const handlePlayPause = () => {
        if (isPlaying) {
            sendPlayerCommand('loopPlayerCommand', 'pause');
            setIsPlaying(false);
            setStatusText("Paused");
        } else {
            sendPlayerCommand('loopPlayerCommand', 'play');
            setIsPlaying(true);
            setStatusText("Playing");
        }
    };

    const handleStop = () => {
        sendPlayerCommand('loopPlayerCommand', 'stop');
        setIsPlaying(false);
        setIsStopped(true);
        setStatusText("Stopped");
    };

    const handleMute = () => {
        if (isMuted) {
            sendPlayerCommand('loopPlayerCommand', 'unmute');
            setIsMuted(false);
        } else {
            sendPlayerCommand('loopPlayerCommand', 'mute');
            setIsMuted(true);
        }
    };

    const handleNext = () => {
        let nextIdx = currentIndex + 1;
        if (nextIdx >= playlist.length) nextIdx = 0;
        setCurrentIndex(nextIdx);
        // Play next
        const vid = playlist[nextIdx];
        if (vid) {
            updateVideoInfo(vid);
            sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
        }
    };

    const handlePrev = () => {
        let prevIdx = currentIndex - 1;
        if (prevIdx < 0) prevIdx = playlist.length - 1;
        setCurrentIndex(prevIdx);
        const vid = playlist[prevIdx];
        if (vid) {
            updateVideoInfo(vid);
            sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
        }
    };

    const handleJump = () => {
        const idx = parseInt(jumpIndex, 10);
        if (isNaN(idx) || idx < 1 || idx > playlist.length) {
            setStatusText(`Enter index 1-${playlist.length}`);
            return;
        }
        const targetIdx = idx - 1; // Convert to 0-indexed
        setCurrentIndex(targetIdx);
        const vid = playlist[targetIdx];
        if (vid) {
            updateVideoInfo(vid);
            sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
            sendPlayerCommand('loopPlayerCommand', 'play');
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText(`Jumped to video ${idx}`);
        }
        setJumpIndex("");
    };

    const handleReset = () => {
        sendPlayerCommand('loopPlayerCommand', 'stop');
        setPlaylist([]);
        setCurrentIndex(0);
        setInputValue("");
        setIsPlaying(false);
        setIsStopped(true);
        setVideoInfo({
            title: "No video loaded",
            thumbnail: "https://placehold.co/300x170?text=No+Video",
            currentTime: "00:00:00",
            remainingTime: "00:00:00"
        });
        hasUserData.current = false;
        localStorage.removeItem('loopPlayerState');
        setStatusText("Playlist reset");
    };

    const handleExport = async () => {
        const timestamp = new Date().toLocaleString();
        const currentVid = playlist[currentIndex] || "N/A";
        const data = `Video ID: ${currentVid}\nPlaylist: ${playlist.join(', ')}\nCurrent Index: ${currentIndex + 1}/${playlist.length}\nTimestamp: ${timestamp}`;
        try {
            await navigator.clipboard.writeText(data);
            setStatusText("Data copied to clipboard!");
        } catch (err) {
            setStatusText("Failed to copy");
        }
    };

    return (
        <div className="player-control-card">
            <h3>Loop Player</h3>
            <img
                src={videoInfo.thumbnail}
                alt="Thumbnail"
                className="video-thumbnail"
            />
            <p className="video-title">{videoInfo.title}</p>
            <p className="video-time-display">{timeInfo.currentTime} / {timeInfo.remainingTime}</p>
            <p className="video-info-display">{playlist.length > 0 ? `Video ${currentIndex + 1} of ${playlist.length}` : ''}</p>

            <input
                type="text"
                className="input-field"
                placeholder="Comma-separated YouTube IDs"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
            />

            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-primary" onClick={handleLoadAndPlay}>Load</PlayerControlBtn>
                <PlayerControlBtn className={isPlaying ? "btn-success" : "btn-danger"} onClick={handlePlayPause}>
                    {isPlaying ? "Playing" : "Paused"}
                </PlayerControlBtn>
                <PlayerControlBtn className={isStopped ? "btn-danger" : "btn-neutral"} onClick={handleStop}>Stop</PlayerControlBtn>
                <PlayerControlBtn className={!isMuted ? "btn-success" : "btn-danger"} onClick={handleMute}>
                    {!isMuted ? "Unmuted" : "Muted"}
                </PlayerControlBtn>
            </div>

            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-neutral" onClick={handlePrev}>Previous</PlayerControlBtn>
                <PlayerControlBtn className="btn-neutral" onClick={handleNext}>Next</PlayerControlBtn>
            </div>

            {/* Jump to Index */}
            <div className="flex gap-2 mt-2 w-full">
                <input
                    type="number"
                    className="input-field flex-1"
                    placeholder="Index (1-N)"
                    value={jumpIndex}
                    onChange={(e) => setJumpIndex(e.target.value)}
                    min="1"
                    max={playlist.length}
                />
                <PlayerControlBtn className="btn-neutral" onClick={handleJump}>Jump</PlayerControlBtn>
            </div>

            {/* Reset and Export */}
            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-danger" onClick={handleReset}>Reset Playlist</PlayerControlBtn>
                <PlayerControlBtn className="btn-neutral" onClick={handleExport}>Export Data</PlayerControlBtn>
            </div>

            <p className="player-status">{statusText}</p>
        </div >
    );
};

export default LoopPlayerCard;
