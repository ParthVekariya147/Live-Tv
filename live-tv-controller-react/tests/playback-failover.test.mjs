/**
 * Playback Failover — what happens when several videos in a row fail to play.
 *
 * The operator's requirement: "if more than 5 IDs skip, switch to whichever player I
 * select, and if there is a playlist inside it, start it the way our universal logic
 * already runs." These pin down the selection, the threshold, and the two decisions
 * staying separate (switching vs. starting a playlist) — fusing them is what made
 * Stream-End Rules silently do nothing when no Group was picked.
 *
 * Run: node tests/playback-failover.test.mjs
 */
import {
    MIN_THRESHOLD, MAX_THRESHOLD,
    defaultFailoverConfig, failoverTargets, normalizeFailoverConfig,
    shouldFailover, resolveFailoverAction,
} from '../src/utils/playbackFailover.js';
import { SOURCE_NAMES, FALLBACK_SOURCE } from '../src/utils/player-switching.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n          got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
};

console.log('\nTargets come from the shared player registry — never a hardcoded list');
check('every registered player is selectable', failoverTargets(), SOURCE_NAMES);
check('a player added to the registry appears automatically',
    failoverTargets().length, SOURCE_NAMES.length);

console.log('\nDefaults — "more than 5 skipped" is the operator-facing description');
check('default threshold is 5', defaultFailoverConfig().threshold, 5);
check('default target is the standing fallback', defaultFailoverConfig().targetPlayer, FALLBACK_SOURCE);
check('enabled by default', defaultFailoverConfig().enabled, true);
check('no playlist configured by default', defaultFailoverConfig().groupId, '');

console.log('\nThreshold — a single bad video is normal, not a failure');
const cfg5 = normalizeFailoverConfig({ threshold: 5 });
check('1 skip does not fail over', shouldFailover(1, cfg5), false);
check('4 skips do not fail over', shouldFailover(4, cfg5), false);
check('5 skips DO fail over', shouldFailover(5, cfg5), true);
check('well past the threshold still fails over', shouldFailover(40, cfg5), true);
check('a custom threshold of 3 is honoured', shouldFailover(3, normalizeFailoverConfig({ threshold: 3 })), true);
check('disabled -> never fails over, however many skip',
    shouldFailover(99, normalizeFailoverConfig({ enabled: false })), false);

console.log('\nConfig repair — stored data from an older build or a deleted player');
check('threshold below the floor is clamped', normalizeFailoverConfig({ threshold: 1 }).threshold, MIN_THRESHOLD);
check('threshold above the ceiling is clamped', normalizeFailoverConfig({ threshold: 999 }).threshold, MAX_THRESHOLD);
check('a non-numeric threshold falls back to the default', normalizeFailoverConfig({ threshold: 'abc' }).threshold, 5);
check('a player that no longer exists falls back to the standing fallback',
    normalizeFailoverConfig({ targetPlayer: 'Deleted Player' }).targetPlayer, FALLBACK_SOURCE);
check('a real player is kept as chosen',
    normalizeFailoverConfig({ targetPlayer: 'Local Player' }).targetPlayer, 'Local Player');
check('garbage input yields usable defaults', normalizeFailoverConfig(null), defaultFailoverConfig());

console.log('\nThe handover — any selected player, never a hardcoded one');
check('switches to the selected player',
    resolveFailoverAction({ targetPlayer: 'Local Player' }, 'Loop Player').targetPlayer, 'Local Player');
check('Delay Live is just as valid a target',
    resolveFailoverAction({ targetPlayer: 'Delay Live' }, 'Loop Player').targetPlayer, 'Delay Live');
check('Live Player is just as valid a target',
    resolveFailoverAction({ targetPlayer: 'Live Player' }, 'Loop Player').targetPlayer, 'Live Player');
check('never hands the failing player back to itself — uses the fallback instead',
    resolveFailoverAction({ targetPlayer: 'Local Player' }, 'Local Player').targetPlayer, FALLBACK_SOURCE);
check('the fallback failing with itself as target -> no safe target, caller only alerts',
    resolveFailoverAction({ targetPlayer: FALLBACK_SOURCE }, FALLBACK_SOURCE).targetPlayer, null);
check('disabled -> no action at all', resolveFailoverAction({ enabled: false }, 'Loop Player'), null);

console.log('\nSwitching and starting a playlist stay SEPARATE decisions');
const withList = resolveFailoverAction({ targetPlayer: 'Loop Player', groupId: 'g1', listId: 'l1' }, 'Live Player');
check('a configured Group rides along for the universal start logic',
    withList.startGroup, { groupId: 'g1', listId: 'l1' });
check('…and the switch still names the selected player', withList.targetPlayer, 'Loop Player');
const noList = resolveFailoverAction({ targetPlayer: 'Local Player', groupId: '' }, 'Loop Player');
check('no Group picked -> still switches (the Stream-End Rules bug, not repeated)',
    noList.targetPlayer, 'Local Player');
check('no Group picked -> nothing to start', noList.startGroup, null);
check('a Group with no specific list starts the Group\'s own first playlist',
    resolveFailoverAction({ targetPlayer: 'Loop Player', groupId: 'g2' }, 'Live Player').startGroup,
    { groupId: 'g2', listId: null });

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
