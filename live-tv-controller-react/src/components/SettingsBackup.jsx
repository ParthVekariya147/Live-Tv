import React, { useRef, useState, useEffect, useCallback } from 'react';

// All localStorage keys used across the app (excludes logs)
const LS_KEYS = [
    'loopPlayerState',
    'livePlayerState',
    'delayPlayerState',
    'localPCPlayerState',
    'localPCPlayerEndActions',
    'savedSearchTitles1',
    'savedSearchTitles2',
    'liveMonitorEnabled1',
    'liveMonitorEnabled2',
    'liveSelectedChannelId',
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

function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
}

function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeAutoSettings(cfg) {
    if (!cfg) return '12h (default)';
    if (cfg.mode === 'hours') return `Every ${cfg.intervalHours}h`;
    if (cfg.mode === 'days')  return `Every ${cfg.intervalDays}d`;
    if (cfg.mode === 'weekly') return `Every ${DAY_NAMES[cfg.dayOfWeek ?? 4]}`;
    return '?';
}

function isActiveSetting(cfg, mode, value) {
    if (!cfg) return false;
    if (cfg.mode !== mode) return false;
    if (mode === 'hours')  return cfg.intervalHours === value;
    if (mode === 'days')   return cfg.intervalDays  === value;
    if (mode === 'weekly') return cfg.dayOfWeek     === value;
    return false;
}

