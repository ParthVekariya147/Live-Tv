
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PLAYER_EVENT_KEY, parseIdsFromText, extractVideoId } from '../utils/core-utils';
import { getStateValue, setStateValue } from '../utils/state-api';
import { useOBS } from '../context/OBSContext';
import {
    getSchedules, addSchedule, deleteSchedule, toggleSchedule,
    connectWebSocket, addWsListener,
} from '../utils/scheduler-api';

// ============================================================================
// Playlist Automation — Groups (routines) containing Lists (playlists).
//
// A Group starts either by chaining from another Group, by scheduled time(s),
// or on a live-event match. Inside a Group, Lists play in sequence: each List
// plays `playCount` videos starting at `startIndex`, then hands off to the
// next List (or ends the Group, which loops or chains to another Group).
//
// Scheduling is NOT reimplemented here — it rides entirely on the same
// server-side Scheduler that already runs the OBS source scheduler and Katha
// Schedulers (scheduler-service.cjs), the same way KathaMonitor.jsx plugs into
// it. Each scheduled time for a Group is one row in that shared system
// (action: 'playlist_automation'), which is why: (a) it keeps firing with no
// browser tab open — the clock is server-side — (b) a Group can have any
// number of scheduled times, just add more rows, and (c) every row already
// shows up for free in the main controller page's "Pending Schedules"/
// "Trigger History" panels (Scheduler.jsx), since that UI treats action/
// source as opaque strings and lists whatever's in the shared list.
//
// This component owns the rest of the engine (persistence, live-event
// listener, and end-of-video chaining) and always keeps it running in the
// background — the panel below is just a view into it, so triggers still
// fire while this panel is closed.
// ============================================================================

// Exported so other player cards (e.g. Delay Player's "On Finish, Start Group" picker) can
// read the current Group list to populate a dropdown without duplicating this key elsewhere.
export const LOOP_AUTOMATION_LOCAL_KEY = 'loopAutomationGroups';
const LOCAL_KEY = LOOP_AUTOMATION_LOCAL_KEY;
const SERVER_KEY = 'player.loop.automation';
const SAVE_DEBOUNCE_MS = 600;
const MAX_CHAIN_HOPS = 20;

