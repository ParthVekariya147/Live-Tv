// End-to-end: server scheduler fires -> frontend executes -> confirms -> server notifies.
// Stands in for the browser controller. WRITES schedules and switches the on-air player,
// so only ever point it at a dev instance. Usage: node tests/scheduler-e2e.mjs [port]
import WebSocket from 'ws';
import { resolveHideFallback } from '../src/utils/player-switching.js';

const PORT = process.argv[2] || '3005';
const BASE = `http://localhost:${PORT}`;
const log = (...a) => console.log('  ' + new Date().toLocaleTimeString(), ...a);
const j = async (url, opts) => (await fetch(BASE + url, opts)).json();

let sourceState = {};
const applyActive = (name) => { if (name) ['Live Player','Loop Player','Delay Live','Local Player'].forEach(s => { sourceState[s] = (s === name); }); };

const seen = [];
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
await new Promise((r) => ws.on('open', r));
log('connected');

ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'STATE_SYNC') applyActive(m.data?.['obs.activeSource']);
    if (m.type === 'STATE_CHANGE' && m.data?.key === 'obs.activeSource') applyActive(m.data.value);
    if (m.type !== 'SCHEDULER_TRIGGER') return;
    const t = m.data;
    if (t.action !== 'show' && t.action !== 'hide') return;
    log(`<- trigger: ${t.action} "${t.source}" (skipIfLivePlaying=${t.skipIfLivePlaying})`);

    // The guard from Scheduler.jsx handleServerTrigger.
    if (sourceState['Live Player'] === true && t.skipIfLivePlaying === true && t.source !== 'Live Player') {
        ws.send(JSON.stringify({ type: 'TRIGGER_RESULT', data: { ...t, ok: false, reason: 'Live Player is on air' } }));
        seen.push({ ...t, outcome: 'skipped' }); return;
    }
    // The switch from setSourceVisibilityConfirmed.
    const target = t.action === 'show' ? t.source : resolveHideFallback(t.source, sourceState);
    let ok = true;
    if (target) {
        ok = !!(await j('/api/state/obs.activeSource', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: target }) })).success;
        log(`-> on-air player = "${target}" (ok=${ok})`);
    } else log('-> hide was a legitimate no-op');
    ws.send(JSON.stringify({ type: 'TRIGGER_RESULT', data: { ...t, ok, reason: ok ? null : 'state write failed' } }));
    seen.push({ ...t, outcome: ok ? 'confirmed' : 'failed', target });
});

const at = (min) => { const d = new Date(Date.now() + min * 60000); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
const mk = (body) => j('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

await j('/api/state/obs.activeSource', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'Loop Player' }) });
await new Promise((r) => setTimeout(r, 300));

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}` + (c ? '' : `\n          ${d}`)); };

const s1 = await mk({ time: at(1), source: 'Delay Live', action: 'show', recurrence: 'daily', title: 'E2E show', enabled: true });
const s2 = await mk({ time: at(2), source: 'Delay Live', action: 'hide', recurrence: 'daily', title: 'E2E hide', enabled: true });
const s3 = await mk({ time: '23:59', source: 'Loop Player', action: 'show', recurrence: 'daily', title: 'E2E flag', enabled: true, skipIfLivePlaying: true });
check('skipIfLivePlaying survives addSchedule', s3.schedule?.skipIfLivePlaying === true, `stored=${s3.schedule?.skipIfLivePlaying}`);
log(`waiting ~145s for both schedules to fire...`);
await new Promise((r) => setTimeout(r, 145000));

const show = seen.find((e) => e.action === 'show' && e.source === 'Delay Live');
const hide = seen.find((e) => e.action === 'hide' && e.source === 'Delay Live');
check('scheduled SHOW fired and switched to Delay Live', show?.outcome === 'confirmed' && show?.target === 'Delay Live', JSON.stringify(show));
check('scheduled HIDE fired and fell back to Loop Player', hide?.outcome === 'confirmed' && hide?.target === 'Loop Player', JSON.stringify(hide));
const final = await j('/api/state/obs.activeSource');
check('on-air player ended on Loop Player', final.value === 'Loop Player', `value=${final.value}`);

for (const id of [s1.schedule?.id, s2.schedule?.id, s3.schedule?.id].filter(Boolean)) await fetch(`${BASE}/api/schedules/${id}`, { method: 'DELETE' });
log('cleaned up test schedules');
console.log(`\n  ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail ? 1 : 0);
