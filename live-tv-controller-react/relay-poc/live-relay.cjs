'use strict';
/**
 * PoC — server-side YouTube relay, validation build.
 *
 * Standalone prototype. Does NOT touch server.cjs, LivePlayer.html,
 * LoopPlayer.html, DelayLive.html, or the React controller in any way.
 * Run directly: node relay-poc/live-relay.cjs
 *
 * Takes a single input — a YouTube videoId — and auto-detects whether it's
 * LIVE, UPCOMING_LIVE, FINISHED_LIVE, or a normal VOD, then routes to the
 * matching pipeline:
 *
 *   LIVE / (resumed) FINISHED_LIVE-as-VOD:
 *     yt-dlp -> HLS master manifest -> pick best quality variant -> rewrite
 *     the media playlist's segment URIs to /relay/segment?u=... on every
 *     request, so the browser's hls.js only ever talks to this server.
 *
 *   VOD (and FINISHED_LIVE, which YouTube treats as a regular video once
 *   the broadcast ends):
 *     yt-dlp -> format list -> YouTube only offers audio+video combined
 *     ("progressive") in a single URL up to ~360p; everything above that is
 *     video-only DASH that needs muxing with a separate audio track (via
 *     ffmpeg, not available on this machine — see Known Limitations in the
 *     final report). This pipeline proxies the best progressive format
 *     directly to a native <video> tag with HTTP Range support.
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '4001', 10);
const QUALITY_PRIORITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const MASTER_MAX_AGE_MS = 20 * 60 * 1000; // refresh live manifest well before its ~hours expiry
const WATCHDOG_INTERVAL_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// yt-dlp binary resolution (standalone — does not import from server.cjs)
// ---------------------------------------------------------------------------
function findYtDlp() {
    const check = (p) => { try { return fs.existsSync(p) ? p : null; } catch { return null; } };
    const repoRoot = path.resolve(__dirname, '..', '..'); // .../Live-Tv
    const candidate = check(path.join(repoRoot, 'windows', 'exe', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'));
    if (candidate) return candidate;
    return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

// ---------------------------------------------------------------------------
// State — one "currently loaded video" at a time (PoC scope: single viewer)
// ---------------------------------------------------------------------------
const relayStartedAt = Date.now();
const state = {
    videoId: null,
    type: null,              // LIVE | UPCOMING_LIVE | FINISHED_LIVE | VOD
    title: null,
    availableQualities: [],  // [{height, width, bandwidth, kind: 'combined'|'video-only'|'live-variant'}]
    highestAvailableHeight: null,

    // LIVE pipeline state
    masterManifestUrl: null,
    masterFetchedAt: null,
    selectedVariant: null,   // { width, height, bandwidth, codecs, url }
    lastMediaFetchAt: null,

    // VOD pipeline state
    vodSelectedFormat: null, // { height, width, url, ext, hasAudio, hasVideo, note }

    // Shared telemetry
    startedAt: null,         // when current video's resolution began
    readyAt: null,           // when it became playable (startup time)
    reconnectCount: 0,
    watchdogRefreshCount: 0,
    lastError: null,
    log: [],

    // Fault injection (recovery testing)
    injectExpireOnce: false,
    injectNetworkFailCount: 0,
};

function logEvent(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log('[Relay]', msg);
    state.log.push(line);
    if (state.log.length > 300) state.log.shift();
}

function resetVideoState(videoId) {
    state.videoId = videoId;
    state.type = null;
    state.title = null;
    state.availableQualities = [];
    state.highestAvailableHeight = null;
    state.masterManifestUrl = null;
    state.masterFetchedAt = null;
    state.selectedVariant = null;
    state.lastMediaFetchAt = null;
    state.vodSelectedFormat = null;
    state.startedAt = Date.now();
    state.readyAt = null;
    state.reconnectCount = 0;
    state.watchdogRefreshCount = 0;
    state.lastError = null;
}

// ---------------------------------------------------------------------------
// yt-dlp: full metadata dump (used for both type detection and format lists)
// ---------------------------------------------------------------------------
function fetchVideoInfo(videoId) {
    return new Promise((resolve, reject) => {
        const ytDlp = findYtDlp();
        const args = ['--dump-json', '--no-warnings', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`];
        const proc = spawn(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            try { proc.kill(); } catch (_) {}
            reject(new Error('yt-dlp timed out'));
        }, 20000);
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
        proc.on('close', (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 300)}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (err) {
                reject(new Error(`Failed to parse yt-dlp JSON: ${err.message}`));
            }
        });
    });
}

// Maps yt-dlp's live_status field to our four categories.
function classify(info) {
    switch (info.live_status) {
        case 'is_live': return 'LIVE';
        case 'is_upcoming': return 'UPCOMING_LIVE';
        case 'was_live': return 'FINISHED_LIVE';
        case 'post_live': return 'FINISHED_LIVE';
        default: return 'VOD';
    }
}

// ---------------------------------------------------------------------------
// Plain HTTPS GET with redirect following + optional Range passthrough.
// This is the server-side fetch path confirmed to work against
// googlevideo.com (unlike a browser's cross-origin fetch, confirmed blocked
// earlier in this project's investigation).
// ---------------------------------------------------------------------------
function httpsGet(url, { binary = false, maxRedirects = 5, range = null } = {}) {
    return new Promise((resolve, reject) => {
        if (state.injectNetworkFailCount > 0) {
            state.injectNetworkFailCount--;
            logEvent(`[FAULT INJECTION] Simulating network failure (${state.injectNetworkFailCount} more queued)`);
            reject(new Error('Simulated network interruption (fault injection)'));
            return;
        }
        const go = (u, redirectsLeft) => {
            const headers = { 'User-Agent': 'Mozilla/5.0 (relay-poc)' };
            if (range) headers['Range'] = range;
            https.get(u, { headers }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    go(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode} for ${u.slice(0, 120)}`));
                    return;
                }
                if (binary === 'stream') {
                    resolve({ stream: res, statusCode: res.statusCode, headers: res.headers });
                    return;
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    resolve({ body: binary ? buf : buf.toString('utf8'), contentType: res.headers['content-type'] || '' });
                });
            }).on('error', reject);
        };
        go(url, maxRedirects);
    });
}

// ---------------------------------------------------------------------------
// HLS master-playlist parsing (LIVE pipeline)
// ---------------------------------------------------------------------------
function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
        const uriLine = lines[i + 1];
        if (!uriLine || uriLine.startsWith('#')) continue;
        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        const bwMatch = line.match(/BANDWIDTH=(\d+)/);
        const codecMatch = line.match(/CODECS="([^"]+)"/);
        variants.push({
            width: resMatch ? parseInt(resMatch[1], 10) : null,
            height: resMatch ? parseInt(resMatch[2], 10) : null,
            bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
            codecs: codecMatch ? codecMatch[1] : null,
            url: new URL(uriLine.trim(), baseUrl).toString(),
        });
    }
    return variants;
}

function pickBestByHeight(items) {
    if (!items.length) return null;
    for (const h of QUALITY_PRIORITY_HEIGHTS) {
        const match = items.find(v => v.height === h);
        if (match) return match;
    }
    return items.slice().sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}

// ---------------------------------------------------------------------------
// LIVE pipeline
// ---------------------------------------------------------------------------
async function refreshMaster(reason) {
    logEvent(`Refreshing master manifest (${reason})...`);
    const info = await fetchVideoInfo(state.videoId);
    const manifestUrl = info.manifest_url
        || (Array.isArray(info.formats) ? info.formats.find(f => f.manifest_url)?.manifest_url : null);
    if (!manifestUrl) throw new Error('yt-dlp returned no manifest_url (stream may have ended)');

    const { body } = await httpsGet(manifestUrl);
    const variants = parseMasterPlaylist(body, manifestUrl);
    const best = pickBestByHeight(variants);
    if (!best) throw new Error('No variants found in master playlist');

    state.masterManifestUrl = manifestUrl;
    state.masterFetchedAt = Date.now();
    state.availableQualities = variants.map(v => ({ height: v.height, width: v.width, bandwidth: v.bandwidth, kind: 'live-variant' }));
    state.highestAvailableHeight = Math.max(...variants.map(v => v.height || 0));
    state.selectedVariant = best;
    if (!state.readyAt) state.readyAt = Date.now();
    logEvent(`Selected live variant ${best.width}x${best.height} @ ${Math.round(best.bandwidth / 1000)}kbps (of ${variants.length} available)`);
}

function masterIsStale() {
    return !state.masterManifestUrl || (Date.now() - state.masterFetchedAt) > MASTER_MAX_AGE_MS || state.injectExpireOnce;
}

// YouTube's live playlists embed proprietary ad-break signaling
// (#EXT-X-DATERANGE:CLASS="CUEPOINT-AD" / #EXT-X-CUEPOINT) that isn't the
// standard SCTE-35 interstitial format. hls.js 1.6.x's interstitial/
// date-range handling was confirmed (via live testing) to silently stall
// forever on it — currentLevel never leaves -1, no fragment ever requested,
// no error event. This PoC has no use for YouTube's ad scheduling, so
// they're dropped entirely.
const STRIPPED_TAG_PREFIXES = ['#EXT-X-DATERANGE', '#EXT-X-CUEPOINT'];

function rewriteMediaPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
        if (STRIPPED_TAG_PREFIXES.some(p => line.startsWith(p))) continue;
        if (!line || line.startsWith('#')) { out.push(line); continue; }
        const resolved = new URL(line.trim(), baseUrl).toString();
        out.push(`/relay/segment?u=${encodeURIComponent(resolved)}`);
    }
    return out.join('\n');
}

async function getLiveMediaPlaylist() {
    if (state.injectExpireOnce) {
        state.injectExpireOnce = false;
        logEvent('[FAULT INJECTION] Simulating expired manifest URL — forcing recovery path');
        state.reconnectCount++;
        await refreshMaster('recovery: simulated expiry');
    } else if (masterIsStale()) {
        await refreshMaster('on-demand: master stale at request time');
    }
    if (!state.selectedVariant) throw new Error('No variant selected yet');

    try {
        const { body } = await httpsGet(state.selectedVariant.url);
        state.lastMediaFetchAt = Date.now();
        return rewriteMediaPlaylist(body, state.selectedVariant.url);
    } catch (err) {
        state.reconnectCount++;
        logEvent(`Media playlist fetch failed (reconnect #${state.reconnectCount}): ${err.message} — forcing full refresh`);
        await refreshMaster('recovery: media fetch failed');
        const { body } = await httpsGet(state.selectedVariant.url);
        state.lastMediaFetchAt = Date.now();
        return rewriteMediaPlaylist(body, state.selectedVariant.url);
    }
}

function buildMasterPlaylist(variant) {
    const codecAttr = variant.codecs ? `,CODECS="${variant.codecs}"` : '';
    return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}${codecAttr}`,
        '/relay/media.m3u8',
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// VOD pipeline
// ---------------------------------------------------------------------------
async function resolveVod(info) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const withHeight = formats.filter(f => f.height);

    state.availableQualities = withHeight.map(f => ({
        height: f.height,
        width: f.width || null,
        bandwidth: f.tbr ? Math.round(f.tbr * 1000) : (f.vbr ? Math.round(f.vbr * 1000) : 0),
        kind: (f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none') ? 'combined' : 'video-only',
    })).sort((a, b) => b.height - a.height);
    state.highestAvailableHeight = state.availableQualities.length
        ? Math.max(...state.availableQualities.map(q => q.height))
        : null;

    // Only a "combined" (progressive: both audio+video in one URL) format
    // can be proxied and played directly without server-side muxing.
    // YouTube has restricted these to <=360p on modern uploads — everything
    // above that is video-only DASH requiring a separate audio track muxed
    // in (ffmpeg), which isn't available in this environment. This is a
    // real, honest ceiling — not a bug — documented in the final report.
    const combined = withHeight.filter(f => f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none');
    const best = pickBestByHeight(combined.map(f => ({ height: f.height, width: f.width, url: f.url, ext: f.ext, formatId: f.format_id })));
    if (!best) throw new Error('No playable (audio+video combined) progressive format found for this VOD');

    state.vodSelectedFormat = {
        height: best.height,
        width: best.width,
        url: best.url,
        ext: best.ext,
        formatId: best.formatId,
        note: best.height < state.highestAvailableHeight
            ? `Highest available (${state.highestAvailableHeight}p) is video-only DASH and needs audio muxing (ffmpeg, not installed) — serving the best progressive format instead.`
            : null,
    };
    state.readyAt = Date.now();
    logEvent(`Selected VOD format ${best.width}x${best.height} (${best.ext}, format ${best.formatId}) — combined audio+video, no muxing needed`);
}

// ---------------------------------------------------------------------------
// Unified resolve — the single entry point the task asked for: {videoId} in,
// auto-detected pipeline out.
// ---------------------------------------------------------------------------
async function loadVideo(videoId) {
    resetVideoState(videoId);
    logEvent(`Resolving video ${videoId}...`);
    const info = await fetchVideoInfo(videoId);
    state.title = info.title || null;
    state.type = classify(info);
    logEvent(`Detected type: ${state.type} — "${state.title}"`);

    if (state.type === 'LIVE') {
        await refreshMaster('initial load');
    } else if (state.type === 'UPCOMING_LIVE') {
        // Nothing to play yet — report the state honestly, no pipeline to run.
        logEvent('Video is an upcoming live stream — not broadcasting yet, nothing to relay.');
    } else {
        // FINISHED_LIVE and VOD both resolve to a normal file once yt-dlp
        // reports them non-live; same pipeline for both.
        await resolveVod(info);
    }
    return buildReport();
}

// ---------------------------------------------------------------------------
// Background watchdog — proactive refresh + reconnect-if-stream-restarted
// (LIVE videos only; VOD format URLs are also signed/time-limited but at a
// similar multi-hour scale and are re-resolved on-demand via /relay/vod).
// ---------------------------------------------------------------------------
function startWatchdog() {
    setInterval(async () => {
        if (state.type !== 'LIVE') return;
        try {
            if (masterIsStale()) {
                await refreshMaster('watchdog: master aged out');
                state.watchdogRefreshCount++;
            }
        } catch (err) {
            state.lastError = err.message;
            state.reconnectCount++;
            logEvent(`Watchdog refresh failed (reconnect #${state.reconnectCount}): ${err.message}`);
        }
    }, WATCHDOG_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Quality report — matches the format requested for validation output
// ---------------------------------------------------------------------------
function buildReport() {
    const qualityLadder = [2160, 1440, 1080, 720, 480, 360];
    const availableHeights = new Set(state.availableQualities.map(q => q.height));
    const selected = state.type === 'LIVE' ? state.selectedVariant : state.vodSelectedFormat;

    return {
        videoId: state.videoId,
        title: state.title,
        type: state.type,
        availableQualities: qualityLadder.map(h => ({ height: h, available: availableHeights.has(h) })),
        highestAvailableHeight: state.highestAvailableHeight,
        selectedHeight: selected ? selected.height : null,
        selectedResolution: selected ? `${selected.width}x${selected.height}` : null,
        selectedBitrate: selected ? (selected.bandwidth || null) : null,
        codec: state.type === 'LIVE' ? (state.selectedVariant && state.selectedVariant.codecs) : (state.vodSelectedFormat && state.vodSelectedFormat.ext),
        manifestUrl: state.type === 'LIVE' ? state.masterManifestUrl : (state.vodSelectedFormat && state.vodSelectedFormat.url),
        startupTimeMs: state.readyAt ? state.readyAt - state.startedAt : null,
        reconnectCount: state.reconnectCount,
        watchdogRefreshCount: state.watchdogRefreshCount,
        vodNote: state.vodSelectedFormat ? state.vodSelectedFormat.note : null,
        qualityValidation: state.highestAvailableHeight && selected
            ? {
                highestAvailable: `${state.highestAvailableHeight}p`,
                actualPlaying: `${selected.height}p`,
                result: selected.height >= state.highestAvailableHeight ? 'PASS' : 'FAIL',
                reason: selected.height >= state.highestAvailableHeight
                    ? null
                    : (state.type === 'VOD' || state.type === 'FINISHED_LIVE'
                        ? 'Highest quality is video-only DASH; only a combined audio+video progressive format can be relayed without server-side muxing (ffmpeg not installed in this environment).'
                        : 'Live variant selection did not reach the highest advertised tier — see reconnectCount/log for cause.'),
            }
            : null,
    };
}

function printReport(report) {
    const lines = [];
    lines.push('=' .repeat(50));
    lines.push(`Video ID: ${report.videoId}`);
    lines.push(`Title: ${report.title || '(unknown)'}`);
    lines.push(`Type: ${report.type}`);
    lines.push('');
    lines.push('Available Qualities:');
    for (const q of report.availableQualities) {
        lines.push(`  ${q.height}p ${q.available ? '' : '(not available)'}`);
    }
    lines.push('');
    lines.push(`Selected Quality: ${report.selectedHeight ? report.selectedHeight + 'p' : 'N/A'}`);
    lines.push(`Current Resolution: ${report.selectedResolution || 'N/A'}`);
    lines.push(`Current Bitrate: ${report.selectedBitrate ? Math.round(report.selectedBitrate / 1000) + ' kbps' : 'N/A'}`);
    lines.push(`Codec: ${report.codec || 'N/A'}`);
    lines.push(`Manifest URL: ${report.manifestUrl ? report.manifestUrl.slice(0, 90) + '...' : 'N/A'}`);
    lines.push(`Startup Time: ${report.startupTimeMs != null ? report.startupTimeMs + ' ms' : 'N/A'}`);
    lines.push(`Reconnect Count: ${report.reconnectCount}`);
    if (report.vodNote) lines.push(`Note: ${report.vodNote}`);
    if (report.qualityValidation) {
        lines.push('');
        lines.push(`Highest Available: ${report.qualityValidation.highestAvailable}`);
        lines.push(`Actual Playing: ${report.qualityValidation.actualPlaying}`);
        lines.push(report.qualityValidation.result);
        if (report.qualityValidation.reason) lines.push(`Reason: ${report.qualityValidation.reason}`);
    }
    lines.push('='.repeat(50));
    console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Single input point: { "videoId": "..." }
app.post('/relay/load', async (req, res) => {
    const videoId = (req.body && req.body.videoId || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!videoId) return res.status(400).json({ error: 'videoId is required' });
    try {
        const report = await loadVideo(videoId);
        printReport(report);
        res.json({ success: true, report });
    } catch (err) {
        state.lastError = err.message;
        logEvent(`Load failed for ${videoId}: ${err.message}`);
        res.status(502).json({ success: false, error: err.message, type: state.type });
    }
});

app.get('/relay/report', (req, res) => {
    if (!state.videoId) return res.status(404).json({ error: 'No video loaded yet — POST /relay/load first' });
    res.json(buildReport());
});

// ---- LIVE pipeline endpoints ----
app.get('/relay/live.m3u8', async (req, res) => {
    if (state.type !== 'LIVE') return res.status(409).json({ error: `Current video is type ${state.type}, not LIVE — use /relay/vod instead` });
    if (masterIsStale()) {
        try { await refreshMaster('on-demand: master stale at request time'); }
        catch (err) { state.lastError = err.message; return res.status(502).json({ error: err.message }); }
    }
    if (!state.selectedVariant) return res.status(503).json({ error: 'No variant selected yet' });
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buildMasterPlaylist(state.selectedVariant));
});

app.get('/relay/media.m3u8', async (req, res) => {
    try {
        const playlist = await getLiveMediaPlaylist();
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(playlist);
    } catch (err) {
        state.lastError = err.message;
        res.status(502).json({ error: err.message });
    }
});

app.get('/relay/segment', async (req, res) => {
    const target = req.query.u;
    if (!target) return res.status(400).send('missing u');
    try {
        const { body, contentType } = await httpsGet(target, { binary: true });
        res.setHeader('Content-Type', contentType || 'video/mp2t');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(body);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// ---- VOD pipeline endpoint (native <video> with Range support) ----
app.get('/relay/vod', async (req, res) => {
    if (state.type !== 'LIVE' && !state.vodSelectedFormat) {
        return res.status(409).json({ error: 'No VOD format resolved — POST /relay/load first' });
    }
    if (!state.vodSelectedFormat) return res.status(409).json({ error: `Current video is type ${state.type}, not VOD — use /relay/live.m3u8 instead` });
    try {
        const { stream, statusCode, headers } = await httpsGet(state.vodSelectedFormat.url, { binary: 'stream', range: req.headers.range || null });
        res.status(statusCode);
        if (headers['content-type']) res.setHeader('Content-Type', headers['content-type']);
        if (headers['content-length']) res.setHeader('Content-Length', headers['content-length']);
        if (headers['content-range']) res.setHeader('Content-Range', headers['content-range']);
        res.setHeader('Accept-Ranges', 'bytes');
        stream.pipe(res);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// ---- Recovery / fault-injection endpoints (validation only) ----
app.post('/relay/simulate/expire', (req, res) => {
    if (state.type !== 'LIVE') return res.status(409).json({ error: 'Expiry simulation only applies to LIVE videos' });
    state.injectExpireOnce = true;
    logEvent('[FAULT INJECTION] Armed: next media playlist fetch will simulate an expired manifest URL');
    res.json({ armed: true });
});

app.post('/relay/simulate/network-fail', (req, res) => {
    const count = Math.max(1, parseInt(req.body?.count, 10) || 3);
    state.injectNetworkFailCount = count;
    logEvent(`[FAULT INJECTION] Armed: next ${count} upstream fetch(es) will simulate a network failure`);
    res.json({ armed: true, count });
});

app.post('/relay/simulate/restart', async (req, res) => {
    if (!state.videoId) return res.status(409).json({ error: 'No video loaded yet' });
    const videoId = state.videoId;
    logEvent(`[FAULT INJECTION] Simulating video restart — reloading ${videoId} from a clean state`);
    try {
        const report = await loadVideo(videoId);
        printReport(report);
        res.json({ success: true, report });
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// ---- Status / debug panel feed ----
app.get('/relay/status', (req, res) => {
    const now = Date.now();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const selected = state.type === 'LIVE' ? state.selectedVariant : state.vodSelectedFormat;
    res.json({
        videoId: state.videoId,
        title: state.title,
        type: state.type,
        selected: selected ? { width: selected.width, height: selected.height, bandwidth: selected.bandwidth || null, codecs: selected.codecs || selected.ext || null } : null,
        availableQualities: state.availableQualities,
        highestAvailableHeight: state.highestAvailableHeight,
        reconnectCount: state.reconnectCount,
        watchdogRefreshCount: state.watchdogRefreshCount,
        masterAgeMs: state.masterFetchedAt ? now - state.masterFetchedAt : null,
        mediaAgeMs: state.lastMediaFetchAt ? now - state.lastMediaFetchAt : null,
        startupTimeMs: state.readyAt ? state.readyAt - state.startedAt : null,
        relayUptimeMs: now - relayStartedAt,
        memory: { rssMB: +(mem.rss / 1e6).toFixed(1), heapUsedMB: +(mem.heapUsed / 1e6).toFixed(1) },
        cpuUserMs: +(cpu.user / 1000).toFixed(1),
        cpuSystemMs: +(cpu.system / 1000).toFixed(1),
        lastError: state.lastError,
        recentLog: state.log.slice(-40),
        pid: process.pid,
    });
});

app.use(express.static(__dirname));

// Bind to localhost only — this is an unauthenticated proxy; Express's
// default of binding all interfaces (0.0.0.0) would expose it to the whole
// LAN. Confirmed via netstat during validation testing that the previous
// default binding was reachable network-wide, and an unexplained /relay/load
// request for an out-of-scope video appeared in the server log during
// testing with no corresponding action in the test browser — root cause not
// conclusively identified, but LAN-wide reachability of an unauthenticated
// control endpoint is a real gap either way. Flagged as a blocker in the
// final report regardless of that specific incident's cause.
app.listen(RELAY_PORT, '127.0.0.1', () => {
    logEvent(`Relay validation server listening on http://localhost:${RELAY_PORT}`);
    logEvent(`Test page: http://localhost:${RELAY_PORT}/RelayTest.html`);
    logEvent(`Load a video: POST http://localhost:${RELAY_PORT}/relay/load  {"videoId":"..."}`);
    const initialVideoId = (process.env.RELAY_VIDEO_ID || '').trim();
    if (initialVideoId) {
        loadVideo(initialVideoId).then(printReport).catch((err) => {
            state.lastError = err.message;
            logEvent(`Initial load failed: ${err.message}`);
        });
    }
    startWatchdog();
});
