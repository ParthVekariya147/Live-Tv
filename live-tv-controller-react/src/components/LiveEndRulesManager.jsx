import React, { useState, useEffect } from 'react';
import { getStateValue, setStateValue } from '../utils/state-api';
import {
    LIVE_END_RULES_LOCAL_KEY, LIVE_END_RULES_UPDATED_EVENT, LIVE_END_RULES_SERVER_KEY,
    newRule, loadLocalRules,
} from '../utils/liveEndRules';
import { LOOP_AUTOMATION_LOCAL_KEY } from './LoopPlaylistAutomation';

// Editor UI for Stream-End Rules (see ../utils/liveEndRules.js for the matching logic
// LivePlayerCard actually runs when a stream ends). Shared globally across the app — there is
// only one Live Player card, same scope as Channel Manager. Persisted the same dual way Loop
// Playlist Automation persists its own Groups: a localStorage mirror for instant same-tab
// reads plus a server-side copy (state-api) so it survives restarts.
const LiveEndRulesManager = () => {
    const [open, setOpen] = useState(false);
    const [rows, setRows] = useState([]);
    const [status, setStatus] = useState('');
    const [saving, setSaving] = useState(false);
    const [automationGroups, setAutomationGroups] = useState([]);

    useEffect(() => {
        const loadGroups = () => {
            try {
                const saved = localStorage.getItem(LOOP_AUTOMATION_LOCAL_KEY);
                const parsed = saved ? JSON.parse(saved) : [];
                setAutomationGroups(Array.isArray(parsed) ? parsed : []);
            } catch { setAutomationGroups([]); }
        };
        loadGroups();
        const onStorage = (e) => { if (e.key === LOOP_AUTOMATION_LOCAL_KEY) loadGroups(); };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const loadRules = async () => {
        const local = loadLocalRules();
        if (local.length > 0) { setRows(local); return; }
        const server = await getStateValue(LIVE_END_RULES_SERVER_KEY);
        setRows(Array.isArray(server) ? server : []);
    };

    useEffect(() => { if (open) loadRules(); }, [open]);

    const addRow = () => setRows((prev) => [...prev, newRule()]);
    const updateRow = (id, patch) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const deleteRow = (id) => setRows((prev) => prev.filter((r) => r.id !== id));
    const setDefaultRow = (id) => setRows((prev) => prev.map((r) => ({ ...r, isDefault: r.id === id })));

    const handleSave = async () => {
        setSaving(true);
        setStatus('Saving...');
        try {
            localStorage.setItem(LIVE_END_RULES_LOCAL_KEY, JSON.stringify(rows));
            await setStateValue(LIVE_END_RULES_SERVER_KEY, rows);
            window.dispatchEvent(new CustomEvent(LIVE_END_RULES_UPDATED_EVENT));
            setStatus(`Saved ${rows.length} rule(s).`);
        } catch (err) {
            setStatus(`Failed to save: ${err.message}`);
        } finally {
            setSaving(false);
        }
    };

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                className="px-2 py-1 rounded text-xs font-medium transition-all bg-gray-700 hover:bg-gray-600 text-amber-400 border border-amber-800/40 flex items-center gap-1"
                title="Map ended stream titles to a Loop Playlist Automation Group/Playlist to auto-start"
            >
                ⚙ End Rules
            </button>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center overflow-y-auto py-6 px-3">
            <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-3xl text-sm text-gray-200">
                <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-4 py-3 flex justify-between items-center rounded-t-lg z-10">
                    <div>
                        <h2 className="text-lg font-bold text-amber-400">Stream-End Rules</h2>
                        <p className="text-xs text-gray-400">
                            {status || 'When the live stream ends, its title is matched against these keywords to pick which Group/Playlist to start. The row marked Default runs when nothing matches.'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={addRow} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-xs font-medium">+ Add Rule</button>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="bg-green-700 hover:bg-green-600 text-white px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50"
                        >
                            {saving ? 'Saving...' : 'Save'}
                        </button>
                        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white text-xl leading-none px-2">×</button>
                    </div>
                </div>

                <div className="p-4 space-y-2">
                    {rows.length === 0 && (
                        <div className="text-center py-10 text-gray-500">
                            <p>No rules configured yet.</p>
                            <p className="text-xs mt-1">Click "+ Add Rule" — enter keyword(s) from the stream title (comma-separated) and pick which Group/Playlist to start when it ends. Mark one rule Default as the fallback.</p>
                        </div>
                    )}

                    {rows.map((row) => {
                        const selectedGroup = automationGroups.find((g) => g.id === row.groupId);
                        return (
                            <div key={row.id} className="flex gap-2 items-center bg-gray-800 border border-gray-700 rounded p-2">
                                <input
                                    type="text"
                                    className="input-field flex-1 min-w-0"
                                    placeholder={row.isDefault ? 'Default — keywords ignored' : 'Keyword(s) from title, comma-separated'}
                                    value={row.keywords}
                                    disabled={row.isDefault}
                                    onChange={(e) => updateRow(row.id, { keywords: e.target.value })}
                                />
                                <select
                                    className="input-field flex-none"
                                    style={{ width: '160px' }}
                                    value={row.groupId}
                                    onChange={(e) => updateRow(row.id, { groupId: e.target.value, listId: '' })}
                                >
                                    <option value="">— Pick Group —</option>
                                    {automationGroups.map((g) => (
                                        <option key={g.id} value={g.id}>{g.serial ? `${g.serial} - ` : ''}{g.name || 'Unnamed Group'}</option>
                                    ))}
                                </select>
                                {selectedGroup && selectedGroup.lists.length > 0 && (
                                    <select
                                        className="input-field flex-none"
                                        style={{ width: '160px' }}
                                        value={row.listId || ''}
                                        onChange={(e) => updateRow(row.id, { listId: e.target.value })}
                                        title="Specific playlist to start within that Group (blank = Group's normal starting playlist)"
                                    >
                                        <option value="">Playlist: first</option>
                                        {selectedGroup.lists.map((l) => (
                                            <option key={l.id} value={l.id}>{l.serial ? `${l.serial} - ` : ''}{l.name || 'Unnamed'}</option>
                                        ))}
                                    </select>
                                )}
                                <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap px-1" title="Fallback used when no keyword rule matches the ended title">
                                    <input type="radio" name="liveEndDefault" checked={!!row.isDefault} onChange={() => setDefaultRow(row.id)} />
                                    Default
                                </label>
                                <button
                                    onClick={() => deleteRow(row.id)}
                                    className="bg-red-700 hover:bg-red-600 text-white px-2 py-1.5 rounded text-xs font-medium"
                                    title="Remove this rule"
                                >
                                    Delete
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default LiveEndRulesManager;
