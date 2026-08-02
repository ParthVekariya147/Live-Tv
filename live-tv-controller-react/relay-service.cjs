'use strict';
/**
 * Live relay — server-side bypass of the YouTube IFrame API's quality
 * controls, which were confirmed deprecated into no-ops by YouTube around
 * 2018 (setPlaybackQuality/getAvailableQualityLevels/suggestedQuality all
 * silently do nothing — see relay-poc/live-relay.cjs for the original
 * validation build and write-up). This is the same logic, promoted from
 * standalone PoC into a router mounted on the main app at /api/relay.
 *
 * yt-dlp resolves the live stream's actual HLS master manifest; the highest
 * quality variant's media playlist is proxied through this server (segment
 * URIs rewritten to /api/relay/segment) so LivePlayer.html's hls.js instance
 * only ever talks to this server, never to googlevideo.com directly.
 *
 * Single "currently loaded video" state, matching the app's one-Live-Player
 * architecture (see PlayerManager.jsx — exactly one <LivePlayerCard/>).
 */
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');

const QUALITY_PRIORITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const MASTER_MAX_AGE_MS = 20 * 60 * 1000; // refresh live manifest well before its ~hours expiry
const WATCHDOG_INTERVAL_MS = 30 * 1000;

// YouTube's live playlists embed proprietary ad-break signaling
// (#EXT-X-DATERANGE:CLASS="CUEPOINT-AD" / #EXT-X-CUEPOINT) that isn't the
// standard SCTE-35 interstitial format. hls.js's interstitial/date-range
// handling was confirmed (via live testing in the PoC) to silently stall
// forever on it — currentLevel never leaves -1, no fragment ever requested,
// no error event. Not needed for this relay's purpose, so dropped entirely.
const STRIPPED_TAG_PREFIXES = ['#EXT-X-DATERANGE', '#EXT-X-CUEPOINT'];

