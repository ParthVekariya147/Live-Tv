/**
 * Scheduler trigger notifications — one trigger must produce exactly one push.
 *
 * A scheduler trigger is broadcast to EVERY connected controller and each one executes it
 * and reports its own TRIGGER_RESULT. The old handleTriggerResult notified once per report,
 * so N open clients meant N identical pushes. Measured in this install's notification
 * history: 99 distinct trigger events sent more than once, up to 6 in the same second.
 * A separate path produced bursts of "did not run" — 11 inside 2 seconds — because every
 * pending confirmation timed out independently when nothing was connected.
 *
 * Run: node tests/trigger-notify-dedupe.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(APP, 'server.cjs'), 'utf8');

// Lift the confirm/notify block out of server.cjs (which otherwise boots a whole server)
// and run it against a recording stub instead of the real push service.
function buildHarness({ confirmTimeoutMs = 60, batchWindowMs = 25 } = {}) {
    const start = src.indexOf('const notifiedTriggers = new Map()');
    const end = src.indexOf('// After each successful execution');
    assert.ok(start > 0 && end > start, 'could not locate the trigger-notification block in server.cjs');
    let block = src.slice(start, end);
    // Shrink the real timers so the test runs in milliseconds, not minutes.
    block = block
        .replace(/TRIGGER_CONFIRM_TIMEOUT_MS/g, 'CONFIRM_MS')
        .replace(/const TIMEOUT_BATCH_WINDOW_MS = \d+;/, `const TIMEOUT_BATCH_WINDOW_MS = ${batchWindowMs};`);

    const sent = [];
    const notificationService = { send: (event, data) => { sent.push({ event, data }); return Promise.resolve(); } };
    const pendingTriggerConfirmations = new Map();
    const fn = new Function('notificationService', 'pendingTriggerConfirmations', 'CONFIRM_MS', 'console', `
        ${block}
        return { awaitTriggerConfirmation, handleTriggerResult };
    `);
    return { sent, pendingTriggerConfirmations, ...fn(notificationService, pendingTriggerConfirmations, confirmTimeoutMs, { log: () => {} }) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = async (name, fn) => {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

const trigger = (n) => ({ id: n, triggerKey: `k${n}`, action: 'show', source: 'Loop Player', title: `Schedule ${n}` });
const result = (n, ok, reason) => ({ ...trigger(n), ok, reason });

await check('six controllers reporting the same success send ONE push', async () => {
    const h = buildHarness();
    h.awaitTriggerConfirmation(trigger(1));
    for (let i = 0; i < 6; i++) h.handleTriggerResult(result(1, true));
    assert.equal(h.sent.length, 1, `expected 1 push, got ${h.sent.length}`);
    assert.equal(h.sent[0].event, 'SCHEDULER_TRIGGER');
});

await check('six controllers reporting the same failure send ONE push', async () => {
    const h = buildHarness();
    h.awaitTriggerConfirmation(trigger(2));
    for (let i = 0; i < 6; i++) h.handleTriggerResult(result(2, false, 'Live Player is on air'));
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].event, 'SCHEDULER_TRIGGER_FAILED');
});

await check('different triggers are still notified separately', async () => {
    const h = buildHarness();
    [3, 4, 5].forEach(n => { h.awaitTriggerConfirmation(trigger(n)); h.handleTriggerResult(result(n, true)); });
    assert.equal(h.sent.length, 3);
});

await check('a late success cannot contradict an already-sent timeout failure', async () => {
    const h = buildHarness({ confirmTimeoutMs: 20, batchWindowMs: 10 });
    h.awaitTriggerConfirmation(trigger(6));
    await sleep(60);
    assert.equal(h.sent.length, 1, 'timeout should have sent exactly one failure');
    assert.equal(h.sent[0].event, 'SCHEDULER_TRIGGER_FAILED');
    h.handleTriggerResult(result(6, true)); // client reports success afterwards
    assert.equal(h.sent.length, 1, 'a late report must not send a second, contradictory push');
});

await check('a burst of timeouts collapses into ONE summary push', async () => {
    const h = buildHarness({ confirmTimeoutMs: 20, batchWindowMs: 40 });
    for (let n = 10; n < 21; n++) h.awaitTriggerConfirmation(trigger(n)); // 11, like the real burst
    await sleep(120);
    assert.equal(h.sent.length, 1, `expected 1 summary push, got ${h.sent.length}`);
    assert.equal(h.sent[0].data.scheduleName, '11 schedules');
    assert.match(h.sent[0].data.reason, /Schedule 10/);
});

await check('a single timeout still names the actual schedule', async () => {
    const h = buildHarness({ confirmTimeoutMs: 20, batchWindowMs: 40 });
    h.awaitTriggerConfirmation(trigger(30));
    await sleep(120);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].data.scheduleName, 'Schedule 30');
    assert.equal(h.sent[0].data.action, 'show');
});

await check('a report that arrives in time cancels the timeout push', async () => {
    const h = buildHarness({ confirmTimeoutMs: 60, batchWindowMs: 10 });
    h.awaitTriggerConfirmation(trigger(40));
    h.handleTriggerResult(result(40, true));
    await sleep(120);
    assert.equal(h.sent.length, 1, 'the timeout must not fire after a result was received');
    assert.equal(h.sent[0].event, 'SCHEDULER_TRIGGER');
});

await check('unidentifiable reports are not collapsed into each other', async () => {
    const h = buildHarness();
    h.handleTriggerResult({ ok: true, action: 'show', source: 'A', title: 'A' });
    h.handleTriggerResult({ ok: true, action: 'show', source: 'B', title: 'B' });
    assert.equal(h.sent.length, 2, 'missing ids must disable dedupe, not merge unrelated triggers');
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll trigger-notification tests passed');
process.exit(failures ? 1 : 0);
