
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PLAYER_EVENT_KEY, parseIdsFromText, extractVideoId } from '../utils/core-utils';
import { getStateValue, setStateValue } from '../utils/state-api';

// ============================================================================
// Playlist Automation — Groups (routines) containing Lists (playlists).
//
// A Group starts either by chaining from another Group, on a clock time, or
// on a live-event match. Inside a Group, Lists play in sequence: each List
// plays `playCount` videos starting at `startIndex`, then hands off to the
// next List (or ends the Group, which loops or chains to another Group).
//
// This component owns the whole engine (persistence, scheduler clock,
// live-event listener, and end-of-video chaining) and always keeps it running
// in the background — the panel below is just a view into it, so scheduled
// Groups still fire even while this panel is closed.
// ============================================================================

const LOCAL_KEY = 'loopAutomationGroups';
const SERVER_KEY = 'player.loop.automation';
const SAVE_DEBOUNCE_MS = 600;
const SCHEDULER_TICK_MS = 20000;
const MAX_CHAIN_HOPS = 20;

const generateId = () => 'id-' + Math.random().toString(36).slice(2, 11);
const todayStamp = () => new Date().toISOString().slice(0, 10);
const nowHHMM = () => {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
};

function newGroup() {
    return {
        id: generateId(), serial: '', name: '',
        triggerType: 'default', triggerValue: '',
        endType: 'loop', endValue: '',
        lastFiredDate: null,
        isExpanded: true,
        lists: [],
    };
}

function newList() {
    return {
        id: generateId(), serial: '', name: '',
        videoIds: [], rawInput: '',
        startIndex: 1, playCount: 1,
        endType: 'nextList', endValue: '',
        isExpanded: true,
    };
}

// ---- Chaining resolver (pure — takes groups, returns where to play next) ----

function firstPlayableList(groups, groupId, hops = 0) {
    if (hops > MAX_CHAIN_HOPS) return null;
    const group = groups.find(g => g.id === groupId);
    if (!group) return null;
    const list = group.lists.find(l => l.videoIds.length > 0);
    if (!list) return null;
    return { groupId: group.id, listId: list.id };
}

function resolveNextRun(groups, groupId, listId, hops = 0) {
    if (hops > MAX_CHAIN_HOPS) return null;
    const group = groups.find(g => g.id === groupId);
    if (!group) return null;
    const list = group.lists.find(l => l.id === listId);
    if (!list) return null;

    if (list.endType === 'nextList') {
        const target = group.lists.find(l => l.id === list.endValue);
        if (!target) return null;
        if (target.videoIds.length === 0) return resolveNextRun(groups, group.id, target.id, hops + 1);
        return { groupId: group.id, listId: target.id };
    }

    // endType === 'endGroup'
    if (group.endType === 'loop') {
        return firstPlayableList(groups, group.id, hops + 1);
    }
    if (group.endType === 'serial') {
        const target = groups.find(g => g.id !== group.id && g.serial !== '' && g.serial === group.endValue);
        if (!target) return null;
        return firstPlayableList(groups, target.id, hops + 1);
    }
    if (group.endType === 'name') {
        const target = groups.find(g => g.id !== group.id && g.name !== '' && g.name === group.endValue);
        if (!target) return null;
        return firstPlayableList(groups, target.id, hops + 1);
    }
    return null;
}