function createRelayRouter({ findYtDlp }) {
    const relayStartedAt = Date.now();
    const state = {
        videoId: null,
        type: null,              // LIVE | UPCOMING_LIVE | FINISHED_LIVE | VOD
        title: null,
        availableQualities: [],
        highestAvailableHeight: null,

        masterManifestUrl: null,
        masterFetchedAt: null,
        selectedVariant: null,
        lastMediaFetchAt: null,

        vodSelectedFormat: null,

        startedAt: null,
        readyAt: null,
        reconnectCount: 0,
        watchdogRefreshCount: 0,
        lastError: null,
        log: [],
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

    function fetchVideoInfo(videoId) {
        return new Promise((resolve, reject) => {
            const ytDlp = findYtDlp();
            if (!ytDlp) { reject(new Error('yt-dlp not found')); return; }
            const args = ['--dump-json', '--no-warnings', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`];
            const proc = spawn(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            const timeout = setTimeout(() => {
                try { proc.kill(); } catch (_) { }
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

    function classify(info) {
        switch (info.live_status) {
            case 'is_live': return 'LIVE';
            case 'is_upcoming': return 'UPCOMING_LIVE';
            case 'was_live': return 'FINISHED_LIVE';
            case 'post_live': return 'FINISHED_LIVE';
            default: return 'VOD';
        }
    }

    // Server-side fetch against googlevideo.com — confirmed to work, unlike a
    // browser's cross-origin fetch (blocked by CORS during PoC validation).
    function httpsGet(url, { binary = false, maxRedirects = 5, range = null } = {}) {
        return new Promise((resolve, reject) => {
            const go = (u, redirectsLeft) => {
                const headers = { 'User-Agent': 'Mozilla/5.0 (live-tv-controller relay)' };
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
        return !state.masterManifestUrl || (Date.now() - state.masterFetchedAt) > MASTER_MAX_AGE_MS;
    }

    function rewriteMediaPlaylist(text, baseUrl) {
        const lines = text.split(/\r?\n/);
        const out = [];
        for (const line of lines) {
            if (STRIPPED_TAG_PREFIXES.some(p => line.startsWith(p))) continue;
            if (!line || line.startsWith('#')) { out.push(line); continue; }
            const resolved = new URL(line.trim(), baseUrl).toString();
            out.push(`/api/relay/segment?u=${encodeURIComponent(resolved)}`);
        }
        return out.join('\n');
    }

    async function getLiveMediaPlaylist() {
        if (masterIsStale()) {
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
            '/api/relay/media.m3u8',
            '',
        ].join('\n');
    }

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

        // Only a "combined" (progressive: audio+video in one URL) format can be
        // proxied and played directly without server-side muxing. YouTube caps
        // these at <=360p on modern uploads — everything above needs a separate
        // audio track muxed in via ffmpeg, which this relay doesn't run. Real
        // ceiling, not a bug — the relay is intended for LIVE playback; VOD
        // support here is best-effort only (LivePlayer.html falls back to the
        // normal YouTube IFrame player for anything that isn't LIVE).
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
                ? `Highest available (${state.highestAvailableHeight}p) is video-only DASH and needs audio muxing (ffmpeg) — serving the best progressive format instead.`
                : null,
        };
        state.readyAt = Date.now();
        logEvent(`Selected VOD format ${best.width}x${best.height} (${best.ext}, format ${best.formatId})`);
    }

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
            logEvent('Video is an upcoming live stream — not broadcasting yet, nothing to relay.');
        } else {
            await resolveVod(info);
        }
        return buildReport();
    }

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
            manifestUrl: state.type === 'LIVE' ? state.masterManifestUrl : (state.vodSelectedFormat && state.vodSelectedFormat.url),
            startupTimeMs: state.readyAt ? state.readyAt - state.startedAt : null,
            reconnectCount: state.reconnectCount,
            watchdogRefreshCount: state.watchdogRefreshCount,
            vodNote: state.vodSelectedFormat ? state.vodSelectedFormat.note : null,
        };
    }

    const router = express.Router();
    router.use(express.json());

    router.post('/load', async (req, res) => {
        const videoId = (req.body && req.body.videoId || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
        if (!videoId) return res.status(400).json({ error: 'videoId is required' });
        try {
            const report = await loadVideo(videoId);
            res.json({ success: true, report });
        } catch (err) {
            state.lastError = err.message;
            logEvent(`Load failed for ${videoId}: ${err.message}`);
            res.status(502).json({ success: false, error: err.message, type: state.type });
        }
    });

    router.get('/report', (req, res) => {
        if (!state.videoId) return res.status(404).json({ error: 'No video loaded yet — POST /api/relay/load first' });
        res.json(buildReport());
    });

    router.get('/live.m3u8', async (req, res) => {
        if (state.type !== 'LIVE') return res.status(409).json({ error: `Current video is type ${state.type}, not LIVE — use /api/relay/vod instead` });
        if (masterIsStale()) {
            try { await refreshMaster('on-demand: master stale at request time'); }
            catch (err) { state.lastError = err.message; return res.status(502).json({ error: err.message }); }
        }
        if (!state.selectedVariant) return res.status(503).json({ error: 'No variant selected yet' });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(buildMasterPlaylist(state.selectedVariant));
    });

    router.get('/media.m3u8', async (req, res) => {
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

    router.get('/segment', async (req, res) => {
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

    router.get('/vod', async (req, res) => {
        if (!state.vodSelectedFormat) {
            return res.status(409).json({ error: state.type === 'LIVE' ? 'Current video is LIVE — use /api/relay/live.m3u8 instead' : 'No VOD format resolved — POST /api/relay/load first' });
        }
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

    router.get('/status', (req, res) => {
        const now = Date.now();
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
            lastError: state.lastError,
            recentLog: state.log.slice(-40),
        });
    });

    startWatchdog();
    return router;
}

module.exports = { createRelayRouter };
