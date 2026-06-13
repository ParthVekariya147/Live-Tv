
import React, { useState, useEffect, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, LOCAL_PLAYER_EVENT_KEY, timeToSeconds } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { logSourceChange, logVideoEnd } from '../utils/logger';
import PlayerControlBtn from './common/PlayerControlBtn';

const daysMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const sourceNames = ["Loop Player", "Live Player", "Delay Live", "Local Player"];

const LocalPlayerCard = () => {
    const { sourceState, setSourceVisibility } = useOBS();
    const isVisible = sourceState["Local Player"];
    const isInitialized = useRef(false);
    const dragIndex = useRef(null);
    const isPlayingRef = useRef(false);
    const isStoppedRef = useRef(false);

    const endActionsRef = useRef([null, null, null, null, null, null, null]);
    const playlistRef = useRef([]);
    const currentIndexRef = useRef(0);
    const isVisibleRef = useRef(false);
    const sourceStateRef = useRef({});

    const [playlist, setPlaylist] = useState([]); // { path, name, startTime, endTime, enabled }
    const [currentIndex, setCurrentIndex] = useState(0);
    const [endActions, setEndActions] = useState([null, null, null, null, null, null, null]);

    // Folder scan state
    const [folderPath, setFolderPath] = useState('');
    const [videosFolder, setVideosFolder] = useState('');
    const [isScanningFolder, setIsScanningFolder] = useState(false);
    const [isDragOverPlaylist, setIsDragOverPlaylist] = useState(false);

    useEffect(() => { endActionsRef.current = endActions; }, [endActions]);
    useEffect(() => { playlistRef.current = playlist; }, [playlist]);
    useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
    useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
    useEffect(() => { sourceStateRef.current = sourceState; }, [sourceState]);

    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);

    // Keep playing/stopped refs in sync — declared after useState so no TDZ issue
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
    useEffect(() => { isStoppedRef.current = isStopped; }, [isStopped]);

    const [videoInfo, setVideoInfo] = useState({ title: "No local video loaded" });
    const [statusText, setStatusText] = useState("Not loaded");

    const timeInfo = usePlayerTime(LOCAL_PLAYER_EVENT_KEY, 'local');

    // PROACTIVE SKIP: whenever playlist or currentIndex changes, check if current video is
    // disabled. If yes and player is in playing mode → immediately advance to next enabled.
    // This is the "human thinking" logic: you don't wait for a disabled video to "end" —
    // you just skip past it the moment you notice it's OFF.
    useEffect(() => {
        if (!isInitialized.current) return;
        if (playlist.length === 0) return;
        // Only auto-skip when actively in playing mode (not stopped by user)
        if (isStoppedRef.current || !isPlayingRef.current) return;

        const current = playlist[currentIndex];
        if (!current || current.enabled !== false) return; // current is ON — nothing to do

        // Current video is OFF — skip immediately
        const nextIdx = findNextEnabledIndex(currentIndex + 1, playlist);
        if (nextIdx !== -1) {
            setCurrentIndex(nextIdx);
            const nextVideo = playlist[nextIdx];
            if (nextVideo?.path) {
                const displayName = nextVideo.name || nextVideo.path.split(/[\\/]/).pop();
                setVideoInfo({ title: displayName });
                const startSec = nextVideo.startTime ? timeToSeconds(nextVideo.startTime) : 0;
                const endSec = nextVideo.endTime ? timeToSeconds(nextVideo.endTime) : null;
                sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSec, endSec, convertToFileUrl(nextVideo.path));
                setIsPlaying(true);
                setIsStopped(false);
                setStatusText(`Skipped OFF → Playing: ${displayName}`);
            }
        } else {
            // No enabled videos left after current — stop
            sendPlayerCommand('localPCPlayerCommand', 'stop');
            setIsPlaying(false);
            setIsStopped(true);
            setCurrentIndex(0);
            setStatusText("No enabled videos — stopped");
        }
    }, [playlist, currentIndex]); // triggers when user toggles ON/OFF or reorders

    // Fetch default videos folder path on mount
    useEffect(() => {
        fetch('/api/videos/root-folder')
            .then(r => r.json())
            .then(d => { if (d.success) setVideosFolder(d.folder); })
            .catch(() => {});
    }, []);

    // Load state from localStorage
    useEffect(() => {
        const saved = localStorage.getItem('localPCPlayerState');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (parsed.playlist && parsed.playlist.length > 0) {
                    // Migrate old items that don't have 'enabled' field
                    const migrated = parsed.playlist.map(item => ({
                        ...item,
                        enabled: item.enabled !== false
                    }));
                    setPlaylist(migrated);
                }
                if (typeof parsed.currentIndex === 'number') setCurrentIndex(parsed.currentIndex);
                setIsPlaying(parsed.isPlaying ?? true);
                setIsMuted(parsed.isMuted ?? false);
                setIsStopped(parsed.isStopped ?? false);
                if (parsed.playlist && parsed.playlist.length > 0) {
                    const current = parsed.playlist[parsed.currentIndex || 0];
                    if (current?.path) {
                        setVideoInfo(prev => ({ ...prev, title: current.path.split(/[\\/]/).pop() }));
                    }
                }
            } catch (e) {
                console.error('LocalPCPlayer LOAD error:', e);
            }
        }

        const savedEndActions = localStorage.getItem('localPCPlayerEndActions');
        if (savedEndActions) {
            try {
                setEndActions(JSON.parse(savedEndActions));
            } catch (e) {}
        }

        setTimeout(() => { isInitialized.current = true; }, 100);
    }, []);

    // Save main player state
    useEffect(() => {
        if (!isInitialized.current) return;
        const persistablePlaylist = playlist
            .map(item => ({ ...item, path: item.path?.startsWith('blob:') ? '' : item.path }))
            .filter(item => item.path && item.path.trim() !== '');
        localStorage.setItem('localPCPlayerState', JSON.stringify({
            playlist: persistablePlaylist, currentIndex, isPlaying, isMuted, isStopped
        }));
    }, [playlist, currentIndex, isPlaying, isMuted, isStopped]);

    // Save endActions
    useEffect(() => {
        if (!isInitialized.current) return;
        if (endActions.some(a => a !== null)) {
            localStorage.setItem('localPCPlayerEndActions', JSON.stringify(endActions));
        }
    }, [endActions]);

    const convertToFileUrl = (path) => {
        if (!path) return path;
        if (path.startsWith('file:///') || path.startsWith('blob:') || path.startsWith('http://') || path.startsWith('https://')) return path;
        if (path.startsWith('/')) return `${window.location.origin}${path}`;
        if (/^[A-Za-z]:[\\/]/.test(path)) return `file:///${path.replace(/\\/g, '/')}`;
        return `${window.location.origin}/${path}`;
    };

    // Find next enabled index starting from `from`, wrapping around
    const findNextEnabledIndex = (from, pl) => {
        if (!pl || pl.length === 0) return -1;
        for (let i = from; i < pl.length; i++) {
            if (pl[i].enabled !== false) return i;
        }
        return -1;
    };

    const resumePlayback = () => {
        const pl = playlistRef.current;
        let ci = currentIndexRef.current;
        if (pl.length === 0) return;

        // Skip disabled videos starting from saved position
        if (pl[ci]?.enabled === false) {
            const nextEnabled = findNextEnabledIndex(ci + 1, pl);
            if (nextEnabled === -1) return; // all remaining disabled — do nothing
            ci = nextEnabled;
            setCurrentIndex(ci);
        }

        const currentVideo = pl[ci];
        if (currentVideo?.path) {
            const displayName = currentVideo.name || currentVideo.path.split(/[\\/]/).pop();
            setVideoInfo({ title: displayName });
            const startSeconds = currentVideo.startTime ? timeToSeconds(currentVideo.startTime) : 0;
            const endSeconds = currentVideo.endTime ? timeToSeconds(currentVideo.endTime) : null;
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(currentVideo.path));
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
        if (timeSinceMount < 500) { prevIsVisible.current = isVisible; return; }
        if (prevIsVisible.current === undefined) { prevIsVisible.current = isVisible; return; }
        if (prevIsVisible.current === isVisible) return;
        prevIsVisible.current = isVisible;
        if (isVisible) { resumePlayback(); } else {
            sendPlayerCommand('localPCPlayerCommand', 'pause');
            setIsPlaying(false);
            setIsStopped(false);
            setStatusText("Local Player Paused");
        }
    }, [isVisible]);

    useEffect(() => {
        const handleStorageEvent = (event) => {
            if (event.key === LOCAL_PLAYER_EVENT_KEY && event.newValue) {
                try {
                    const data = JSON.parse(event.newValue);
                    if (data.playerType === 'local' && data.event === 'videoEnded') handleVideoEnded();
                } catch (e) {}
            }
        };
        window.addEventListener('storage', handleStorageEvent);
        return () => window.removeEventListener('storage', handleStorageEvent);
    }, []);

    const handleVideoEnded = () => {
        const currentIdx = currentIndexRef.current;
        const currentPlaylist = playlistRef.current;
        const currentEndActions = endActionsRef.current;

        // Find next enabled video after current
        const nextIdx = findNextEnabledIndex(currentIdx + 1, currentPlaylist);

        if (nextIdx !== -1) {
            setCurrentIndex(nextIdx);
            const nextVideo = currentPlaylist[nextIdx];
            if (nextVideo?.path) {
                const displayName = nextVideo.name || nextVideo.path.split(/[\\/]/).pop();
                setVideoInfo(prev => ({ ...prev, title: displayName }));
                const startSeconds = nextVideo.startTime ? timeToSeconds(nextVideo.startTime) : 0;
                const endSeconds = nextVideo.endTime ? timeToSeconds(nextVideo.endTime) : null;
                sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(nextVideo.path));
                setIsPlaying(true);
                setIsStopped(false);
                setStatusText(`Playing ${nextIdx + 1} of ${currentPlaylist.length}`);
            }
        } else {
            const currentDay = new Date().getDay();
            const targetScene = currentEndActions[currentDay];
            sendPlayerCommand('localPCPlayerCommand', 'stop');
            setIsPlaying(false);
            setIsStopped(true);
            setCurrentIndex(0);

            if (isVisibleRef.current) {
                const currentSourceState = sourceStateRef.current;
                if (targetScene && sourceNames.includes(targetScene) && targetScene !== "Local Player") {
                    logSourceChange(targetScene, true, 'playlist_ended', 'Local Player');
                    logVideoEnd('Local Player', null, `switch_to_${targetScene}`);
                    if (currentSourceState["Live Player"] && targetScene === "Loop Player") setSourceVisibility("Live Player", false);
                    setSourceVisibility(targetScene, true);
                    setStatusText(`Switched to ${targetScene}`);
                } else {
                    logSourceChange('Loop Player', true, 'playlist_ended_default', 'Local Player');
                    logVideoEnd('Local Player', null, 'switch_to_Loop Player');
                    if (currentSourceState["Live Player"]) setSourceVisibility("Live Player", false);
                    setSourceVisibility("Loop Player", true);
                    setStatusText("Switched to Loop Player");
                }
            }
        }
    };

    // ============================================
    // PLAYLIST MANAGEMENT
    // ============================================

    const addVideoPath = () => {
        setPlaylist(prev => [...prev, { path: "", startTime: "", endTime: "", enabled: true }]);
    };

    const updatePath = (index, value) => {
        // Clear name so path is shown — prevents name from overriding display when user types
        setPlaylist(prev => prev.map((item, i) => i === index ? { ...item, path: value, name: '' } : item));
    };

    const updateStartTime = (index, value) => {
        setPlaylist(prev => prev.map((item, i) => i === index ? { ...item, startTime: value } : item));
    };

    const updateEndTime = (index, value) => {
        setPlaylist(prev => prev.map((item, i) => i === index ? { ...item, endTime: value } : item));
    };

    const toggleEnabled = (index) => {
        setPlaylist(prev => prev.map((item, i) =>
            i === index ? { ...item, enabled: item.enabled === false ? true : false } : item
        ));
    };

    const removePath = (index) => {
        const item = playlist[index];
        if (item?.path?.startsWith('blob:')) URL.revokeObjectURL(item.path);
        setPlaylist(prev => prev.filter((_, i) => i !== index));
    };

    // ============================================
    // AUTO-SCAN VIDEOS FOLDER
    // ============================================

    const handleScanVideosFolder = async () => {
        setIsScanningFolder(true);
        setStatusText("Scanning videos folder...");
        try {
            const res = await fetch('/api/videos/scan');
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            if (data.files.length === 0) {
                setStatusText(`No video files found in: ${data.folder}`);
                return;
            }
            const newItems = data.files.map(f => ({
                path: f.serverPath,
                name: f.name,
                startTime: "",
                endTime: "",
                enabled: true
            }));
            setPlaylist(newItems);
            setCurrentIndex(0);
            setStatusText(`Loaded ${newItems.length} video(s) from videos folder`);
        } catch (err) {
            setStatusText("Scan failed: " + err.message);
        } finally {
            setIsScanningFolder(false);
        }
    };

    const handleScanCustomFolder = async () => {
        const trimmed = folderPath.trim();
        if (!trimmed) { setStatusText("Enter a folder path first"); return; }
        setIsScanningFolder(true);
        setStatusText("Scanning folder...");
        try {
            const res = await fetch('/api/videos/scan-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath: trimmed })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            if (data.files.length === 0) {
                setStatusText(`No video files found in: ${trimmed}`);
                return;
            }
            const newItems = data.files.map(f => ({
                path: f.absolutePath,
                name: f.name,
                startTime: "",
                endTime: "",
                enabled: true
            }));
            setPlaylist(prev => [...prev, ...newItems]);
            setStatusText(`Added ${newItems.length} video(s) from folder`);
        } catch (err) {
            setStatusText("Scan failed: " + err.message);
        } finally {
            setIsScanningFolder(false);
        }
    };

    // ============================================
    // FILE PICKER
    // ============================================

    const handleFilePicker = async () => {
        try {
            if ('showOpenFilePicker' in window) {
                const handles = await window.showOpenFilePicker({
                    multiple: true,
                    types: [{ description: 'Video Files', accept: { 'video/*': ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'] } }]
                });
                for (const handle of handles) {
                    const file = await handle.getFile();
                    const blobUrl = URL.createObjectURL(file);
                    setPlaylist(prev => [...prev, { path: blobUrl, name: file.name, startTime: "", endTime: "", enabled: true }]);
                }
                setStatusText(`Added ${handles.length} file(s)`);
            } else {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'video/*';
                input.multiple = true;
                input.onchange = (e) => {
                    const files = Array.from(e.target.files);
                    files.forEach(file => {
                        const blobUrl = URL.createObjectURL(file);
                        setPlaylist(prev => [...prev, { path: blobUrl, name: file.name, startTime: "", endTime: "", enabled: true }]);
                    });
                    setStatusText(`Added ${files.length} file(s)`);
                };
                input.click();
            }
        } catch (err) {
            if (err.name !== 'AbortError') setStatusText("File picker cancelled or failed");
        }
    };

    // ============================================
    // DRAG-DROP FROM FILESYSTEM
    // ============================================

    const handlePlaylistDragOver = (e) => {
        // Only show drop zone when dragging from filesystem (has files)
        if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setIsDragOverPlaylist(true);
        }
    };

    const handlePlaylistDragLeave = (e) => {
        // Only clear if leaving the whole container
        if (!e.currentTarget.contains(e.relatedTarget)) {
            setIsDragOverPlaylist(false);
        }
    };

    const handlePlaylistFileDrop = (e) => {
        e.preventDefault();
        setIsDragOverPlaylist(false);
        const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'];
        const files = Array.from(e.dataTransfer.files).filter(f =>
            VIDEO_EXTS.some(ext => f.name.toLowerCase().endsWith(ext))
        );
        if (files.length === 0) { setStatusText("No video files in drop"); return; }
        files.forEach(file => {
            const blobUrl = URL.createObjectURL(file);
            setPlaylist(prev => [...prev, { path: blobUrl, name: file.name, startTime: "", endTime: "", enabled: true }]);
        });
        setStatusText(`Added ${files.length} video file(s)`);
    };

    // ============================================
    // PLAYLIST REORDER DRAG-DROP
    // ============================================

    const handleDragStart = (e, index) => {
        dragIndex.current = index;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData('text/plain', String(index)); // mark as row drag, not file drag
    };

    const handleItemDragOver = (e, index) => {
        // Only handle row-to-row reorder, not filesystem drops
        if (e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
    };

    const handleItemDrop = (e, targetIndex) => {
        // Let parent handle filesystem drops
        if (e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation(); // prevent parent handlePlaylistFileDrop from firing
        if (dragIndex.current === null || dragIndex.current === targetIndex) return;

        const newPlaylist = [...playlist];
        const [movedItem] = newPlaylist.splice(dragIndex.current, 1);
        newPlaylist.splice(targetIndex, 0, movedItem);
        setPlaylist(newPlaylist);

        if (dragIndex.current === currentIndex) setCurrentIndex(targetIndex);
        else if (dragIndex.current < currentIndex && targetIndex >= currentIndex) setCurrentIndex(currentIndex - 1);
        else if (dragIndex.current > currentIndex && targetIndex <= currentIndex) setCurrentIndex(currentIndex + 1);

        dragIndex.current = null;
        setStatusText("Playlist reordered");
    };

    // ============================================
    // PLAYBACK CONTROLS
    // ============================================

    const handleLoadAndPlay = () => {
        const enabledIdx = findNextEnabledIndex(0, playlist);
        if (enabledIdx === -1) { setStatusText("No enabled videos in playlist"); return; }
        setCurrentIndex(enabledIdx);
        const currentVideo = playlist[enabledIdx];
        if (currentVideo?.path) {
            const displayName = currentVideo.name || currentVideo.path.split(/[\\/]/).pop();
            setVideoInfo(prev => ({ ...prev, title: displayName }));
            const startSeconds = currentVideo.startTime ? timeToSeconds(currentVideo.startTime) : 0;
            const endSeconds = currentVideo.endTime ? timeToSeconds(currentVideo.endTime) : null;
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
        const nextIdx = findNextEnabledIndex(currentIndex + 1, playlist);
        const targetIdx = nextIdx !== -1 ? nextIdx : findNextEnabledIndex(0, playlist);
        if (targetIdx === -1) return;
        setCurrentIndex(targetIdx);
        const video = playlist[targetIdx];
        if (video?.path) {
            const displayName = video.name || video.path.split(/[\\/]/).pop();
            setVideoInfo(prev => ({ ...prev, title: displayName }));
            const startSeconds = video.startTime ? timeToSeconds(video.startTime) : 0;
            const endSeconds = video.endTime ? timeToSeconds(video.endTime) : null;
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(video.path));
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText("Playing");
        }
    };

    const handlePrev = () => {
        if (playlist.length === 0) return;
        // Find previous enabled going backwards
        let prevIdx = -1;
        for (let i = currentIndex - 1; i >= 0; i--) {
            if (playlist[i].enabled !== false) { prevIdx = i; break; }
        }
        if (prevIdx === -1) {
            // Wrap to end
            for (let i = playlist.length - 1; i > currentIndex; i--) {
                if (playlist[i].enabled !== false) { prevIdx = i; break; }
            }
        }
        if (prevIdx === -1) return;
        setCurrentIndex(prevIdx);
        const video = playlist[prevIdx];
        if (video?.path) {
            const displayName = video.name || video.path.split(/[\\/]/).pop();
            setVideoInfo(prev => ({ ...prev, title: displayName }));
            const startSeconds = video.startTime ? timeToSeconds(video.startTime) : 0;
            const endSeconds = video.endTime ? timeToSeconds(video.endTime) : null;
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(video.path));
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText("Playing");
        }
    };

    const handlePlayAt = (index) => {
        setCurrentIndex(index);
        const video = playlist[index];
        if (video?.path) {
            const displayName = video.name || video.path.split(/[\\/]/).pop();
            setVideoInfo({ title: displayName });
            const startSeconds = video.startTime ? timeToSeconds(video.startTime) : 0;
            const endSeconds = video.endTime ? timeToSeconds(video.endTime) : null;
            sendPlayerCommand('localPCPlayerCommand', 'loadVideo', null, startSeconds, endSeconds, convertToFileUrl(video.path));
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText(`Playing: ${displayName}`);
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

    const updateEndAction = (dayIndex, value) => {
        const newEndActions = [...endActions];
        newEndActions[dayIndex] = value || null;
        setEndActions(newEndActions);
    };

    const handleExport = async () => {
        const timestamp = new Date().toLocaleString();
        const playlistPaths = playlist.map((item, i) =>
            `${i + 1}. [${item.enabled !== false ? 'ON' : 'OFF'}] ${item.name || item.path || "Empty"}`
        ).join('\n');
        const endActionsStr = endActions.map((action, i) => `${daysMap[i]}: ${action || "Do Nothing"}`).join(', ');
        const data = `Local PC Player Playlist\nTimestamp: ${timestamp}\nCurrent: ${currentIndex + 1}/${playlist.length}\n\nPlaylist:\n${playlistPaths}\n\nEnd Actions: ${endActionsStr}`;
        try {
            await navigator.clipboard.writeText(data);
            setStatusText("Data copied to clipboard!");
        } catch (err) {
            setStatusText("Failed to copy");
        }
    };

    const enabledCount = playlist.filter(item => item.enabled !== false).length;

    return (
        <div className="player-control-card">
            <h3>Local PC Player</h3>
            <p className="video-title">{videoInfo.title}</p>
            <p className="video-time-display">{timeInfo.currentTime} / {timeInfo.remainingTime}</p>
            <p className="video-info-display">
                {playlist.length > 0 ? `Video ${currentIndex + 1} of ${playlist.length} (${enabledCount} enabled)` : ''}
            </p>

            {/* AUTO-SCAN VIDEOS FOLDER */}
            <div className="w-full mt-2">
                <div className="flex gap-2 items-center">
                    <button
                        className="common-btn-style btn-primary flex-1"
                        onClick={handleScanVideosFolder}
                        disabled={isScanningFolder}
                        title={`Scan videos folder: ${videosFolder}`}
                    >
                        {isScanningFolder ? "Scanning..." : "Load Videos Folder"}
                    </button>
                    <button
                        className="common-btn-style btn-neutral"
                        onClick={handleFilePicker}
                        title="Pick individual files"
                    >
                        Pick Files
                    </button>
                </div>

                {/* Custom folder path input */}
                <div className="flex gap-2 mt-2">
                    <input
                        type="text"
                        className="input-field flex-1"
                        placeholder={`Custom folder path (e.g. D:\\videos)`}
                        value={folderPath}
                        onChange={e => setFolderPath(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleScanCustomFolder()}
                    />
                    <button
                        className="common-btn-style btn-neutral"
                        onClick={handleScanCustomFolder}
                        disabled={isScanningFolder}
                        title="Scan the custom folder path above"
                    >
                        Scan
                    </button>
                </div>
                {videosFolder && (
                    <p style={{ fontSize: '10px', color: '#666', marginTop: '4px', wordBreak: 'break-all' }}>
                        Default folder: {videosFolder}
                    </p>
                )}
            </div>

            {/* PLAYLIST with drag-drop from filesystem */}
            <div
                className="w-full flex flex-col gap-2 mt-3"
                style={{
                    minHeight: '60px',
                    border: isDragOverPlaylist ? '2px dashed #00adb5' : '2px dashed transparent',
                    borderRadius: '8px',
                    padding: isDragOverPlaylist ? '8px' : '0',
                    transition: 'border-color 0.15s, padding 0.15s',
                    background: isDragOverPlaylist ? 'rgba(0,173,181,0.07)' : 'transparent'
                }}
                onDragOver={handlePlaylistDragOver}
                onDragLeave={handlePlaylistDragLeave}
                onDrop={handlePlaylistFileDrop}
            >
                {playlist.length === 0 && (
                    <div style={{ textAlign: 'center', color: '#555', padding: '20px 0', fontSize: '13px' }}>
                        {isDragOverPlaylist ? "Drop video files here" : "No videos — drag files here or use Load Videos Folder"}
                    </div>
                )}
                {playlist.map((item, index) => {
                    const isCurrentPlaying = index === currentIndex;
                    const isDisabled = item.enabled === false;
                    return (
                        <div
                            key={index}
                            style={{
                                display: 'flex',
                                gap: '6px',
                                alignItems: 'center',
                                opacity: isDisabled ? 0.45 : 1,
                                background: isCurrentPlaying ? 'rgba(0,173,181,0.13)' : 'transparent',
                                borderRadius: '6px',
                                padding: '2px 4px',
                                cursor: 'grab',
                                border: isCurrentPlaying ? '1px solid #00adb580' : '1px solid transparent'
                            }}
                            draggable
                            onDragStart={(e) => handleDragStart(e, index)}
                            onDragOver={(e) => handleItemDragOver(e, index)}
                            onDrop={(e) => handleItemDrop(e, index)}
                        >
                            {/* Drag handle + index */}
                            <span style={{ color: '#555', fontSize: '12px', minWidth: '20px', textAlign: 'center', cursor: 'grab' }}>
                                {isCurrentPlaying ? '▶' : index + 1}
                            </span>

                            {/* Enable/Disable toggle */}
                            <button
                                onClick={() => toggleEnabled(index)}
                                title={isDisabled ? "Click to enable (currently skipped)" : "Click to disable (will skip this video)"}
                                style={{
                                    background: isDisabled ? '#444' : '#00adb5',
                                    color: isDisabled ? '#666' : '#fff',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '2px 7px',
                                    fontSize: '11px',
                                    cursor: 'pointer',
                                    minWidth: '38px',
                                    fontWeight: 'bold'
                                }}
                            >
                                {isDisabled ? 'OFF' : 'ON'}
                            </button>

                            {/* File name / path */}
                            <div
                                style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                                title={`Double-click to play: ${item.name || item.path}`}
                                onDoubleClick={() => !isDisabled && handlePlayAt(index)}
                            >
                                <input
                                    type="text"
                                    className="input-field"
                                    style={{
                                        width: '100%',
                                        fontSize: '12px',
                                        textDecoration: isDisabled ? 'line-through' : 'none'
                                    }}
                                    placeholder="Video path"
                                    value={item.name || item.path}
                                    onChange={(e) => updatePath(index, e.target.value)}
                                    title={item.path}
                                />
                            </div>

                            {/* Start / End times */}
                            <input
                                type="text"
                                className="input-field"
                                style={{ width: '58px', fontSize: '11px' }}
                                placeholder="Start"
                                title="Start time (MM:SS)"
                                value={item.startTime || ''}
                                onChange={(e) => updateStartTime(index, e.target.value)}
                            />
                            <input
                                type="text"
                                className="input-field"
                                style={{ width: '58px', fontSize: '11px' }}
                                placeholder="End"
                                title="End time (MM:SS)"
                                value={item.endTime || ''}
                                onChange={(e) => updateEndTime(index, e.target.value)}
                            />

                            {/* Play button */}
                            <button
                                onClick={() => handlePlayAt(index)}
                                disabled={isDisabled}
                                title="Play this video now"
                                style={{
                                    background: isCurrentPlaying ? '#00adb5' : '#333',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '2px 6px',
                                    fontSize: '13px',
                                    cursor: isDisabled ? 'not-allowed' : 'pointer'
                                }}
                            >▶</button>

                            {/* Remove */}
                            <button
                                className="btn-danger rounded"
                                style={{ padding: '2px 7px', fontSize: '12px' }}
                                onClick={() => removePath(index)}
                            >✕</button>
                        </div>
                    );
                })}

                {/* Drop hint when list is not empty */}
                {playlist.length > 0 && isDragOverPlaylist && (
                    <div style={{ textAlign: 'center', color: '#00adb5', fontSize: '12px', padding: '6px 0' }}>
                        Drop to add more files
                    </div>
                )}
            </div>

            {/* ADD PATH BUTTON */}
            <div className="flex gap-2 mt-2 w-full">
                <button className="common-btn-style btn-neutral flex-1" onClick={addVideoPath}>+ Add Empty Row</button>
                {playlist.length > 0 && (
                    <button
                        className="common-btn-style btn-danger"
                        onClick={() => { setPlaylist([]); setStatusText("Playlist cleared"); }}
                        title="Clear entire playlist"
                    >Clear All</button>
                )}
            </div>

            {/* PLAYBACK CONTROLS */}
            <div className="btn-group mt-2">
                <PlayerControlBtn className="btn-primary" onClick={handleLoadAndPlay}>Load &amp; Play</PlayerControlBtn>
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
                <PlayerControlBtn className="btn-neutral" onClick={handleExport}>Export</PlayerControlBtn>
            </div>

            {/* END ACTIONS */}
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
        </div>
    );
};

export default LocalPlayerCard;