export default function SettingsBackup() {
    const fileInputRef = useRef(null);
    const [status, setStatus] = useState(null);
    const [importing, setImporting] = useState(false);

    // Backup panel state
    const [showBackups, setShowBackups] = useState(false);
    const [backupList, setBackupList] = useState([]);
    const [backupStatus, setBackupStatus] = useState(null); // { manual, auto, autoSettings }
    const [savingBackup, setSavingBackup] = useState(false);
    const [restoring, setRestoring] = useState(null); // filename being restored
    const [autoSettings, setAutoSettings] = useState(null); // { mode, intervalHours, intervalDays, dayOfWeek }
    const [savingAutoSettings, setSavingAutoSettings] = useState(false);

    function flash(type, msg) {
        setStatus({ type, msg });
        setTimeout(() => setStatus(null), 4000);
    }

    const loadBackupStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/backup/status');
            if (res.ok) {
                const data = await res.json();
                setBackupStatus(data);
                if (data.autoSettings) setAutoSettings(data.autoSettings);
            }
        } catch (_) {}
    }, []);

    const loadBackupList = useCallback(async () => {
        try {
            const res = await fetch('/api/backup/list?type=manual');
            if (res.ok) {
                const data = await res.json();
                setBackupList(data.backups || []);
            }
        } catch (_) {}
    }, []);

    useEffect(() => {
        loadBackupStatus();
    }, [loadBackupStatus]);

    useEffect(() => {
        if (showBackups) loadBackupList();
    }, [showBackups, loadBackupList]);

    async function saveAutoConfig(cfg) {
        setSavingAutoSettings(true);
        try {
            const res = await fetch('/api/backup/auto-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg),
            });
            const data = await res.json();
            if (data.success) {
                setAutoSettings(data.settings);
                flash('success', `Auto-backup set: ${describeAutoSettings(data.settings)}`);
            } else {
                flash('error', data.error || 'Failed to save');
            }
        } catch (e) {
            flash('error', e.message);
        } finally {
            setSavingAutoSettings(false);
        }
    }

    async function handleManualBackup() {
        setSavingBackup(true);
        try {
            const res = await fetch('/api/backup/manual', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                flash('success', `Saved: ${data.filename}`);
                await loadBackupStatus();
                if (showBackups) await loadBackupList();
            } else {
                flash('error', data.error || 'Backup failed');
            }
        } catch (e) {
            flash('error', e.message);
        } finally {
            setSavingBackup(false);
        }
    }

    async function handleRestore(filename) {
        if (!window.confirm(`Restore from "${filename}"?\n\nThis will overwrite current schedules and settings. The page will reload.`)) return;
        setRestoring(filename);
        try {
            const res = await fetch('/api/backup/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'manual', filename }),
            });
            const data = await res.json();
            if (data.success) {
                flash('success', `Restored ${data.restored} files from ${filename}. Reloading...`);
                setTimeout(() => window.location.reload(), 1500);
            } else {
                flash('error', data.error || 'Restore failed');
            }
        } catch (e) {
            flash('error', e.message);
        } finally {
            setRestoring(null);
        }
    }

    async function handleExport() {
        try {
            const res = await fetch('/api/settings/export');
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const serverData = await res.json();
            const localStorageData = readLocalStorage();

            const fullExport = {
                exportedAt: new Date().toISOString(),
                version: '2.0',
                serverState: serverData.state,
                schedules: serverData.schedules,
                localStorage: localStorageData,
            };

            const filename = `live-tv-settings-${new Date().toISOString().slice(0, 10)}.json`;
            const blob = new Blob([JSON.stringify(fullExport, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);

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

            const serverState = json.serverState || json.state || {};
            const schedules = json.schedules || [];
            const lsData = json.localStorage || {};

            restoreLocalStorage(lsData);

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

            {/* Row 1: Export / Import */}
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
                    title="Import settings from JSON file"
                    className={`px-2 py-1 rounded text-xs font-medium transition-all text-white ${importing ? 'bg-gray-600 cursor-wait' : 'bg-green-700 hover:bg-green-600'}`}
                >
                    {importing ? '...' : '⬆ Import'}
                </button>
                <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleImport} />
            </div>

            {/* Row 2: Backup controls */}
            <div className="flex gap-1">
                <button
                    onClick={handleManualBackup}
                    disabled={savingBackup}
                    title="Save a manual backup to backups/manual_backup/ folder next to the EXE"
                    className={`px-2 py-1 rounded text-xs font-medium transition-all text-white ${savingBackup ? 'bg-gray-600 cursor-wait' : 'bg-purple-700 hover:bg-purple-600'}`}
                >
                    {savingBackup ? '...' : '💾 Backup'}
                </button>
                <button
                    onClick={() => setShowBackups(v => !v)}
                    title="Show backup history"
                    className={`px-2 py-1 rounded text-xs font-medium transition-all ${showBackups ? 'bg-gray-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
                >
                    📂 History
                </button>
            </div>

            {/* Auto-backup status */}
            {backupStatus && (
                <div className="text-xs text-gray-500 text-right leading-tight">
                    <div>Auto: {backupStatus.auto?.latest ? fmtDate(backupStatus.auto.latest.modifiedAt) : 'none yet'}</div>
                    {backupStatus.manual?.latest && (
                        <div>Manual: {fmtDate(backupStatus.manual.latest.modifiedAt)}</div>
                    )}
                </div>
            )}

            {/* Backup history + schedule panel */}
            {showBackups && (
                <div className="bg-gray-900 border border-purple-700/50 rounded-lg p-3 w-72 text-xs mt-1">

                    {/* ── Auto-backup Schedule ─────────────────────────── */}
                    <p className="text-purple-400 font-semibold mb-2">Auto-Backup Schedule</p>
                    <p className="text-gray-500 mb-2">
                        Current: <span className="text-gray-300">{describeAutoSettings(autoSettings)}</span>
                    </p>

                    {/* Hours row */}
                    <div className="mb-1">
                        <span className="text-gray-500 mr-1">Hours:</span>
                        <div className="inline-flex flex-wrap gap-1">
                            {[6, 10, 12, 20, 24].map(h => (
                                <button
                                    key={h}
                                    disabled={savingAutoSettings}
                                    onClick={() => saveAutoConfig({ mode: 'hours', intervalHours: h })}
                                    className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${
                                        isActiveSetting(autoSettings, 'hours', h)
                                            ? 'bg-purple-600 text-white'
                                            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                                >{h}h</button>
                            ))}
                        </div>
                    </div>

                    {/* Days row */}
                    <div className="mb-1">
                        <span className="text-gray-500 mr-1">Days:</span>
                        <div className="inline-flex flex-wrap gap-1">
                            {[1, 7, 15].map(d => (
                                <button
                                    key={d}
                                    disabled={savingAutoSettings}
                                    onClick={() => saveAutoConfig({ mode: 'days', intervalDays: d })}
                                    className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${
                                        isActiveSetting(autoSettings, 'days', d)
                                            ? 'bg-purple-600 text-white'
                                            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                                >{d}d</button>
                            ))}
                        </div>
                    </div>

                    {/* Weekly row */}
                    <div className="mb-3">
                        <span className="text-gray-500 mr-1">Weekly:</span>
                        <div className="inline-flex flex-wrap gap-1">
                            {DAY_SHORT.map((day, idx) => (
                                <button
                                    key={idx}
                                    disabled={savingAutoSettings}
                                    onClick={() => saveAutoConfig({ mode: 'weekly', dayOfWeek: idx })}
                                    className={`px-1.5 py-0.5 rounded text-xs font-medium transition-all ${
                                        isActiveSetting(autoSettings, 'weekly', idx)
                                            ? 'bg-purple-600 text-white'
                                            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                                >{day}</button>
                            ))}
                        </div>
                    </div>

                    {/* ── Manual Backup History ────────────────────────── */}
                    <div className="border-t border-gray-700 pt-2">
                        <div className="flex items-center justify-between mb-1">
                            <p className="text-purple-400 font-semibold">Manual Backups</p>
                            <button onClick={loadBackupList} className="text-gray-500 hover:text-gray-300">↻</button>
                        </div>
                        {backupStatus?.paths?.manual && (
                            <p className="text-gray-600 text-xs font-mono break-all mb-2" title="Backup folder location">
                                📁 {backupStatus.paths.manual}
                            </p>
                        )}
                        {backupList.length === 0 ? (
                            <p className="text-gray-500 text-center py-2">No manual backups yet</p>
                        ) : (
                            <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                                {backupList.map(b => (
                                    <div key={b.filename} className="flex items-center justify-between py-1 px-2 bg-gray-800/60 rounded">
                                        <div className="flex flex-col">
                                            <span className="text-gray-200">{fmtDate(b.modifiedAt)}</span>
                                            <span className="text-gray-500">{fmtSize(b.size)}</span>
                                        </div>
                                        <button
                                            onClick={() => handleRestore(b.filename)}
                                            disabled={restoring === b.filename}
                                            className="px-2 py-0.5 bg-orange-700 hover:bg-orange-600 text-white rounded text-xs ml-2 flex-shrink-0"
                                        >
                                            {restoring === b.filename ? '...' : 'Restore'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-1 mt-2">
                            <button
                                onClick={() => fetch('/api/backup/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: 'manual_backup' }) })}
                                className="flex-1 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs flex items-center justify-center gap-1"
                                title="Open manual_backup folder in Explorer"
                            >
                                📂 Manual ↗
                            </button>
                            <button
                                onClick={() => fetch('/api/backup/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: 'auto_backup' }) })}
                                className="flex-1 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs flex items-center justify-center gap-1"
                                title="Open auto_backup folder in Explorer"
                            >
                                📂 Auto ↗
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {status && (
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${status.type === 'success' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
                    {status.type === 'success' ? '✓' : '✗'} {status.msg}
                </span>
            )}
        </div>
    );
}
