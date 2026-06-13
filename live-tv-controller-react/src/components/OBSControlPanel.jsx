
import React, { useRef, useEffect } from 'react';
import { useOBS } from '../context/OBSContext';
import PreviewBox from './PreviewBox';
import SettingsBackup from './SettingsBackup';

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

    const toggleLiveLoop = () => {
        if (sourceState["Live Player"]) {
            setSourceVisibility("Loop Player", true);
        } else if (sourceState["Loop Player"]) {
            setSourceVisibility("Live Player", true);
        } else {
            setSourceVisibility("Loop Player", true);
        }
    };

    const getLiveLoopClass = () => {
        if (sourceState["Live Player"]) return 'on-live';
        if (sourceState["Loop Player"]) return 'on-loop';
        return 'off';
    };

    const getLiveLoopText = () => {
        if (sourceState["Live Player"]) return 'Live';
        if (sourceState["Loop Player"]) return 'Loop';
        return 'Off';
    };

    // Compact toggle button component
    const ToggleBtn = ({ active, onClick, label, activeClass = 'bg-green-600' }) => (
        <button
            onClick={onClick}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${active
                ? `${activeClass} text-white`
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
        >
            {label}
        </button>
    );

    return (
        <div className="w-full bg-gray-800/50 rounded-lg p-4 border border-gray-700 flex flex-wrap gap-6 items-center justify-between">
            {/* Preview Box */}
            <div className="flex-shrink-0">
                <PreviewBox />
            </div>

            {/* Title & Time */}
            <div className="text-center min-w-[150px]">
                <h2 className="text-2xl font-bold text-[#00adb5]">SMK TV</h2>
                <div className="text-xl font-mono text-white">{currentTime.split(',')[1]?.trim()}</div>
                <div className="text-sm text-gray-400">{currentTime.split(',')[0]?.trim()}</div>
            </div>

            {/* Source Toggles - Compact Row */}
            <div className="flex flex-wrap gap-1.5 justify-center">
                <button
                    onClick={toggleLiveLoop}
                    className={`px-3 py-1.5 rounded text-xs font-medium transition-all toggle-btn ${getLiveLoopClass()}`}
                >
                    {getLiveLoopText()}
                </button>
                <ToggleBtn
                    active={sourceState["Delay Live"]}
                    onClick={() => setSourceVisibility("Delay Live", !sourceState["Delay Live"])}
                    label={`Delay ${sourceState["Delay Live"] ? '●' : '○'}`}
                    activeClass="bg-purple-600"
                />
                <ToggleBtn
                    active={sourceState["OrdaChesta"]}
                    onClick={() => setSourceVisibility("OrdaChesta", !sourceState["OrdaChesta"])}
                    label={`Orda ${sourceState["OrdaChesta"] ? '●' : '○'}`}
                    activeClass="bg-orange-600"
                />
                <ToggleBtn
                    active={sourceState["Local Player"]}
                    onClick={() => setSourceVisibility("Local Player", !sourceState["Local Player"])}
                    label={`Local ${sourceState["Local Player"] ? '●' : '○'}`}
                    activeClass="bg-pink-600"
                />
            </div>

            {/* OBS Controls - Compact Column */}
            <div className="flex flex-col gap-1 items-end">
                <div className="flex items-center gap-2 mb-1">
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

                {showOBSSetup && (
                    <div className="bg-gray-900 border border-cyan-700/50 rounded-lg p-3 mb-1 w-64 text-xs">
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

                <div className="flex gap-1">
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
                </div>
                <div className="flex gap-1 mt-1">
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

            {/* Settings Export / Import */}
            <SettingsBackup />
        </div>
    );
};

export default OBSControlPanel;

