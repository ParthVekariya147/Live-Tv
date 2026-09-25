/**
 * End-to-end exercise of the REAL ffmpeg split-mux relay path — real ffmpeg
 * binary, real HTTP inputs, real FfmpegPipeline, real HlsLedger. No YouTube
 * needed: it generates its own video-only + audio-only sources and serves them
 * over HTTP so ffmpeg's http protocol options (-reconnect, -rw_timeout) are
 * genuinely in play.
 *
 * It forces the exact event the old code could not survive — replacing the
 * running ffmpeg mid-stream, including an unclean SIGKILL — and asserts that
 * the served playlist stays continuous, that every advertised segment and
 * #EXT-X-MAP is on disk throughout, and that a real decoder still accepts the
 * output after a restart.
 *
 * Run: node tests/relay-ffmpeg-e2e.mjs
 * First run spends ~30s generating the test media, then caches it.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { FfmpegPipeline } = require(path.join(APP, 'relay-ffmpeg-pipeline.cjs'));
const { HlsLedger } = require(path.join(APP, 'relay-hls-ledger.cjs'));

// Same two-tier resolution server.cjs uses in development.
function findFfmpeg() {
    const isWin = process.platform === 'win32';
    const name = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    const dev = path.resolve(APP, '..', 'windows', 'exe', name);
    if (fs.existsSync(dev)) return dev;
    try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return name; } catch { return null; }
}
const FFMPEG = findFfmpeg();
if (!FFMPEG) { console.error('ffmpeg not found — skipping (this test needs a real ffmpeg binary)'); process.exit(0); }
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, (m) => m.replace('ffmpeg', 'ffprobe'));

const WORK = path.join(os.tmpdir(), 'relay-ffmpeg-e2e');
const MEDIA = path.join(WORK, 'media');
const OUT = path.join(WORK, 'hls');
fs.mkdirSync(MEDIA, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const V = path.join(MEDIA, 'v.mp4');
const A = path.join(MEDIA, 'a.m4a');
if (!fs.existsSync(V) || !fs.existsSync(A)) {
    console.log('Generating test sources (one-off, ~30s)...');
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'testsrc2=size=640x360:rate=30', '-t', '300', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-an', V]);
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=44100', '-t', '300', '-c:a', 'aac', '-vn', A]);
}

const PORT = 3011 + (process.pid % 200);
const media = http.createServer((req, res) => {
    const f = req.url.startsWith('/a') ? A : V;
    const size = fs.statSync(f).size;
    const range = req.headers.range;
    if (range) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = parseInt(s, 10), end = e ? parseInt(e, 10) : size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        fs.createReadStream(f, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(f).pipe(res);
    }
});
await new Promise(r => media.listen(PORT, r));

const selection = {
    mode: 'split',
    video: { url: `http://127.0.0.1:${PORT}/v.mp4`, width: 640, height: 360, tbr: 1000, httpHeaders: {} },
    audio: { url: `http://127.0.0.1:${PORT}/a.m4a`, abr: 128, httpHeaders: {} },
};

const ledger = new HlsLedger(OUT, { window: 8, retain: 20 });
ledger.stop(); // polled by hand below so the test is deterministic
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const problems = [];
const fail = (m) => { problems.push(m); console.log(`  x ${m}`); };

function startRun(label) {
    return new Promise((resolve, reject) => {
        const p = new FfmpegPipeline(FFMPEG, OUT);
        let done = false;
        p.once('ready', () => { if (!done) { done = true; resolve(p); } });
        p.once('ready-timeout', () => { if (!done) { done = true; reject(new Error(label + ': ready-timeout')); } });
        p.on('close', (i) => {
            if (!done) { done = true; reject(new Error(`${label}: exited before ready — ${i.stderrTail.split('\n').slice(-2).join(' | ')}`)); }
        });
        ledger.registerRun({ runId: p.runId, playlistFile: p.playlistFile, initFile: p.initFile, staged: true });
        p.start(selection);
    });
}

let lastSeq = -1, polls = 0;
const seen = new Set();
function pollOnce(tag) {
    ledger.poll();
    const pl = ledger.buildMediaPlaylist();
    if (!pl) return;
    polls++;
    const seq = parseInt(pl.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1], 10);
    // THE property the whole fix exists to guarantee.
    if (seq < lastSeq) fail(`${tag}: MEDIA-SEQUENCE went backwards ${lastSeq} -> ${seq}`);
    lastSeq = Math.max(lastSeq, seq);
    for (const m of pl.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)) {
        if (!fs.existsSync(path.join(OUT, m[1]))) fail(`${tag}: init ${m[1]} advertised but missing on disk`);
    }
    for (const line of pl.split('\n')) {
        const n = line.trim();
        if (!n.endsWith('.m4s')) continue;
        if (!fs.existsSync(path.join(OUT, n))) fail(`${tag}: segment ${n} advertised but missing on disk`);
        else seen.add(n);
    }
}

console.log('\n1. cold start');
const a = await startRun('runA');
ledger.promoteRun(a.runId);
if (a.getCopyConfirmation() !== true) fail('ffmpeg is not running every stream in copy mode');
else console.log('   copy-only confirmed from ffmpeg stderr');
for (let i = 0; i < 12; i++) { pollOnce('cold'); await sleep(500); }
console.log(`   published ${ledger.segments.length} segments, media sequence ${lastSeq}`);

console.log('\n2. make-before-break restart (the ~20-minute killer)');
const t0 = Date.now();
const b = await startRun('runB');            // starts BESIDE runA
const readyMs = Date.now() - t0;
if (a.isRunning()) console.log('   replacement reached ready while the old run was STILL on air');
ledger.retireRun(a.runId); a.stop(); ledger.promoteRun(b.runId);
console.log(`   replacement ready in ${readyMs}ms, cut over`);
for (let i = 0; i < 12; i++) { pollOnce('restart'); await sleep(500); }

console.log('\n3. unclean crash of the on-air run (SIGKILL)');
const segsBeforeKill = ledger.segments.length;
b.kill();
await sleep(1500);
for (let i = 0; i < 6; i++) { pollOnce('crash'); await sleep(500); }
if (ledger.segments.length < segsBeforeKill - 2) fail('playlist collapsed after the crash instead of continuing to serve');
else console.log(`   playlist still serving ${ledger.segments.length} segments — a player keeps playing through the crash`);
const c = await startRun('runC');            // what requestFfmpegRestart() does
ledger.retireRun(b.runId); ledger.promoteRun(c.runId);
for (let i = 0; i < 12; i++) { pollOnce('recovered'); await sleep(500); }

const finalPl = ledger.buildMediaPlaylist();
const discSeq = parseInt(finalPl.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/)[1], 10);
if (discSeq !== 2) fail(`expected 2 signalled discontinuities after 2 restarts, playlist reports ${discSeq}`);
else console.log(`\n4. playlist reports DISCONTINUITY-SEQUENCE:${discSeq} — both restarts signalled as HLS period changes`);

console.log('\n5. decode check on post-restart output');
const win = finalPl.split('\n').map(l => l.trim()).filter(l => l.endsWith('.m4s'));
const lastMap = [...finalPl.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].pop()[1];
const probe = path.join(OUT, '_probe.mp4');
fs.writeFileSync(probe, Buffer.concat([fs.readFileSync(path.join(OUT, lastMap)), fs.readFileSync(path.join(OUT, win[win.length - 1]))]));
try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'csv=p=0', probe], { encoding: 'utf8' });
    console.log('   ffprobe:', out.trim().split('\n').join(' / '));
    if (!/h264/.test(out) || !/aac/.test(out)) fail('post-restart segment is missing video or audio');
} catch (e) { fail('ffprobe rejected the post-restart segment: ' + String(e.stderr || e.message).slice(0, 160)); }

c.stop();
await sleep(1000);
media.close();

console.log('\n──────── result ────────');
console.log(`  playlist polls            ${polls}`);
console.log(`  distinct segments served  ${seen.size}`);
console.log(`  restarts performed        2 (1 planned cutover, 1 after SIGKILL)`);
console.log(`  final media sequence      ${lastSeq}`);
console.log(problems.length
    ? `\n${problems.length} PROBLEM(S) — see the x lines above`
    : '\nPASS — no rewind, no missing segment or init, decodable after restart');
process.exit(problems.length ? 1 : 0);