// The shared scheduler stores schedule rows with a fixed, whitelisted field set (see
// scheduler-service.cjs addSchedule()) — there's no room for a custom "groupId" field, and the
// SCHEDULER_TRIGGER broadcast that fires a row only echoes back {id, source, action, title,
// time}. So the target Group is encoded directly in the row's own id instead of a side field.
const PLAYLIST_SCHEDULE_ACTION = 'playlist_automation';
const makeScheduleId = (groupId) => `pa_${groupId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const scheduleGroupId = (schedule) =>
    (typeof schedule?.id === 'string' && schedule.id.startsWith('pa_')) ? schedule.id.split('_')[1] : null;

const generateId = () => 'id-' + Math.random().toString(36).slice(2, 11);
const todayStamp = () => new Date().toISOString().slice(0, 10);

// Matches Date.getDay() (0=Sun..6=Sat) — same convention as the OBS Scheduler's daysList.
const DAY_LABELS = [
    { id: 0, short: 'Sun' }, { id: 1, short: 'Mon' }, { id: 2, short: 'Tue' }, { id: 3, short: 'Wed' },
    { id: 4, short: 'Thu' }, { id: 5, short: 'Fri' }, { id: 6, short: 'Sat' },
];

// Empty/missing activeDays means "no restriction" — every existing Group keeps working
// unchanged. Only gates fresh entry points (scheduler tick, live-event match); chaining
// within an already-running automation and manual Activate/Play are never gated by this.
function isGroupActiveToday(group) {
    const days = group.activeDays;
    if (!Array.isArray(days) || days.length === 0) return true;
    return days.includes(new Date().getDay());
}

function newGroup() {
    return {
        id: generateId(), serial: '', name: '',
        triggerType: 'default', triggerValue: '',
        endType: 'loop', endValue: '',
        activeDays: [],
        isExpanded: true,
        enabled: true,
        lists: [],
    };
}

function newList() {
    return {
        id: generateId(), serial: '', name: '',
        videoIds: [], rawInput: '',
        startIndex: 1, playCount: 1,
        runEvery: 1, cycleCount: 0,
        endType: 'nextList', endValue: '',
        isExpanded: true,
        enabled: true,
    };
}

// Row drag-reorder — shared by the Groups list and each Group's Lists list. Only the
// dragged row's origin index travels via dataTransfer, so sibling row components never
// need a shared ref to coordinate a drag in progress.
function handleRowDragStart(e, index) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
}
function handleRowDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}
function reorderArray(arr, fromIndex, toIndex) {
    const next = [...arr];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
}

// ---- Chaining resolver (pure — takes groups, returns where to play next) ----
//
// A List's `runEvery` gates how often its turn actually plays: turns 1..runEvery-1 are
// silent skips — no video loads, the list is treated as if it had instantly finished and
// play immediately follows its own "Then" setting — turn `runEvery` actually plays and
// resets the counter back to 0. Regular lists default to runEvery: 1, so the gate is a
// no-op for them (always due). Skips are returned as data rather than applied here, so the
// caller can batch the cycleCount bookkeeping into one state update alongside the real
// activation (manual Activate/Play always force-plays and bypasses this gate entirely).

function isListDue(list) {
    const every = Math.max(1, parseInt(list.runEvery, 10) || 1);
    return ((list.cycleCount || 0) + 1) >= every;
}

// A candidate list (known to have videos) either plays now (due) or gets skipped — in which
// case its own "Then" setting decides where to look next, same as if it had just finished.
// A disabled list is always treated as skipped here (same path as "not due yet"), so turning
// a list off just removes it from the chain — every other list's Then/runEvery/cycleCount
// bookkeeping keeps working exactly as before.
function landOn(groups, groupId, listId, hops, skipped) {
    if (hops > MAX_CHAIN_HOPS) return null;
    const group = groups.find(g => g.id === groupId);
    const list = group?.lists.find(l => l.id === listId);
    if (!group || !list) return null;
    if (list.enabled !== false && isListDue(list)) return { groupId: group.id, listId: list.id, skipped };
    return followThen(groups, group.id, list.id, hops + 1, [...skipped, { groupId: group.id, listId: list.id }]);
}

// Follows a list's "Then" setting (Next List / End Group) to find what comes after it,
// whether that list actually played or was silently skipped for not being due yet.
function followThen(groups, groupId, listId, hops = 0, skipped = []) {
    if (hops > MAX_CHAIN_HOPS) return null;
    const group = groups.find(g => g.id === groupId);
    const list = group?.lists.find(l => l.id === listId);
    if (!group || !list) return null;

    if (list.endType === 'nextList') {
        const target = group.lists.find(l => l.id === list.endValue);
        if (!target) return null;
        if (target.videoIds.length === 0) return followThen(groups, group.id, target.id, hops + 1, skipped);
        return landOn(groups, group.id, target.id, hops + 1, skipped);
    }

    // endType === 'endGroup'
    if (group.endType === 'loop') return enterGroup(groups, group.id, hops + 1, skipped);
    if (group.endType === 'serial' || group.endType === 'name') {
        const key = group.endType === 'serial' ? 'serial' : 'name';
        const target = groups.find(g => g.id !== group.id && g.enabled !== false && g[key] !== '' && g[key] === group.endValue);
        if (!target) return null;
        return enterGroup(groups, target.id, hops + 1, skipped);
    }
    return null;
}

// Entry point into a Group — fresh activation (manual, scheduler, live-event, or chained
// from another Group). Picks the first enabled list with videos in panel order, then resolves
// it through the same due/skip gate as any mid-chain transition.
function enterGroup(groups, groupId, hops = 0, skipped = []) {
    if (hops > MAX_CHAIN_HOPS) return null;
    const group = groups.find(g => g.id === groupId);
    const first = group?.lists.find(l => l.videoIds.length > 0 && l.enabled !== false);
    if (!first) return null;
    return landOn(groups, group.id, first.id, hops, skipped);
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
    const { sourceState, setSourceVisibility } = useOBS();

    const groupsRef = useRef(groups);
    const activeRunRef = useRef(activeRun);
    const playedInListRef = useRef(0);
    // Frozen at run activation — playCount math must stay stable for the whole run even
    // though advanceResumePointer() is mutating list.startIndex in state as we go.
    const runStartIdx0Ref = useRef(0);
    const lastLiveVideoIdRef = useRef(null);
    // Ref (not state) so the WS/event listeners below can read the latest value without being
    // recreated on every OBS poll update — same pattern MonitorManager uses for sourceState.
    const isLiveActiveRef = useRef(false);
    // Same ref pattern as isLiveActiveRef — lets activateRun (below) check current OBS
    // visibility without depending on sourceState directly, which would recreate the
    // callback (and the effects that depend on it) on every OBS poll tick.
    const isLoopVisibleRef = useRef(false);
    useEffect(() => { groupsRef.current = groups; }, [groups]);
    useEffect(() => { activeRunRef.current = activeRun; }, [activeRun]);
    useEffect(() => { isLiveActiveRef.current = !!sourceState['Live Player']; }, [sourceState]);
    useEffect(() => { isLoopVisibleRef.current = !!sourceState['Loop Player']; }, [sourceState]);

    // ---- Shared scheduler integration ----
    // Schedule rows for this feature (action === PLAYLIST_SCHEDULE_ACTION) live in the same
    // server-side Scheduler as OBS source schedules and Katha Schedulers — see the file header
    // comment for why. This keeps a single local mirror (filtered to our own action) in sync
    // via the shared WebSocket, the same connection Scheduler.jsx/KathaMonitor.jsx use.
    const [playlistSchedules, setPlaylistSchedules] = useState([]);
    const refreshPlaylistSchedules = useCallback(async () => {
        const res = await getSchedules();
        if (res.success && Array.isArray(res.schedules)) {
            setPlaylistSchedules(res.schedules.filter(s => s.action === PLAYLIST_SCHEDULE_ACTION));
        }
    }, []);

    useEffect(() => {
        getSchedules().then(res => {
            if (res.success && Array.isArray(res.schedules)) {
                setPlaylistSchedules(res.schedules.filter(s => s.action === PLAYLIST_SCHEDULE_ACTION));
            }
        });
        connectWebSocket();
        const removeListener = addWsListener((msg) => {
            if (msg.type === 'SCHEDULES_UPDATED' && Array.isArray(msg.data?.schedules)) {
                setPlaylistSchedules(msg.data.schedules.filter(s => s.action === PLAYLIST_SCHEDULE_ACTION));
                return;
            }
            if (msg.type === 'SCHEDULER_TRIGGER' && msg.data?.action === PLAYLIST_SCHEDULE_ACTION) {
                const groupId = scheduleGroupId(msg.data);
                if (!groupId) return;
                // Same Live-priority guard the old client-only scheduler tick used — a
                // scheduled Group never preempts an actual live broadcast, it just waits
                // quietly for its next scheduled time instead.
                if (isLiveActiveRef.current) {
                    setEngineStatus(`Skipped scheduled "${msg.data.title || 'Group'}" — Live Player is active`);
                    return;
                }
                window.dispatchEvent(new CustomEvent('loopAutomationStartGroup', {
                    detail: { groupId, label: `Scheduled ${msg.data.time || ''}`.trim() },
                }));
            }
        });
        return () => removeListener();
    }, []);

    // One-time migration: the old client-only "On Scheduler Time" trigger (a single
    // time+days baked into the Group itself) becomes one row in the shared scheduler instead,
    // so Groups configured before this change keep firing instead of silently losing their
    // schedule.
    const migratedLegacyRef = useRef(false);
    useEffect(() => {
        if (!loaded || migratedLegacyRef.current) return;
        migratedLegacyRef.current = true;
        const legacy = groupsRef.current.filter(g => g.triggerType === 'scheduler' && g.triggerValue);
        if (legacy.length === 0) return;
        (async () => {
            for (const g of legacy) {
                await addSchedule({
                    id: makeScheduleId(g.id),
                    time: g.triggerValue,
                    source: 'Playlist Automation',
                    action: PLAYLIST_SCHEDULE_ACTION,
                    title: `Loop: ${g.name || 'Group'}`,
                    recurrence: Array.isArray(g.activeDays) && g.activeDays.length > 0 ? 'days' : 'daily',
                    days: g.activeDays || [],
                    enabled: g.enabled !== false,
                });
            }
            setGroups(prev => prev.map(g => legacy.some(lg => lg.id === g.id) ? { ...g, triggerType: 'default', triggerValue: '' } : g));
            refreshPlaylistSchedules();
        })();
    }, [loaded, refreshPlaylistSchedules]);

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

    // Marks videoIds[index0] as "consumed" by advancing the List's persisted Start Index to
    // whatever comes after it (wrapping to the top once the list has been fully cycled). This
    // is what makes a List a rotating playlist instead of replaying the same slice every time
    // it's (re)activated — without it, "Loop this Group" would play the exact same video(s)
    // forever instead of working through the whole List.
    const advanceResumePointer = useCallback((groupId, listId, index0, totalVideos) => {
        if (totalVideos <= 0) return;
        const nextPointer0 = (index0 + 1) % totalVideos;
        setGroups(prev => prev.map(g => g.id !== groupId ? g : {
            ...g,
            lists: g.lists.map(l => l.id === listId ? { ...l, startIndex: nextPointer0 + 1 } : l),
        }));
    }, []);

    // Applies the cycleCount increments collected while walking past not-yet-due Lists
    // (see landOn/followThen above) — batched into one update per resolution.
    const applySkips = useCallback((skipped) => {
        if (!skipped || skipped.length === 0) return;
        setGroups(prev => prev.map(g => {
            const hits = skipped.filter(s => s.groupId === g.id);
            if (hits.length === 0) return g;
            const bump = new Map();
            hits.forEach(h => bump.set(h.listId, (bump.get(h.listId) || 0) + 1));
            return { ...g, lists: g.lists.map(l => bump.has(l.id) ? { ...l, cycleCount: (l.cycleCount || 0) + bump.get(l.id) } : l) };
        }));
    }, []);

    // ---- Core: start playing a specific List under a Group ----
    const activateRun = useCallback((groupId, listId, label) => {
        const group = groupsRef.current.find(g => g.id === groupId);
        const list = group?.lists.find(l => l.id === listId);
        if (!group || !list) { setEngineStatus('Activation failed — group/list not found'); return false; }
        if (list.videoIds.length === 0) { setEngineStatus(`"${list.name || 'List'}" has no videos — add some first`); return false; }

        const startIdx0 = Math.min(Math.max((parseInt(list.startIndex, 10) || 1) - 1, 0), list.videoIds.length - 1);
        playedInListRef.current = 0;
        runStartIdx0Ref.current = startIdx0;
        const runInfo = { groupId: group.id, listId: list.id, groupName: group.name || 'Group', listName: list.name || 'List' };
        activeRunRef.current = runInfo;
        setActiveRun(runInfo);
        // This List's turn has now been used (whether it was due naturally or force-played
        // manually) — reset its cycle so it starts counting toward runEvery again from here.
        setGroups(prev => prev.map(g => g.id !== group.id ? g : {
            ...g, lists: g.lists.map(l => l.id === list.id ? { ...l, cycleCount: 0 } : l),
        }));
        advanceResumePointer(group.id, list.id, startIdx0, list.videoIds.length);
        // Loading the playlist into the Loop Player is not enough on its own — LoopPlayerCard
        // deliberately refuses to actually play()/unmute() while OBS isn't showing its source
        // (so automation can never blast audio/video from off-screen), same as every other
        // player's own "on finish, hand off" flow (LivePlayerCard/DelayPlayerCard) already
        // does. Without this, a scheduled/triggered run loads silently and never visibly
        // starts. Skipped when already visible to avoid a redundant OBS call on every
        // mid-chain list-to-list transition.
        if (!isLoopVisibleRef.current) setSourceVisibility('Loop Player', true, 'automation');
        window.dispatchEvent(new CustomEvent('loopPlayerLoadPlaylist', { detail: { videoIds: list.videoIds, startIndex: startIdx0 } }));
        setEngineStatus(`${label ? label + ' — ' : ''}Playing "${runInfo.listName}" from "${runInfo.groupName}"`);
        return true;
    }, [advanceResumePointer, setSourceVisibility]);

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

            // Use the start index frozen when this run activated, not the live value —
            // advanceResumePointer() below mutates list.startIndex as the run progresses,
            // and re-reading it here would corrupt the playCount math mid-run.
            const startIdx0 = runStartIdx0Ref.current;
            const maxAvailable = list.videoIds.length - startIdx0;
            const effectiveCount = Math.min(parseInt(list.playCount, 10) || 1, Math.max(maxAvailable, 0));

            playedInListRef.current += 1;

            if (playedInListRef.current < effectiveCount) {
                const nextIdx = startIdx0 + playedInListRef.current;
                advanceResumePointer(group.id, list.id, nextIdx, list.videoIds.length);
                window.dispatchEvent(new CustomEvent('loopPlayerLoadPlaylist', { detail: { videoIds: list.videoIds, startIndex: nextIdx } }));
                setEngineStatus(`Playing "${list.name || 'List'}" (${playedInListRef.current + 1}/${effectiveCount}) from "${group.name || 'Group'}"`);
                return;
            }

            const next = followThen(groupsRef.current, group.id, list.id);
            if (next) {
                applySkips(next.skipped);
                activateRun(next.groupId, next.listId, 'Chained');
            } else {
                stopAutomation();
            }
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, [activateRun, stopAutomation, advanceResumePointer, applySkips]);

    // ---- Engine: live-event trigger — reacts to the same detection Live Player's monitor already uses ----
    useEffect(() => {
        const handleLiveMatch = async (event) => {
            const videoId = event.detail?.videoId;
            if (!videoId || videoId === lastLiveVideoIdRef.current) return;
            lastLiveVideoIdRef.current = videoId;

            const candidates = groupsRef.current.filter(g => g.triggerType === 'live_events' && g.enabled !== false && isGroupActiveToday(g));
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
            const first = enterGroup(groupsRef.current, match.id);
            if (first) { applySkips(first.skipped); activateRun(first.groupId, first.listId, 'Live event'); }
        };
        window.addEventListener('livePlayerAutoLoad', handleLiveMatch);
        return () => window.removeEventListener('livePlayerAutoLoad', handleLiveMatch);
    }, [activateRun, applySkips]);

    // ---- Engine: direct "start this Group [/ List]" requests from other player cards ----
    // Unlike the Scheduler/Live-event triggers above, this names a specific Group (and
    // optionally a specific List within it) by id — picked in that player's own UI, e.g.
    // Delay Player's "On Finish, Start Group" dropdown, or Local Player's per-day Group/List
    // pickers — rather than matching on triggerType. Also how the shared-scheduler WS listener
    // above starts a Group at its scheduled time. Bypasses activeDays and the live-priority
    // guard entirely (each caller that needs those handles them itself — the shared-scheduler
    // listener already checked Live-priority before dispatching here), same as a manual
    // Activate/Play. Does respect the Group's own enabled flag though — none of this event's
    // callers are "the user manually clicked this specific Group," so a disabled Group should
    // stay quiet for all of them, same as it does for the scheduler/live-event/chain triggers.
    // A given listId still goes through the normal due/skip (runEvery) gate — an explicit list
    // pick isn't the same as the ▶ Play force-play button.
    useEffect(() => {
        const handleStartGroup = (event) => {
            const groupId = event.detail?.groupId;
            const listId = event.detail?.listId;
            const label = event.detail?.label || 'Triggered';
            if (!groupId) return;
            const group = groupsRef.current.find(g => g.id === groupId);
            if (group?.enabled === false) { setEngineStatus(`"${label}" skipped — "${group.name || 'Group'}" is disabled`); return; }
            const first = listId
                ? landOn(groupsRef.current, groupId, listId, 0, [])
                : enterGroup(groupsRef.current, groupId);
            if (first) { applySkips(first.skipped); activateRun(first.groupId, first.listId, label); }
            else setEngineStatus(`"${label}" tried to start a Group/List with no playable video`);
        };
        window.addEventListener('loopAutomationStartGroup', handleStartGroup);
        return () => window.removeEventListener('loopAutomationStartGroup', handleStartGroup);
    }, [activateRun, applySkips]);

    // ============================================================================
    // Editor actions
    // ============================================================================

    const addGroup = () => setGroups(prev => [...prev, newGroup()]);
    const deleteGroup = (groupId) => {
        setGroups(prev => prev.filter(g => g.id !== groupId));
        if (activeRunRef.current?.groupId === groupId) stopAutomation();
        // Clean up this Group's rows in the shared scheduler too — otherwise they'd linger,
        // still fire, and clutter the main page's Pending Schedules with a dead reference.
        const orphaned = playlistSchedules.filter(s => scheduleGroupId(s) === groupId);
        orphaned.forEach(s => deleteSchedule(s.id));
        if (orphaned.length > 0) refreshPlaylistSchedules();
    };

    // ---- Per-Group scheduled times (rows in the shared server-side scheduler) ----
    const addGroupSchedule = useCallback(async (groupId, { time, days }) => {
        const group = groupsRef.current.find(g => g.id === groupId);
        await addSchedule({
            id: makeScheduleId(groupId),
            time,
            source: 'Playlist Automation',
            action: PLAYLIST_SCHEDULE_ACTION,
            title: `Loop: ${group?.name || 'Group'}`,
            recurrence: days.length > 0 ? 'days' : 'daily',
            days,
            enabled: true,
        });
        refreshPlaylistSchedules();
    }, [refreshPlaylistSchedules]);

    const toggleGroupSchedule = useCallback(async (scheduleId) => {
        await toggleSchedule(scheduleId);
        refreshPlaylistSchedules();
    }, [refreshPlaylistSchedules]);

    const deleteGroupSchedule = useCallback(async (scheduleId) => {
        await deleteSchedule(scheduleId);
        refreshPlaylistSchedules();
    }, [refreshPlaylistSchedules]);
    const addList = (groupId) => setGroups(prev => prev.map(g => g.id === groupId ? { ...g, lists: [...g.lists, newList()] } : g));
    const deleteList = (groupId, listId) => {
        setGroups(prev => prev.map(g => g.id === groupId ? { ...g, lists: g.lists.filter(l => l.id !== listId) } : g));
        if (activeRunRef.current?.listId === listId) stopAutomation();
    };

    const updateGroup = (groupId, patch) => setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ...patch } : g));
    const updateList = (groupId, listId, patch) => setGroups(prev => prev.map(g =>
        g.id !== groupId ? g : { ...g, lists: g.lists.map(l => l.id === listId ? { ...l, ...patch } : l) }
    ));

    const reorderGroups = (fromIndex, toIndex) => {
        if (fromIndex === toIndex) return;
        setGroups(prev => reorderArray(prev, fromIndex, toIndex));
    };

    const importListVideos = (groupId, listId) => {
        const group = groups.find(g => g.id === groupId);
        const list = group?.lists.find(l => l.id === listId);
        if (!list) return;
        const raw = list.rawInput || '';
        const unique = [...new Set(parseIdsFromText(raw).map(extractVideoId).filter(Boolean))];
        updateList(groupId, listId, { videoIds: unique, rawInput: unique.join(', '), startIndex: 1 });
    };

    const clearListVideos = (groupId, listId) => updateList(groupId, listId, { videoIds: [], rawInput: '', startIndex: 1, playCount: 1, cycleCount: 0 });

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
                            schedules={playlistSchedules.filter(s => scheduleGroupId(s) === group.id)}
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
                            onAddSchedule={(time, days) => addGroupSchedule(group.id, { time, days })}
                            onToggleSchedule={toggleGroupSchedule}
                            onDeleteSchedule={deleteGroupSchedule}
                            onDragStart={(e) => handleRowDragStart(e, gIdx)}
                            onDragOver={handleRowDragOver}
                            onDrop={(e) => {
                                const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                                if (!Number.isNaN(from)) reorderGroups(from, gIdx);
                            }}
                            onActivateGroup={() => {
                                const first = enterGroup(groups, group.id);
                                if (first) { applySkips(first.skipped); activateRun(first.groupId, first.listId, 'Manual'); }
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
    group, index, groups, schedules, isDuplicate, isActive, activeListId,
    onUpdate, onDelete, onAddList, onDeleteList, onUpdateList,
    onImportListVideos, onClearListVideos, onDragStart, onDragOver, onDrop,
    onAddSchedule, onToggleSchedule, onDeleteSchedule,
    onActivateGroup, onActivateList,
}) {
    const errCls = isDuplicate ? 'border-red-500' : 'border-gray-700';
    const isDisabled = group.enabled === false;

    const reorderLists = (fromIndex, toIndex) => {
        if (fromIndex === toIndex) return;
        onUpdate({ lists: reorderArray(group.lists, fromIndex, toIndex) });
    };

    return (
        <div className={`bg-gray-800/60 rounded-lg border ${isActive ? 'border-amber-500' : 'border-gray-700'} overflow-hidden ${isDisabled ? 'opacity-50' : ''}`}>
            <div
                className="bg-gray-800 px-3 py-2 flex justify-between items-center cursor-grab hover:bg-gray-750"
                draggable
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onClick={() => onUpdate({ isExpanded: !group.isExpanded })}
            >
                <div className="flex items-center gap-2">
                    <span className="text-gray-600 text-xs" title="Drag to reorder">⠿</span>
                    <span className="text-gray-400">{group.isExpanded ? '▾' : '▸'}</span>
                    <h3 className={`font-semibold text-gray-100 ${isDisabled ? 'line-through decoration-gray-500' : ''}`}>
                        {group.name || `Group ${index + 1}`} <span className="text-xs text-gray-500">#{group.serial || '?'}</span>
                        {isActive && <span className="ml-2 text-xs text-amber-400">● live</span>}
                    </h3>
                </div>
                <div className="flex items-center gap-2 text-xs">
                    <span className="bg-gray-700 px-2 py-0.5 rounded">{group.lists.length} list(s)</span>
                    <button
                        onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: isDisabled ? true : false }); }}
                        title={isDisabled ? 'Disabled — excluded from scheduler/live-event/chain triggers. Click to enable.' : 'Enabled. Click to disable — this Group will be skipped by automation (manual Activate still works).'}
                        className={`px-2 py-1 rounded font-bold ${isDisabled ? 'bg-gray-700 text-gray-400' : 'bg-teal-700 text-teal-100'}`}
                    >
                        {isDisabled ? 'OFF' : 'ON'}
                    </button>
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
                                <option value="live_events">On Live Event Match</option>
                            </select>
                            {group.triggerType === 'live_events' && (
                                <input type="text" placeholder="Keywords, comma separated (blank = any live event)"
                                    className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100 w-64"
                                    value={group.triggerValue} onChange={(e) => onUpdate({ triggerValue: e.target.value })} />
                            )}
                            {group.triggerType === 'live_events' && (
                                <div className="flex items-center gap-1 border-l border-gray-700 pl-3" title="Which days this trigger is allowed to fire on — blank/none selected means every day. Doesn't affect chaining or manual Activate.">
                                    {DAY_LABELS.map(d => {
                                        const active = Array.isArray(group.activeDays) && group.activeDays.includes(d.id);
                                        return (
                                            <button
                                                key={d.id}
                                                type="button"
                                                onClick={() => {
                                                    const days = Array.isArray(group.activeDays) ? group.activeDays : [];
                                                    onUpdate({ activeDays: active ? days.filter(x => x !== d.id) : [...days, d.id] });
                                                }}
                                                className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${active ? 'bg-amber-700/60 border-amber-500 text-amber-100' : 'bg-gray-800 border-gray-600 text-gray-400'}`}
                                            >
                                                {d.short}
                                            </button>
                                        );
                                    })}
                                </div>
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

                    <GroupSchedules
                        schedules={schedules}
                        onAdd={onAddSchedule}
                        onToggle={onToggleSchedule}
                        onDelete={onDeleteSchedule}
                    />

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
                            onDragStart={(e) => handleRowDragStart(e, lIdx)}
                            onDragOver={handleRowDragOver}
                            onDrop={(e) => {
                                const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                                if (!Number.isNaN(from)) reorderLists(from, lIdx);
                            }}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Per-Group scheduled times — rows in the shared server-side scheduler (see file header
// comment). Any number of times can be added for the same Group; each "+ Add Schedule"
// creates one more independent row, editable/deletable individually.
// ============================================================================
function GroupSchedules({ schedules, onAdd, onToggle, onDelete }) {
    const [newTime, setNewTime] = useState('');
    const [newDays, setNewDays] = useState([]);

    const sorted = [...schedules].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    const handleAdd = () => {
        if (!newTime) return;
        onAdd(newTime, newDays);
        setNewTime('');
        setNewDays([]);
    };

    return (
        <div className="bg-gray-900/50 border border-gray-700 rounded p-2 space-y-2">
            <div
                className="text-xs text-gray-400 font-semibold uppercase"
                title="Runs server-side — these fire even with this panel closed or no browser open at all. Also listed on the main controller page's Pending Schedules / Trigger History."
            >
                Scheduled Times {sorted.length > 0 ? `(${sorted.length})` : ''}
            </div>

            {sorted.map(s => {
                const disabled = !s.enabled;
                const firedToday = s.lastTriggered === `${todayStamp()}-${s.time}`;
                const daysLabel = s.recurrence === 'days' && Array.isArray(s.days) && s.days.length > 0
                    ? s.days.slice().sort((a, b) => a - b).map(d => DAY_LABELS[d].short).join(', ')
                    : 'Every day';
                let statusText, statusCls;
                if (disabled) { statusText = 'Disabled'; statusCls = 'text-gray-500'; }
                else if (firedToday) { statusText = 'Fired today'; statusCls = 'text-green-400'; }
                else { statusText = 'Pending'; statusCls = 'text-amber-400'; }

                return (
                    <div key={s.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs bg-gray-800/60 rounded px-2 py-1">
                        <span className={`text-gray-200 font-mono ${disabled ? 'opacity-50 line-through' : ''}`}>{s.time}</span>
                        <span className="text-gray-500">{daysLabel}</span>
                        <span className={statusCls}>{statusText}</span>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => onToggle(s.id)}
                                title={disabled ? 'Disabled — click to enable' : 'Enabled — click to disable'}
                                className={`px-2 py-0.5 rounded font-bold ${disabled ? 'bg-gray-700 text-gray-400' : 'bg-teal-800/60 text-teal-200'}`}
                            >
                                {disabled ? 'OFF' : 'ON'}
                            </button>
                            <button onClick={() => onDelete(s.id)} className="text-gray-500 hover:text-red-400 px-1">✕</button>
                        </div>
                    </div>
                );
            })}
            {sorted.length === 0 && <div className="text-xs text-gray-600">No scheduled times yet — add one below.</div>}

            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-gray-800">
                <input type="time" className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-100"
                    value={newTime} onChange={(e) => setNewTime(e.target.value)} />
                <div className="flex items-center gap-1" title="Which days this new time should fire on — blank/none selected means every day">
                    {DAY_LABELS.map(d => {
                        const active = newDays.includes(d.id);
                        return (
                            <button
                                key={d.id}
                                type="button"
                                onClick={() => setNewDays(active ? newDays.filter(x => x !== d.id) : [...newDays, d.id])}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${active ? 'bg-amber-700/60 border-amber-500 text-amber-100' : 'bg-gray-800 border-gray-600 text-gray-400'}`}
                            >
                                {d.short}
                            </button>
                        );
                    })}
                </div>
                <button
                    onClick={handleAdd}
                    disabled={!newTime}
                    className="bg-blue-900/50 hover:bg-blue-800/60 disabled:opacity-40 disabled:cursor-not-allowed text-blue-300 px-2 py-1 rounded text-xs border border-blue-800/60"
                >
                    + Add Schedule
                </button>
            </div>
        </div>
    );
}

// ============================================================================
// List editor (one playlist card)
// ============================================================================
function ListEditor({ list, index, siblingLists, isActive, onUpdate, onDelete, onImport, onClear, onActivate, onDragStart, onDragOver, onDrop }) {
    const maxVideos = Math.max(1, list.videoIds.length);
    const fileInputRef = useRef(null);
    const [isImportingFile, setIsImportingFile] = useState(false);
    const isDisabled = list.enabled === false;

    const handleFileImport = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-selecting the same file next time
        if (!file) return;

        setIsImportingFile(true);
        try {
            const ext = file.name.split('.').pop().toLowerCase();
            let ids;
            if (ext === 'xlsx' || ext === 'xls') {
                const XLSX = await import('xlsx');
                const buf = await file.arrayBuffer();
                const wb = XLSX.read(buf, { type: 'array' });
                const sheet = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                ids = rows.flat().map(v => String(v ?? '').trim()).filter(Boolean);
            } else {
                ids = parseIdsFromText(await file.text());
            }
            const unique = [...new Set(ids.map(extractVideoId).filter(Boolean))];
            onUpdate({ videoIds: unique, rawInput: unique.join(', '), startIndex: 1 });
        } catch (err) {
            console.error('Playlist Automation file import error:', err);
        } finally {
            setIsImportingFile(false);
        }
    };

    return (
        <div className={`bg-gray-850 bg-gray-900/40 rounded border ${isActive ? 'border-amber-500' : 'border-blue-900/50'} overflow-hidden ${isDisabled ? 'opacity-50' : ''}`}>
            <div
                className="bg-blue-950/30 px-3 py-1.5 flex justify-between items-center cursor-grab"
                draggable
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onClick={() => onUpdate({ isExpanded: !list.isExpanded })}
            >
                <div className="flex items-center gap-2">
                    <span className="text-gray-600 text-xs" title="Drag to reorder">⠿</span>
                    <span className="text-blue-400 text-xs">{list.isExpanded ? '▾' : '▸'}</span>
                    <span className={`text-sm text-gray-200 ${isDisabled ? 'line-through decoration-gray-500' : ''}`}>{list.name || `List ${index + 1}`} <span className="text-xs text-gray-500">#{list.serial || '?'}</span></span>
                    {isActive && <span className="text-xs text-amber-400">● live</span>}
                </div>
                <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400">{list.videoIds.length} videos</span>
                    <button
                        onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: isDisabled ? true : false }); }}
                        title={isDisabled ? 'Disabled — skipped in the chain, its own "Then" is still followed. Click to enable.' : 'Enabled. Click to disable — this List will be skipped (▶ Play still force-plays it).'}
                        className={`px-2 py-0.5 rounded font-bold ${isDisabled ? 'bg-gray-700 text-gray-400' : 'bg-teal-800/60 text-teal-200'}`}
                    >
                        {isDisabled ? 'OFF' : 'ON'}
                    </button>
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
                        <button onClick={() => fileInputRef.current?.click()} disabled={isImportingFile}
                            className="bg-gray-700 hover:bg-gray-600 text-gray-100 px-2 py-1 rounded text-xs disabled:opacity-60"
                            title="Import video IDs from a .txt, .csv or Excel file — one ID per line, or comma-separated">
                            {isImportingFile ? 'Reading...' : 'Import File'}
                        </button>
                        <input ref={fileInputRef} type="file" accept=".txt,.csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleFileImport} />
                        <button onClick={onClear} className="bg-gray-800 border border-gray-600 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs">Clear</button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-900/50 border border-gray-700 rounded px-2 py-1.5">
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1">
                                <label className="text-xs text-gray-400" title="Auto-advances as this list plays, so replays continue where they left off instead of repeating videos. Edit it to manually jump/replay.">Resume At:</label>
                                <input type="number" min={1} max={maxVideos} className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-center text-gray-100"
                                    value={list.startIndex} onChange={(e) => onUpdate({ startIndex: parseInt(e.target.value, 10) || 1 })} />
                            </div>
                            <div className="flex items-center gap-1 border-l border-gray-700 pl-3">
                                <label className="text-xs text-gray-400">Play Count:</label>
                                <input type="number" min={1} className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-center text-gray-100"
                                    value={list.playCount} onChange={(e) => onUpdate({ playCount: parseInt(e.target.value, 10) || 1 })} />
                            </div>
                            <div className="flex items-center gap-1 border-l border-gray-700 pl-3">
                                <label className="text-xs text-gray-400" title="How many times this List's turn must come up before it actually plays. 25 means it's silently skipped 24 times and plays on the 25th, then starts counting again. Leave at 1 to always play.">Run Every:</label>
                                <input type="number" min={1} className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-center text-gray-100"
                                    value={list.runEvery ?? 1} onChange={(e) => onUpdate({ runEvery: parseInt(e.target.value, 10) || 1 })} />
                                {(parseInt(list.runEvery, 10) || 1) > 1 && (
                                    <span className="text-xs text-gray-500" title="Turns passed toward this List's next play">({list.cycleCount || 0}/{parseInt(list.runEvery, 10) || 1})</span>
                                )}
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
