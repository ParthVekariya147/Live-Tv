// Simulates what hls.js does to the relay during real playback: poll the media
// playlist on its target-duration cadence and fetch every new segment as it appears.
// A "video stops" bug shows up here as segment failures or a starved playlist.
// Read-only against the relay. Usage: node tests/relay-soak.mjs [port] [seconds]
const PORT = process.argv[2] || '3004';
const SECONDS = parseInt(process.argv[3] || '90', 10);
const B = `http://localhost:${PORT}/api/relay`;

const seqOf = (line) => (line.match(/sq%2F(\d+)/) || [])[1];
let fetched = 0, failed = 0, polls = 0, stale = 0;
const seen = new Set();
const failures = [];
const started = Date.now();
let lastNewSeqAt = Date.now();

console.log(`  soaking ${B} for ${SECONDS}s (simulating a live player)\n`);
while ((Date.now() - started) / 1000 < SECONDS) {
    let text;
    try {
        const r = await fetch(`${B}/media.m3u8`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) { failed++; failures.push(`playlist HTTP ${r.status}`); await new Promise(s => setTimeout(s, 3000)); continue; }
        text = await r.text();
        polls++;
    } catch (e) { failed++; failures.push(`playlist ${e.message}`); await new Promise(s => setTimeout(s, 3000)); continue; }

    const segs = text.split('\n').filter(l => l.startsWith('/api/relay/segment'));
    const fresh = segs.filter(l => { const s = seqOf(l); return s && !seen.has(s); });
    if (fresh.length) lastNewSeqAt = Date.now();
    else stale++;

    for (const line of fresh) {
        const sq = seqOf(line);
        seen.add(sq);
        try {
            const res = await fetch(`http://localhost:${PORT}${line}`, { signal: AbortSignal.timeout(25000) });
            const buf = Buffer.from(await res.arrayBuffer());
            if (res.ok && buf.length > 0) {
                fetched++;
                const syncOk = buf[0] === 0x47; // MPEG-TS sync byte
                if (!syncOk) { failed++; failures.push(`seq ${sq}: 200 but not valid TS (first byte 0x${buf[0].toString(16)})`); }
            } else {
                failed++;
                failures.push(`seq ${sq}: HTTP ${res.status} ${buf.toString('utf8').slice(0, 120)}`);
            }
        } catch (e) { failed++; failures.push(`seq ${sq}: ${e.message}`); }
    }
    const gap = Math.round((Date.now() - lastNewSeqAt) / 1000);
    process.stdout.write(`\r  polls=${polls} segments=${fetched} failed=${failed} newest-gap=${gap}s   `);
    await new Promise(s => setTimeout(s, 4000));
}

console.log('\n');
console.log(`  playlist polls        : ${polls}`);
console.log(`  segments fetched OK   : ${fetched}`);
console.log(`  segment failures      : ${failed}`);
console.log(`  polls with no new seq : ${stale}`);
const longestGap = Math.round((Date.now() - lastNewSeqAt) / 1000);
console.log(`  gap since newest seq  : ${longestGap}s`);
if (failures.length) { console.log('\n  failures:'); failures.slice(0, 12).forEach(f => console.log('    ' + f)); }
const verdict = failed === 0 && fetched > 5 && longestGap < 30;
console.log(`\n  ${verdict ? 'PASS' : 'FAIL'}  relay ${verdict ? 'sustained playback cleanly' : 'would stall a player'}`);
process.exit(verdict ? 0 : 1);
