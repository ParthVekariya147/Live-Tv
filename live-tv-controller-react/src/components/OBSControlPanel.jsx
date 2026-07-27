
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useOBS } from '../context/OBSContext';
import PreviewBox from './PreviewBox';
import SettingsBackup from './SettingsBackup';
import NotificationSettings from './NotificationSettings';
import ChannelManager from './ChannelManager';
import { LIVE_PLAYER_EVENT_KEY, PLAYER_EVENT_KEY, DELAY_PLAYER_EVENT_KEY, LOCAL_PLAYER_EVENT_KEY } from '../utils/core-utils';
import { logError, LogCategory, LogType } from '../utils/logger';

// Maps OBS source name -> the localStorage event key / playerType its player page reports timeUpdate on
const SOURCE_EVENT_INFO = {
    "Live Player":  { eventKey: LIVE_PLAYER_EVENT_KEY,  playerType: 'live' },
    "Loop Player":  { eventKey: PLAYER_EVENT_KEY,       playerType: 'loop' },
    "Delay Live":   { eventKey: DELAY_PLAYER_EVENT_KEY, playerType: 'delay' },
    "Local Player": { eventKey: LOCAL_PLAYER_EVENT_KEY, playerType: 'local' },
};
const HEALTH_CHECK_TIMEOUT_MS = 8000;

