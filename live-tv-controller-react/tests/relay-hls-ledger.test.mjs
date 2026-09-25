/**
 * Proves the property the whole "live stream stops after ~20 minutes" fix rests
 * on: an ffmpeg restart must never make the served playlist travel backwards or
 * silently swap the initialisation segment.
 *
 * Run: node tests/relay-hls-ledger.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HlsLedger } = require('../relay-hls-ledger.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
const write = (runId, count) => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-MAP:URI="init_${runId}.mp4"`];
    for (let i = 0; i < count; i++) {
        lines.push('#EXTINF:4.000000,', `seg_${runId}_${String(i).padStart(5, '0')}.m4s`);
    }
    fs.writeFileSync(path.join(dir, `run_${runId}.m3u8`), lines.join('\n'));
};
const touchSegments = (runId, count) => {
    fs.writeFileSync(path.join(dir, `init_${runId}.mp4`), 'init');
    for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(dir, `seg_${runId}_${String(i).padStart(5, '0')}.m4s`), 'seg');
    }
};
const mediaSeq = (pl) => parseInt(pl.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1], 10);
const segsIn = (pl) => pl.split('\n').filter(l => l.endsWith('.m4s'));

let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

const ledger = new HlsLedger(dir, { window: 6, retain: 10 });

// ---- Run A: the stream is on air --------------------------------------------
ledger.registerRun({ runId: 'A', playlistFile: 'run_A.m3u8', initFile: 'init_A.mp4' });
ledger.stop(); // drive poll() by hand, no timers in a test
touchSegments('A', 5); write('A', 5);
ledger.poll();
const p1 = ledger.buildMediaPlaylist();

check('first run publishes its segments', () => {
    assert.equal(segsIn(p1).length, 5);
    assert.equal(mediaSeq(p1), 0);
    assert.match(p1, /#EXT-X-MAP:URI="init_A\.mp4"/);
});
check('first run carries no discontinuity', () => {
    assert.ok(!p1.includes('#EXT-X-DISCONTINUITY\n'));
    assert.match(p1, /#EXT-X-DISCONTINUITY-SEQUENCE:0/);
});

// ---- Restart: run B starts beside A, then A is retired (make-before-break) ---
ledger.registerRun({ runId: 'B', playlistFile: 'run_B.m3u8', initFile: 'init_B.mp4' });
touchSegments('B', 3); write('B', 3);
ledger.retireRun('A');
ledger.poll();
const p2 = ledger.buildMediaPlaylist();

check('media sequence never goes backwards across a restart', () => {
    assert.ok(mediaSeq(p2) >= mediaSeq(p1), `${mediaSeq(p2)} < ${mediaSeq(p1)}`);
});
check('restart is signalled as an HLS period change', () => {
    assert.ok(p2.includes('#EXT-X-DISCONTINUITY\n'), 'no #EXT-X-DISCONTINUITY at the run boundary');
});
check('new run brings its own init segment', () => {
    assert.match(p2, /#EXT-X-MAP:URI="init_B\.mp4"/);
    assert.match(p2, /#EXT-X-MAP:URI="init_A\.mp4"/); // old run still in the window
});
check('no segment filename is ever reused between runs', () => {
    const all = segsIn(p2);
    assert.equal(new Set(all).size, all.length);
});
check('the old run stops contributing once retired', () => {
    write('A', 9); // ffmpeg A kept writing after cutover
    ledger.poll();
    assert.ok(!segsIn(ledger.buildMediaPlaylist()).includes('seg_A_00008.m4s'));
});

// ---- Continuity over many restarts ------------------------------------------
check('sequence stays strictly monotonic over 20 restarts', () => {
    let last = mediaSeq(ledger.buildMediaPlaylist());
    for (let r = 0; r < 20; r++) {
        const id = `R${r}`;
        ledger.registerRun({ runId: id, playlistFile: `run_${id}.m3u8`, initFile: `init_${id}.mp4` });
        touchSegments(id, 4); write(id, 4);
        ledger.poll();
        ledger.retireRun(id);
        const seq = mediaSeq(ledger.buildMediaPlaylist());
        assert.ok(seq >= last, `restart ${r}: media sequence went ${last} -> ${seq}`);
        last = seq;
    }
});

check('window stays bounded and retention keeps extra files on disk', () => {
    const pl = ledger.buildMediaPlaylist();
    assert.equal(segsIn(pl).length, 6, 'advertised window should equal the configured size');
    assert.ok(ledger.segments.length <= ledger.retain);
    // Retention must exceed the window, or a slow client 404s on a segment the
    // playlist is still advertising. That 404 is what used to become a fatal
    // fragLoadError under ffmpeg's delete_segments.
    assert.ok(ledger.retain > ledger.window);
    for (const name of segsIn(pl)) {
        assert.ok(fs.existsSync(path.join(dir, name)), `${name} advertised but deleted from disk`);
    }
});

check('every advertised segment has a live init segment on disk', () => {
    const pl = ledger.buildMediaPlaylist();
    for (const m of pl.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)) {
        assert.ok(fs.existsSync(path.join(dir, m[1])), `${m[1]} advertised but pruned`);
    }
});

check('discontinuity-sequence tracks periods that scrolled out of the window', () => {
    const pl = ledger.buildMediaPlaylist();
    const ds = parseInt(pl.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/)[1], 10);
    assert.ok(ds > 0, 'expected scrolled-off discontinuities to be counted');
    assert.ok(ds <= ledger.discCounter);
});

// ---- Staged runs: the make-before-break contract ----------------------------
// During a restart two ffmpeg processes are alive at once. If both fed the
// playlist their segments would interleave into garbage, so the replacement
// must stay silent until it is promoted.
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-staged-'));
const w2 = (runId, count) => {
    const lines = ['#EXTM3U', `#EXT-X-MAP:URI="init_${runId}.mp4"`];
    for (let i = 0; i < count; i++) lines.push('#EXTINF:4.000000,', `seg_${runId}_${String(i).padStart(5, '0')}.m4s`);
    fs.writeFileSync(path.join(dir2, `run_${runId}.m3u8`), lines.join('\n'));
    fs.writeFileSync(path.join(dir2, `init_${runId}.mp4`), 'init');
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir2, `seg_${runId}_${String(i).padStart(5, '0')}.m4s`), 'seg');
};

const l2 = new HlsLedger(dir2, { window: 8, retain: 20 });
l2.stop();
l2.registerRun({ runId: 'OLD', playlistFile: 'run_OLD.m3u8', initFile: 'init_OLD.mp4' });
w2('OLD', 4); l2.poll();

check('a staged run contributes nothing to the playlist', () => {
    l2.registerRun({ runId: 'NEW', playlistFile: 'run_NEW.m3u8', initFile: 'init_NEW.mp4', staged: true });
    w2('NEW', 3);
    l2.poll();
    const pl = l2.buildMediaPlaylist();
    assert.ok(!segsIn(pl).some(s => s.includes('_NEW_')), 'staged run leaked into the playlist');
    assert.equal(segsIn(pl).length, 4);
});

check('promotion drops the replacement backlog the old run already covered', () => {
    l2.retireRun('OLD');
    l2.promoteRun('NEW');
    l2.poll();
    const newSegs = segsIn(l2.buildMediaPlaylist()).filter(s => s.includes('_NEW_'));
    // Only the newest pre-promotion segment survives; replaying seg 0 and 1
    // would show the viewer wall-clock time the outgoing run already delivered.
    assert.deepEqual(newSegs, ['seg_NEW_00002.m4s']);
});

check('promoted run is what continues the stream', () => {
    w2('NEW', 6);
    l2.poll();
    const segs = segsIn(l2.buildMediaPlaylist());
    assert.ok(segs.includes('seg_NEW_00005.m4s'));
    assert.ok(!segs.includes('seg_OLD_00009.m4s'));
});

check('a restart attempt that never went on air leaves nothing on disk', () => {
    l2.registerRun({ runId: 'DEAD', playlistFile: 'run_DEAD.m3u8', initFile: 'init_DEAD.mp4', staged: true });
    w2('DEAD', 2);
    l2.discardRun('DEAD');
    const leftovers = fs.readdirSync(dir2).filter(f => f.includes('DEAD'));
    assert.deepEqual(leftovers, [], `leftover files: ${leftovers.join(', ')}`);
});

check('discarding never touches a run that already published', () => {
    l2.discardRun('NEW');
    assert.ok(fs.existsSync(path.join(dir2, 'init_NEW.mp4')), 'deleted an init the playlist still advertises');
});

fs.rmSync(dir2, { recursive: true, force: true });
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed` : '\nAll ledger tests passed');
process.exit(failures ? 1 : 0);
