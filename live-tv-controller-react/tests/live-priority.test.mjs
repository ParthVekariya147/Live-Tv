// The live-vs-loop screen race: MonitorManager and LoopPlaylistAutomation both react
// to the same 'livePlayerAutoLoad' event and both want the screen. React state lags a
// switch by a full server round trip, so the loser used to be decided by whoever
// awaited something first — the broadcast cut to live, then flipped back a moment later.
const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
};

const { readActiveSourceNow, ACTIVE_SOURCE_KEY } = await import('../src/utils/player-switching.js');

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n          got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
};

// The decision activateRun makes in LoopPlaylistAutomation.
const wouldGrabScreen = ({ stateLive, stateLoop }) => {
    if (stateLive || readActiveSourceNow() === 'Live Player') return 'queued';
    return stateLoop ? 'already-loop' : 'grabbed';
};

// Loop is on air running a playlist; a live stream is detected.
store[ACTIVE_SOURCE_KEY] = 'Loop Player';

// MonitorManager switches to Live. localStorage updates synchronously; React state does not.
store[ACTIVE_SOURCE_KEY] = 'Live Player';
check('during the state-lag window -> queues instead of stealing the screen',
    wouldGrabScreen({ stateLive: false, stateLoop: true }), 'queued');
check('after React state catches up -> still queued',
    wouldGrabScreen({ stateLive: true, stateLoop: false }), 'queued');

// Live ends: App.jsx puts Loop back on air and the queued run takes over.
store[ACTIVE_SOURCE_KEY] = 'Loop Player';
check('live ended, loop not yet showing -> automation may take the screen',
    wouldGrabScreen({ stateLive: false, stateLoop: false }), 'grabbed');
check('mid-chain list transition, loop already on air -> no redundant switch',
    wouldGrabScreen({ stateLive: false, stateLoop: true }), 'already-loop');

// Regression guard: the old code read only the lagging ref.
store[ACTIVE_SOURCE_KEY] = 'Live Player';
const oldStyle = (staleRef) => (staleRef ? 'queued' : 'grabbed-from-live');
check('OLD ref-only check would have stolen the screen in that window',
    oldStyle(false), 'grabbed-from-live');
check('NEW check survives the same window', wouldGrabScreen({ stateLive: false, stateLoop: false }), 'queued');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
