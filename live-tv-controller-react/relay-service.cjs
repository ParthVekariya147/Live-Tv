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
const { HlsLedger } = require('./relay-hls-ledger.cjs');

const QUALITY_PRIORITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const MASTER_MAX_AGE_MS = 20 * 60 * 1000; // refresh live manifest well before its ~hours expiry
// YouTube stops honouring a LIVE stream's signed segment URLs roughly 30s after the
// manifest is resolved, even though the signature itself claims hours of validity and
// the playlist keeps serving fresh sequence numbers. Measured directly: segments fetch
// 200 immediately after a resolve, then every newly-produced segment 403s from ~30s on
// and never recovers. MASTER_MAX_AGE_MS (20 min) is 40x too slow for that, which is why
// Direct Relay played for a few seconds and then froze for the rest of the window.
const LIVE_MANIFEST_TTL_MS = 18 * 1000;
// A resolve costs a yt-dlp spawn (~8-12s), so a failing segment must not be able to
// kick one on every request — the player retries several times a second while stalled.
const RESOLVE_THROTTLE_MS = 10 * 1000;
// 30s was far too coarse to notice a dead ffmpeg. The watchdog is now cheap
// (it reads in-memory ledger counters, not the network) so it can tick fast
// enough to catch a stall inside the player's buffer window.
const WATCHDOG_INTERVAL_MS = 5 * 1000;

// ---- ffmpeg split-mux health/refresh policy -------------------------------
// A segment lands every 4s. Six missed in a row means the source is gone, the
// process is wedged in a read, or ffmpeg died without exiting — all of which
// used to be completely invisible (the only health signal was process exit,
// and -reconnect keeps a dead pull alive indefinitely).
const FFMPEG_STALL_MS = 25 * 1000;
// Signed googlevideo URLs carry their own ?expire= (typically ~6h). Restarting
// blindly every 20 minutes threw away hours of perfectly good stream time and
// cost a visible glitch each time; refresh is now driven by the actual expiry
// with a safety margin, and the stall watchdog above is the net for URLs that
// die early.
const FFMPEG_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const FFMPEG_REFRESH_MIN_MS = 10 * 60 * 1000;
const FFMPEG_REFRESH_MAX_MS = 4 * 60 * 60 * 1000;
const FFMPEG_REFRESH_FALLBACK_MS = 20 * 60 * 1000; // no ?expire= in the URL
// After this many consecutive failed restarts with nothing on air, give up on
// the split path for this stream and drop to the proxy-combined path rather
// than retrying a broken configuration forever.
const FFMPEG_MAX_FAILURES_BEFORE_FALLBACK = 5;

const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

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

