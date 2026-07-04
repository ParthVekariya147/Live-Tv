
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, PLAYER_EVENT_KEY } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { useVideoInfo } from '../hooks/useVideoInfo';
import { logVideoLoad, logVideoPlay, logPlaylistAction } from '../utils/logger';
import { setStateValue } from '../utils/state-api';
import PlayerControlBtn from './common/PlayerControlBtn';
import ThumbnailLoader from './common/ThumbnailLoader';

const LoopPlayerCard = () => {
    const { sourceState } = useOBS();
    const isVisible = sourceState["Loop Player"];
    const isInitialized = useRef(false);
    const hasUserData = useRef(false); // Track if we have actual user data to save

    const [playlist, setPlaylist] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const playlistRef = useRef(playlist);
    const currentIndexRef = useRef(currentIndex);
    useEffect(() => { playlistRef.current = playlist; }, [playlist]);
    useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
    const [inputValue, setInputValue] = useState("");
    const [jumpIndex, setJumpIndex] = useState(""); // For jump to index feature
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef(null);

    // Playback State
    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);
    const [loadingAction, setLoadingAction] = useState(false);

    const currentVideoId = playlist[currentIndex] || '';
    const { title: videoTitle, thumbnail: videoThumbnail, loading: thumbLoading } = useVideoInfo(currentVideoId);
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
                    // Don't dump the (potentially huge) playlist back into the text input —
                    // a single-line <input> with 10,000+ IDs freezes the browser on render.
                    setIsPlaying(parsed.isPlaying ?? true);
                    setIsMuted(parsed.isMuted ?? false);
                    setIsStopped(parsed.isStopped ?? false);
                    hasUserData.current = true; // Mark that we have valid user data
                }
            } catch (e) {
                console.error("Error loading loop saved state", e);
            }
        }
        // Mark initialized after React state settles, then sync loaded state to server
        setTimeout(() => {
            isInitialized.current = true;
            // Push whatever was just loaded from localStorage to the server so
            // the server's app-state.json reflects the real video IDs on startup.
            flushStateRef.current?.();
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
        setStateValue('player.loop', state);
    }, [playlist, currentIndex, isPlaying, isMuted, isStopped]);

    // Always-current ref to flush current state on demand (pre-backup / pre-export)
    const flushStateRef = useRef(null);
    useEffect(() => {
        flushStateRef.current = () => {
            if (!isInitialized.current) return;
            if (!hasUserData.current && playlist.length === 0) return;
            const state = {
                playlist,
                currentIndex,
                isPlaying,
                isMuted,
                isStopped,
                videoId: playlist[currentIndex] || ""
            };
            localStorage.setItem('loopPlayerState', JSON.stringify(state));
            setStateValue('player.loop', state);
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
            setStatusText("Loop Player Active");
        } else {
            sendPlayerCommand('loopPlayerCommand', 'pause');
            setIsPlaying(false);
            setIsStopped(false);
            setStatusText("Loop Player Paused");
        }
    }, [isVisible]);

    // Resume playback of existing playlist without parsing inputValue
    const resumePlayback = () => {
        const pl = playlistRef.current;
        const ci = currentIndexRef.current;
        if (pl.length > 0) {
            const vid = pl[ci] || pl[0];
            if (vid) {
                sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
                sendPlayerCommand('loopPlayerCommand', 'play');
                sendPlayerCommand('loopPlayerCommand', 'unmute');
                setIsPlaying(true);
                setIsStopped(false);
                setIsMuted(false);
            }
        }
    };

    // Listen to player events (time update, ended) — uses refs to avoid stale closure
    useEffect(() => {
        const handleStorage = (e) => {
            if (e.key === PLAYER_EVENT_KEY && e.newValue) {
                try {
                    const data = JSON.parse(e.newValue);
                    if (data.playerType === 'loop' && (data.event === 'videoEnded' || data.event === 'videoError')) {
                        const ci = currentIndexRef.current;
                        const pl = playlistRef.current;
                        let nextIdx = ci + 1;
                        if (nextIdx >= pl.length) nextIdx = 0;
                        setCurrentIndex(nextIdx);
                        const vid = pl[nextIdx];
                        if (vid) sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
                    }
                } catch (err) { }
            }
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []); // refs always have latest values — no stale closure

    const handleLoadAndPlay = () => {
        let currentList = playlist;
        if (inputValue) {
            currentList = inputValue.split(',').map(s => s.trim()).filter(Boolean);
            setPlaylist(currentList);
            hasUserData.current = true;
        }

        if (currentList.length > 0) {
            const vid = currentList[currentIndex] || currentList[0];
            if (vid) {
                setLoadingAction(true);

                if (isVisible) {
                    sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
                    sendPlayerCommand('loopPlayerCommand', 'play');
                    sendPlayerCommand('loopPlayerCommand', 'unmute');
                    setIsPlaying(true);
                    setIsStopped(false);
                    setIsMuted(false);
                    setStatusText("Video loaded, playing.");
                    logVideoLoad('Loop Player', vid, videoTitle, 'manual', { playlistIndex: currentIndex, playlistSize: currentList.length });
                    logVideoPlay('Loop Player', vid, 'manual');
                } else {
                    setStatusText("Loaded - will play when source is visible.");
                    logVideoLoad('Loop Player', vid, videoTitle, 'manual_prepared', { playlistIndex: currentIndex, playlistSize: currentList.length });
                }

                setTimeout(() => setLoadingAction(false), 800);
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
        const vid = playlist[nextIdx];
        if (vid) sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
    };

    const handlePrev = () => {
        let prevIdx = currentIndex - 1;
        if (prevIdx < 0) prevIdx = playlist.length - 1;
        setCurrentIndex(prevIdx);
        const vid = playlist[prevIdx];
        if (vid) sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
    };

    const handleJump = () => {
        const idx = parseInt(jumpIndex, 10);
        if (isNaN(idx) || idx < 1 || idx > playlist.length) {
            setStatusText(`Enter index 1-${playlist.length}`);
            return;
        }
        const targetIdx = idx - 1;
        setCurrentIndex(targetIdx);
        const vid = playlist[targetIdx];
        if (vid) {
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
        hasUserData.current = false;
        localStorage.removeItem('loopPlayerState');
        setStatusText("Playlist reset");
    };

    const handleExport = () => {
        if (playlist.length === 0) {
            setStatusText("Playlist is empty — nothing to export");
            return;
        }
        // Download as a real file (one ID per line) — clipboard copy silently
        // fails/truncates for large playlists, which is why exports looked incomplete.
        const blob = new Blob([playlist.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `loop-player-playlist-${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatusText(`Exported ${playlist.length.toLocaleString()} video ID(s) to file`);
    };

    // Splits raw pasted/file text into IDs — accepts newline, comma, or CR/LF separated lists.
    const parseIdsFromText = (text) => text.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);

    // Accepts either a bare 11-char YouTube ID or a full URL (watch?v=, youtu.be/, /shorts/, /embed/)
    // and returns just the ID — so files/pastes built from copied URLs still work.
    const YOUTUBE_URL_ID_RE = /(?:v=|\/embed\/|\/shorts\/|youtu\.be\/|\/v\/)([a-zA-Z0-9_-]{11})/;
    const extractVideoId = (raw) => {
        const trimmed = String(raw ?? '').trim();
        if (!trimmed) return '';
        if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
        const match = trimmed.match(YOUTUBE_URL_ID_RE);
        return match ? match[1] : trimmed;
    };

    const loadIds = (rawIds, sourceLabel) => {
        const unique = [...new Set(rawIds.map(extractVideoId).filter(Boolean))];
        if (unique.length === 0) {
            setStatusText("No video IDs found");
            return;
        }
        setPlaylist(unique);
        setCurrentIndex(0);
        setInputValue("");
        hasUserData.current = true;
        setStatusText(`Loaded ${unique.length.toLocaleString()} video ID(s)${sourceLabel ? ` from ${sourceLabel}` : ''}`);
    };

    // Large pastes (10,000-50,000+ IDs) freeze the browser if they land inside a
    // single-line <input>. Intercept them and parse directly instead of rendering.
    const handleInputPaste = (e) => {
        const text = e.clipboardData?.getData('text') || '';
        if (text.length > 20000) {
            e.preventDefault();
            loadIds(parseIdsFromText(text), 'paste');
        }
    };

    const handleFileImport = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-selecting the same file next time
        if (!file) return;

        setIsImporting(true);
        setStatusText(`Reading ${file.name}...`);
        try {
            const ext = file.name.split('.').pop().toLowerCase();
            let ids;
            if (ext === 'xlsx' || ext === 'xls') {
                const XLSX = await import('xlsx');
                const buf = await file.arrayBuffer();
                const wb = XLSX.read(buf, { type: 'array' });
                const sheet = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                ids = rows.flat().map(v => String(v ?? '').trim()).filter(Boolean);
            } else {
                ids = parseIdsFromText(await file.text());
            }
            loadIds(ids, file.name);
        } catch (err) {
            console.error('Loop Player file import error:', err);
            setStatusText('Failed to read file: ' + err.message);
        } finally {
            setIsImporting(false);
        }
    };

    return (
        <div className="player-control-card">
            <h3>Loop Player</h3>
            <ThumbnailLoader src={videoThumbnail} alt="Loop Player Thumbnail" loading={thumbLoading} />
            <p className="video-title">{thumbLoading ? 'Loading...' : (videoTitle || 'No video loaded')}</p>
            <p className="video-time-display">{timeInfo.currentTime} / {timeInfo.remainingTime}</p>
            <p className="video-info-display">{playlist.length > 0 ? `Video ${currentIndex + 1} of ${playlist.length}` : ''}</p>

            <input
                type="text"
                className="input-field"
                placeholder="Comma-separated YouTube IDs (small lists — use Import File for 1000+)"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onPaste={handleInputPaste}
            />

            <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.xlsx,.xls"
                style={{ display: 'none' }}
                onChange={handleFileImport}
            />

            <div className="btn-group mt-2">
                <PlayerControlBtn
                    className={`btn-primary${loadingAction ? ' btn-loading' : ''}`}
                    onClick={handleLoadAndPlay}
                    disabled={loadingAction}
                >
                    {loadingAction ? <><span className="btn-spinner" /> Loading</> : 'Load'}
                </PlayerControlBtn>
                <PlayerControlBtn
                    className={`btn-neutral${isImporting ? ' btn-loading' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isImporting}
                    title="Import video IDs from a .txt, .csv or Excel file — one ID per line, or comma-separated"
                >
                    {isImporting ? <><span className="btn-spinner" /> Reading</> : 'Import File'}
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
