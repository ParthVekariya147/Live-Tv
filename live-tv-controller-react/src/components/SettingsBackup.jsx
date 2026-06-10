import React, { useRef, useState } from 'react';

// All localStorage keys used across the app (excludes logs)
const LS_KEYS = [
    'loopPlayerState',       // Loop Player: playlist, currentIndex, muted, isPlaying
    'livePlayerState',       // Live Player: videoId, priority, muted, isPlaying
    'delayPlayerState',      // Delay Live Player: videoId, startTime, endTime, muted
    'localPCPlayerState',    // Local PC Player: playlist (paths), currentIndex, muted
    'localPCPlayerEndActions', // Local PC: end-of-playlist actions by day (7 days)
    'savedSearchTitles1',    // Monitor 1: search terms (auto-load)
    'savedSearchTitles2',    // Monitor 2: search terms (auto-load)
    'liveMonitorEnabled1',   // Monitor 1: enabled flag
    'liveMonitorEnabled2',   // Monitor 2: enabled flag
    'liveSelectedChannelId', // Monitor: selected channel
];

function readLocalStorage() {
    const data = {};
    for (const key of LS_KEYS) {
        const val = localStorage.getItem(key);
        if (val !== null) data[key] = val;
    }
    return data;
}

function restoreLocalStorage(data) {
    if (!data || typeof data !== 'object') return;
    for (const key of LS_KEYS) {
        if (key in data) localStorage.setItem(key, data[key]);
    }
}

export default function SettingsBackup() {
    const fileInputRef = useRef(null);
    const [status, setStatus] = useState(null);
    const [importing, setImporting] = useState(false);

    function flash(type, msg) {
        setStatus({ type, msg });
        setTimeout(() => setStatus(null), 4000);
    }

    async function handleExport() {
        try {
            // 1. Fetch server-side state + schedules
            const res = await fetch('/api/settings/export');
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const serverData = await res.json();

            // 2. Read ALL localStorage keys from browser
            const localStorageData = readLocalStorage();

            // 3. Merge into one complete export file
            const fullExport = {
                exportedAt: new Date().toISOString(),
                version: '2.0',
                // Server-side data
                serverState: serverData.state,
                schedules: serverData.schedules,
                // Browser-side data (all player + monitor settings)
                localStorage: localStorageData,
            };

            const filename = `live-tv-settings-${new Date().toISOString().slice(0, 10)}.json`;
            const blob = new Blob([JSON.stringify(fullExport, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);

            const schedCount = (fullExport.schedules || []).length;
            const lsCount = Object.keys(localStorageData).length;
            flash('success', `Exported ${lsCount} player settings + ${schedCount} schedules`);
        } catch (e) {
            flash('error', e.message);
        }
    }

    async function handleImport(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        setImporting(true);

        try {
            const text = await file.text();
            const json = JSON.parse(text);

            // Support both v1.0 (old) and v2.0 (new) export format
            const serverState = json.serverState || json.state || {};
            const schedules = json.schedules || [];
            const lsData = json.localStorage || {};

            // 1. Restore all localStorage keys in browser
            restoreLocalStorage(lsData);

            // 2. Send server-side state + schedules to backend
            const res = await fetch('/api/settings/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: serverState, schedules }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Server import failed');

            const lsCount = Object.keys(lsData).length;
            flash('success', `Imported ${lsCount} player settings + ${data.schedulesCount} schedules. Reloading...`);
            setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
            flash('error', e.message);
        } finally {
            setImporting(false);
        }
    }

    return (
        <div className="flex flex-col gap-1 items-end">
            <span className="text-xs text-cyan-400 font-semibold mb-1">Settings</span>
            <div className="flex gap-1">
                <button
                    onClick={handleExport}
                    title="Export all settings to JSON (players, monitors, schedules)"
                    className="px-2 py-1 rounded text-xs font-medium transition-all bg-blue-700 hover:bg-blue-600 text-white"
                >
                    ⬇ Export
                </button>
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                    title="Import settings from JSON file — restores all players, monitors, schedules"
                    className={`px-2 py-1 rounded text-xs font-medium transition-all text-white ${importing ? 'bg-gray-600 cursor-wait' : 'bg-green-700 hover:bg-green-600'}`}
                >
                    {importing ? '...' : '⬆ Import'}
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={handleImport}
                />
            </div>
            {status && (
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${status.type === 'success' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
                    {status.type === 'success' ? '✓' : '✗'} {status.msg}
                </span>
            )}
        </div>
    );
}
