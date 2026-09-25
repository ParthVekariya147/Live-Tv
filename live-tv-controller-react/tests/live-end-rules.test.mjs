/**
 * Stream-End Rules matching — the logic behind "when the live stream ends, switch to
 * Loop Player".
 *
 * The case that matters most here is the one taken verbatim from this install's own
 * backup: a rule with keywords and isDefault set, but groupId "" because no Loop
 * Automation Group existed yet to pick. resolveLiveEndTarget used to require a groupId
 * on BOTH the keyword lookup and the default lookup, so that rule resolved to null —
 * and the caller treats null as "do nothing", which cancelled the handoff to Loop Player
 * entirely. Deciding WHERE to switch and WHICH playlist to start are now separate.
 *
 * Run: node tests/live-end-rules.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The module imports ./state-api (browser fetch); pull out just the pure function.
const srcPath = path.join(APP, 'src', 'utils', 'liveEndRules.js');
const src = fs.readFileSync(srcPath, 'utf8');
const fnSrc = src.slice(src.indexOf('export function resolveLiveEndTarget'));
const resolveLiveEndTarget = new Function(`${fnSrc.replace('export function', 'return function')}`)();

let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

// ---- the exact rule found in backup_2026-08-24T12-47-48.json --------------------
const REAL_RULE = [{
    id: 'rule-mshfrly6-eaagvf', keywords: 'Mangla', groupId: '', listId: '', isDefault: true,
}];

check('the real saved rule now resolves (was null — the whole bug)', () => {
    const t = resolveLiveEndTarget(REAL_RULE, 'Mangla Aarti Live from Kundaldham');
    assert.ok(t, 'returned null, so the Loop Player handoff would be skipped');
    assert.equal(t.matchedBy, 'keyword');
    assert.equal(t.groupId, null, 'no Group was chosen, so there is nothing to start');
});

check('the same rule resolves as Default for an unrelated title', () => {
    const t = resolveLiveEndTarget(REAL_RULE, 'Some Other Broadcast');
    assert.ok(t, 'a Default row must still hand off');
    assert.equal(t.matchedBy, 'default');
    assert.equal(t.groupId, null);
});

check('the same rule resolves as Default when the title is unknown', () => {
    const t = resolveLiveEndTarget(REAL_RULE, '');
    assert.ok(t);
    assert.equal(t.matchedBy, 'default');
});

// ---- behaviour that must NOT change -------------------------------------------
check('no rules at all still means do nothing', () => {
    assert.equal(resolveLiveEndTarget([], 'anything'), null);
    assert.equal(resolveLiveEndTarget(null, 'anything'), null);
    assert.equal(resolveLiveEndTarget(undefined, 'anything'), null);
});

check('a non-matching title with no Default row still means do nothing', () => {
    const rules = [{ id: 'a', keywords: 'katha', groupId: 'g1', isDefault: false }];
    assert.equal(resolveLiveEndTarget(rules, 'Mangla Aarti'), null);
});

check('a keyword rule with a Group still starts that Group', () => {
    const rules = [{ id: 'a', keywords: 'katha,pravachan', groupId: 'g1', listId: 'l1', isDefault: false }];
    const t = resolveLiveEndTarget(rules, 'Evening PRAVACHAN live');
    assert.deepEqual(t, { groupId: 'g1', listId: 'l1', matchedBy: 'keyword' });
});

check('keyword match beats the Default row', () => {
    const rules = [
        { id: 'a', keywords: 'katha', groupId: 'g1', isDefault: false },
        { id: 'b', keywords: '', groupId: 'g2', isDefault: true },
    ];
    assert.equal(resolveLiveEndTarget(rules, 'Morning Katha').groupId, 'g1');
    assert.equal(resolveLiveEndTarget(rules, 'Unrelated').groupId, 'g2');
});

check('matching is case-insensitive and comma-separated', () => {
    const rules = [{ id: 'a', keywords: ' KATHA , Aarti ', groupId: 'g1', isDefault: false }];
    assert.ok(resolveLiveEndTarget(rules, 'evening aarti live'));
    assert.ok(resolveLiveEndTarget(rules, 'morning katha'));
    assert.equal(resolveLiveEndTarget(rules, 'bhajan'), null);
});

check('a Default row with a Group still wins over a Group-less one', () => {
    const rules = [
        { id: 'a', keywords: '', groupId: '', isDefault: false },
        { id: 'b', keywords: '', groupId: 'g9', isDefault: true },
    ];
    assert.equal(resolveLiveEndTarget(rules, 'x').groupId, 'g9');
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll stream-end rule tests passed');
process.exit(failures ? 1 : 0);