export default function LoopPlaylistAutomation() {
    const [open, setOpen] = useState(false);
    const [groups, setGroups] = useState(() => {
        try {
            const saved = localStorage.getItem(LOCAL_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (e) { console.error('[PlaylistAutomation] Failed to parse local config', e); }
        return [];
    });
    const [activeRun, setActiveRun] = useState(null); // { groupId, listId, groupName, listName }
    const [engineStatus, setEngineStatus] = useState('Idle');
    const [loaded, setLoaded] = useState(false);
    const fileInputRef = useRef(null);

    const groupsRef = useRef(groups);
    const activeRunRef = useRef(activeRun);
    const playedInListRef = useRef(0);
    const lastLiveVideoIdRef = useRef(null);
    useEffect(() => { groupsRef.current = groups; }, [groups]);
    useEffect(() => { activeRunRef.current = activeRun; }, [activeRun]);

    // ---- Reconcile with server copy (local copy, if any, already loaded synchronously above) ----
    useEffect(() => {
        let cancelled = false;
        getStateValue(SERVER_KEY).then(serverGroups => {
            if (cancelled) return;
            setGroups(prev => (prev.length === 0 && Array.isArray(serverGroups) && serverGroups.length > 0) ? serverGroups : prev);
        }).finally(() => { if (!cancelled) setLoaded(true); });
        return () => { cancelled = true; };
    }, []);

    // ---- Persist config on change (debounced) ----
    const saveTimerRef = useRef(null);
    useEffect(() => {
        if (!loaded) return; // don't overwrite saved data with the initial empty state
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            try { localStorage.setItem(LOCAL_KEY, JSON.stringify(groups)); } catch { /* quota etc — server copy still attempted */ }
            setStateValue(SERVER_KEY, groups);
        }, SAVE_DEBOUNCE_MS);
        return () => clearTimeout(saveTimerRef.current);
    }, [groups, loaded]);

    // ---- Core: start playing a specific List under a Group ----
    const activateRun = useCallback((groupId, listId, label) => {
        const group = groupsRef.current.find(g => g.id === groupId);
        const list = group?.lists.find(l => l.id === listId);
        if (!group || !list) { setEngineStatus('Activation failed — group/list not found'); return false; }
        if (list.videoIds.length === 0) { setEngineStatus(`"${list.name || 'List'}" has no videos — add some first`); return false; }

        const startIdx0 = Math.min(Math.max((parseInt(list.startIndex, 10) || 1) - 1, 0), list.videoIds.length - 1);
        playedInListRef.current = 0;
        const runInfo = { groupId: group.id, listId: list.id, groupName: group.name || 'Group', listName: list.name || 'List' };
        activeRunRef.current = runInfo;
        setActiveRun(runInfo);
        window.dispatchEvent(new CustomEvent('loopPlayerLoadPlaylist', { detail: { videoIds: list.videoIds, startIndex: startIdx0 } }));
        setEngineStatus(`${label ? label + ' — ' : ''}Playing "${runInfo.listName}" from "${runInfo.groupName}"`);
        return true;
    }, []);

    const stopAutomation = useCallback(() => {
        activeRunRef.current = null;
        setActiveRun(null);
        window.dispatchEvent(new CustomEvent('loopPlayerAutomationStop'));
        setEngineStatus('Automation stopped — Loop Player controls are back in your hands');
    }, []);

    // ---- Engine: react to the Loop Player's videoEnded broadcasts while a run is active ----
    useEffect(() => {
        const handleStorage = (e) => {
            if (e.key !== PLAYER_EVENT_KEY || !e.newValue) return;
            const run = activeRunRef.current;
            if (!run) return;
            let data;
            try { data = JSON.parse(e.newValue); } catch { return; }
            if (data.playerType !== 'loop' || (data.event !== 'videoEnded' && data.event !== 'videoError')) return;

            const group = groupsRef.current.find(g => g.id === run.groupId);
            const list = group?.lists.find(l => l.id === run.listId);
            if (!group || !list) { stopAutomation(); return; }

            const startIdx0 = Math.min(Math.max((parseInt(list.startIndex, 10) || 1) - 1, 0), Math.max(list.videoIds.length - 1, 0));
            const maxAvailable = list.videoIds.length - startIdx0;
            const effectiveCount = Math.min(parseInt(list.playCount, 10) || 1, Math.max(maxAvailable, 0));

            playedInListRef.current += 1;

            if (playedInListRef.current < effectiveCount) {
                const nextIdx = startIdx0 + playedInListRef.current;
                window.dispatchEvent(new CustomEvent('loopPlayerLoadPlaylist', { detail: { videoIds: list.videoIds, startIndex: nextIdx } }));
                setEngineStatus(`Playing "${list.name || 'List'}" (${playedInListRef.current + 1}/${effectiveCount}) from "${group.name || 'Group'}"`);
                return;
            }

            const next = resolveNextRun(groupsRef.current, group.id, list.id);
            if (next) {
                activateRun(next.groupId, next.listId, 'Chained');
            } else {
                stopAutomation();
            }
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, [activateRun, stopAutomation]);

    // ---- Engine: scheduler clock — fires groups whose trigger time matches "now", once per day ----
    useEffect(() => {
        const tick = () => {
            const hhmm = nowHHMM();
            const today = todayStamp();
            const due = groupsRef.current.find(g =>
                g.triggerType === 'scheduler' && g.triggerValue === hhmm && g.lastFiredDate !== today
            );
            if (!due) return;
            setGroups(prev => prev.map(g => g.id === due.id ? { ...g, lastFiredDate: today } : g));
            const first = firstPlayableList(groupsRef.current, due.id);
            if (first) activateRun(first.groupId, first.listId, `Scheduled ${hhmm}`);
            else setEngineStatus(`Group "${due.name || due.id}" was due but has no playable list`);
        };
        const t = setInterval(tick, SCHEDULER_TICK_MS);
        return () => clearInterval(t);
    }, [activateRun]);

    // ---- Engine: live-event trigger — reacts to the same detection Live Player's monitor already uses ----
    useEffect(() => {
        const handleLiveMatch = async (event) => {
            const videoId = event.detail?.videoId;
            if (!videoId || videoId === lastLiveVideoIdRef.current) return;
            lastLiveVideoIdRef.current = videoId;

            const candidates = groupsRef.current.filter(g => g.triggerType === 'live_events');
            if (candidates.length === 0) return;

            // Groups with no keyword fire on any detected live event.
            // Groups with keywords need the matched video's title — fetched best-effort.
            const keyworded = candidates.filter(g => (g.triggerValue || '').trim() !== '');
            let title = '';
            if (keyworded.length > 0) {
                try {
                    const res = await fetch(`https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${videoId}&format=json`);
                    if (res.ok) title = ((await res.json()).title || '').toLowerCase();
                } catch { /* keyworded groups just won't match this time */ }
            }

            const match = candidates.find(g => {
                const kw = (g.triggerValue || '').trim();
                if (!kw) return true;
                return title && kw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(k => title.includes(k));
            });
            if (!match) return;
            const first = firstPlayableList(groupsRef.current, match.id);
            if (first) activateRun(first.groupId, first.listId, 'Live event');
        };
        window.addEventListener('livePlayerAutoLoad', handleLiveMatch);
        return () => window.removeEventListener('livePlayerAutoLoad', handleLiveMatch);
    }, [activateRun]);

    // ============================================================================
    // Editor actions
    // ============================================================================

    const addGroup = () => setGroups(prev => [...prev, newGroup()]);
    const deleteGroup = (groupId) => {
        setGroups(prev => prev.filter(g => g.id !== groupId));
        if (activeRunRef.current?.groupId === groupId) stopAutomation();
    };
    const addList = (groupId) => setGroups(prev => prev.map(g => g.id === groupId ? { ...g, lists: [...g.lists, newList()] } : g));
    const deleteList = (groupId, listId) => {
        setGroups(prev => prev.map(g => g.id === groupId ? { ...g, lists: g.lists.filter(l => l.id !== listId) } : g));
        if (activeRunRef.current?.listId === listId) stopAutomation();
    };

    const updateGroup = (groupId, patch) => setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ...patch } : g));
    const updateList = (groupId, listId, patch) => setGroups(prev => prev.map(g =>
        g.id !== groupId ? g : { ...g, lists: g.lists.map(l => l.id === listId ? { ...l, ...patch } : l) }
    ));

    const importListVideos = (groupId, listId) => {
        const group = groups.find(g => g.id === groupId);
        const list = group?.lists.find(l => l.id === listId);
        if (!list) return;
        const raw = list.rawInput || '';
        const unique = [...new Set(parseIdsFromText(raw).map(extractVideoId).filter(Boolean))];
        updateList(groupId, listId, { videoIds: unique, rawInput: unique.join(', '), startIndex: 1 });
    };

    const clearListVideos = (groupId, listId) => updateList(groupId, listId, { videoIds: [], rawInput: '', startIndex: 1, playCount: 1 });

    const handleExportConfig = () => {
        const blob = new Blob([JSON.stringify(groups, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `loop-playlist-automation-${todayStamp()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    const handleImportConfig = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            if (Array.isArray(parsed)) {
                setGroups(parsed);
                setEngineStatus(`Imported ${parsed.length} group(s) from ${file.name}`);
            } else {
                setEngineStatus('Import failed — file is not a valid config export');
            }
        } catch (err) {
            setEngineStatus('Import failed — ' + err.message);
        }
    };

    // Uniqueness validation, mirroring the original editor's behavior.
    const groupSerials = new Set(), groupNames = new Set();
    const dupGroupIds = new Set();
    groups.forEach(g => {
        if (g.serial !== '') { if (groupSerials.has(g.serial)) dupGroupIds.add(g.id); groupSerials.add(g.serial); }
        if (g.name !== '') { if (groupNames.has(g.name)) dupGroupIds.add(g.id); groupNames.add(g.name); }
    });

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                className="px-2 py-1 rounded text-xs font-medium transition-all bg-gray-700 hover:bg-gray-600 text-amber-400 border border-amber-800/40 flex items-center gap-1"
                title="Playlist Automation — schedule multiple playlists to play at different times"
            >
                ⚙ Playlists{activeRun ? ' •' : ''}
            </button>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center overflow-y-auto py-6 px-3">
            <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-5xl text-sm text-gray-200">
                {/* Header */}
                <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-4 py-3 flex justify-between items-center rounded-t-lg z-10">
                    <div>
                        <h2 className="text-lg font-bold text-amber-400">Loop Player — Playlist Automation</h2>
                        <p className="text-xs text-gray-400">{engineStatus}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={addGroup} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-xs font-medium">+ Add Group</button>
                        <button onClick={handleExportConfig} className="bg-gray-700 hover:bg-gray-600 text-gray-200 px-3 py-1.5 rounded text-xs font-medium">Export</button>
                        <button onClick={() => fileInputRef.current?.click()} className="bg-gray-700 hover:bg-gray-600 text-gray-200 px-3 py-1.5 rounded text-xs font-medium">Import</button>
                        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportConfig} />
                        {activeRun && (
                            <button onClick={stopAutomation} className="bg-red-700 hover:bg-red-600 text-white px-3 py-1.5 rounded text-xs font-medium">Stop Automation</button>
                        )}
                        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white text-xl leading-none px-2">×</button>
                    </div>
                </div>

                {activeRun && (
                    <div className="mx-4 mt-3 bg-amber-900/30 border border-amber-700/50 rounded px-3 py-2 text-xs text-amber-200">
                        ▶ Currently automated: <strong>{activeRun.groupName}</strong> → <strong>{activeRun.listName}</strong>
                    </div>
                )}

                {/* Groups */}
                <div className="p-4 space-y-3">
                    {groups.length === 0 && (
                        <div className="text-center py-16 text-gray-500">
                            <p className="text-base">No groups configured yet.</p>
                            <p className="text-xs mt-1">A Group is a routine — click "+ Add Group" to build one, add Playlists inside it, then Activate it or give it a scheduled time.</p>
                        </div>
                    )}

                    {groups.map((group, gIdx) => (
                        <GroupEditor
                            key={group.id}
                            group={group}
                            index={gIdx}
                            groups={groups}
                            isDuplicate={dupGroupIds.has(group.id)}
                            isActive={activeRun?.groupId === group.id}
                            activeListId={activeRun?.listId}
                            onUpdate={(patch) => updateGroup(group.id, patch)}
                            onDelete={() => deleteGroup(group.id)}
                            onAddList={() => addList(group.id)}
                            onDeleteList={(listId) => deleteList(group.id, listId)}
                            onUpdateList={(listId, patch) => updateList(group.id, listId, patch)}
                            onImportListVideos={(listId) => importListVideos(group.id, listId)}
                            onClearListVideos={(listId) => clearListVideos(group.id, listId)}
                            onActivateGroup={() => {
                                const first = firstPlayableList(groups, group.id);
                                if (first) activateRun(first.groupId, first.listId, 'Manual');
                                else setEngineStatus(`"${group.name || 'Group'}" has no playable list`);
                            }}
                            onActivateList={(listId) => activateRun(group.id, listId, 'Manual')}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// Group editor (one routine card)
// ============================================================================
function GroupEditor({
    group, index, groups, isDuplicate, isActive, activeListId,
    onUpdate, onDelete, onAddList, onDeleteList, onUpdateList,
    onImportListVideos, onClearListVideos, onActivateGroup, onActivateList,
}) {
    const errCls = isDuplicate ? 'border-red-500' : 'border-gray-700';

    return (
        <div className={`bg-gray-800/60 rounded-lg border ${isActive ? 'border-amber-500' : 'border-gray-700'} overflow-hidden`}>
            <div
                className="bg-gray-800 px-3 py-2 flex justify-between items-center cursor-pointer hover:bg-gray-750"
                onClick={() => onUpdate({ isExpanded: !group.isExpanded })}
            >
                <div className="flex items-center gap-2">
                    <span className="text-gray-400">{group.isExpanded ? '▾' : '▸'}</span>
                    <h3 className="font-semibold text-gray-100">
                        {group.name || `Group ${index + 1}`} <span className="text-xs text-gray-500">#{group.serial || '?'}</span>
                        {isActive && <span className="ml-2 text-xs text-amber-400">● live</span>}
                    </h3>
                </div>
                <div className="flex items-center gap-2 text-xs">
                    <span className="bg-gray-700 px-2 py-0.5 rounded">{group.lists.length} list(s)</span>
                    <button onClick={(e) => { e.stopPropagation(); onActivateGroup(); }} className="bg-green-700 hover:bg-green-600 text-white px-2 py-1 rounded">▶ Activate</button>
                    <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="bg-red-900/60 hover:bg-red-800 text-red-200 px-2 py-1 rounded">Delete</button>
                </div>
            </div>

            {group.isExpanded && (
                <div className="p-3 space-y-3">
                    <div className="flex flex-wrap gap-3">
                        <div className={`input-wrapper border rounded px-2 py-1 ${errCls}`}>
                            <label className="text-xs text-gray-400 block">Serial</label>
                            <input type="number" className="bg-transparent outline-none w-16 text-gray-100" value={group.serial}
                                onChange={(e) => onUpdate({ serial: e.target.value })} />
                        </div>
                        <div className={`input-wrapper border rounded px-2 py-1 flex-1 min-w-[180px] ${errCls}`}>
                            <label className="text-xs text-gray-400 block">Group Name</label>
                            <input type="text" className="bg-transparent outline-none w-full text-gray-100" value={group.name}
                                onChange={(e) => onUpdate({ name: e.target.value })} />
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-4 bg-gray-900/50 border border-gray-700 rounded p-2">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">Trigger:</span>
                            <select className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                                value={group.triggerType}
                                onChange={(e) => onUpdate({ triggerType: e.target.value, triggerValue: '' })}>
                                <option value="default">Default (chained from another Group)</option>
                                <option value="scheduler">On Scheduler Time</option>
                                <option value="live_events">On Live Event Match</option>
                            </select>
                            {group.triggerType === 'scheduler' && (
                                <input type="time" className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                                    value={group.triggerValue} onChange={(e) => onUpdate({ triggerValue: e.target.value })} />
                            )}
                            {group.triggerType === 'live_events' && (
                                <input type="text" placeholder="Keywords, comma separated (blank = any live event)"
                                    className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 w-64"
                                    value={group.triggerValue} onChange={(e) => onUpdate({ triggerValue: e.target.value })} />
                            )}
                        </div>

                        <div className="flex items-center gap-2 border-l border-gray-700 pl-4">
                            <span className="text-xs text-gray-400">When Group ends:</span>
                            <select className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                                value={group.endType}
                                onChange={(e) => onUpdate({ endType: e.target.value, endValue: '' })}>
                                <option value="loop">Loop this Group</option>
                                <option value="serial">Go to Group by Serial</option>
                                <option value="name">Go to Group by Name</option>
                            </select>
                            {group.endType === 'serial' && (
                                <select className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                                    value={group.endValue} onChange={(e) => onUpdate({ endValue: e.target.value })}>
                                    <option value="">Select target...</option>
                                    {groups.filter(g => g.id !== group.id).map(g => (
                                        <option key={g.id} value={g.serial}>{g.serial || '?'} - {g.name || 'Unnamed'}</option>
                                    ))}
                                </select>
                            )}
                            {group.endType === 'name' && (
                                <select className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                                    value={group.endValue} onChange={(e) => onUpdate({ endValue: e.target.value })}>
                                    <option value="">Select target...</option>
                                    {groups.filter(g => g.id !== group.id).map(g => (
                                        <option key={g.id} value={g.name}>{g.name || 'Unnamed'}</option>
                                    ))}
                                </select>
                            )}
                        </div>
                    </div>

                    <div className="flex justify-between items-center">
                        <h4 className="text-xs font-semibold uppercase text-gray-400">Playlists</h4>
                        <button onClick={onAddList} className="bg-blue-900/50 hover:bg-blue-800/60 text-blue-300 px-2 py-1 rounded text-xs border border-blue-800/60">+ Add List</button>
                    </div>

                    {group.lists.length === 0 && <div className="text-center py-3 text-gray-500 text-xs border border-dashed border-gray-700 rounded">No lists yet.</div>}

                    {group.lists.map((list, lIdx) => (
                        <ListEditor
                            key={list.id}
                            list={list}
                            index={lIdx}
                            siblingLists={group.lists.filter(l => l.id !== list.id)}
                            isActive={activeListId === list.id}
                            onUpdate={(patch) => onUpdateList(list.id, patch)}
                            onDelete={() => onDeleteList(list.id)}
                            onImport={() => onImportListVideos(list.id)}
                            onClear={() => onClearListVideos(list.id)}
                            onActivate={() => onActivateList(list.id)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ============================================================================
// List editor (one playlist card)
// ============================================================================
function ListEditor({ list, index, siblingLists, isActive, onUpdate, onDelete, onImport, onClear, onActivate }) {
    const maxVideos = Math.max(1, list.videoIds.length);
    return (
        <div className={`bg-gray-850 bg-gray-900/40 rounded border ${isActive ? 'border-amber-500' : 'border-blue-900/50'} overflow-hidden`}>
            <div className="bg-blue-950/30 px-3 py-1.5 flex justify-between items-center cursor-pointer" onClick={() => onUpdate({ isExpanded: !list.isExpanded })}>
                <div className="flex items-center gap-2">
                    <span className="text-blue-400 text-xs">{list.isExpanded ? '▾' : '▸'}</span>
                    <span className="text-sm text-gray-200">{list.name || `List ${index + 1}`} <span className="text-xs text-gray-500">#{list.serial || '?'}</span></span>
                    {isActive && <span className="text-xs text-amber-400">● live</span>}
                </div>
                <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400">{list.videoIds.length} videos</span>
                    <button onClick={(e) => { e.stopPropagation(); onActivate(); }} className="bg-green-800/60 hover:bg-green-700 text-green-200 px-2 py-0.5 rounded">▶ Play</button>
                    <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-gray-500 hover:text-red-400 px-1">✕</button>
                </div>
            </div>

            {list.isExpanded && (
                <div className="px-3 py-2 space-y-2">
                    <div className="flex flex-wrap gap-3">
                        <div className="border border-gray-700 rounded px-2 py-1">
                            <label className="text-xs text-gray-400 block">Serial</label>
                            <input type="number" className="bg-transparent outline-none w-14 text-gray-100" value={list.serial}
                                onChange={(e) => onUpdate({ serial: e.target.value })} />
                        </div>
                        <div className="border border-gray-700 rounded px-2 py-1 flex-1 min-w-[160px]">
                            <label className="text-xs text-gray-400 block">List Name</label>
                            <input type="text" className="bg-transparent outline-none w-full text-gray-100" value={list.name}
                                onChange={(e) => onUpdate({ name: e.target.value })} />
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <textarea rows={1} className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs font-mono text-gray-100"
                            placeholder="Video IDs or YouTube URLs — comma or newline separated"
                            value={list.rawInput ?? list.videoIds.join(', ')}
                            onChange={(e) => onUpdate({ rawInput: e.target.value })} />
                        <button onClick={onImport} className="bg-gray-700 hover:bg-gray-600 text-gray-100 px-2 py-1 rounded text-xs">Import</button>
                        <button onClick={onClear} className="bg-gray-800 border border-gray-600 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs">Clear</button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-900/50 border border-gray-700 rounded px-2 py-1.5">
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1">
                                <label className="text-xs text-gray-400">Start Index:</label>
                                <input type="number" min={1} max={maxVideos} className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-center text-gray-100"
                                    value={list.startIndex} onChange={(e) => onUpdate({ startIndex: parseInt(e.target.value, 10) || 1 })} />
                            </div>
                            <div className="flex items-center gap-1 border-l border-gray-700 pl-3">
                                <label className="text-xs text-gray-400">Play Count:</label>
                                <input type="number" min={1} className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-center text-gray-100"
                                    value={list.playCount} onChange={(e) => onUpdate({ playCount: parseInt(e.target.value, 10) || 1 })} />
                            </div>
                        </div>
                        <div className="flex items-center gap-2 border-l border-gray-700 pl-3">
                            <label className="text-xs text-gray-400">Then:</label>
                            <select className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                                value={list.endType} onChange={(e) => onUpdate({ endType: e.target.value, endValue: '' })}>
                                <option value="nextList">Go to Next List</option>
                                <option value="endGroup">End Group</option>
                            </select>
                            {list.endType === 'nextList' && (
                                <select className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                                    value={list.endValue} onChange={(e) => onUpdate({ endValue: e.target.value })}>
                                    <option value="">Select target...</option>
                                    {siblingLists.map(l => <option key={l.id} value={l.id}>{l.serial || '?'} - {l.name || 'Unnamed'}</option>)}
                                </select>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
