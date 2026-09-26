import React, { useState, useEffect } from 'react';
import { getStateValue, setStateValue } from '../utils/state-api';
import {
    FAILOVER_LOCAL_KEY, FAILOVER_SERVER_KEY, FAILOVER_UPDATED_EVENT,
    MIN_THRESHOLD, MAX_THRESHOLD,
    defaultFailoverConfig, failoverTargets, normalizeFailoverConfig,
} from '../utils/playbackFailover';
import { LOOP_AUTOMATION_LOCAL_KEY } from './LoopPlaylistAutomation';

// Editor UI for Playback Failover — what happens when several videos in a row fail to
// play. The rules it edits live in ../utils/playbackFailover.js; LoopPlayerCard and
// LoopPlaylistAutomation are what actually run them. Persisted the same dual way as
// Stream-End Rules and the automation Groups: a localStorage mirror for instant reads
// plus a server copy so it survives a restart and reaches a second machine.
const PlaybackFailoverManager = () => {
    const [open, setOpen] = useState(false);
    const [cfg, setCfg] = useState(defaultFailoverConfig);
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

    // localStorage first, then the server copy — the same fallback the Stream-End Rules
    // runtime needed, for the same reason: a machine that never saved these locally would
    // otherwise show defaults while the real config sat on the server.
    const loadConfig = async () => {
        try {
            const local = localStorage.getItem(FAILOVER_LOCAL_KEY);
            if (local) { setCfg(normalizeFailoverConfig(JSON.parse(local))); return; }
        } catch { /* fall through to the server copy */ }
        try {
            setCfg(normalizeFailoverConfig(await getStateValue(FAILOVER_SERVER_KEY)));
        } catch { setCfg(defaultFailoverConfig()); }
    };

    useEffect(() => { if (open) loadConfig(); }, [open]);

    const update = (patch) => setCfg((prev) => ({ ...prev, ...patch }));

    const handleSave = async () => {
        setSaving(true);
        setStatus('Saving...');
        const clean = normalizeFailoverConfig(cfg);
        try {
            localStorage.setItem(FAILOVER_LOCAL_KEY, JSON.stringify(clean));
            await setStateValue(FAILOVER_SERVER_KEY, clean);
            setCfg(clean);
            window.dispatchEvent(new CustomEvent(FAILOVER_UPDATED_EVENT));
            setStatus('Saved.');
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
                className="px-2 py-1 rounded text-xs font-medium transition-all bg-gray-700 hover:bg-gray-600 text-red-400 border border-red-800/40 flex items-center gap-1"
                title="What to do when several videos in a row fail to play — which player takes over, and which playlist starts"
            >
                🚨 Failover
            </button>
        );
    }

    const selectedGroup = automationGroups.find((g) => g.id === cfg.groupId);

    return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center overflow-y-auto py-6 px-3">
            <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl text-sm text-gray-200">
                <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-4 py-3 flex justify-between items-center rounded-t-lg z-10">
                    <div>
                        <h2 className="text-lg font-bold text-red-400">Playback Failover</h2>
                        <p className="text-xs text-gray-400">
                            {status || 'When videos keep failing to play, stop advancing, put another player on air and send an emergency notification.'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
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

                <div className="p-4 space-y-4">
                    <label className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded p-3 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={cfg.enabled}
                            onChange={(e) => update({ enabled: e.target.checked })}
                        />
                        <span className="font-semibold text-white">Enable failover</span>
                        <span className="text-xs text-gray-400">
                            Off = advancing still halts and you still get the notification, but no player switch happens.
                        </span>
                    </label>

                    <div className="bg-gray-800 border border-gray-700 rounded p-3 space-y-3">
                        <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-gray-300">After</span>
                            <input
                                type="number"
                                className="input-field"
                                style={{ width: '80px' }}
                                min={MIN_THRESHOLD}
                                max={MAX_THRESHOLD}
                                value={cfg.threshold}
                                onChange={(e) => update({ threshold: e.target.value })}
                                title={`How many videos in a row may fail before failing over (${MIN_THRESHOLD}-${MAX_THRESHOLD})`}
                            />
                            <span className="text-gray-300">videos in a row fail to play, switch to</span>
                            <select
                                className="input-field"
                                style={{ width: '170px' }}
                                value={cfg.targetPlayer}
                                onChange={(e) => update({ targetPlayer: e.target.value })}
                                title="Any player you have. The failing player is never handed back to itself."
                            >
                                {failoverTargets().map((name) => (
                                    <option key={name} value={name}>{name}</option>
                                ))}
                            </select>
                        </div>

                        <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-gray-300">…and start</span>
                            <select
                                className="input-field"
                                style={{ width: '190px' }}
                                value={cfg.groupId}
                                onChange={(e) => update({ groupId: e.target.value, listId: '' })}
                            >
                                <option value="">— No playlist (just switch) —</option>
                                {automationGroups.map((g) => (
                                    <option key={g.id} value={g.id}>{g.serial ? `${g.serial} - ` : ''}{g.name || 'Unnamed Group'}</option>
                                ))}
                            </select>
                            {selectedGroup && selectedGroup.lists.length > 0 && (
                                <select
                                    className="input-field"
                                    style={{ width: '170px' }}
                                    value={cfg.listId || ''}
                                    onChange={(e) => update({ listId: e.target.value })}
                                    title="Specific playlist within that Group (blank = the Group's normal starting playlist)"
                                >
                                    <option value="">Playlist: first</option>
                                    {selectedGroup.lists.map((l) => (
                                        <option key={l.id} value={l.id}>{l.serial ? `${l.serial} - ` : ''}{l.name || 'Unnamed'}</option>
                                    ))}
                                </select>
                            )}
                        </div>
                    </div>

                    {automationGroups.length === 0 && (
                        <p className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded px-2 py-1.5 leading-snug">
                            ⚠ No Playlist Automation Groups exist yet, so there is nothing to start on arrival.
                            The failover will still switch players — create a Group in ⚙ Playlists to also start content.
                        </p>
                    )}

                    <p className="text-xs text-gray-400 bg-gray-800/60 border border-gray-700 rounded px-3 py-2 leading-relaxed">
                        A single unplayable video is still skipped normally — that is not a failure.
                        This only fires when <strong>nothing at all plays</strong> for {cfg.threshold} advances in a row,
                        which is what a wrong playlist, a batch of private videos or an embedding block looks like.
                        An emergency push (<strong>Playback failed</strong>, in Notification settings → Playlists) is sent
                        whether or not a switch is configured, so a black screen always reaches your phone.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default PlaybackFailoverManager;
