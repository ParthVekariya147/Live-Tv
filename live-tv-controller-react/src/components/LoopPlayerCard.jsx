
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOBS } from '../context/OBSContext';
import { sendPlayerCommand, PLAYER_EVENT_KEY, parseIdsFromText, extractVideoId } from '../utils/core-utils';
import { usePlayerTime } from '../utils/usePlayerHooks';
import { useVideoInfo } from '../hooks/useVideoInfo';
import { logVideoLoad, logVideoPlay, logPlaylistAction } from '../utils/logger';
import { setStateValue } from '../utils/state-api';
import PlayerControlBtn from './common/PlayerControlBtn';
import ThumbnailLoader from './common/ThumbnailLoader';
import ErrorBoundary from './common/ErrorBoundary';
import LoopPlaylistAutomation from './LoopPlaylistAutomation';

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
    // True while the Playlist Automation manager is actively driving playback (Groups/Lists
    // chaining). While true, this card's own "wrap to next index on video end" logic backs
    // off so the two don't fight over what plays next — the automation manager decides.
    // Any manual control (Load/Next/Prev/Jump/Reset) takes control back from automation.
    const automationModeRef = useRef(false);
    const [inputValue, setInputValue] = useState("");
    const [jumpIndex, setJumpIndex] = useState(""); // For jump to index feature
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef(null);

    // Playback State
    const [isPlaying, setIsPlaying] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [isStopped, setIsStopped] = useState(false);
    const [loadingAction, setLoadingAction] = useState(false);

    // Which Playlist Automation Group/List the current playlist came from — null when the
    // playlist was loaded manually (typed, imported, or reset). `active` flips to false once
    // automation hands control back, while the same playlist keeps looping on this card.
    const [automationInfo, setAutomationInfo] = useState(null);

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
                    // Restore as inactive — the playlist is still this Group/List's, but nothing
                    // is driving it until automation actually activates a run again.
                    if (parsed.automation?.groupName || parsed.automation?.listName) {
                        setAutomationInfo({ ...parsed.automation, active: false });
                    }
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
            automation: automationInfo,
            videoId: playlist[currentIndex] || ""
        };
        localStorage.setItem('loopPlayerState', JSON.stringify(state));
        setStateValue('player.loop', state);
    }, [playlist, currentIndex, isPlaying, isMuted, isStopped, automationInfo]);

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
                automation: automationInfo,
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

    // Tell the actual player page (public/LoopPlayer.html) whether this source is
    // really on-air right now, so it can refuse to autoplay in the background even
    // if some other code path sends a loadVideo/play command while hidden. Fires on
    // mount too — the player page defaults to "not visible" until it hears otherwise.
    useEffect(() => {
        sendPlayerCommand('loopPlayerCommand', 'setSourceVisible', null, null, null, null, { visible: !!isVisible });
    }, [isVisible]);

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
                        // Playlist Automation owns advancement while it's driving playback —
                        // it listens to this same event independently and decides what plays
                        // next (including cross-list/cross-group chaining). Don't also wrap here.
                        if (automationModeRef.current) return;
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

    // Receive a video list + start position from the Playlist Automation manager.
    // Mirrors handleLoadAndPlay/handleJump but is triggered externally (by a schedule,
    // a live-event match, or list/group chaining) instead of by the user.
    useEffect(() => {
        const handleAutomationLoad = (event) => {
            const { videoIds, startIndex, groupName, listName } = event.detail || {};
            if (!Array.isArray(videoIds) || videoIds.length === 0) return;
            const idx = Math.min(Math.max(startIndex || 0, 0), videoIds.length - 1);
            const vid = videoIds[idx];
            if (!vid) return;

            automationModeRef.current = true;
            setAutomationInfo({ groupName: groupName || 'Group', listName: listName || 'List', active: true });
            setPlaylist(videoIds);
            setCurrentIndex(idx);
            hasUserData.current = true;

            // Always send play/unmute, never gate them on isVisible here. The player page
            // owns the "am I on air?" decision (it resolves obs.activeSource itself) and
            // holds the intent until it goes on air. Gating here instead meant the intent
            // never reached it: automation activates while the source is still switching,
            // so isVisible was stale-false, the video got cued, and nothing ever played it.
            sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
            sendPlayerCommand('loopPlayerCommand', 'play');
            sendPlayerCommand('loopPlayerCommand', 'unmute');
            logVideoLoad('Loop Player', vid, videoTitle, 'automation', { playlistIndex: idx, playlistSize: videoIds.length });
            setIsPlaying(true);
            setIsStopped(false);
            setIsMuted(false);
            setStatusText(isVisible ? 'Playlist Automation active' : 'Playlist Automation active — starts as soon as the source is on air.');
            logVideoPlay('Loop Player', vid, 'automation');
        };
        window.addEventListener('loopPlayerLoadPlaylist', handleAutomationLoad);
        return () => window.removeEventListener('loopPlayerLoadPlaylist', handleAutomationLoad);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible]);

    // Automation intentionally stopped (dead-end chain, deleted group, or the user hit
    // "Stop Automation") — hand control back so this card's own wraparound resumes on
    // whatever was last loaded, instead of silently going unresponsive on video end.
    useEffect(() => {
        const handleAutomationStop = () => {
            automationModeRef.current = false;
            // Keep the Group/List name visible — that's still where this playlist came from —
            // but drop the "live" marker, since automation is no longer driving it.
            setAutomationInfo(prev => prev ? { ...prev, active: false } : null);
            setStatusText('Automation ended — looping last playlist');
        };
        window.addEventListener('loopPlayerAutomationStop', handleAutomationStop);
        return () => window.removeEventListener('loopPlayerAutomationStop', handleAutomationStop);
    }, []);

    // Automation re-announcing the run it restored after a page refresh — the playlist is
    // already back from localStorage, so this only re-confirms the Group/List names and that
    // automation is still the one driving them (no reload, no re-cue of the video).
    useEffect(() => {
        const handleRunInfo = (event) => {
            const { groupName, listName } = event.detail || {};
            if (!groupName && !listName) return;
            automationModeRef.current = true;
            setAutomationInfo({ groupName: groupName || 'Group', listName: listName || 'List', active: true });
        };
        window.addEventListener('loopAutomationRunInfo', handleRunInfo);
        return () => window.removeEventListener('loopAutomationRunInfo', handleRunInfo);
    }, []);

    // Manual control takes over from automation. Actions that replace the playlist outright
    // also drop the Group/List label (it no longer describes what's loaded); actions that just
    // move within the same playlist keep the label but clear its "live" marker.
    const releaseAutomation = (clearLabel) => {
        automationModeRef.current = false;
        setAutomationInfo(prev => (clearLabel || !prev) ? null : { ...prev, active: false });
    };

    const handleLoadAndPlay = () => {
        let currentList = playlist;
        if (inputValue) {
            currentList = inputValue.split(',').map(s => s.trim()).filter(Boolean);
            setPlaylist(currentList);
            hasUserData.current = true;
        }
        releaseAutomation(!!inputValue);

        if (currentList.length > 0) {
            const vid = currentList[currentIndex] || currentList[0];
            if (vid) {
                setLoadingAction(true);

                sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
                sendPlayerCommand('loopPlayerCommand', 'play');
                sendPlayerCommand('loopPlayerCommand', 'unmute');
                setIsPlaying(true);
                setIsStopped(false);
                setIsMuted(false);
                setStatusText(isVisible ? "Video loaded, playing." : "Loaded - will play when source is visible.");
                logVideoLoad('Loop Player', vid, videoTitle, isVisible ? 'manual' : 'manual_prepared', { playlistIndex: currentIndex, playlistSize: currentList.length });
                logVideoPlay('Loop Player', vid, 'manual');

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
        releaseAutomation(false);
        let nextIdx = currentIndex + 1;
        if (nextIdx >= playlist.length) nextIdx = 0;
        setCurrentIndex(nextIdx);
        const vid = playlist[nextIdx];
        if (vid) {
            sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
            sendPlayerCommand('loopPlayerCommand', 'play');
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText(isVisible ? `Video ${nextIdx + 1}` : `Video ${nextIdx + 1} cued — will play when source is visible.`);
        }
    };

    const handlePrev = () => {
        releaseAutomation(false);
        let prevIdx = currentIndex - 1;
        if (prevIdx < 0) prevIdx = playlist.length - 1;
        setCurrentIndex(prevIdx);
        const vid = playlist[prevIdx];
        if (vid) {
            sendPlayerCommand('loopPlayerCommand', 'loadVideo', vid);
            sendPlayerCommand('loopPlayerCommand', 'play');
            setIsPlaying(true);
            setIsStopped(false);
            setStatusText(isVisible ? `Video ${prevIdx + 1}` : `Video ${prevIdx + 1} cued — will play when source is visible.`);
        }
    };

    const handleJump = () => {
        releaseAutomation(false);
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
            setStatusText(isVisible ? `Jumped to video ${idx}` : `Video ${idx} cued — will play when source is visible.`);
        }
        setJumpIndex("");
    };

    const handleReset = () => {
        releaseAutomation(true);
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

    const loadIds = (rawIds, sourceLabel) => {
        releaseAutomation(true); // manual import takes control back from automation
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
            <div className="flex items-center justify-between w-full gap-2">
                <h3>Loop Player</h3>
                <ErrorBoundary label="Playlist Automation">
                    <LoopPlaylistAutomation />
                </ErrorBoundary>
            </div>
            {/* What's playing right now, in Playlist Automation terms — always on screen, and
                restored on refresh from the persisted loop state / automation's own saved run. */}
            <div
                className={`w-full mb-2 px-2 py-1 rounded border text-xs flex items-center justify-center gap-x-2 gap-y-0.5 flex-wrap ${automationInfo?.active
                    ? 'bg-amber-900/30 border-amber-700/50 text-amber-100'
                    : 'bg-gray-800/60 border-gray-700 text-gray-400'}`}
                title={automationInfo
                    ? (automationInfo.active
                        ? 'Playlist Automation is driving the Loop Player — this is the Group and Playlist currently playing.'
                        : 'This playlist came from Playlist Automation, but automation is no longer driving playback.')
                    : 'This playlist was loaded by hand (typed IDs or Import File), so it belongs to no automation Group.'}
            >
                {automationInfo ? (
                    <>
                        <span>{automationInfo.active ? '▶' : '⏸'}</span>
                        <span><span className="opacity-70">Group:</span> <strong>{automationInfo.groupName}</strong></span>
                        <span className="opacity-50">|</span>
                        <span><span className="opacity-70">Playlist:</span> <strong>{automationInfo.listName}</strong></span>
                    </>
                ) : (
                    <span>{playlist.length > 0 ? 'Manual playlist — no automation Group' : 'No playlist loaded'}</span>
                )}
            </div>
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
