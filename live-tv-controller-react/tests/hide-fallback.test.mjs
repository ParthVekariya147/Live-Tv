// "hide X" has no OBS meaning in the single-source UnifiedPlayer layout — there is
// no scene item to switch off. These pin down what it must translate into instead.
import { resolveHideFallback } from '../src/utils/player-switching.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n          got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
};

const onAir = (name) => ({ 'Live Player': false, 'Loop Player': false, 'Delay Live': false, 'Local Player': false, [name]: true });

check('hide the on-air Delay Live -> falls back to Loop', resolveHideFallback('Delay Live', onAir('Delay Live')), 'Loop Player');
check('hide the on-air Live Player -> falls back to Loop', resolveHideFallback('Live Player', onAir('Live Player')), 'Loop Player');
check('hide the on-air Local Player -> falls back to Loop', resolveHideFallback('Local Player', onAir('Local Player')), 'Loop Player');
check('hide Loop Player itself -> no-op (nothing sits below it)', resolveHideFallback('Loop Player', onAir('Loop Player')), null);
check('hide a player that is NOT on air -> no-op', resolveHideFallback('Delay Live', onAir('Loop Player')), null);
check('hide with nothing known on air -> no-op', resolveHideFallback('Delay Live', {}), null);
check('legacy: hide one of two visible sources -> the other stays up', resolveHideFallback('Delay Live', { 'Delay Live': true, 'Local Player': true }), null);
check('legacy: hide the last visible non-Loop source -> falls back to Loop', resolveHideFallback('Delay Live', { 'Delay Live': true, 'Local Player': false }), 'Loop Player');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