// Path to the bgutil GetPOT plugin + the base URL of the local provider, or null
// when the plugin isn't deployed. Two-tier resolution matching
// pot-provider-manager.cjs resolveServerEntry(): next to the EXE when packaged,
// repo-root sibling in dev. Returning null degrades to the old behaviour rather
// than passing yt-dlp a --plugin-dirs that doesn't exist.
function resolvePotArgs() {
    const base = process.pkg
        ? path.join(path.dirname(process.execPath), 'pot-provider', 'plugin')
        : path.resolve(__dirname, '..', 'pot-provider', 'plugin');
    try {
        if (!fs.existsSync(path.join(base, 'yt_dlp_plugins', 'extractor', 'getpot_bgutil_http.py'))) return null;
    } catch (_) { return null; }
    return ['--plugin-dirs', base, '--extractor-args', 'youtube:getpot_bgutil_baseurl=http://127.0.0.1:4416'];
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
    // The single continuous HLS playlist the player consumes, stitched across
    // however many ffmpeg runs it takes to keep the stream up. See
    // relay-hls-ledger.cjs for why the player must never see ffmpeg's own
    // playlist directly.
    const ledger = hlsOutputDir ? new HlsLedger(hlsOutputDir) : null;
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
            pipeline: null,       // FfmpegPipeline currently ON AIR, or null
            selected: null,       // {mode:'split', video, audio} from selectFormats()
            pipelineReady: false,
            resolvedAt: null,
            refreshDueAt: null,   // derived from the source URLs' own ?expire=
            copyConfirmed: null,
            pid: null,
            runId: null,
            // Single-flight guard. Previously the 20-minute watchdog refresh and
            // the crash-recovery timer could both call startFfmpegRelay(), giving
            // two ffmpeg processes the same output directory to fight over — each
            // wiping the other's segments, with the loser orphaned forever.
            restartInFlight: null,
            // Drives the retry backoff and is RESET BY A SUCCESSFUL RESTART. The
            // old code used state.reconnectCount for this, which was also bumped
            // by unrelated watchdog/media-fetch blips and only ever cleared on a
            // brand-new /load — so after a few hiccups every crash sat out the
            // full 15s cap before even trying.
            consecutiveFailures: 0,
            restartCount: 0,
            lastRestartReason: null,
        },

        startedAt: null,
        readyAt: null,
        reconnectCount: 0,
        watchdogRefreshCount: 0,
        lastError: null,
        segmentFailStreak: 0,
        lastSegmentOkAt: null,
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
        state.ffmpeg.resolvedAt = null;
        state.ffmpeg.refreshDueAt = null;
        state.ffmpeg.copyConfirmed = null;
        state.ffmpeg.pid = null;
        state.ffmpeg.runId = null;
        state.ffmpeg.consecutiveFailures = 0;
        state.ffmpeg.restartCount = 0;
        state.ffmpeg.lastRestartReason = null;
        // A NEW video is the only time the segment history may be thrown away.
        // Restarts of the SAME video deliberately keep it — that continuity is
        // what lets the playlist go on serving while a replacement ffmpeg starts.
        if (ledger) ledger.reset();
        state.startedAt = Date.now();
        state.readyAt = null;
        state.reconnectCount = 0;
        state.watchdogRefreshCount = 0;
        state.lastError = null;
    }

    function runYtDlpJson(videoId, cookiesFile) {
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
            // Hand yt-dlp the local bgutil PO-Token provider. server.cjs already starts it
            // on :4416 (pot-provider-manager.cjs) and nothing was consulting it, which is
            // the configuration yt-dlp recommends for YouTube.
            //
            // NOTE: this is NOT the fix for the "Direct Relay plays a few seconds then
            // freezes" bug — that was measured to be manifest ageing, not PO tokens. A
            // POT-resolved manifest was soaked for 75s and every new segment still 403'd
            // (0 OK / 20 failed), the same as without it. See MASTER_MAX_AGE_MS.
            const potArgs = resolvePotArgs();
            if (potArgs) args.push(...potArgs);
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

    // Cookies help for members-only and age-restricted streams, but a stale jar is worse
    // than none at all: YouTube answers a request carrying invalid cookies with a flat
    // "Video unavailable", which used to reject straight out of loadVideo() and leave the
    // relay dead — state.type null, no ffmpeg, /live.m3u8 returning 409 — while the player
    // page sat on a frozen frame believing the relay was still live. A public stream that
    // resolves perfectly well anonymously must not go off air because a saved cookie file
    // went bad, so fall back to an anonymous resolve and record that it happened.
    async function fetchVideoInfo(videoId) {
        const cookiesFile = resolveCookiesFile();
        if (!cookiesFile) {
            state.cookiesRejected = false;
            return runYtDlpJson(videoId, null);
        }
        try {
            const info = await runYtDlpJson(videoId, cookiesFile);
            state.cookiesRejected = false;
            return info;
        } catch (err) {
            logEvent(`yt-dlp failed using saved cookies (${err.message}) — retrying without them`);
            const info = await runYtDlpJson(videoId, null);
            state.cookiesRejected = true;
            logEvent('Resolved anonymously — the saved cookies.txt is being rejected by YouTube and should be replaced');
            return info;
        }
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

    // Single-flight across EVERY caller — loadVideo, the watchdog, kickRefresh,
    // getLiveMediaPlaylist's recovery path and /live.m3u8's on-demand refresh all
    // funnel through here. Each resolve spawns a yt-dlp process for ~4s, and
    // these callers overlap constantly in normal operation: observed live, the
    // watchdog fired a second resolve 3.7s into the initial load's own resolve,
    // so two yt-dlp processes raced and both wrote state.selectedVariant. A
    // caller that arrives mid-resolve now simply awaits the one already running.
    let masterRefreshInFlight = null;
    function refreshMaster(reason) {
        if (masterRefreshInFlight) {
            logEvent(`Master refresh already in flight — coalescing (${reason})`);
            return masterRefreshInFlight;
        }
        masterRefreshInFlight = doRefreshMaster(reason)
            .finally(() => { masterRefreshInFlight = null; });
        return masterRefreshInFlight;
    }

    async function doRefreshMaster(reason) {
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
        if (!state.masterManifestUrl) return true;
        // LIVE proxy-combined is the case with the ~30s segment-URL lifetime; VOD and the
        // ffmpeg split path keep the old, relaxed budget.
        const ttl = (state.type === 'LIVE' && state.mode === 'proxy-combined')
            ? LIVE_MANIFEST_TTL_MS
            : MASTER_MAX_AGE_MS;
        return (Date.now() - state.masterFetchedAt) > ttl;
    }

    // Re-resolve WITHOUT making the caller wait.
    //
    // hls.js polls the media playlist every few seconds; blocking one of those polls for
    // the ~10s a yt-dlp resolve takes would stall playback worse than the stale manifest
    // does. So the refresh runs in the background and the current (still-serving) variant
    // URL keeps being used until the new one lands. Throttled and single-flight.
    let resolveInFlight = null;
    let lastResolveKickAt = 0;
    function kickRefresh(reason) {
        if (resolveInFlight) return resolveInFlight;
        if (Date.now() - lastResolveKickAt < RESOLVE_THROTTLE_MS) return null;
        lastResolveKickAt = Date.now();
        resolveInFlight = refreshMaster(reason)
            .then(() => {
                state.segmentFailStreak = 0;
                state.lastError = null;
            })
            .catch((err) => {
                state.lastError = `Manifest refresh failed: ${err.message}`;
                state.reconnectCount++;
                logEvent(state.lastError);
            })
            .finally(() => { resolveInFlight = null; });
        return resolveInFlight;
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

    // Signed googlevideo URLs carry the moment they stop being honoured in the
    // query string itself. Reading it turns the refresh from a blind timer into
    // a deadline, which is the difference between one glitch every 20 minutes
    // and one every few hours.
    function urlExpiryMs(url) {
        try {
            const exp = new URL(url).searchParams.get('expire');
            if (exp && /^\d+$/.test(exp)) return parseInt(exp, 10) * 1000;
        } catch (_) { /* fall through to the path-style form below */ }
        const m = String(url || '').match(/[?&/]expire[=/](\d{10,})/);
        return m ? parseInt(m[1], 10) * 1000 : null;
    }

    function computeRefreshDueAt(selection) {
        const now = Date.now();
        const stamps = [selection.video, selection.audio, selection.combined]
            .filter(Boolean)
            .map(f => urlExpiryMs(f.url))
            .filter(v => v && v > now);
        if (!stamps.length) return now + FFMPEG_REFRESH_FALLBACK_MS;
        const due = Math.min(...stamps) - FFMPEG_REFRESH_MARGIN_MS;
        return Math.min(Math.max(due, now + FFMPEG_REFRESH_MIN_MS), now + FFMPEG_REFRESH_MAX_MS);
    }

    // Is playable output actually reaching the playlist right now? The ledger is
    // the only component that knows, because it is the only one that sees
    // segments appear. state.ffmpeg.pipelineReady says "a run started
    // successfully once", which is a different and much weaker claim.
    function ffmpegOnAir() {
        return !!(ledger && ledger.hasSegments() && (ledger.msSinceLastSegment() ?? Infinity) < FFMPEG_STALL_MS);
    }

    function lastFfmpegError(stderrTail) {
        const lines = String(stderrTail || '').split('\n').map(l => l.trim()).filter(Boolean);
        const err = lines.reverse().find(l => /error|invalid|failed|denied|403|404|refused/i.test(l));
        return err ? err.slice(0, 200) : 'no diagnostic output';
    }

    // Starts a NEW ffmpeg run and cuts over to it once it has produced real,
    // fetchable output — make-before-break, the way a broadcast encoder fails
    // over. The run already on air keeps producing (and keeps being served)
    // right up to the cutover, so a refresh or a recovery costs one
    // #EXT-X-DISCONTINUITY instead of the 20-40s hole the old
    // stop-then-resolve-then-start order left with nothing to serve.
    //
    // Never call this directly for a restart — go through requestFfmpegRestart(),
    // which serialises callers. Two concurrent starts are the bug that let two
    // ffmpeg processes share one output directory.
    function startFfmpegRelay(selection) {
        return new Promise((resolve, reject) => {
            const { ffmpegPath } = findFfmpeg();
            if (!ffmpegPath) { reject(new Error('ffmpeg not found')); return; }
            if (!hlsOutputDir || !ledger) { reject(new Error('relay HLS output directory not configured')); return; }

            const previous = state.ffmpeg.pipeline; // null on a cold start; still on air during a restart
            const pipeline = new FfmpegPipeline(ffmpegPath, hlsOutputDir);
            let settled = false;

            // A replacement that fails must take only itself down. The stream
            // currently on air is untouched, and the half-started process is
            // reaped rather than left to write into the output directory.
            const fail = (err) => {
                if (settled) return;
                settled = true;
                try { pipeline.kill(); } catch (_) { /* noop */ }
                // It never reached the playlist, so its output is dead weight —
                // remove it rather than let every failed restart attempt leave a
                // partial run behind on disk.
                ledger.discardRun(pipeline.runId);
                reject(err);
            };

            pipeline.once('ready', () => {
                if (settled) return;
                settled = true;
                // Atomic period swap: the outgoing run stops contributing in the
                // same tick the incoming one starts, so the two can never
                // interleave segments in the playlist.
                if (previous && previous !== pipeline) {
                    ledger.retireRun(previous.runId);
                    previous.stop();
                    logEvent(`Cut over from run ${previous.runId} to ${pipeline.runId} (no gap)`);
                }
                ledger.promoteRun(pipeline.runId);
                state.ffmpeg.pipeline = pipeline;
                state.ffmpeg.selected = selection;
                state.ffmpeg.pipelineReady = true;
                state.ffmpeg.runId = pipeline.runId;
                state.ffmpeg.pid = pipeline.proc && pipeline.proc.pid;
                state.ffmpeg.copyConfirmed = pipeline.getCopyConfirmation();
                state.ffmpeg.resolvedAt = Date.now();
                state.ffmpeg.refreshDueAt = computeRefreshDueAt(selection);
                state.ffmpeg.consecutiveFailures = 0;
                state.mode = 'ffmpeg-split';
                if (!state.readyAt) state.readyAt = Date.now();
                const mins = Math.round((state.ffmpeg.refreshDueAt - Date.now()) / 60000);
                logEvent(`ffmpeg split-mux ready: ${selection.video.width}x${selection.video.height} (run ${pipeline.runId}, next URL refresh in ~${mins}min)`);
                resolve();
            });

            pipeline.once('ready-timeout', () => {
                logEvent(`ffmpeg run ${pipeline.runId} produced no playable output within 30s`);
                fail(new Error('ffmpeg did not produce playable output in time'));
            });

            pipeline.on('error', (err) => {
                state.lastError = err.message;
                logEvent(`ffmpeg process error (run ${pipeline.runId}): ${err.message}`);
                fail(err);
            });

            pipeline.on('close', ({ wasIntentional, runId, stderrTail }) => {
                ledger.retireRun(runId);
                if (!settled) {
                    fail(new Error(wasIntentional
                        ? 'relay stopped before ffmpeg finished starting'
                        : `ffmpeg exited before producing output — ${lastFfmpegError(stderrTail)}`));
                    return;
                }
                // Only the run currently on air can trigger recovery. A run that
                // has already been superseded by a newer one exiting is expected
                // and must stay silent — that stray path is how the old code
                // ended up with a recovery timer racing a mode switch.
                if (state.ffmpeg.pipeline !== pipeline) return;
                state.ffmpeg.pipeline = null;
                if (wasIntentional) return;
                logEvent(`ffmpeg run ${runId} exited unexpectedly — ${lastFfmpegError(stderrTail)}`);
                if (state.type === 'LIVE' && state.mode === 'ffmpeg-split') {
                    requestFfmpegRestart('ffmpeg exited unexpectedly');
                }
            });

            // Staged: the ledger owns this run's files from now on (so a failure
            // can be cleaned up), but it publishes nothing until promoteRun().
            ledger.registerRun({
                runId: pipeline.runId,
                playlistFile: pipeline.playlistFile,
                initFile: pipeline.initFile,
                staged: true,
            });
            pipeline.start(selection);
        });
    }

    function stopFfmpegRelay() {
        return new Promise((resolve) => {
            const pipeline = state.ffmpeg.pipeline;
            // Cleared BEFORE stopping so the close handler above recognises this
            // as a deliberate teardown and does not schedule a recovery.
            state.ffmpeg.pipeline = null;
            state.ffmpeg.pipelineReady = false;
            state.ffmpeg.runId = null;
            if (!pipeline) { resolve(); return; }
            ledger && ledger.retireRun(pipeline.runId);
            let done = false;
            const finish = () => { if (done) return; done = true; resolve(); };
            pipeline.once('close', finish);
            // pipeline.stop() already escalates SIGTERM -> SIGKILL after 5s, but a
            // promise that can never settle would hang /load and /stop behind a
            // process that is never going to exit. Bound it here too.
            const guard = setTimeout(finish, 8000);
            if (guard.unref) guard.unref();
            pipeline.stop();
        });
    }

    // The ONE entry point for replacing the running ffmpeg — scheduled URL
    // refresh, output stall and crash recovery all funnel through here, so they
    // can never overlap. Re-resolves via yt-dlp for fresh signed URLs, starts a
    // replacement beside the current run, and cuts over. Falls back to the
    // proxy-combined path only after repeated failures with nothing on air.
    function requestFfmpegRestart(reason) {
        if (state.ffmpeg.restartInFlight) return state.ffmpeg.restartInFlight;

        const videoIdAtStart = state.videoId;
        const genAtStart = state.loadGeneration;
        const superseded = () => state.loadGeneration !== genAtStart
            || state.videoId !== videoIdAtStart
            || state.type !== 'LIVE';

        const run = (async () => {
            for (;;) {
                if (superseded()) return;
                const failures = state.ffmpeg.consecutiveFailures;
                if (failures > 0) {
                    const delay = Math.min(2000 * failures, 15000);
                    logEvent(`ffmpeg restart backoff ${delay}ms (consecutive failure #${failures})`);
                    await sleep(delay);
                    if (superseded()) return;
                }
                try {
                    state.ffmpeg.restartCount++;
                    state.ffmpeg.lastRestartReason = reason;
                    logEvent(`ffmpeg restart (${reason}) — re-resolving ${videoIdAtStart}`);
                    const info = await fetchVideoInfo(videoIdAtStart);
                    if (superseded()) return;
                    const selection = selectFormats(info);
                    if (selection.mode !== 'split' || !findFfmpeg().ffmpegPath) {
                        logEvent('Split formats no longer available or ffmpeg missing — falling back to proxy-combined');
                        await stopFfmpegRelay();
                        await refreshMaster('ffmpeg restart: falling back to combined');
                        return;
                    }
                    await startFfmpegRelay(selection);
                    // A /load or /stop can arrive during the seconds this took to
                    // cut over. Without this check the replacement would survive
                    // its own supersession and leave an ffmpeg process running for
                    // a video nobody asked for.
                    if (superseded()) { await stopFfmpegRelay(); return; }
                    state.lastError = null;
                    return;
                } catch (err) {
                    if (superseded()) return;
                    state.ffmpeg.consecutiveFailures++;
                    state.reconnectCount++;
                    state.lastError = `ffmpeg restart failed: ${err.message}`;
                    logEvent(state.lastError);
                    if (state.ffmpeg.consecutiveFailures >= FFMPEG_MAX_FAILURES_BEFORE_FALLBACK && !ffmpegOnAir()) {
                        logEvent(`ffmpeg restart failed ${state.ffmpeg.consecutiveFailures}x with nothing on air — falling back to proxy-combined`);
                        try {
                            await stopFfmpegRelay();
                            await refreshMaster('ffmpeg restarts exhausted, falling back to combined');
                            return;
                        } catch (e2) {
                            logEvent(`Fallback to proxy-combined also failed: ${e2.message} — will keep retrying ffmpeg`);
                        }
                    }
                }
            }
        })();

        // Held as the guard itself so a second caller awaits the first rather
        // than starting a competing ffmpeg.
        state.ffmpeg.restartInFlight = run;
        run.catch((err) => logEvent(`ffmpeg restart loop aborted: ${err && err.message}`))
           .finally(() => { state.ffmpeg.restartInFlight = null; });
        return run;
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
        if (!state.masterManifestUrl) {
            await refreshMaster('on-demand: no manifest yet');
        } else if (masterIsStale()) {
            kickRefresh('proactive: live segment URLs approaching their ~30s lifetime');
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
                    // startFfmpegRelay() already reaped its own failed process, but
                    // clear the ffmpeg state explicitly so nothing (watchdog or a
                    // late close event) can flip the mode back to ffmpeg-split
                    // after refreshMaster() has moved us to proxy-combined. That
                    // mode-flapping race is what the old ready-timeout path caused.
                    await stopFfmpegRelay();
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
        state.ffmpeg.refreshDueAt = null;
        state.ffmpeg.consecutiveFailures = 0;
        // Nothing is being served any more, so the segment history is dead
        // weight — drop it and clear the disk.
        if (ledger) ledger.reset();
        logEvent('Relay stopped (client requested — source hidden, relay disabled, or player destroyed)');
    }

    function startWatchdog() {
        const timer = setInterval(async () => {
            if (state.type !== 'LIVE') return;
            try {
                if (state.mode === 'ffmpeg-split') {
                    // Never compete with a restart that is already running. This
                    // guard plus requestFfmpegRestart()'s own single-flight is what
                    // makes it impossible for two ffmpeg processes to end up
                    // sharing the output directory.
                    if (state.ffmpeg.restartInFlight) return;

                    // 1. Liveness. The one signal that actually means "frames are
                    //    reaching the player": did a new segment appear? Process
                    //    liveness is not a proxy for it — ffmpeg's -reconnect keeps
                    //    a wedged pull running forever, and the old watchdog only
                    //    ever looked at manifest AGE, so a silently dead stream
                    //    kept reporting a healthy "RELAY LIVE 1920x1080".
                    const since = ledger ? ledger.msSinceLastSegment() : null;
                    if (state.ffmpeg.pipelineReady && since !== null && since > FFMPEG_STALL_MS) {
                        state.watchdogRefreshCount++;
                        state.lastError = `No new segment for ${Math.round(since / 1000)}s`;
                        requestFfmpegRestart(`output stalled ${Math.round(since / 1000)}s`);
                        return;
                    }

                    // 2. The process vanished without its close event producing a
                    //    restart (belt and braces — the close handler is the
                    //    primary path).
                    if (state.ffmpeg.pipelineReady && state.ffmpeg.pipeline && !state.ffmpeg.pipeline.isRunning()) {
                        requestFfmpegRestart('ffmpeg process is gone');
                        return;
                    }

                    // 3. Scheduled refresh, driven by the source URLs' real expiry
                    //    rather than a blind 20-minute clock.
                    if (state.ffmpeg.refreshDueAt && Date.now() >= state.ffmpeg.refreshDueAt) {
                        state.watchdogRefreshCount++;
                        requestFfmpegRestart('scheduled URL refresh before signature expiry');
                    }
                } else if (masterIsStale()) {
                    // Routed through kickRefresh, NOT straight to refreshMaster:
                    // kickRefresh is single-flight and throttled, so the tick can
                    // be fast (the ffmpeg stall check needs that) without ever
                    // spawning a second yt-dlp alongside one already resolving.
                    // Calling refreshMaster directly here raced both the initial
                    // load and the on-demand /media.m3u8 refresh — observed live
                    // as two overlapping resolves 400ms apart.
                    if (kickRefresh('watchdog: master aged out')) state.watchdogRefreshCount++;
                }
            } catch (err) {
                state.lastError = err.message;
                state.reconnectCount++;
                logEvent(`Watchdog failed (reconnect #${state.reconnectCount}): ${err.message}`);
            }
        }, WATCHDOG_INTERVAL_MS);
        if (timer.unref) timer.unref();
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
            cookiesRejected: !!state.cookiesRejected,
            pipelineReady: state.mode === 'ffmpeg-split' ? state.ffmpeg.pipelineReady : null,
            copyConfirmed: state.mode === 'ffmpeg-split' ? state.ffmpeg.copyConfirmed : null,
            // A restart is a normal, survivable event now, but the UI should still
            // be able to say so rather than showing a serenely healthy panel.
            restarting: state.mode === 'ffmpeg-split' ? !!state.ffmpeg.restartInFlight : false,
            restartCount: state.mode === 'ffmpeg-split' ? state.ffmpeg.restartCount : null,
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
            // Gated on the LEDGER having playable segments, not on a pipeline
            // being up this instant. During a restart the previous run's segments
            // are still on disk and still valid, so the master must keep
            // resolving — the old pipelineReady gate turned every restart into a
            // 503 storm that hls.js escalated to a fatal manifestLoadError.
            if (!state.ffmpeg.selected || !ledger || !ledger.hasSegments()) {
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
        if (state.mode !== 'ffmpeg-split' || !ledger) {
            return res.status(404).json({ error: 'ffmpeg relay not active' });
        }
        if (!hlsOutputDir) return res.status(404).json({ error: 'relay HLS output not configured' });
        const decoded = decodeURIComponent(req.params[0] || '');

        // The media playlist is synthesised, never read from disk. ffmpeg's own
        // per-run playlists stay private precisely because they restart their
        // numbering from zero; this one is continuous across every run.
        if (decoded === 'stream.m3u8') {
            const playlist = ledger.buildMediaPlaylist();
            if (!playlist) return res.status(503).json({ error: 'no segments available yet' });
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache');
            return res.send(playlist);
        }

        const root = path.resolve(hlsOutputDir);
        const resolved = path.resolve(root, decoded);
        // The separator matters: a bare startsWith(root) also accepts a sibling
        // directory whose name merely begins with the root's ("relay_hls_x").
        if (resolved !== root && !resolved.startsWith(root + path.sep)) return res.status(400).send('bad path');
        fs.readFile(resolved, (err, data) => {
            if (err) return res.status(404).send('not found');
            const ext = path.extname(resolved).toLowerCase();
            const mime = ext === '.m3u8' ? 'application/vnd.apple.mpegurl'
                : ext === '.m4s' ? 'video/iso.segment'
                : ext === '.mp4' ? 'video/mp4'
                : 'application/octet-stream';
            res.setHeader('Content-Type', mime);
            // Segment and init filenames now carry the run id and are never
            // reused, so they are safely immutable. That is not a micro-
            // optimisation: it is what guarantees a restart's new init segment
            // can never be answered from a cached copy of the previous run's,
            // which is exactly how the old fixed "init.mp4" name corrupted
            // playback after every restart.
            res.setHeader('Cache-Control', ext === '.m3u8' ? 'no-cache' : 'public, max-age=300, immutable');
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
            state.segmentFailStreak = 0;
            state.lastSegmentOkAt = Date.now();
            res.send(body);
        } catch (err) {
            // A failing segment used to be swallowed here: 502 to the player, nothing
            // recorded, no recovery. /status therefore kept reporting a healthy
            // "RELAY LIVE 1920x1080" while not one frame was reaching the player, and
            // the watchdog — which only looks at manifest age — never noticed. Both the
            // visibility gap and the recovery gap are fixed here.
            state.segmentFailStreak = (state.segmentFailStreak || 0) + 1;
            state.lastError = `Segment fetch failed (${state.segmentFailStreak} in a row): ${err.message}`;
            if (/403/.test(err.message) || state.segmentFailStreak >= 2) {
                kickRefresh(`recovery: ${state.segmentFailStreak} segment failure(s) — signed URLs no longer accepted`);
            }
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
            cookiesRejected: !!state.cookiesRejected,
            segmentFailStreak: state.segmentFailStreak || 0,
            lastSegmentOkAt: state.lastSegmentOkAt || null,
            // segmentsFlowing used to be derived only from state.lastSegmentOkAt,
            // which is set by the /segment proxy route — a route the ffmpeg-split
            // path never calls. So it read false forever in ffmpeg mode and the
            // "no frames are reaching the player" detector simply did not exist
            // there. In ffmpeg mode the ledger is the authority.
            segmentsFlowing: state.mode === 'ffmpeg-split'
                ? ffmpegOnAir()
                : !!(state.lastSegmentOkAt && (now - state.lastSegmentOkAt) < 30000),
            ffmpeg: state.mode === 'ffmpeg-split' ? {
                runId: state.ffmpeg.runId,
                pid: state.ffmpeg.pid,
                processAlive: !!(state.ffmpeg.pipeline && state.ffmpeg.pipeline.isRunning()),
                restarting: !!state.ffmpeg.restartInFlight,
                restartCount: state.ffmpeg.restartCount,
                consecutiveFailures: state.ffmpeg.consecutiveFailures,
                lastRestartReason: state.ffmpeg.lastRestartReason,
                refreshDueInMs: state.ffmpeg.refreshDueAt ? state.ffmpeg.refreshDueAt - now : null,
                ledger: ledger ? ledger.stats() : null,
            } : null,
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
