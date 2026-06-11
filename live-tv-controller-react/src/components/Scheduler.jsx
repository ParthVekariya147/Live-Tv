

import { useState, useEffect, useRef, useCallback } from 'react';
import { useOBS } from '../context/OBSContext';
import { logSchedulerTrigger, logSchedulerSkip, logInfo, logWarn, logError, LogType, LogCategory } from '../utils/logger';
import {
    startScheduler,
    stopScheduler,
    getSchedules,
    addSchedule as apiAddSchedule,
    updateSchedule as apiUpdateSchedule,
    deleteSchedule as apiDeleteSchedule,
    toggleSchedule as apiToggleSchedule,
    importSchedules,
    connectWebSocket,
    disconnectWebSocket,
    addWsListener,
    formatTimeRemaining
} from '../utils/scheduler-api';

const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const daysList = [
    { id: 0, label: "Sunday" },
    { id: 1, label: "Monday" },
    { id: 2, label: "Tuesday" },
    { id: 3, label: "Wednesday" },
    { id: 4, label: "Thursday" },
    { id: 5, label: "Friday" },
    { id: 6, label: "Saturday" },
];

const Scheduler = () => {
    const { sourceState, setSourceVisibility, isConnected: obsConnected } = useOBS();

    // Server state
    const [schedules, setSchedules] = useState([]);
    const [schedulerEnabled, setSchedulerEnabled] = useState(false);
    const [pendingTimeouts, setPendingTimeouts] = useState([]);
    const [serverConnected, setServerConnected] = useState(false);
    const [loading, setLoading] = useState(true);

    // Ref to always have fresh sourceState in WS callbacks (avoids stale closure)
    const sourceStateRef = useRef(sourceState);

    // Keep ref in sync with latest sourceState
    useEffect(() => {
        sourceStateRef.current = sourceState;
    }, [sourceState]);

    // Form State
    const [time, setTime] = useState("");
    const [source, setSource] = useState("Live Player");
    const [action, setAction] = useState("show");
    const [recurrence, setRecurrence] = useState("daily");
    const [selectedDays, setSelectedDays] = useState([]);
    const [title, setTitle] = useState("");
    const [editingId, setEditingId] = useState(null);

    // Import/Export State
    const [showImportArea, setShowImportArea] = useState(false);
    const [importData, setImportData] = useState("");

    const draggedItem = useRef(null);

    // ============================================
    // WEBSOCKET & DATA LOADING
    // ============================================

    // Load schedules from server
    const loadSchedules = useCallback(async () => {
        const result = await getSchedules();
        if (result.success) {
            setSchedules(result.schedules);
            setSchedulerEnabled(result.isRunning);
        }
    }, []);

    // Handle trigger from server - execute OBS action
    const handleServerTrigger = useCallback((triggerData) => {

        // Read from ref to always get the LATEST sourceState (avoids stale closure bug)
        // Check if Live Player is active - skip ALL triggers (including those targeting Live Player)
        // This ensures Live Player priority is maintained and it won't be hidden by any schedule
        const currentSourceState = sourceStateRef.current;
        if (currentSourceState["Live Player"] === true) {
            logWarn('SCHEDULER_TRIGGER_SKIPPED', LogCategory.SCHEDULER,
                { ...triggerData, reason: 'Live Player is active/visible', skippedAt: new Date().toISOString() },
                `[FRONTEND] Skipped: ${triggerData.action} ${triggerData.source} - Live Player is active/visible`);
            logSchedulerSkip(
                triggerData.id,
                triggerData.time,
                triggerData.action,
                triggerData.source,
                triggerData.title,
                'Live Player is active/visible'
            );
            return;
        }

        // Log before execution
        logInfo('SCHEDULER_TRIGGER_EXECUTING', LogCategory.SCHEDULER,
            { ...triggerData, executingAt: new Date().toISOString() },
            `[FRONTEND] Executing: ${triggerData.action} ${triggerData.source}`);

        // Execute the action via OBS
        const targetVisibility = triggerData.action === 'show';
        setSourceVisibility(triggerData.source, targetVisibility, 'scheduler');


        // Log successful execution
        logInfo('SCHEDULER_TRIGGER_EXECUTED', LogCategory.SCHEDULER,
            { ...triggerData, executedAt: new Date().toISOString() },
            `[FRONTEND] ✓ Executed: ${triggerData.action} ${triggerData.source} - ${triggerData.title}`);

        logSchedulerTrigger(
            triggerData.id,
            triggerData.time,
            triggerData.action,
            triggerData.source,
            triggerData.title
        );
    }, [setSourceVisibility]); // sourceState read via ref - no dep needed

    // Handle WebSocket messages
    const handleWsMessage = useCallback((data) => {

        switch (data.type) {
            case 'WS_CONNECTED':
                setServerConnected(true);
                logInfo('SCHEDULER_WS_CONNECTED', LogCategory.SCHEDULER, {}, 'Frontend connected to scheduler WebSocket');
                loadSchedules();
                break;

            case 'WS_DISCONNECTED':
                setServerConnected(false);
                logWarn('SCHEDULER_WS_DISCONNECTED', LogCategory.SCHEDULER, {}, 'Frontend disconnected from scheduler WebSocket');
                break;

            case 'SCHEDULER_STATUS':
                setSchedulerEnabled(data.data?.isRunning ?? false);
                break;

            case 'SCHEDULES_UPDATED':
                if (data.data?.schedules) {
                    setSchedules(data.data.schedules);
                }
                break;

            case 'SCHEDULER_TICK':
                // Real-time tick from server with pending triggers (every 1 second)
                if (data.data?.nextTriggers) {
                    const triggers = data.data.nextTriggers.map(t => ({
                        ...t,
                        nextTrigger: new Date(t.nextTrigger)
                    }));
                    setPendingTimeouts(triggers);
                }
                // Update scheduler running state if provided
                if (data.data?.isRunning !== undefined) {
                    setSchedulerEnabled(data.data.isRunning);
                }
                break;

            case 'SCHEDULER_TRIGGER':
                // Log that we received the trigger from server
                logInfo('SCHEDULER_TRIGGER_RECEIVED', LogCategory.SCHEDULER,
                    { source: data.data?.source, action: data.data?.action, title: data.data?.title },
                    `Frontend received trigger from server: ${data.data?.action} ${data.data?.source}`);
                // Handle the trigger - execute OBS action
                handleServerTrigger(data.data);
                break;
        }
    }, [loadSchedules, handleServerTrigger]);

    // Initialize WebSocket connection and load data
    // NOTE: pendingTimeouts now come 100% from WebSocket SCHEDULER_TICK (every 1 second)
    // No REST polling needed - server pushes updates automatically
    useEffect(() => {
        setLoading(true);

        // Connect to WebSocket
        connectWebSocket();
        const removeListener = addWsListener(handleWsMessage);

        // Initial data load (only schedules - pending triggers come via WebSocket)
        loadSchedules().then(() => {
            setLoading(false);
        });

        // No polling needed - SCHEDULER_TICK comes every 1 second via WebSocket

        return () => {
            removeListener();
            disconnectWebSocket();
        };
    }, [handleWsMessage, loadSchedules]);

    // Note: countdown display is driven by SCHEDULER_TICK from WebSocket (every 1s) — no polling needed

    // ============================================
    // SCHEDULER CONTROL
    // ============================================

    const handleToggleScheduler = async () => {
        // State is driven by WebSocket SCHEDULER_STATUS — no optimistic update needed
        if (schedulerEnabled) {
            await stopScheduler();
        } else {
            await startScheduler();
        }
    };

    // ============================================
    // SCHEDULE CRUD HANDLERS
    // ============================================

    const handleAddSchedule = async () => {
        if (!time || !source || !action) {
            alert("Please fill in all required fields.");
            return;
        }

        let scheduledDay = null;
        if (recurrence === "weekly") {
            scheduledDay = new Date().getDay();
        }
        if (recurrence === "days" && selectedDays.length === 0) {
            alert("Please select at least one day for 'Specific Days' recurrence.");
            return;
        }

        const scheduleData = {
            time,
            source,
            action,
            recurrence,
            days: recurrence === "days" ? selectedDays : [],
            scheduledDay,
            title,
            enabled: true
        };

        if (editingId) {
            await apiUpdateSchedule(editingId, scheduleData);
            setEditingId(null);
        } else {
            await apiAddSchedule(scheduleData);
        }

        resetForm();
        loadSchedules();
    };

    const handleEdit = (schedule) => {
        setTime(schedule.time);
        setSource(schedule.source);
        setAction(schedule.action);
        setRecurrence(schedule.recurrence);
        setTitle(schedule.title);
        setSelectedDays(schedule.days || []);
        setEditingId(schedule.id);
    };

    const handleDelete = async (id) => {
        await apiDeleteSchedule(id);
        loadSchedules();
    };

    const handleToggleEnable = async (id) => {
        await apiToggleSchedule(id);
        loadSchedules();
    };

    const resetForm = () => {
        setTime("");
        setSource("Live Player");
        setAction("show");
        setRecurrence("daily");
        setSelectedDays([]);
        setTitle("");
        setEditingId(null);
    };

    const handleDayToggle = (dayId) => {
        if (selectedDays.includes(dayId)) {
            setSelectedDays(selectedDays.filter(d => d !== dayId));
        } else {
            setSelectedDays([...selectedDays, dayId]);
        }
    };

    const formatTime12Hr = (timeString) => {
        if (!timeString) return "";
        const [hours, minutes] = timeString.split(":").map(Number);
        const date = new Date();
        date.setHours(hours);
        date.setMinutes(minutes);
        return date.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
        });
    };

    // ============================================
    // IMPORT/EXPORT
    // ============================================

    const handleCopy = () => {
        const dataStr = JSON.stringify(schedules, null, 2);
        navigator.clipboard.writeText(dataStr).then(() => alert("Copied to clipboard!"));
    };

    const handleImport = async () => {
        try {
            const data = JSON.parse(importData);
            if (Array.isArray(data)) {
                await importSchedules(data);
                setShowImportArea(false);
                setImportData("");
                loadSchedules();
                alert("Import successful!");
            } else {
                alert("Invalid format (must be an array)");
            }
        } catch (e) {
            alert("Invalid JSON");
        }
    };

    // ============================================
    // DRAG AND DROP
    // ============================================

    const onDragStart = (e, index) => {
        draggedItem.current = index;
        e.dataTransfer.effectAllowed = "move";
    };

    const onDragOver = (e, index) => {
        e.preventDefault();
    };

    const onDrop = async (e, index) => {
        const newSchedules = [...schedules];
        const draggedItemContent = newSchedules.splice(draggedItem.current, 1)[0];
        newSchedules.splice(index, 0, draggedItemContent);
        draggedItem.current = null;

        // Update server with new order
        await importSchedules(newSchedules);
        loadSchedules();
    };

    // ============================================
    // RENDER
    // ============================================

    if (loading) {
        return (
            <div id="scheduler-container" className="w-full px-2">
                <h2 className="text-2xl font-bold mb-4 text-[#00adb5] text-center">Scheduler</h2>
                <div className="text-center py-8 text-gray-400">Loading scheduler...</div>
            </div>
        );
    }

    return (
        <div id="scheduler-container" className="w-full px-2">
            <h2 className="text-2xl font-bold mb-4 text-[#00adb5] text-center">Scheduler</h2>

            {/* Server Status */}
            <div className="flex justify-center gap-2 mb-2">
                <span className={`text-xs px-2 py-1 rounded ${serverConnected ? 'bg-green-600/30 text-green-400' : 'bg-red-600/30 text-red-400'}`}>
                    {serverConnected ? '🟢 Server Connected' : '🔴 Server Disconnected'}
                </span>
            </div>

            {/* Toggle Button */}
            <div className="flex justify-center mb-4">
                <button
                    className={`px-6 py-2 rounded-full font-semibold transition-all ${schedulerEnabled
                        ? 'bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-600/30'
                        : 'bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-600/30'
                        }`}
                    onClick={handleToggleScheduler}
                >
                    Scheduler: {schedulerEnabled ? "On" : "Off"}
                </button>
            </div>

            {/* Pending Timeouts Display */}
            {schedulerEnabled && pendingTimeouts.length > 0 && (
                <div className="mb-4 p-3 bg-gradient-to-r from-gray-800 to-gray-900 rounded-lg border border-cyan-600/50">
                    <h3 className="text-sm font-semibold text-cyan-400 mb-2 flex items-center gap-2">
                        <span>⏰</span> Pending Schedules ({pendingTimeouts.length})
                        <span className="text-xs text-green-400 ml-auto">Server-Side</span>
                    </h3>
                    <div className="grid gap-1">
                        {pendingTimeouts.slice(0, 3).map((pt) => {
                            const now = new Date();
                            const remaining = pt.nextTrigger.getTime() - now.getTime();
                            return (
                                <div
                                    key={pt.id}
                                    className="flex justify-between items-center py-1 px-2 bg-gray-900/50 rounded text-sm"
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="text-white">{pt.title || pt.source}</span>
                                        <span className={`text-xs px-1.5 py-0.5 rounded ${pt.action === 'show' ? 'bg-green-600/80' : 'bg-red-600/80'}`}>
                                            {pt.action}
                                        </span>
                                    </div>
                                    <div className="text-right flex items-center gap-3">
                                        <span className="text-cyan-400 text-xs">
                                            {pt.nextTrigger.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}
                                        </span>
                                        <span className="text-yellow-400 text-xs font-mono">
                                            in {formatTimeRemaining(remaining)}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                        {pendingTimeouts.length > 3 && (
                            <div className="text-xs text-gray-500 text-center">+{pendingTimeouts.length - 3} more...</div>
                        )}
                    </div>
                </div>
            )}

            {/* Form - Compact Grid Layout */}
            <div className="bg-gray-800/50 rounded-lg p-4 mb-4 border border-gray-700">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                    {/* Time */}
                    <div>
                        <label className="text-xs text-gray-400 block mb-1">Time</label>
                        <input
                            type="time"
                            value={time}
                            onChange={(e) => setTime(e.target.value)}
                            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white text-sm focus:border-cyan-500 focus:outline-none"
                        />
                    </div>

                    {/* Source */}
                    <div>
                        <label className="text-xs text-gray-400 block mb-1">Source</label>
                        <select
                            value={source}
                            onChange={(e) => setSource(e.target.value)}
                            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white text-sm focus:border-cyan-500 focus:outline-none cursor-pointer"
                        >
                            <option value="Live Player">Live Player</option>
                            <option value="Loop Player">Loop Player</option>
                            <option value="Delay Live">Delay Live</option>
                            <option value="OrdaChesta">OrdaChesta</option>
                            <option value="Local Player">Local Player</option>
                        </select>
                    </div>

                    {/* Action */}
                    <div>
                        <label className="text-xs text-gray-400 block mb-1">Action</label>
                        <select
                            value={action}
                            onChange={(e) => setAction(e.target.value)}
                            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white text-sm focus:border-cyan-500 focus:outline-none cursor-pointer"
                        >
                            <option value="show">Show</option>
                            <option value="hide">Hide</option>
                        </select>
                    </div>

                    {/* Recurrence */}
                    <div>
                        <label className="text-xs text-gray-400 block mb-1">Recurrence</label>
                        <select
                            value={recurrence}
                            onChange={(e) => setRecurrence(e.target.value)}
                            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white text-sm focus:border-cyan-500 focus:outline-none cursor-pointer"
                        >
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly (Today)</option>
                            <option value="days">Specific Days</option>
                        </select>
                    </div>
                </div>

                {/* Specific Days */}
                {recurrence === "days" && (
                    <div className="flex flex-wrap gap-2 mb-3 p-2 bg-gray-900/50 rounded">
                        {daysList.map(day => (
                            <label
                                key={day.id}
                                className={`flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-xs transition-all ${selectedDays.includes(day.id)
                                    ? 'bg-cyan-600 text-white'
                                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                    }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedDays.includes(day.id)}
                                    onChange={() => handleDayToggle(day.id)}
                                    className="hidden"
                                />
                                <span>{day.label.slice(0, 3)}</span>
                            </label>
                        ))}
                    </div>
                )}

                {/* Description & Add Button */}
                <div className="flex gap-2">
                    <input
                        type="text"
                        placeholder="Description (optional)"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="flex-1 px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white text-sm focus:border-cyan-500 focus:outline-none"
                    />
                    <button
                        onClick={handleAddSchedule}
                        className={`px-4 py-2 rounded font-semibold text-white text-sm transition-all ${editingId
                            ? 'bg-yellow-600 hover:bg-yellow-700'
                            : 'bg-cyan-600 hover:bg-cyan-700'
                            }`}
                    >
                        {editingId ? "Update" : "Add"}
                    </button>
                    {editingId && (
                        <button
                            onClick={resetForm}
                            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded font-semibold text-white text-sm"
                        >
                            Cancel
                        </button>
                    )}
                </div>
            </div>

            {/* Schedule Table */}
            {schedules.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-gray-700">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-800 text-gray-400">
                            <tr>
                                <th className="px-3 py-2 text-left font-medium">Time</th>
                                <th className="px-3 py-2 text-left font-medium">Source</th>
                                <th className="px-3 py-2 text-left font-medium">Action</th>
                                <th className="px-3 py-2 text-left font-medium">When</th>
                                <th className="px-3 py-2 text-left font-medium">Title</th>
                                <th className="px-3 py-2 text-center font-medium">Status</th>
                                <th className="px-3 py-2 text-center font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-700">
                            {schedules.map((schedule, index) => (
                                <tr
                                    key={schedule.id}
                                    draggable
                                    onDragStart={(e) => onDragStart(e, index)}
                                    onDragOver={(e) => onDragOver(e, index)}
                                    onDrop={(e) => onDrop(e, index)}
                                    className="bg-gray-900/50 hover:bg-gray-800 cursor-move transition-colors"
                                >
                                    <td className="px-3 py-2 text-cyan-400 font-mono">{formatTime12Hr(schedule.time)}</td>
                                    <td className="px-3 py-2 text-white">{schedule.source}</td>
                                    <td className="px-3 py-2">
                                        <span className={`px-2 py-0.5 rounded text-xs ${schedule.action === 'show' ? 'bg-green-600/80' : 'bg-red-600/80'
                                            } text-white`}>
                                            {schedule.action}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-gray-400 text-xs">
                                        {schedule.recurrence === 'days'
                                            ? schedule.days.map(d => daysMap[d]).join(", ")
                                            : schedule.recurrence === 'weekly'
                                                ? `${daysMap[schedule.scheduledDay]}`
                                                : "Daily"
                                        }
                                    </td>
                                    <td className="px-3 py-2 text-gray-300">{schedule.title || '-'}</td>
                                    <td className="px-3 py-2 text-center">
                                        <button
                                            onClick={() => handleToggleEnable(schedule.id)}
                                            className={`px-2 py-1 rounded text-xs font-medium transition-all ${schedule.enabled
                                                ? 'bg-green-600 hover:bg-green-700 text-white'
                                                : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                                                }`}
                                        >
                                            {schedule.enabled ? "On" : "Off"}
                                        </button>
                                    </td>
                                    <td className="px-3 py-2 text-center space-x-1">
                                        <button
                                            onClick={() => handleEdit(schedule)}
                                            className="px-2 py-1 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-xs"
                                        >
                                            Edit
                                        </button>
                                        <button
                                            onClick={() => handleDelete(schedule.id)}
                                            className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs"
                                        >
                                            ✕
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Import/Export Buttons */}
            <div className="mt-4 flex gap-2 justify-center">
                <button
                    onClick={handleCopy}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-all"
                >
                    📋 Copy Schedules
                </button>
                <button
                    onClick={() => setShowImportArea(!showImportArea)}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm font-medium transition-all"
                >
                    📥 Import/Export
                </button>
            </div>

            {/* Import Area */}
            {showImportArea && (
                <div className="mt-3 p-3 bg-gray-800 rounded-lg border border-gray-700">
                    <textarea
                        className="w-full h-24 bg-gray-900 border border-gray-600 rounded p-2 text-white text-sm focus:border-cyan-500 focus:outline-none"
                        placeholder="Paste schedule JSON here..."
                        value={importData}
                        onChange={(e) => setImportData(e.target.value)}
                    ></textarea>
                    <button
                        onClick={handleImport}
                        className="w-full mt-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded font-medium transition-all"
                    >
                        Load Data
                    </button>
                </div>
            )}

            {/* Connection Status */}
            <p className="text-xs text-gray-500 text-center mt-4">
                {obsConnected ? '✓ OBS Connected' : '⚠ OBS WebSocket not connected'}
                {' | '}
                {serverConnected ? '✓ Scheduler Server Connected' : '⚠ Scheduler Server not connected'}
            </p>
        </div>
    );
};

export default Scheduler;