const OBSControlPanel = ({ currentTime, monitor1Enabled, toggleMonitor1, monitor2Enabled, toggleMonitor2 }) => {
    const {
        toggleStream, streamActive,
        toggleRecord, recordActive,
        toggleVirtualCam, virtualCamActive,
        sourceState, setSourceVisibility,
        obsSettings, updateOBSSettings,
        isConnected,
        SCENE_NAME
    } = useOBS();

    // OBS Setup panel state
    const [showOBSSetup, setShowOBSSetup] = React.useState(false);
    const [obsHost, setObsHost] = React.useState(obsSettings?.host || 'localhost');
    const [obsPort, setObsPort] = React.useState(String(obsSettings?.port || 4455));

    const handleOBSSave = () => {
        const port = parseInt(obsPort, 10);
        if (!obsHost.trim() || isNaN(port) || port < 1 || port > 65535) return;
        updateOBSSettings({ host: obsHost.trim(), port });
        setShowOBSSetup(false);
    };

    // Auto-record state — shared with LivePlayerCard via localStorage key 'liveAutoRecord'
    const [autoRecord, setAutoRecord] = React.useState(() => {
        try { return JSON.parse(localStorage.getItem('liveAutoRecord') ?? 'false'); } catch { return false; }
    });
    const autoRecordRef = useRef(autoRecord);
    useEffect(() => { autoRecordRef.current = autoRecord; }, [autoRecord]);

    // Stay in sync when LivePlayerCard toggles the value
    useEffect(() => {
        const onStorage = (e) => {
            if (e.key === 'liveAutoRecord') {
                try { setAutoRecord(JSON.parse(e.newValue ?? 'false')); } catch { }
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const toggleAutoRecord = () => {
        const next = !autoRecordRef.current;
        setAutoRecord(next);
        localStorage.setItem('liveAutoRecord', JSON.stringify(next));
    };

    const mountTime = useRef(Date.now());
    const obsAutoStartedRef = useRef(false);
    const recordActiveRef = useRef(recordActive);
    useEffect(() => { recordActiveRef.current = recordActive; }, [recordActive]);

    const isLivePlayerVisible = sourceState["Live Player"];
    useEffect(() => {
        if (Date.now() - mountTime.current < 1000) return;
        if (!autoRecordRef.current) return;

        if (isLivePlayerVisible) {
            if (!recordActiveRef.current) {
                obsAutoStartedRef.current = true;
                toggleRecord();
            }
        } else {
            if (recordActiveRef.current && obsAutoStartedRef.current) {
                obsAutoStartedRef.current = false;
                toggleRecord();
            }
        }
    }, [isLivePlayerVisible]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Switch-source loading + 5-10s health check ───────────────────────────
    // loadingSource: name of the source button currently spinning (waiting for confirmation)
    // warnSource: name of the source whose stream didn't report back in time ("not working")
    const [loadingSource, setLoadingSource] = useState(null);
    const [warnSource, setWarnSource] = useState(null);
    const healthTimeoutRef = useRef(null);

    const switchToSource = useCallback((sourceName) => {
        const ok = setSourceVisibility(sourceName, true);

        // setSourceVisibility returns false when OBS scene/sourceId not yet known —
        // show the warning immediately instead of waiting 8s for the health timer.
        if (!ok) {
            logError(
                LogType.OBS_SOURCE_ERROR,
                LogCategory.SYSTEM,
                { function: 'switchToSource', sourceName, isConnected, SCENE_NAME },
                `switchToSource("${sourceName}") failed — setSourceVisibility returned false`
            );
            setWarnSource(sourceName);
            setLoadingSource(null);
            return;
        }

        setWarnSource(prev => (prev === sourceName ? null : prev));
        setLoadingSource(sourceName);

        if (healthTimeoutRef.current) clearTimeout(healthTimeoutRef.current);
        healthTimeoutRef.current = setTimeout(() => {
            setLoadingSource(prev => (prev === sourceName ? null : prev));
            setWarnSource(sourceName);
        }, HEALTH_CHECK_TIMEOUT_MS);
    }, [setSourceVisibility, isConnected, SCENE_NAME]);

    // Listen for the player page's timeUpdate ping — proof the switched-to source is actually playing
    useEffect(() => {
        const handleStorageEvent = (event) => {
            if (!event.newValue || !loadingSource) return;
            const info = SOURCE_EVENT_INFO[loadingSource];
            if (!info || event.key !== info.eventKey) return;
            try {
                const data = JSON.parse(event.newValue);
                if (data.playerType !== info.playerType || data.event !== 'timeUpdate') return;
                if (healthTimeoutRef.current) clearTimeout(healthTimeoutRef.current);
                setLoadingSource(null);
                setWarnSource(prev => (prev === loadingSource ? null : prev));
            } catch { /* ignore parse errors */ }
        };
        window.addEventListener('storage', handleStorageEvent);
        return () => window.removeEventListener('storage', handleStorageEvent);
    }, [loadingSource]);

    useEffect(() => () => { if (healthTimeoutRef.current) clearTimeout(healthTimeoutRef.current); }, []);

    // Compact toggle button component — shows a spinner while waiting for the
    // switched-to player to confirm playback, and a warning ring if it never does
    const ToggleBtn = ({ active, onClick, label, activeClass = 'bg-green-600', loading, warn }) => (
        <button
            onClick={onClick}
            title={warn ? 'No playback signal received — stream may not be working' : undefined}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-all flex items-center gap-1.5 ${active
                ? `${activeClass} text-white`
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                } ${warn ? 'ring-2 ring-red-500' : ''}`}
        >
            {loading && <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {label}
            {warn && <span title="Not responding">⚠</span>}
        </button>
    );

    // Compact bordered "chip" used to visually group related buttons inline,
    // without adding a separate label row (keeps the header to one row's height).
    const HeaderGroup = ({ label, children }) => (
        <div className="flex items-center gap-1.5 bg-gray-900/40 border border-gray-700/60 rounded-md pl-2 pr-1.5 py-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{label}</span>
            {children}
        </div>
    );

    return (
        <div className="w-full bg-gray-800/50 rounded-lg p-4 border border-gray-700 flex flex-wrap gap-6 items-center">
            {/* Left: Preview + Title */}
            <div className="flex items-center gap-4 flex-shrink-0">
                <PreviewBox />

                <div className="text-center min-w-[150px]">
                    <h2 className="text-2xl font-bold text-[#00adb5]">SMK TV</h2>
                    <div className="text-xl font-mono text-white">{currentTime.split(',')[1]?.trim()}</div>
                    <div className="text-sm text-gray-400">{currentTime.split(',')[0]?.trim()}</div>
                </div>
            </div>

            {/* Center: Sources — takes the flexible middle space so it stays visually centered */}
            <div className="flex-1 flex justify-center min-w-[200px]">
                <HeaderGroup label="Src">
                    <ToggleBtn
                        active={sourceState["Live Player"]}
                        onClick={() => switchToSource("Live Player")}
                        label={`Live ${sourceState["Live Player"] ? '●' : '○'}`}
                        activeClass="bg-green-600"
                        loading={loadingSource === "Live Player"}
                        warn={warnSource === "Live Player"}
                    />
                    <ToggleBtn
                        active={sourceState["Loop Player"]}
                        onClick={() => switchToSource("Loop Player")}
                        label={`Loop ${sourceState["Loop Player"] ? '●' : '○'}`}
                        activeClass="bg-blue-600"
                        loading={loadingSource === "Loop Player"}
                        warn={warnSource === "Loop Player"}
                    />
                    <ToggleBtn
                        active={sourceState["Delay Live"]}
                        onClick={() => switchToSource("Delay Live")}
                        label={`Delay ${sourceState["Delay Live"] ? '●' : '○'}`}
                        activeClass="bg-purple-600"
                        loading={loadingSource === "Delay Live"}
                        warn={warnSource === "Delay Live"}
                    />
                    <ToggleBtn
                        active={sourceState["Local Player"]}
                        onClick={() => switchToSource("Local Player")}
                        label={`Local ${sourceState["Local Player"] ? '●' : '○'}`}
                        activeClass="bg-pink-600"
                        loading={loadingSource === "Local Player"}
                        warn={warnSource === "Local Player"}
                    />
                </HeaderGroup>
            </div>

            {/* Right: Rec group + utility cluster, each clearly separated by a gap + divider */}
            <div className="flex flex-wrap gap-5 items-start flex-shrink-0">
                <HeaderGroup label="Rec">
                    <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap gap-1.5">
                            <button
                                onClick={toggleStream}
                                className={`px-2 py-1 rounded text-xs font-medium transition-all ${streamActive
                                    ? 'bg-red-600 text-white animate-pulse'
                                    : 'bg-green-600 hover:bg-green-700 text-white'
                                    }`}
                            >
                                {streamActive ? "⏹ Stream" : "▶ Stream"}
                            </button>
                            <button
                                onClick={toggleRecord}
                                className={`px-2 py-1 rounded text-xs font-medium transition-all ${recordActive
                                    ? 'bg-red-600 text-white animate-pulse'
                                    : 'bg-gray-600 hover:bg-gray-500 text-white'
                                    }`}
                            >
                                {recordActive ? "⏹ Rec" : "● Rec"}
                            </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            <button
                                onClick={toggleAutoRecord}
                                title="Auto-record: start OBS recording when Live Player turns on, stop when it turns off"
                                className={`px-2 py-1 rounded text-xs font-medium transition-all ${autoRecord
                                    ? 'bg-red-800 text-red-200 ring-1 ring-red-500'
                                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                            >
                                {autoRecord ? '⏺ Auto' : '○ Auto'}
                            </button>
                            <button
                                onClick={toggleVirtualCam}
                                className={`px-2 py-1 rounded text-xs font-medium transition-all ${virtualCamActive
                                    ? 'bg-yellow-600 text-white'
                                    : 'bg-gray-600 hover:bg-gray-500 text-white'
                                    }`}
                            >
                                {virtualCamActive ? "⏹ VCam" : "📷 VCam"}
                            </button>
                            <button
                                onClick={toggleMonitor1}
                                className={`px-2 py-1 rounded text-xs font-medium transition-all ${monitor1Enabled
                                    ? 'bg-cyan-600 text-white'
                                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                            >
                                Mon1 {monitor1Enabled ? '●' : '○'}
                            </button>
                            <button
                                onClick={toggleMonitor2}
                                className={`px-2 py-1 rounded text-xs font-medium transition-all ${monitor2Enabled
                                    ? 'bg-cyan-600 text-white'
                                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                            >
                                Mon2 {monitor2Enabled ? '●' : '○'}
                            </button>
                        </div>
                    </div>
                </HeaderGroup>

                <div className="w-px self-stretch bg-gray-700/70" />

                {/* Settings/backup */}
                <SettingsBackup />

                <div className="w-px self-stretch bg-gray-700/70" />

                {/* Setup / Notifications / Channels stacked in one column — the very last group, rightmost */}
                <div className="relative flex flex-col items-end gap-1.5">
                    <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-500'}`} />
                        <span className="text-xs text-cyan-400 font-semibold">OBS</span>
                        <button
                            onClick={() => setShowOBSSetup(v => !v)}
                            title="OBS WebSocket Setup"
                            className={`px-1.5 py-0.5 rounded text-xs font-medium transition-all ${showOBSSetup ? 'bg-cyan-700 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
                        >
                            ⚙ Setup
                        </button>
                    </div>

                    <NotificationSettings />
                    <ChannelManager />

                {showOBSSetup && (
                    <div className="absolute right-0 top-full mt-1 z-20 bg-gray-900 border border-cyan-700/50 rounded-lg p-3 w-64 text-xs shadow-xl">
                            {/* OBS Auto-Setup launcher */}
                            <div className="mb-3">
                                <div className="flex items-center justify-between mb-2">
                                    <p className="text-cyan-400 font-semibold">OBS Auto-Setup</p>
                                    <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${isConnected ? 'bg-green-900/60 text-green-400' : 'bg-red-900/60 text-red-400'}`}>
                                        <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-500'}`} />
                                        {isConnected ? 'Connected' : 'Not Connected'}
                                    </span>
                                </div>
                                <p className="text-gray-500 mb-2 leading-relaxed">
                                    Auto-configure OBS sources, encoder, and RTMP settings for SMK TV.
                                </p>
                                <button
                                    onClick={() => window.open('/obs-auto-setup.html', '_blank', 'width=600,height=700')}
                                    className="w-full py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded font-medium text-xs transition-all flex items-center justify-center gap-1.5"
                                >
                                    🚀 Open OBS Auto-Setup
                                </button>
                                {!isConnected && (
                                    <p className="text-yellow-600 mt-1.5 text-xs">⚠ OBS not connected — auto-setup will try to connect on its own.</p>
                                )}
                            </div>

                            {/* Divider */}
                            <div className="border-t border-gray-700 my-2" />

                            {/* WebSocket Config */}
                            <p className="text-gray-400 font-semibold mb-2">WS Connection</p>
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2">
                                    <label className="text-gray-400 w-10 flex-shrink-0">Host</label>
                                    <input
                                        value={obsHost}
                                        onChange={e => setObsHost(e.target.value)}
                                        className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs"
                                        placeholder="localhost"
                                    />
                                </div>
                                <div className="flex items-center gap-2">
                                    <label className="text-gray-400 w-10 flex-shrink-0">Port</label>
                                    <input
                                        value={obsPort}
                                        onChange={e => setObsPort(e.target.value)}
                                        className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs"
                                        placeholder="4455"
                                        type="number"
                                    />
                                </div>
                                <div className="flex gap-2 mt-1">
                                    <button onClick={handleOBSSave} className="flex-1 bg-cyan-700 hover:bg-cyan-600 text-white rounded px-2 py-1 text-xs font-medium">
                                        Save & Reconnect
                                    </button>
                                    <button onClick={() => setShowOBSSetup(false)} className="bg-gray-700 hover:bg-gray-600 text-gray-300 rounded px-2 py-1 text-xs">
                                        Cancel
                                    </button>
                                </div>
                            </div>
                            <p className="text-gray-500 mt-2">
                                Current: {obsSettings?.host || 'localhost'}:{obsSettings?.port || 4455}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default OBSControlPanel;

