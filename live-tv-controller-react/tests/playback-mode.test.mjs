/**
 * Playback mode + playback session — the isolation rules behind "a normal Video ID
 * must never be routed through the live pipeline, and must never be skipped by an
 * event that belongs to a different video".
 *
 * These cover the three skip chains found in the audit:
 *   1. the Live Monitor replacing a manually-loaded normal video (allowsLiveEventTakeover)
 *   2. videoError being treated as "video ended"                  (isEndOfPlayback / isUnplayableVideoError)
 *   3. Stream-End Rules firing for an ordinary video              (allowsStreamEndRules)
 * plus the stale-event gate that makes video A's late ENDED harmless to video B.
 *
 * Run: node tests/playback-mode.test.mjs
 */
import {
    PLAYBACK_MODE, normalizeMode, isNormalMode,
    allowsStreamExtraction, allowsLiveEventTakeover, allowsStreamEndRules,
    newPlaybackSessionId, isEndOfPlayback, isUnplayableVideoError,
    shouldAcceptPlayerEvent, describePlayback,
    isRunawayAdvance, MAX_ADVANCES_WITHOUT_PLAYBACK,
} from '../src/utils/playback-mode.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n          got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
};

console.log('\nMode normalisation — an absent mode must mean what every pre-existing caller meant');
check('missing mode -> live (no regression for existing live setups)', normalizeMode(undefined), PLAYBACK_MODE.LIVE);
check('unknown mode -> live', normalizeMode('something-else'), PLAYBACK_MODE.LIVE);
check('explicit normal -> normal', normalizeMode('normal'), PLAYBACK_MODE.NORMAL);
check('isNormalMode only for an explicit normal', isNormalMode(undefined), false);

console.log('\nPipeline isolation — mode is the ONLY thing that unlocks yt-dlp/cookies/ffmpeg');
check('live mode may extract a stream', allowsStreamExtraction(PLAYBACK_MODE.LIVE), true);
check('normal mode may NOT extract a stream', allowsStreamExtraction(PLAYBACK_MODE.NORMAL), false);
check('normal mode blocks live-event takeover', allowsLiveEventTakeover(PLAYBACK_MODE.NORMAL), false);
check('live mode allows live-event takeover', allowsLiveEventTakeover(PLAYBACK_MODE.LIVE), true);
check('normal mode blocks Stream-End Rules', allowsStreamEndRules(PLAYBACK_MODE.NORMAL), false);
check('live mode keeps Stream-End Rules', allowsStreamEndRules(PLAYBACK_MODE.LIVE), true);

console.log('\nFalse "ended" — only a genuinely completed playback counts');
for (const notAnEnd of ['videoError', 'timeUpdate', 'relayStatus', 'buffering', 'cued', 'paused', 'unstarted', 'durationUpdate']) {
    check(`"${notAnEnd}" is not an end`, isEndOfPlayback(notAnEnd), false);
}
check('"videoEnded" is an end', isEndOfPlayback('videoEnded'), true);

console.log('\nError classification — skip only what can never play, never a transient failure');
check('2 (invalid id) is terminal', isUnplayableVideoError(2), true);
check('100 (removed/private) is terminal', isUnplayableVideoError(100), true);
check('101 (embedding disabled) is terminal', isUnplayableVideoError(101), true);
check('150 (embedding disabled) is terminal', isUnplayableVideoError(150), true);
check('5 (HTML5 player error) is NOT terminal — must not skip', isUnplayableVideoError(5), false);
check('undefined code is NOT terminal', isUnplayableVideoError(undefined), false);
check('string "150" is terminal (payloads arrive as JSON)', isUnplayableVideoError('150'), true);

console.log('\nStale-event gate — video A must not be able to skip video B');
const sessA = newPlaybackSessionId();
const sessB = newPlaybackSessionId();
check('two loads get distinct session ids', sessA === sessB, false);
check('A ENDED while A is current -> accepted',
    shouldAcceptPlayerEvent({ playbackSessionId: sessA, videoId: 'AAA' }, { playbackSessionId: sessA, videoId: 'AAA' }), true);
check('A ENDED arriving after B loaded -> REJECTED (the skip bug)',
    shouldAcceptPlayerEvent({ playbackSessionId: sessA, videoId: 'AAA' }, { playbackSessionId: sessB, videoId: 'BBB' }), false);
check('same video reloaded (new session) -> stale event still rejected',
    shouldAcceptPlayerEvent({ playbackSessionId: sessA, videoId: 'AAA' }, { playbackSessionId: sessB, videoId: 'AAA' }), false);
check('no session on either side -> fall back to videoId match',
    shouldAcceptPlayerEvent({ videoId: 'AAA' }, { videoId: 'BBB' }), false);
check('videoId match with no sessions -> accepted',
    shouldAcceptPlayerEvent({ videoId: 'AAA' }, { videoId: 'AAA' }), true);
check('event with no identity at all -> accepted (old player page must keep working)',
    shouldAcceptPlayerEvent({}, { playbackSessionId: sessB, videoId: 'BBB' }), true);
check('current side not known yet -> accepted (never go unresponsive)',
    shouldAcceptPlayerEvent({ playbackSessionId: sessA, videoId: 'AAA' }, {}), true);

console.log('\nStructured logging — normal failures distinguishable from live extraction failures');
check('normal-video error line',
    describePlayback({ mode: 'normal', videoId: 'ABC123', playerId: 'PLAYER_01', event: 'ERROR', source: 'youtube_iframe', reason: 'embedding disabled' }),
    '[Playback] mode=normal videoId=ABC123 playerId=PLAYER_01 event=ERROR source=youtube_iframe reason=embedding disabled');
check('live extraction line',
    describePlayback({ mode: 'live', videoId: 'XYZ', playerId: 'PLAYER_01', event: 'ERROR', source: 'yt-dlp', reason: 'not live' }),
    '[Playback] mode=live videoId=XYZ playerId=PLAYER_01 event=ERROR source=yt-dlp reason=not live');
check('no cookie material can reach the line (only declared fields are emitted)',
    describePlayback({ mode: 'live', videoId: 'X', cookies: 'SECRET', cookiesFile: '/x/cookies.txt' }),
    '[Playback] mode=live videoId=X');

console.log('\nRunaway-advance breaker — the observed one-advance-per-second storm');
check('a normal single skip is not a runaway', isRunawayAdvance(1), false);
check('four consecutive failed advances still allowed', isRunawayAdvance(4), false);
check('the fifth trips the breaker', isRunawayAdvance(MAX_ADVANCES_WITHOUT_PLAYBACK), true);
check('well past the limit stays tripped', isRunawayAdvance(30), true);
check('a video that played resets to zero -> not a runaway', isRunawayAdvance(0), false);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
