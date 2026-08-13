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
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { FfmpegPipeline } = require('./relay-ffmpeg-pipeline.cjs');
const { selectFormats } = require('./relay-format-selector.cjs');

const QUALITY_PRIORITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const MASTER_MAX_AGE_MS = 20 * 60 * 1000; // refresh live manifest well before its ~hours expiry
const WATCHDOG_INTERVAL_MS = 30 * 1000;

// yt-dlp needs BOTH a cookies file AND a JS runtime together to reliably get
// past YouTube's bot-check ("Sign in to confirm you're not a bot") — neither
// alone is enough, and without the JS runtime yt-dlp can silently fall back
// to a degraded client that returns only storyboard formats, no error at
// all. Confirmed by direct testing in ffmpeg-poc/README.md. Default cookies
// location is next to the running app (repo root in dev, next to the exe
// when packaged — never inside pkg's read-only snapshot) so dropping a
// cookies.txt there (Netscape format, exported from a logged-in YouTube
// session) just works with zero config — same convenience pattern as
// ffmpeg-poc's cookies.txt.
function defaultCookiesFile() {
    return process.pkg
        ? path.join(path.dirname(process.execPath), 'cookies.txt')
        : path.join(__dirname, 'cookies.txt');
}
function resolveCookiesFile() {
    if (process.env.RELAY_COOKIES_FILE) return process.env.RELAY_COOKIES_FILE;
    try { const p = defaultCookiesFile(); return fs.existsSync(p) ? p : null; } catch { return null; }
}
// Where a new cookies.txt gets written from the controller UI — same location
// resolveCookiesFile() would pick up, but doesn't require the file to already
// exist (resolveCookiesFile() returns null until there's something to read).
function resolveCookiesFileForWrite() {
    return process.env.RELAY_COOKIES_FILE || defaultCookiesFile();
}
// Netscape cookie file: tab-separated data lines, optionally prefixed with
// "#HttpOnly_" (still a real data line, not a comment — only bare "#" lines
// and blanks are comments/ignorable).
function looksLikeNetscapeCookieFile(content) {
    return content.split(/\r?\n/).some(line => {
        const t = line.trim();
        if (!t) return false;
        if (t.startsWith('#') && !t.startsWith('#HttpOnly_')) return false;
        return t.split('\t').length >= 6;
    });
}

// YouTube's live playlists embed proprietary ad-break signaling
// (#EXT-X-DATERANGE:CLASS="CUEPOINT-AD" / #EXT-X-CUEPOINT) that isn't the
// standard SCTE-35 interstitial format. hls.js's interstitial/date-range
// handling was confirmed (via live testing in the PoC) to silently stall
// forever on it — currentLevel never leaves -1, no fragment ever requested,
// no error event. Not needed for this relay's purpose, so dropped entirely.
const STRIPPED_TAG_PREFIXES = ['#EXT-X-DATERANGE', '#EXT-X-CUEPOINT'];

