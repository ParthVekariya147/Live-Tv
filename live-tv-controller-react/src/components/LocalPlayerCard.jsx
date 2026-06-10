
import React, { useState, useEffect, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { fetchVideoDetails, sendPlayerCommand, LOCAL_PLAYER_EVENT_KEY, timeToSeconds } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { logSourceChange, logVideoEnd } from '../utils/logger';
import PlayerControlBtn from './common/PlayerControlBtn';

const daysMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const sourceNames = ["Loop Player", "Live Player", "Delay Live", "Local Player"];

const LocalPlayerCard = () => {
    const { sourceState, setSourceVisibility } = useOBS();
    const isVisible = sourceState["Local Player"];
    const isInitialized = useRef(false);
    const dragIndex = useRef(null); // For drag-drop

    // Refs to track latest state for event handlers (avoids stale closure)
    const endActionsRef = useRef([null, null, null, null, null, null, null]);
    const playlistRef = useRef([]);
    const currentIndexRef = useRef(0);
    const isVisibleRef = useRef(false); // For handling video ended correctly
    const sourceStateRef = useRef({}); // For checking Live Player state

    const [playlist, setPlaylist] = useState([]); // { path: string }
    const [currentIndex, setCurrentIndex] = useState(0);
    const [endActions, setEndActions] = useState([null, null, null, null, null, null, null]); // 7 days

    // Keep refs in sync with state
    useEffect(() => { endActionsRef.current = endActions; }, [endActions]);
    useEffect(() => { playlistRef.current = playlist; }, [playlist]);
    useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
    useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
    useEffect(() => { sourceStateRef.current = sourceState; }, [sourceState]);

    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);

    const [videoInfo, setVideoInfo] = useState({
        title: "No local video loaded",
        currentTime: "00:00:00",
        remainingTime: "00:00:00"
    });
    const [statusText, setStatusText] = useState("Not loaded");

    // Use custom hook for time updates
    const timeInfo = usePlayerTime(LOCAL_PLAYER_EVENT_KEY, 'local');

    // Load state from localStorage - runs ONCE on mount
    useEffect(() => {
        // Load main player state
        const saved = localStorage.getItem('localPCPlayerState');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                console.log('LocalPCPlayer LOAD: playlist from localStorage:', parsed.playlist);
                if (parsed.playlist && parsed.playlist.length > 0) {
                    setPlaylist(parsed.playlist);
                }
                if (typeof parsed.currentIndex === 'number') {
                    setCurrentIndex(parsed.currentIndex);
                }
                setIsPlaying(parsed.isPlaying ?? true);
                setIsMuted(parsed.isMuted ?? false);
                setIsStopped(parsed.isStopped ?? false);
                // Restore video title if playlist exists
                if (parsed.playlist && parsed.playlist.length > 0) {
                    const current = parsed.playlist[parsed.currentIndex || 0];
                    if (current && current.path) {
                        setVideoInfo(prev => ({ ...prev, title: current.path.split(/[\\/]/).pop() }));
                    }
                }
            } catch (e) {
                console.error('LocalPCPlayer LOAD: Error parsing main state:', e);
            }
        }

        // Load endActions from SEPARATE key
        const savedEndActions = localStorage.getItem('localPCPlayerEndActions');
        if (savedEndActions) {
            try {
                const parsedEndActions = JSON.parse(savedEndActions);
                console.log('LocalPCPlayer LOAD: endActions:', parsedEndActions);
                setEndActions(parsedEndActions);
            } catch (e) {
                console.error('LocalPCPlayer LOAD: Error parsing endActions:', e);
            }
        }

        // Mark as initialized AFTER setting all state - this will trigger a re-render
        // and only then will the save effects start working
        // Use setTimeout to ensure this runs after React processes state updates
        setTimeout(() => {
            isInitialized.current = true;
            console.log('LocalPCPlayer: Initialization complete, saving enabled');
        }, 100);
    }, []);

    // Save main player state (excludes endActions) - only after initialization
    useEffect(() => {
        if (!isInitialized.current) {
            console.log('LocalPCPlayer SAVE: Skipping save, not initialized yet');
            return;
        }

        // Filter out blob URLs and empty paths from localStorage
        const persistablePlaylist = playlist.map(item => ({
            ...item,
            path: item.path?.startsWith('blob:') ? '' : item.path
        })).filter(item => item.path && item.path.trim() !== '');

        const state = {
            playlist: persistablePlaylist,
            currentIndex,
            isPlaying,
            isMuted,
            isStopped
        };
        console.log('LocalPCPlayer SAVE: Saving state:', state);
        localStorage.setItem('localPCPlayerState', JSON.stringify(state));
    }, [playlist, currentIndex, isPlaying, isMuted, isStopped]);

    // Save endActions to SEPARATE key - only after initialization
    useEffect(() => {
        if (!isInitialized.current) return;
        // Only save if we have at least one non-null value (user has set something)
        const hasAnyValue = endActions.some(action => action !== null);
        if (hasAnyValue) {
            console.log('LocalPCPlayer SAVE: endActions:', endActions);
            localStorage.setItem('localPCPlayerEndActions', JSON.stringify(endActions));
        }
    }, [endActions]);

    // Resume playback when OBS visibility changes - sends actual player commands
    const resumePlayback = () => {
        if (playlist.length === 0) return;
        const currentVideo = playlist[currentIndex];
        if (currentVideo && currentVideo.path) {
            const displayName = currentVideo.name || currentVideo.path.split(/[\\/]/).pop();
            setVideoInfo(prev => ({ ...prev, title: displayName }));
            // Get start/end times in seconds
            const startSeconds = currentVideo.startTime ? timeToSeconds(currentVideo.startTime) : 0;
            const endSeconds = currentVideo.endTime ? timeToSeconds(currentVideo.endTime) : null;
            // loadVideo command auto-plays with sound
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(currentVideo.path));
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText("Playing");
        }
    };

    // Track mount time to prevent visibility commands on initial mount
    const mountTime = useRef(Date.now());
    // Track previous visibility value to detect actual CHANGES (not just mount)
    const prevIsVisible = useRef(undefined);

    // Visibility reaction - ONLY react to actual changes, not initial mount
    useEffect(() => {
        // Guard: Ignore any visibility effects within 500ms of mount
        const timeSinceMount = Date.now() - mountTime.current;
        if (timeSinceMount < 500) {
            console.log('LocalPCPlayer: Ignoring visibility effect within 500ms of mount, time:', timeSinceMount);
            prevIsVisible.current = isVisible;
            return;
        }

        // prevIsVisible.current is undefined on first mount
        // Only send commands when visibility actually CHANGES
        if (prevIsVisible.current === undefined) {
            // First mount - just record current value, don't send any commands
            console.log('LocalPCPlayer: Initial mount, visibility:', isVisible, '- not sending commands');
            prevIsVisible.current = isVisible;
            return;
        }

        // Check if visibility actually changed
        if (prevIsVisible.current === isVisible) {
            console.log('LocalPCPlayer: Visibility unchanged, skipping');
            return;
        }

        // Visibility actually changed - now react
        prevIsVisible.current = isVisible;

        if (isVisible) {
            console.log('LocalPCPlayer: Visibility CHANGED to visible, resuming playback');
            resumePlayback();
        } else {
            console.log('LocalPCPlayer: Visibility CHANGED to hidden, pausing');
            sendPlayerCommand('localPCPlayerCommand', 'pause');
            setIsPlaying(false);
            setIsStopped(false);
            setStatusText("Local Player Paused");
        }
    }, [isVisible]);

    // Listen for video ended events from LocalPCPlayer.html
    useEffect(() => {
        const handleStorageEvent = (event) => {
            if (event.key === LOCAL_PLAYER_EVENT_KEY && event.newValue) {
                try {
                    const data = JSON.parse(event.newValue);
                    if (data.playerType === 'local' && data.event === 'videoEnded') {
                        console.log('LocalPCPlayer: Video ended.');
                        handleVideoEnded();
                    }
                } catch (e) {
                    console.error('Error parsing LocalPCPlayer event:', e);
                }
            }
        };

        window.addEventListener('storage', handleStorageEvent);
        return () => window.removeEventListener('storage', handleStorageEvent);
    }, []); // Empty deps - uses refs for latest values

    // Handle video ended - advance to next or trigger end action
    const handleVideoEnded = () => {
        // Use refs to get latest values (avoids stale closure)
        const currentIdx = currentIndexRef.current;
        const currentPlaylist = playlistRef.current;
        const currentEndActions = endActionsRef.current;

        const nextIdx = currentIdx + 1;

        console.log(`LocalPCPlayer: handleVideoEnded - currentIdx=${currentIdx}, playlistLength=${currentPlaylist.length}, endActions=`, currentEndActions);

        if (nextIdx < currentPlaylist.length) {
            // More videos in playlist - play next
            console.log(`LocalPCPlayer: Playing next video at index ${nextIdx}`);
            setCurrentIndex(nextIdx);
            const nextVideo = currentPlaylist[nextIdx];
            if (nextVideo && nextVideo.path) {
                const displayName = nextVideo.name || nextVideo.path.split(/[\\/]/).pop();
                setVideoInfo(prev => ({ ...prev, title: displayName }));
                // Get start/end times in seconds
                const startSeconds = nextVideo.startTime ? timeToSeconds(nextVideo.startTime) : 0;
                const endSeconds = nextVideo.endTime ? timeToSeconds(nextVideo.endTime) : null;
                // loadVideo command auto-plays with sound
                sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(nextVideo.path));
                setIsPlaying(true);
                setIsStopped(false);
                setStatusText(`Playing ${nextIdx + 1} of ${currentPlaylist.length}`);
            }
        } else {
            // End of playlist - trigger end action based on day
            const currentDay = new Date().getDay(); // 0 = Sunday, 6 = Saturday
            const targetScene = currentEndActions[currentDay];

            console.log(`LocalPCPlayer: Playlist ended. Day=${currentDay} (${daysMap[currentDay]}), targetScene="${targetScene}"`);

            sendPlayerCommand('localPCPlayerCommand', 'stop');
            setIsPlaying(false);
            setIsStopped(true);
            setCurrentIndex(0); // Reset to start

            // Only switch if Local Player is currently visible (use ref for latest value)
            if (isVisibleRef.current) {
                const currentSourceState = sourceStateRef.current;
                if (targetScene && sourceNames.includes(targetScene) && targetScene !== "Local Player") {
                    console.log(`LocalPCPlayer: Switching to "${targetScene}" for ${daysMap[currentDay]}`);
                    // Log the source change
                    logSourceChange(targetScene, true, 'playlist_ended', 'Local Player');
                    logVideoEnd('Local Player', null, `switch_to_${targetScene}`);

                    // Match core.js: If switching to Loop Player while Live Player is active, hide Live Player first
                    if (currentSourceState["Live Player"] && targetScene === "Loop Player") {
                        setSourceVisibility("Live Player", false);
                    }

                    setSourceVisibility(targetScene, true);  // This will auto-hide Local Player via exclusivity
                    setStatusText(`Switched to ${targetScene}`);
                } else {
                    // Default: Switch to Loop Player if no valid end action configured
                    console.log(`LocalPCPlayer: No valid end action for ${daysMap[currentDay]}. Defaulting to Loop Player.`);
                    // Log the source change
                    logSourceChange('Loop Player', true, 'playlist_ended_default', 'Local Player');
                    logVideoEnd('Local Player', null, 'switch_to_Loop Player');

                    // Match core.js: If Live Player is active, hide it first
                    if (currentSourceState["Live Player"]) {
                        setSourceVisibility("Live Player", false);
                    }

                    setSourceVisibility("Loop Player", true);
                    setStatusText("Switched to Loop Player");
                }
            }
        }
    };

    const addVideoPath = () => {
        setPlaylist([...playlist, { path: "", startTime: "", endTime: "" }]);
    };

    const updatePath = (index, value) => {
        const newPlaylist = playlist.map((item, i) =>
            i === index ? { ...item, path: value } : item
        );
        setPlaylist(newPlaylist);
    };

    const updateStartTime = (index, value) => {
        const newPlaylist = playlist.map((item, i) =>
            i === index ? { ...item, startTime: value } : item
        );
        setPlaylist(newPlaylist);
    };

    const updateEndTime = (index, value) => {
        const newPlaylist = playlist.map((item, i) =>
            i === index ? { ...item, endTime: value } : item
        );
        setPlaylist(newPlaylist);
    };

    const removePath = (index) => {
        const newPlaylist = playlist.filter((_, i) => i !== index);
        setPlaylist(newPlaylist);
    };

    // Convert path to appropriate URL format
    const convertToFileUrl = (path) => {
        if (!path) return path;
        // If already a proper URL (file://, blob:, http://, https://), return as-is
        if (path.startsWith('file:///') || path.startsWith('blob:') || path.startsWith('http://') || path.startsWith('https://')) {
            return path;
        }
        // If path starts with /, it's a public folder path - convert to localhost URL
        if (path.startsWith('/')) {
            return `${window.location.origin}${path}`;
        }
        // Windows absolute path (like C:\ or I:\) - convert to file:// URL
        if (/^[A-Za-z]:[\\/]/.test(path)) {
            const normalized = path.replace(/\\/g, '/');
            return `file:///${normalized}`;
        }
        // Relative path (like video.mp4) - treat as public folder
        return `${window.location.origin}/${path}`;
    };

    // File picker using modern File System Access API
    const handleFilePicker = async () => {
        try {
            // Modern File System Access API
            if ('showOpenFilePicker' in window) {
                const handles = await window.showOpenFilePicker({
                    multiple: true,
                    types: [{
                        description: 'Video Files',
                        accept: { 'video/*': ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'] }
                    }]
                });

                for (const handle of handles) {
                    const file = await handle.getFile();
                    // Create a blob URL for the file
                    const blobUrl = URL.createObjectURL(file);
                    setPlaylist(prev => [...prev, { path: blobUrl, name: file.name }]);
                }
                setStatusText(`Added ${handles.length} file(s)`);
            } else {
                // Fallback: use hidden input
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'video/*';
                input.multiple = true;
                input.onchange = (e) => {
                    const files = Array.from(e.target.files);
                    files.forEach(file => {
                        const blobUrl = URL.createObjectURL(file);
                        setPlaylist(prev => [...prev, { path: blobUrl, name: file.name }]);
                    });
                    setStatusText(`Added ${files.length} file(s)`);
                };
                input.click();
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                setStatusText("File picker cancelled or failed");
            }
        }
    };

    const handleLoadAndPlay = () => {
        if (playlist.length === 0) {
            setStatusText("No videos in playlist");
            return;
        }

        const currentVideo = playlist[currentIndex];
        if (currentVideo && currentVideo.path) {
            const displayName = currentVideo.name || currentVideo.path.split(/[\\/]/).pop();
            setVideoInfo(prev => ({ ...prev, title: displayName }));
            // Get start/end times in seconds
            const startSeconds = currentVideo.startTime ? timeToSeconds(currentVideo.startTime) : 0;
            const endSeconds = currentVideo.endTime ? timeToSeconds(currentVideo.endTime) : null;
            // loadVideo command auto-plays with sound
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(currentVideo.path));
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText(`Playing: ${displayName}`);
        }
    };

    const handlePlayPause = () => {
        if (isPlaying) {
            sendPlayerCommand('localPCPlayerCommand', 'pause');
            setIsPlaying(false);
            setStatusText("Paused");
        } else {
            sendPlayerCommand('localPCPlayerCommand', 'play');
            setIsPlaying(true);
            setStatusText("Playing");
        }
    };

    const handleStop = () => {
        sendPlayerCommand('localPCPlayerCommand', 'stop');
        setIsPlaying(false);
        setIsStopped(true);
        setStatusText("Stopped");
    };

    const handleNext = () => {
        if (playlist.length === 0) return;
        let nextIdx = currentIndex + 1;
        if (nextIdx >= playlist.length) nextIdx = 0;
        setCurrentIndex(nextIdx);
        const currentVideo = playlist[nextIdx];
        if (currentVideo && currentVideo.path) {
            const displayName = currentVideo.name || currentVideo.path.split(/[\\/]/).pop();
            setVideoInfo(prev => ({ ...prev, title: displayName }));
            // Get start/end times in seconds
            const startSeconds = currentVideo.startTime ? timeToSeconds(currentVideo.startTime) : 0;
            const endSeconds = currentVideo.endTime ? timeToSeconds(currentVideo.endTime) : null;
            // loadVideo command auto-plays with sound
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(currentVideo.path));
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText("Playing");
        }
    };

    const handlePrev = () => {
        if (playlist.length === 0) return;
        let prevIdx = currentIndex - 1;
        if (prevIdx < 0) prevIdx = playlist.length - 1;
        setCurrentIndex(prevIdx);
        const currentVideo = playlist[prevIdx];
        if (currentVideo && currentVideo.path) {
            const displayName = currentVideo.name || currentVideo.path.split(/[\\/]/).pop();
            setVideoInfo(prev => ({ ...prev, title: displayName }));
            // Get start/end times in seconds
            const startSeconds = currentVideo.startTime ? timeToSeconds(currentVideo.startTime) : 0;
            const endSeconds = currentVideo.endTime ? timeToSeconds(currentVideo.endTime) : null;
            // loadVideo command auto-plays with sound
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(currentVideo.path));
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText("Playing");
        }
    };

    const handleMute = () => {
        if (isMuted) {
            sendPlayerCommand('localPCPlayerCommand', 'unmute');
            setIsMuted(false);
            setStatusText("Unmuted");
        } else {
            sendPlayerCommand('localPCPlayerCommand', 'mute');
            setIsMuted(true);
            setStatusText("Muted");
        }
    };

    // Drag-drop handlers for reordering playlist
    const handleDragStart = (e, index) => {
        dragIndex.current = index;
        e.dataTransfer.effectAllowed = "move";
    };

    const handleDragOver = (e, index) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
    };

    const handleDrop = (e, targetIndex) => {
        e.preventDefault();
        if (dragIndex.current === null || dragIndex.current === targetIndex) return;

        const newPlaylist = [...playlist];
        const [movedItem] = newPlaylist.splice(dragIndex.current, 1);
        newPlaylist.splice(targetIndex, 0, movedItem);
        setPlaylist(newPlaylist);

        // Adjust currentIndex if needed
        if (dragIndex.current === currentIndex) {
            setCurrentIndex(targetIndex);
        } else if (dragIndex.current < currentIndex && targetIndex >= currentIndex) {
            setCurrentIndex(currentIndex - 1);
        } else if (dragIndex.current > currentIndex && targetIndex <= currentIndex) {
            setCurrentIndex(currentIndex + 1);
        }

        dragIndex.current = null;
        setStatusText("Playlist reordered");
    };

    // Update end action for a specific day
    const updateEndAction = (dayIndex, value) => {
        const newEndActions = [...endActions];
        newEndActions[dayIndex] = value || null;
        setEndActions(newEndActions);
    };

    // Export playlist data to clipboard
    const handleExport = async () => {
        const timestamp = new Date().toLocaleString();
        const playlistPaths = playlist.map((item, i) => `${i + 1}. ${item.path || "Empty"}`).join('\n');
        const endActionsStr = endActions.map((action, i) => `${daysMap[i]}: ${action || "Do Nothing"}`).join(', ');
        const data = `Local PC Player Playlist\nTimestamp: ${timestamp}\nCurrent: ${currentIndex + 1}/${playlist.length}\n\nPlaylist:\n${playlistPaths}\n\nEnd Actions: ${endActionsStr}`;
        try {
            await navigator.clipboard.writeText(data);
            setStatusText("Data copied to clipboard!");
        } catch (err) {
            setStatusText("Failed to copy");
        }
    };

    return (
        <div className="player-control-card">
            <h3>Local PC Player</h3>
            <p className="video-title">{videoInfo.title}</p>
            <p className="video-time-display">{timeInfo.currentTime} / {timeInfo.remainingTime}</p>
            <p className="video-info-display">{playlist.length > 0 ? `Video ${currentIndex + 1} of ${playlist.length}` : ''}</p>

            <div className="w-full flex flex-col gap-2">
                {playlist.map((item, index) => (
                    <div
                        key={index}
                        className="flex gap-2 cursor-move"
                        draggable
                        onDragStart={(e) => handleDragStart(e, index)}
                        onDragOver={(e) => handleDragOver(e, index)}
                        onDrop={(e) => handleDrop(e, index)}
                    >
                        <span className="text-gray-400 px-2 flex items-center">{index + 1}</span>
                        <input
                            type="text"
                            className="input-field flex-1"
                            placeholder="Video Path"
                            value={item.path}
                            onChange={(e) => updatePath(index, e.target.value)}
                        />
                        <input
                            type="text"
                            className="input-field"
                            style={{ width: '70px' }}
                            placeholder="Start"
                            title="Start time (MM:SS or HH:MM:SS)"
                            value={item.startTime || ''}
                            onChange={(e) => updateStartTime(index, e.target.value)}
                        />
                        <input
                            type="text"
                            className="input-field"
                            style={{ width: '70px' }}
                            placeholder="End"
                            title="End time (MM:SS or HH:MM:SS)"
                            value={item.endTime || ''}
                            onChange={(e) => updateEndTime(index, e.target.value)}
                        />
                        <button className="btn-danger rounded px-2" onClick={() => removePath(index)}>X</button>
                    </div>
                ))}
            </div>
            <div className="flex gap-2 mt-2 w-full">
                <button className="common-btn-style btn-primary w-full" onClick={addVideoPath}>Add Path +</button>
            </div>

            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-primary" onClick={handleLoadAndPlay}>Load Playlist</PlayerControlBtn>
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
                <PlayerControlBtn className="btn-neutral" onClick={handleExport}>Export Data</PlayerControlBtn>
            </div>

            {/* End Actions - Scene to switch to when playlist ends */}
            <div className="mt-3 w-full">
                <p className="text-sm text-gray-400 mb-2">End of Playlist Actions (by day):</p>
                <div className="flex flex-wrap gap-2 justify-center">
                    {daysMap.map((day, i) => (
                        <div key={i} className="flex flex-col items-center">
                            <label className="text-xs text-gray-400 mb-1 font-medium">{day}</label>
                            <select
                                className="rounded border-2 font-medium cursor-pointer"
                                style={{
                                    backgroundColor: endActions[i] ? '#00adb5' : '#2d2d44',
                                    color: endActions[i] ? '#fff' : '#aaa',
                                    borderColor: endActions[i] ? '#00adb5' : '#444',
                                    padding: '6px 8px',
                                    minWidth: '65px',
                                    fontSize: '11px'
                                }}
                                value={endActions[i] || ""}
                                onChange={(e) => updateEndAction(i, e.target.value)}
                            >
                                <option value="" style={{ backgroundColor: '#2d2d44', color: '#aaa' }}>None</option>
                                {sourceNames.filter(s => s !== "Local Player").map((src) => (
                                    <option key={src} value={src} style={{ backgroundColor: '#2d2d44', color: '#fff' }}>
                                        {src.replace(" Player", "").replace(" Live", "")}
                                    </option>
                                ))}
                            </select>
                        </div>
                    ))}
                </div>
            </div>

            <p className="player-status">{statusText}</p>
        </div >
    );
};

export default LocalPlayerCard;
