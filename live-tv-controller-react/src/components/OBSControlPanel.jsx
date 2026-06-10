
import React from 'react';
import { useOBS } from '../context/OBSContext';
import PreviewBox from './PreviewBox';

const OBSControlPanel = ({ currentTime, monitor1Enabled, toggleMonitor1, monitor2Enabled, toggleMonitor2 }) => {
    const {
        toggleStream, streamActive,
        toggleRecord, recordActive,
        toggleVirtualCam, virtualCamActive,
        sourceState, setSourceVisibility,
        SCENE_NAME
    } = useOBS();

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
                <span className="text-xs text-cyan-400 font-semibold mb-1">OBS</span>
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
        </div>
    );
};

export default OBSControlPanel;