function createRelayRouter({ findYtDlp, findFfmpeg = () => ({ ffmpegPath: null, ffprobePath: null }), hlsOutputDir = null }) {
    const relayStartedAt = Date.now();
    const state = {
        // Bumped by every loadVideo() call and by POST /stop. loadVideo() re-checks
        // this against the value it captured at the start after each slow await
        // (yt-dlp resolve, ffmpeg startup) — if it's moved on, a /stop (or a newer
        // /load) arrived while this one was still in flight, so it backs off instead
        // of clobbering state / leaving an orphaned ffmpeg process nothing asked for.
        loadGeneration: 0,
        videoId: null,
        type: null,              // LIVE | UPCOMING_LIVE | FINISHED_LIVE | VOD
        title: null,
        mode: null,               // null | 'proxy-combined' | 'ffmpeg-split' (LIVE only)
        availableQualities: [],
        highestAvailableHeight: null,

        masterManifestUrl: null,
        masterFetchedAt: null,
        selectedVariant: null,
        lastMediaFetchAt: null,

        vodSelectedFormat: null,

        // ffmpeg split-mux path — see startFfmpegRelay/stopFfmpegRelay below.
        // Reaches true max quality (video-only + audio-only DASH copy-muxed)
        // when a live stream publishes those tracks, which the combined-HLS
        // proxy path above can never do since it's capped to whatever
        // resolution YouTube's combined manifest happens to expose.
        ffmpeg: {
            pipeline: null,       // FfmpegPipeline instance, or null
            selected: null,       // {mode:'split', video, audio} from selectFormats()
            generation: 0,
            pipelineReady: false,
            resolvedAt: null,     // for the watchdog's proactive URL-refresh window
            copyConfirmed: null,
            pid: null,
        },

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
        state.mode = null;
        state.availableQualities = [];
        state.highestAvailableHeight = null;
        state.masterManifestUrl = null;
        state.masterFetchedAt = null;
        state.selectedVariant = null;
        state.lastMediaFetchAt = null;
        state.vodSelectedFormat = null;
        // Caller (loadVideo) awaits stopFfmpegRelay() before calling this, so
        // any previous pipeline is already stopped/nulled by this point —
        // reset here too as defense in depth.
        state.ffmpeg.pipeline = null;
        state.ffmpeg.selected = null;
        state.ffmpeg.pipelineReady = false;
        state.ffmpeg.generation = 0;
        state.ffmpeg.resolvedAt = null;
        state.ffmpeg.copyConfirmed = null;
        state.ffmpeg.pid = null;
        state.startedAt = Date.now();
        state.readyAt = null;
        state.reconnectCount = 0;
        state.watchdogRefreshCount = 0;
        state.lastError = null;
    }

    function fetchVideoInfo(videoId) {
        return new Promise((resolve, reject) => {
            const ytDlp = findYtDlp();
            // This message is surfaced verbatim in LivePlayerCard's Direct Relay
            // status line, so it has to say what to actually do about it — a bare
            // "yt-dlp not found" next to a toggle that appears to do nothing is
            // exactly how this looked like a broken toggle on a fresh PC.
            if (!ytDlp) { reject(new Error('yt-dlp.exe missing — put it in the same folder as the app, or rebuild with a bundled copy')); return; }
            const args = ['--dump-json', '--no-warnings', '--no-playlist'];
            // Required for YouTube's current JS-based signature/challenge handling —
            // without a JS runtime, yt-dlp silently falls back to a degraded client
            // (storyboard-only formats, no real video/audio) even with valid cookies.
            // Node is already a hard dependency of this whole app, so always safe.
            args.push('--js-runtimes', 'node');
            const cookiesFile = resolveCookiesFile();
            if (cookiesFile) args.push('--cookies', cookiesFile);
            args.push(`https://www.youtube.com/watch?v=${videoId}`);
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

        state.mode = 'proxy-combined';
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

    // ------------------------------------------------------------------
    // ffmpeg split-mux — video-only + audio-only copy-mux for LIVE streams
    // that publish separate high-res DASH tracks (the only way to exceed
    // the combined-HLS proxy path's quality ceiling above). Safe fallback
    // philosophy preserved throughout: any failure here falls back to
    // refreshMaster()'s proxy-combined path, never a hard relay failure.
    // ------------------------------------------------------------------
    function buildFfmpegMasterPlaylist(selected) {
        const video = selected.video;
        const audio = selected.audio;
        const bandwidth = Math.round(((video.tbr || 0) + (audio.abr || 0)) * 1000) || 1;
        return [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${video.width}x${video.height}`,
            '/api/relay/hls/stream.m3u8',
            '',
        ].join('\n');
    }

    // Spawns/tracks one ffmpeg process copy-muxing the given video-only +
    // audio-only selection into local fragmented-MP4 HLS output. Resolves
    // only once ffmpeg has produced real, fetchable playable output (the
    // pipeline's 'ready' event) — so /load naturally waits for that before
    // responding, and /live.m3u8 + /hls/* both refuse to serve anything
    // until pipelineReady is true.
    function startFfmpegRelay(selection) {
        return new Promise((resolve, reject) => {
            const { ffmpegPath } = findFfmpeg();
            if (!ffmpegPath) { reject(new Error('ffmpeg not found')); return; }
            if (!hlsOutputDir) { reject(new Error('relay HLS output directory not configured')); return; }

            state.mode = 'ffmpeg-split';
            state.ffmpeg.selected = selection;
            state.ffmpeg.pipelineReady = false;
            state.ffmpeg.generation += 1;
            state.ffmpeg.resolvedAt = Date.now();
            state.ffmpeg.copyConfirmed = null;

            const pipeline = new FfmpegPipeline(ffmpegPath, hlsOutputDir);
            state.ffmpeg.pipeline = pipeline;
            let settled = false;

            pipeline.once('ready', () => {
                state.ffmpeg.pipelineReady = true;
                state.ffmpeg.copyConfirmed = pipeline.getCopyConfirmation();
                if (!state.readyAt) state.readyAt = Date.now();
                logEvent(`ffmpeg split-mux ready: ${selection.video.width}x${selection.video.height}`);
                if (!settled) { settled = true; resolve(); }
            });
            pipeline.once('ready-timeout', () => {
                logEvent('ffmpeg produced no playable output within 30s');
                pipeline.kill();
                if (!settled) { settled = true; reject(new Error('ffmpeg did not produce playable output in time')); }
            });
            pipeline.on('error', (err) => {
                state.lastError = err.message;
                logEvent(`ffmpeg process error: ${err.message}`);
                if (!settled) { settled = true; reject(err); }
            });
            pipeline.on('close', ({ wasIntentional }) => {
                if (state.ffmpeg.pipeline === pipeline) state.ffmpeg.pipeline = null;
                if (wasIntentional) {
                    // stopFfmpegRelay()-initiated (e.g. a new video was loaded while this
                    // pipeline was still starting) — no recovery needed, but still settle
                    // the promise if nobody has yet, so an in-flight caller (e.g. a
                    // recovery attempt superseded mid-start) doesn't hang forever.
                    if (!settled) { settled = true; reject(new Error('relay stopped before ffmpeg finished starting')); }
                    return;
                }
                logEvent('ffmpeg exited unexpectedly');
                if (!settled) {
                    settled = true;
                    reject(new Error('ffmpeg exited unexpectedly before producing output'));
                    return;
                }
                if (state.type === 'LIVE' && state.mode === 'ffmpeg-split') scheduleFfmpegRecovery();
            });

            pipeline.start(selection);
            state.ffmpeg.pid = pipeline.proc && pipeline.proc.pid;
        });
    }

    function stopFfmpegRelay() {
        return new Promise((resolve) => {
            const pipeline = state.ffmpeg.pipeline;
            if (!pipeline) { resolve(); return; }
            pipeline.once('close', () => resolve());
            pipeline.stop();
        });
    }

    // Re-resolves via yt-dlp (fresh signed URLs) and restarts ffmpeg, with
    // backoff — mirrors ffmpeg-poc/start.js's auto-recovery. Falls back to
    // the proxy-combined path if split formats are no longer available
    // (e.g. the broadcaster's encoder configuration changed mid-stream).
    function scheduleFfmpegRecovery() {
        const videoIdAtSchedule = state.videoId;
        state.reconnectCount++;
        const delay = Math.min(2000 * state.reconnectCount, 15000);
        logEvent(`ffmpeg auto-recovery in ${delay}ms (reconnect #${state.reconnectCount})`);
        setTimeout(async () => {
            // A new /load (different or same video) superseded this recovery attempt.
            if (state.type !== 'LIVE' || state.videoId !== videoIdAtSchedule) return;
            try {
                const info = await fetchVideoInfo(state.videoId);
                const selection = selectFormats(info);
                if (selection.mode === 'split' && findFfmpeg().ffmpegPath) {
                    await startFfmpegRelay(selection);
                } else {
                    logEvent('Split formats no longer available or ffmpeg missing — falling back to proxy-combined');
                    await refreshMaster('ffmpeg recovery: falling back to combined');
                }
            } catch (err) {
                // Don't chase a video that's no longer loaded — a concurrent /load
                // (new or same video) superseded this attempt while it was in flight.
                if (state.videoId !== videoIdAtSchedule) return;
                state.lastError = `ffmpeg recovery failed: ${err.message}`;
                logEvent(state.lastError);
                scheduleFfmpegRecovery();
            }
        }, delay);
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
        const myGeneration = ++state.loadGeneration;
        // Stop any ffmpeg process from the previous video BEFORE resetting
        // state, so two processes never race writing into hlsOutputDir.
        await stopFfmpegRelay();
        // Superseded (a /stop, or a newer /load) while the previous pipeline was
        // shutting down — back off instead of resurrecting state a stop just cleared.
        if (state.loadGeneration !== myGeneration) return buildReport();
        resetVideoState(videoId);
        logEvent(`Resolving video ${videoId}...`);
        const info = await fetchVideoInfo(videoId);
        // yt-dlp resolution takes real time (spawns a process, hits the network) —
        // the client may have already asked us to stop while this was in flight.
        if (state.loadGeneration !== myGeneration) return buildReport();
        state.title = info.title || null;
        state.type = classify(info);
        logEvent(`Detected type: ${state.type} — "${state.title}"`);

        if (state.type === 'LIVE') {
            const selection = selectFormats(info);
            if (selection.mode === 'split' && findFfmpeg().ffmpegPath) {
                try {
                    await startFfmpegRelay(selection);
                    if (state.loadGeneration !== myGeneration) { await stopFfmpegRelay(); return buildReport(); }
                } catch (err) {
                    logEvent(`ffmpeg split-mux failed to start (${err.message}) — falling back to proxy-combined`);
                    await refreshMaster('ffmpeg start failed, falling back to combined');
                }
            } else {
                if (selection.mode === 'split') {
                    logEvent('Split formats available but ffmpeg not found — falling back to proxy-combined');
                }
                await refreshMaster('initial load');
            }
        } else if (state.type === 'UPCOMING_LIVE') {
            logEvent('Video is an upcoming live stream — not broadcasting yet, nothing to relay.');
        } else {
            await resolveVod(info);
        }
        return buildReport();
    }

    // Client-driven full stop — see LivePlayer.html's stopRelayCompletely(). Without
    // this there was no way to ever stop the yt-dlp/ffmpeg pipeline short of loading
    // a different video: turning "Direct Relay" off, switching this Live Player out
    // of the active OBS scene, or the browser tab closing all left it running
    // indefinitely in the background, burning CPU/bandwidth for a stream nobody was
    // consuming anymore.
    async function stopRelay() {
        state.loadGeneration++; // invalidate any /load still in flight
        await stopFfmpegRelay();
        state.videoId = null;
        state.type = null;
        state.title = null;
        state.mode = null;
        state.availableQualities = [];
        state.highestAvailableHeight = null;
        state.masterManifestUrl = null;
        state.masterFetchedAt = null;
        state.selectedVariant = null;
        state.lastMediaFetchAt = null;
        state.vodSelectedFormat = null;
        state.readyAt = null;
        logEvent('Relay stopped (client requested — source hidden, relay disabled, or player destroyed)');
    }

    function startWatchdog() {
        setInterval(async () => {
            if (state.type !== 'LIVE') return;
            try {
                if (state.mode === 'ffmpeg-split') {
                    if (state.ffmpeg.resolvedAt && (Date.now() - state.ffmpeg.resolvedAt) > MASTER_MAX_AGE_MS) {
                        logEvent('Watchdog: proactively refreshing ffmpeg relay URLs...');
                        state.watchdogRefreshCount++;
                        const info = await fetchVideoInfo(state.videoId);
                        const selection = selectFormats(info);
                        await stopFfmpegRelay();
                        if (selection.mode === 'split' && findFfmpeg().ffmpegPath) {
                            await startFfmpegRelay(selection);
                        } else {
                            await refreshMaster('watchdog: split gone, falling back to combined');
                        }
                    }
                } else if (masterIsStale()) {
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
        const selected = state.mode === 'ffmpeg-split'
            ? (state.ffmpeg.selected ? state.ffmpeg.selected.video : null)
            : (state.type === 'LIVE' ? state.selectedVariant : state.vodSelectedFormat);

        return {
            videoId: state.videoId,
            title: state.title,
            type: state.type,
            mode: state.mode,
            availableQualities: qualityLadder.map(h => ({ height: h, available: availableHeights.has(h) })),
            highestAvailableHeight: state.highestAvailableHeight,
            selectedHeight: selected ? selected.height : null,
            selectedResolution: selected ? `${selected.width}x${selected.height}` : null,
            manifestUrl: state.mode === 'ffmpeg-split' ? null : (state.type === 'LIVE' ? state.masterManifestUrl : (state.vodSelectedFormat && state.vodSelectedFormat.url)),
            startupTimeMs: state.readyAt ? state.readyAt - state.startedAt : null,
            reconnectCount: state.reconnectCount,
            watchdogRefreshCount: state.watchdogRefreshCount,
            vodNote: state.vodSelectedFormat ? state.vodSelectedFormat.note : null,
            pipelineReady: state.mode === 'ffmpeg-split' ? state.ffmpeg.pipelineReady : null,
            copyConfirmed: state.mode === 'ffmpeg-split' ? state.ffmpeg.copyConfirmed : null,
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

    router.post('/stop', async (req, res) => {
        await stopRelay();
        res.json({ success: true });
    });

    router.get('/report', (req, res) => {
        if (!state.videoId) return res.status(404).json({ error: 'No video loaded yet — POST /api/relay/load first' });
        res.json(buildReport());
    });

    router.get('/live.m3u8', async (req, res) => {
        if (state.type !== 'LIVE') return res.status(409).json({ error: `Current video is type ${state.type}, not LIVE — use /api/relay/vod instead` });

        // Same stable URL regardless of mode — LivePlayer.html never needs to
        // know whether it's getting the ffmpeg-mux path or the proxy path.
        if (state.mode === 'ffmpeg-split') {
            if (!state.ffmpeg.pipelineReady || !state.ffmpeg.selected) {
                return res.status(503).json({ error: 'ffmpeg relay pipeline not ready yet' });
            }
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache');
            return res.send(buildFfmpegMasterPlaylist(state.ffmpeg.selected));
        }

        if (masterIsStale()) {
            try { await refreshMaster('on-demand: master stale at request time'); }
            catch (err) { state.lastError = err.message; return res.status(502).json({ error: err.message }); }
        }
        if (!state.selectedVariant) return res.status(503).json({ error: 'No variant selected yet' });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(buildMasterPlaylist(state.selectedVariant));
    });

    // Serves the ffmpeg-generated local HLS output (master is synthesized
    // separately by buildFfmpegMasterPlaylist above — this only serves the
    // media playlist + fMP4 segments/init that ffmpeg itself writes).
    router.get('/hls/*', (req, res) => {
        if (state.mode !== 'ffmpeg-split' || !state.ffmpeg.pipelineReady) {
            return res.status(404).json({ error: 'ffmpeg relay not active' });
        }
        if (!hlsOutputDir) return res.status(404).json({ error: 'relay HLS output not configured' });
        const decoded = decodeURIComponent(req.params[0] || '');
        const resolved = path.normalize(path.join(hlsOutputDir, decoded));
        if (!resolved.startsWith(path.normalize(hlsOutputDir))) return res.status(400).send('bad path');
        fs.readFile(resolved, (err, data) => {
            if (err) return res.status(404).send('not found');
            const ext = path.extname(resolved).toLowerCase();
            const mime = ext === '.m3u8' ? 'application/vnd.apple.mpegurl'
                : ext === '.m4s' ? 'video/iso.segment'
                : ext === '.mp4' ? 'video/mp4'
                : 'application/octet-stream';
            res.setHeader('Content-Type', mime);
            if (ext === '.m3u8') res.setHeader('Cache-Control', 'no-cache');
            res.send(data);
        });
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
        const selected = state.mode === 'ffmpeg-split'
            ? (state.ffmpeg.selected ? state.ffmpeg.selected.video : null)
            : (state.type === 'LIVE' ? state.selectedVariant : state.vodSelectedFormat);
        res.json({
            videoId: state.videoId,
            title: state.title,
            type: state.type,
            mode: state.mode,
            selected: selected ? { width: selected.width, height: selected.height, bandwidth: selected.bandwidth || null, codecs: selected.codecs || selected.ext || selected.vcodec || null } : null,
            availableQualities: state.availableQualities,
            highestAvailableHeight: state.highestAvailableHeight,
            reconnectCount: state.reconnectCount,
            watchdogRefreshCount: state.watchdogRefreshCount,
            masterAgeMs: state.masterFetchedAt ? now - state.masterFetchedAt : null,
            mediaAgeMs: state.lastMediaFetchAt ? now - state.lastMediaFetchAt : null,
            startupTimeMs: state.readyAt ? state.readyAt - state.startedAt : null,
            relayUptimeMs: now - relayStartedAt,
            pipelineReady: state.mode === 'ffmpeg-split' ? state.ffmpeg.pipelineReady : null,
            copyConfirmed: state.mode === 'ffmpeg-split' ? state.ffmpeg.copyConfirmed : null,
            lastError: state.lastError,
            recentLog: state.log.slice(-40),
        });
    });

    // GET/POST /api/relay/cookies — lets the controller UI read/replace the
    // yt-dlp cookies.txt without touching the filesystem by hand. Same file
    // resolveCookiesFile() feeds to every yt-dlp invocation above, so a save
    // here takes effect on the very next fetchVideoInfo() call (next /load,
    // or the watchdog's next refresh) — no restart needed.
    //
    // Optional secret gate (off unless RELAY_COOKIES_SECRET is set) — same
    // pattern as /api/notifications/*'s NOTIFICATIONS_SECRET in server.cjs.
    // Matters here specifically because the whole app, cookies routes
    // included, is reachable through the Cloudflare quick-tunnel already
    // used for phone push-notification setup, and cookies.txt is a live
    // YouTube session token, not just app config.
    router.use('/cookies', (req, res, next) => {
        const secret = process.env.RELAY_COOKIES_SECRET;
        if (!secret) return next();
        const auth = req.headers['authorization'] || '';
        if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
        next();
    });

    router.get('/cookies', (req, res) => {
        const filePath = resolveCookiesFile() || resolveCookiesFileForWrite();
        try {
            const exists = fs.existsSync(filePath);
            const content = exists ? fs.readFileSync(filePath, 'utf8') : '';
            const stat = exists ? fs.statSync(filePath) : null;
            res.json({
                path: filePath,
                exists,
                active: !!resolveCookiesFile(),
                content,
                updatedAt: stat ? stat.mtime.toISOString() : null,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/cookies', (req, res) => {
        const content = req.body && typeof req.body.content === 'string' ? req.body.content : null;
        if (content === null) return res.status(400).json({ error: 'content (string) is required' });
        if (!content.trim()) return res.status(400).json({ error: 'Cookie file content is empty' });
        if (!looksLikeNetscapeCookieFile(content)) {
            return res.status(400).json({ error: 'Does not look like a Netscape-format cookies.txt (expected tab-separated fields per cookie line)' });
        }
        const filePath = resolveCookiesFileForWrite();
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, 'utf8');
            logEvent(`Cookies file updated (${content.length} bytes) at ${filePath}`);
            res.json({ success: true, path: filePath, updatedAt: new Date().toISOString() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    startWatchdog();
    return router;
}

module.exports = { createRelayRouter };
