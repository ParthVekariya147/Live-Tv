import React, { useRef, useState, useEffect, useCallback } from 'react';

// All localStorage keys used across the app (excludes logs)
const LS_KEYS = [
    'loopPlayerState',
    'livePlayerState',
    'delayPlayerState',
    'localPCPlayerState',
    'localPCPlayerEndActions',
    'localPCPlayerFolderPath',
    'liveAutoRecord',
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

// Validate all player states in a localStorage snapshot — returns array of warning strings
function validatePlayerStates(lsData) {
    const warnings = [];

    // Loop Player
    try {
        const loop = JSON.parse(lsData.loopPlayerState || 'null');
        if (loop) {
            if (!Array.isArray(loop.playlist)) {
                warnings.push('Loop Player: playlist is not an array');
            } else {
                const nullEntries = loop.playlist.filter(id => !id || id === 'null').length;
                if (nullEntries > 0) warnings.push(`Loop Player: ${nullEntries} null/empty playlist entries`);
                if (typeof loop.currentIndex !== 'number') warnings.push('Loop Player: missing currentIndex');
                else if (loop.currentIndex >= loop.playlist.length && loop.playlist.length > 0) warnings.push('Loop Player: currentIndex out of bounds');
                if (!loop.videoId && loop.playlist.length > 0) warnings.push('Loop Player: videoId is null/empty');
            }
        }
    } catch (_) { warnings.push('Loop Player: state JSON is corrupted'); }

    // Live Player
    try {
        const live = JSON.parse(lsData.livePlayerState || 'null');
        if (live && !live.videoId) warnings.push('Live Player: videoId is null/empty');
    } catch (_) { warnings.push('Live Player: state JSON is corrupted'); }

    // Delay Player
    try {
        const delay = JSON.parse(lsData.delayPlayerState || 'null');
        if (delay && !delay.videoId) warnings.push('Delay Player: videoId is null/empty');
    } catch (_) { warnings.push('Delay Player: state JSON is corrupted'); }

    // Local PC Player
    try {
        const local = JSON.parse(lsData.localPCPlayerState || 'null');
        if (local) {
            if (!Array.isArray(local.playlist)) {
                warnings.push('Local PC Player: playlist is not an array');
            } else {
                const emptyPaths = local.playlist.filter(item => !item?.path).length;
                if (emptyPaths > 0) warnings.push(`Local PC Player: ${emptyPaths} playlist entries have no path`);
                if (typeof local.currentIndex !== 'number') warnings.push('Local PC Player: missing currentIndex');
                else if (local.playlist.length > 0 && local.currentIndex >= local.playlist.length) warnings.push('Local PC Player: currentIndex out of bounds');
            }
        }
    } catch (_) { warnings.push('Local PC Player: state JSON is corrupted'); }

    // End actions
    try {
        const actions = JSON.parse(lsData.localPCPlayerEndActions || 'null');
        if (actions !== null && (!Array.isArray(actions) || actions.length !== 7)) {
            warnings.push('Local PC Player: end actions array is malformed');
        }
    } catch (_) { warnings.push('Local PC Player: end actions JSON is corrupted'); }

    return warnings;
}

// Validate and repair an imported localStorage snapshot — returns { repaired, warnings }
function validateAndRepairImportData(lsData) {
    const warnings = [];
    const repaired = { ...lsData };

    // ── Loop Player ──────────────────────────────────────────────────────────
    if (repaired.loopPlayerState !== undefined) {
        try {
            const loop = typeof repaired.loopPlayerState === 'string'
                ? JSON.parse(repaired.loopPlayerState)
                : repaired.loopPlayerState;
            let changed = false;

            if (!Array.isArray(loop.playlist)) {
                loop.playlist = [];
                loop.currentIndex = 0;
                loop.videoId = '';
                warnings.push('Loop Player: playlist missing — defaulted to empty');
                changed = true;
            } else {
                const before = loop.playlist.length;
                loop.playlist = loop.playlist.filter(id => id && id !== 'null' && typeof id === 'string');
                if (loop.playlist.length < before) {
                    warnings.push(`Loop Player: removed ${before - loop.playlist.length} null/empty playlist entries`);
                    changed = true;
                }
                if (typeof loop.currentIndex !== 'number' || loop.currentIndex < 0 || (loop.playlist.length > 0 && loop.currentIndex >= loop.playlist.length)) {
                    loop.currentIndex = 0;
                    warnings.push('Loop Player: currentIndex invalid — reset to 0');
                    changed = true;
                }
                if (!loop.videoId && loop.playlist.length > 0) {
                    loop.videoId = loop.playlist[loop.currentIndex] || '';
                    warnings.push('Loop Player: videoId was null — rebuilt from playlist');
                    changed = true;
                }
            }
            if (loop.isPlaying === undefined) { loop.isPlaying = true; changed = true; }
            if (loop.isMuted === undefined) { loop.isMuted = false; changed = true; }
            if (loop.isStopped === undefined) { loop.isStopped = false; changed = true; }
            if (changed) repaired.loopPlayerState = JSON.stringify(loop);
        } catch (e) {
            warnings.push('Loop Player: state unparseable — skipping (' + e.message + ')');
            delete repaired.loopPlayerState;
        }
    }

    // ── Live Player ──────────────────────────────────────────────────────────
    if (repaired.livePlayerState !== undefined) {
        try {
            const live = typeof repaired.livePlayerState === 'string'
                ? JSON.parse(repaired.livePlayerState)
                : repaired.livePlayerState;
            let changed = false;
            if (!live.priority) { live.priority = 'matchSearchTerms'; changed = true; }
            if (live.isPlaying === undefined) { live.isPlaying = true; changed = true; }
            if (live.isMuted === undefined) { live.isMuted = false; changed = true; }
            if (live.isStopped === undefined) { live.isStopped = false; changed = true; }
            if (changed) repaired.livePlayerState = JSON.stringify(live);
        } catch (e) {
            warnings.push('Live Player: state unparseable — skipping (' + e.message + ')');
            delete repaired.livePlayerState;
        }
    }

    // ── Delay Player ─────────────────────────────────────────────────────────
    if (repaired.delayPlayerState !== undefined) {
        try {
            const delay = typeof repaired.delayPlayerState === 'string'
                ? JSON.parse(repaired.delayPlayerState)
                : repaired.delayPlayerState;
            let changed = false;
            if (delay.isPlaying === undefined) { delay.isPlaying = true; changed = true; }
            if (delay.isMuted === undefined) { delay.isMuted = false; changed = true; }
            if (delay.isStopped === undefined) { delay.isStopped = false; changed = true; }
            if (delay.startTime === undefined) { delay.startTime = ''; changed = true; }
            if (delay.endTime === undefined) { delay.endTime = ''; changed = true; }
            if (changed) repaired.delayPlayerState = JSON.stringify(delay);
        } catch (e) {
            warnings.push('Delay Player: state unparseable — skipping (' + e.message + ')');
            delete repaired.delayPlayerState;
        }
    }

    // ── Local PC Player ──────────────────────────────────────────────────────
    if (repaired.localPCPlayerState !== undefined) {
        try {
            const local = typeof repaired.localPCPlayerState === 'string'
                ? JSON.parse(repaired.localPCPlayerState)
                : repaired.localPCPlayerState;
            let changed = false;

            if (!Array.isArray(local.playlist)) {
                local.playlist = [];
                local.currentIndex = 0;
                warnings.push('Local PC Player: playlist missing — defaulted to empty');
                changed = true;
            } else {
                // Ensure all items have the enabled field (forward-compatibility migration)
                local.playlist = local.playlist.map(item => ({ ...item, enabled: item.enabled !== false }));
                changed = true;
                if (typeof local.currentIndex !== 'number' || local.currentIndex < 0) {
                    local.currentIndex = 0;
                    warnings.push('Local PC Player: currentIndex invalid — reset to 0');
                } else if (local.playlist.length > 0 && local.currentIndex >= local.playlist.length) {
                    local.currentIndex = 0;
                    warnings.push('Local PC Player: currentIndex out of bounds — reset to 0');
                }
            }
            if (local.isPlaying === undefined) { local.isPlaying = true; changed = true; }
            if (local.isMuted === undefined) { local.isMuted = false; changed = true; }
            if (local.isStopped === undefined) { local.isStopped = false; changed = true; }
            if (changed) repaired.localPCPlayerState = JSON.stringify(local);
        } catch (e) {
            warnings.push('Local PC Player: state unparseable — skipping (' + e.message + ')');
            delete repaired.localPCPlayerState;
        }
    }

    // ── End Actions ──────────────────────────────────────────────────────────
    if (repaired.localPCPlayerEndActions !== undefined) {
        try {
            const actions = typeof repaired.localPCPlayerEndActions === 'string'
                ? JSON.parse(repaired.localPCPlayerEndActions)
                : repaired.localPCPlayerEndActions;
            if (!Array.isArray(actions) || actions.length !== 7) {
                repaired.localPCPlayerEndActions = JSON.stringify([null, null, null, null, null, null, null]);
                warnings.push('Local PC Player: end actions array malformed — defaulted to empty');
            }
        } catch (e) {
            warnings.push('Local PC Player: end actions unparseable — skipping (' + e.message + ')');
            delete repaired.localPCPlayerEndActions;
        }
    }

    return { repaired, warnings };
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
            window.dispatchEvent(new CustomEvent('flushPlayerState'));
            await new Promise(r => setTimeout(r, 400));

            const res = await fetch('/api/settings/export');
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const serverData = await res.json();
            const localStorageData = readLocalStorage();

            const validationWarnings = validatePlayerStates(localStorageData);
            if (validationWarnings.length > 0) {
                console.warn('[Export] Validation warnings:', validationWarnings);
            }

            const fullExport = {
                exportedAt: new Date().toISOString(),
                version: '2.0',
                serverState: serverData.state,
                schedules: serverData.schedules,
                localStorage: localStorageData,
                validation: {
                    warnings: validationWarnings,
                    playerKeys: Object.keys(localStorageData),
                },
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
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            const schedCount = (fullExport.schedules || []).length;
            const lsCount = Object.keys(localStorageData).length;
            const warnSuffix = validationWarnings.length > 0
                ? ` — ${validationWarnings.length} warning${validationWarnings.length > 1 ? 's' : ''} (see console)`
                : '';
            flash(validationWarnings.length > 0 ? 'warn' : 'success', `Exported ${lsCount} settings + ${schedCount} schedules${warnSuffix}`);
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
            const rawLsData = json.localStorage || {};

            const { repaired: lsData, warnings: repairWarnings } = validateAndRepairImportData(rawLsData);
            if (repairWarnings.length > 0) {
                console.warn('[Import] Repair warnings:', repairWarnings);
            }

            const res = await fetch('/api/settings/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: serverState, schedules }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Server import failed');

            if (lsData && Object.keys(lsData).length > 0) {
                Object.entries(lsData).forEach(([key, value]) => {
                    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
                });
            }

            const lsCount = Object.keys(lsData).length;
            const warnSuffix = repairWarnings.length > 0
                ? ` — ${repairWarnings.length} field${repairWarnings.length > 1 ? 's' : ''} repaired`
                : '';
            flash('success', `Imported ${lsCount} settings + ${data.schedulesCount} schedules${warnSuffix}. Reloading...`);
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
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${status.type === 'success' ? 'bg-green-900 text-green-300' : status.type === 'warn' ? 'bg-yellow-900 text-yellow-300' : 'bg-red-900 text-red-300'}`}>
                    {status.type === 'success' ? '✓' : status.type === 'warn' ? '⚠' : '✗'} {status.msg}
                </span>
            )}
        </div>
    );
}
