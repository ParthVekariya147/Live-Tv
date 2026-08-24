// Runs the REAL public/UnifiedPlayer.html script in a stubbed DOM and records the
// mute/unmute commands it writes. All four players share one always-visible OBS
// browser source now, so OBS can no longer silence the off-air ones — and two of the
// player pages (LoopPlayer, DelayLive) contain no <video> element at all, which is
// why reaching into the DOM was not enough and their audio bled over the broadcast.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'public', 'UnifiedPlayer.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const sent = [];
let ws = null;
const store = {};

const makeEl = () => {
    const el = {
        dataset: {}, children: [], style: {}, _attrs: {}, className: '',
        classList: { toggle() {} },
        setAttribute(k, v) { el._attrs[k] = v; },
        appendChild(c) { el.children.push(c); },
        addEventListener() {},
        // A player page with no <video> at all — LoopPlayer.html / DelayLive.html.
        get contentDocument() { return { querySelectorAll: () => [] }; },
    };
    return el;
};
const root = makeEl();

const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    JSON,
    document: { getElementById: () => root, createElement: makeEl },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); if (/Command$/.test(k)) sent.push({ key: k, command: JSON.parse(v).command }); },
        removeItem: (k) => { delete store[k]; },
    },
    location: { protocol: 'http:', host: 'localhost:3004' },
    WebSocket: class { constructor() { ws = this; } set onmessage(f) { this._m = f; } get onmessage() { return this._m; } set onclose(f) {} set onerror(f) {} close() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ state: {
        'obs.activeSource': 'Loop Player',
        'player.loop': { isMuted: false }, 'player.live': { isMuted: false },
        'player.delay': { isMuted: false }, 'player.local': { isMuted: true }, // operator muted Local by hand
    } }) }),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
await new Promise((r) => setImmediate(r));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    cond ? pass++ : fail++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}` + (cond ? '' : `\n          ${detail}`));
};
const cmds = (k) => sent.filter((s) => s.key === k).map((s) => s.command);

check('off-air Delay (YouTube-only page) gets an explicit mute', cmds('delayLivePlayerCommand').includes('mute'), JSON.stringify(cmds('delayLivePlayerCommand')));
check('off-air Live gets muted', cmds('livePlayerCommand').includes('mute'), JSON.stringify(cmds('livePlayerCommand')));
check('on-air Loop gets unmuted', cmds('loopPlayerCommand').includes('unmute'), JSON.stringify(cmds('loopPlayerCommand')));
check('operator-muted Local is NOT force-unmuted', !cmds('localPCPlayerCommand').includes('unmute'), JSON.stringify(cmds('localPCPlayerCommand')));

// Switch to Live over the WebSocket, exactly as a scheduler trigger would.
sent.length = 0;
ws.onmessage({ data: JSON.stringify({ type: 'STATE_CHANGE', data: { type: 'SET', key: 'obs.activeSource', value: 'Live Player' } }) });

check('after switching: Live is unmuted', cmds('livePlayerCommand').includes('unmute'), JSON.stringify(cmds('livePlayerCommand')));
check('after switching: previously on-air Loop is muted (no bleed)', cmds('loopPlayerCommand').includes('mute'), JSON.stringify(cmds('loopPlayerCommand')));
const keys = ['loopPlayerCommand', 'livePlayerCommand', 'delayLivePlayerCommand', 'localPCPlayerCommand'];
check('each of the four players got exactly one command', keys.every((k) => cmds(k).length === 1), JSON.stringify(Object.fromEntries(keys.map((k) => [k, cmds(k).length]))));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
