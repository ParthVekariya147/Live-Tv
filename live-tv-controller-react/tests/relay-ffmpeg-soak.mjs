// Acceptance test for the ffmpeg split-mux relay path — the one that used to
// freeze after ~20 minutes. Behaves like hls.js does: resolve the master, poll
// the media playlist on its target-duration cadence, and fetch every new
// segment and every new init segment as they appear.
//
// It asserts the three properties a restart must preserve:
//   1. #EXT-X-MEDIA-SEQUENCE never goes backwards (a rewind is what fataled
//      hls.js on every old restart).
//   2. Every segment and #EXT-X-MAP the playlist advertises is actually
//      fetchable (retention must outlive the advertised window).
//   3. New segments never stop arriving for longer than the stall threshold.
//
// A restart shows up as an #EXT-X-DISCONTINUITY with a new #EXT-X-MAP and is
// reported, not failed — surviving them is the point.
//
// Usage: node tests/relay-ffmpeg-soak.mjs <videoId> [port] [minutes]
// Run it for longer than the relay's refresh interval (see /status
// ffmpeg.refreshDueInMs) to observe a real restart end to end.

const VIDEO_ID = process.argv[2];
const PORT = process.argv[3] || '3004';
const MINUTES = parseFloat(process.argv[4] || '25');
const B = `http://localhost:${PORT}/api/relay`;

if (!VIDEO_ID) {
    console.error('Usage: node tests/relay-ffmpeg-soak.mjs <videoId> [port] [minutes]');
    process.exit(2);
}

const STALL_LIMIT_MS = 30000;
const j = (r) => r.json();
const sleep = (ms) => new Promise(s => setTimeout(s, ms));

let lastMediaSeq = -1;
let lastNewSegAt = Date.now();
let segsOk = 0, segsFailed = 0, polls = 0, discontinuities = 0, longestGapMs = 0;
const seenSegs = new Set();
const seenInits = new Set();
const problems = [];

const fail = (msg) => { problems.push(msg); console.error(`  ✗ ${msg}`); };

console.log(`Loading ${VIDEO_ID} into the relay at ${B} ...`);
const load = await fetch(`${B}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: VIDEO_ID }),
}).then(j);

if (!load.success) { console.error('Load failed:', load.error); process.exit(1); }
const report = load.report;
console.log(`  type=${report.type} mode=${report.mode} resolution=${report.selectedResolution} startup=${report.startupTimeMs}ms`);
if (report.mode !== 'ffmpeg-split') {
    console.error(`\nRelay chose "${report.mode}", not ffmpeg-split — this test only covers the ffmpeg path.`);
    console.error('That is a valid fallback (no split formats, or ffmpeg missing), not a failure.');
    process.exit(0);
}

// The master playlist points at the synthesised media playlist.
const master = await fetch(`${B}/live.m3u8`).then(r => r.text());
const mediaPath = master.split('\n').find(l => l.trim() && !l.startsWith('#')).trim();
console.log(`  media playlist: ${mediaPath}\n`);
console.log(`Soaking for ${MINUTES} minute(s). A restart appears as "RESTART SURVIVED".\n`);

const deadline = Date.now() + MINUTES * 60000;
while (Date.now() < deadline) {
    let text;
    try {
        const r = await fetch(`http://localhost:${PORT}${mediaPath}`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) { fail(`playlist HTTP ${r.status}`); await sleep(2000); continue; }
        text = await r.text();
        polls++;
    } catch (e) { fail(`playlist ${e.message}`); await sleep(2000); continue; }

    const seq = parseInt((text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1], 10);
    if (Number.isFinite(seq)) {
        if (seq < lastMediaSeq) fail(`MEDIA-SEQUENCE went backwards: ${lastMediaSeq} -> ${seq}`);
        lastMediaSeq = Math.max(lastMediaSeq, seq);
    }

    // Every init segment the playlist references must be fetchable.
    for (const m of text.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)) {
        if (seenInits.has(m[1])) continue;
        seenInits.add(m[1]);
        if (seenInits.size > 1) {
            discontinuities++;
            console.log(`  ↻ RESTART SURVIVED #${discontinuities} — new init ${m[1]} at seq ${seq}`);
        }
        const r = await fetch(`http://localhost:${PORT}/api/relay/hls/${m[1]}`);
        if (!r.ok) fail(`init ${m[1]} advertised but HTTP ${r.status}`);
        else await r.arrayBuffer();
    }

    const segs = text.split('\n').map(l => l.trim()).filter(l => l.endsWith('.m4s'));
    const fresh = segs.filter(s => !seenSegs.has(s));
    if (fresh.length) lastNewSegAt = Date.now();

    for (const name of fresh) {
        seenSegs.add(name);
        try {
            const r = await fetch(`http://localhost:${PORT}/api/relay/hls/${name}`, { signal: AbortSignal.timeout(20000) });
            if (!r.ok) { segsFailed++; fail(`segment ${name} advertised but HTTP ${r.status}`); continue; }
            const buf = await r.arrayBuffer();
            if (!buf.byteLength) { segsFailed++; fail(`segment ${name} is empty`); continue; }
            segsOk++;
        } catch (e) { segsFailed++; fail(`segment ${name}: ${e.message}`); }
    }

    const gap = Date.now() - lastNewSegAt;
    if (gap > longestGapMs) longestGapMs = gap;
    if (gap > STALL_LIMIT_MS) {
        const st = await fetch(`${B}/status`).then(j).catch(() => null);
        fail(`no new segment for ${Math.round(gap / 1000)}s (restarting=${st?.ffmpeg?.restarting}, lastError=${st?.lastError})`);
        lastNewSegAt = Date.now(); // report once per stall, not once per poll
    }

    await sleep(2000);
}

const status = await fetch(`${B}/status`).then(j).catch(() => ({}));
console.log('\n──────── result ────────');
console.log(`  playlist polls        ${polls}`);
console.log(`  segments fetched OK   ${segsOk}`);
console.log(`  segments failed       ${segsFailed}`);
console.log(`  restarts survived     ${discontinuities}`);
console.log(`  longest no-new-segment gap ${Math.round(longestGapMs / 1000)}s`);
console.log(`  server restartCount   ${status?.ffmpeg?.restartCount ?? 'n/a'} (last: ${status?.ffmpeg?.lastRestartReason ?? 'none'})`);
console.log(`  server segmentsFlowing ${status?.segmentsFlowing}`);
console.log(problems.length ? `\n${problems.length} problem(s) — see ✗ lines above` : '\nPASS — no rewinds, no missing segments, no stalls');
process.exit(problems.length ? 1 : 0);
