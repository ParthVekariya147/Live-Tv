'use strict';
// Builds the ffmpeg command line and manages one running ffmpeg process for
// the LIVE relay's split-mux path. ffmpeg's only job here is MUXING — never
// transcoding: always -c:v copy -c:a copy. Output is fragmented-MP4 HLS
// (not classic MPEG-TS) because the highest-quality YouTube video stream is
// frequently VP9 or AV1, and TS only supports H.264/H.265 video — fMP4/CMAF
// segments work for any codec and still play fine in hls.js for H.264
// sources too.
//
// Ported from ffmpeg-poc/lib/ffmpegPipeline.js (validated end-to-end there
// against real YouTube VOD and Live videos), with one deliberate deviation:
// this version does NOT ask ffmpeg to generate its own master playlist
// (-master_pl_name). The PoC found ffmpeg's live-source master playlist can
// come out with zero variants (bitrate is unknown up front for a live
// input), requiring a reactive parse-error-and-retry workaround. Production
// sidesteps this proactively — relay-service.cjs already knows the selected
// format's resolution/bitrate from yt-dlp's metadata and synthesizes the
// master playlist itself (see buildFfmpegMasterPlaylist in relay-service.cjs).
//
// ONE RUN = ONE PROCESS = ONE PRIVATE NAMESPACE
// ---------------------------------------------
// A pipeline no longer owns the output directory, and it NEVER deletes
// anything. It writes to filenames stamped with its own runId
// (init_<runId>.mp4, seg_<runId>_NNNNN.m4s, run_<runId>.m3u8) and its
// playlist is private — relay-hls-ledger.cjs tails it and synthesises the
// single continuous playlist the player consumes. That is what makes a
// restart survivable: the old run's segments stay on disk and stay served
// while the new run spins up beside it, and the two can never collide.
//
// The previous design did the opposite (wiped the directory on every start,
// reused seg_00000/init.mp4 for every run) which reset #EXT-X-MEDIA-SEQUENCE
// to 0 and swapped the init segment under the player's feet — a guaranteed
// fatal hls.js error roughly every 20 minutes.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

let runCounter = 0;
function nextRunId() {
    runCounter = (runCounter + 1) % 100000;
    return `${Date.now().toString(36)}${runCounter.toString(36)}`;
}

function headerString(httpHeaders) {
    const h = httpHeaders || {};
    const lines = Object.entries(h)
        .filter(([k]) => k.toLowerCase() !== 'accept-encoding') // let ffmpeg negotiate its own
        .map(([k, v]) => `${k}: ${v}`);
    return lines.length ? lines.join('\r\n') + '\r\n' : '';
}

function reconnectFlags() {
    // Best-effort network resilience for long-lived HTTP(S) reads. Older
    // ffmpeg builds may not know every flag; unknown input options on some
    // builds are just ignored with a warning rather than a hard failure.
    //
    // -rw_timeout matters as much as the reconnect flags: without it a dead
    // socket leaves ffmpeg blocked in read() forever. The process stays alive
    // and healthy-looking while producing nothing, which is precisely the
    // failure the old code could not see (its only health signal was process
    // exit). With it, a wedged read becomes an exit, and the ledger's
    // no-new-segment watchdog catches whatever slips through.
    return [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-reconnect_on_network_error', '1',
        '-rw_timeout', '15000000', // 15s, microseconds
    ];
}

function inputBlock(format) {
    const args = [...reconnectFlags()];
    const headers = headerString(format.httpHeaders);
    if (headers) args.push('-headers', headers);
    args.push('-i', format.url);
    return args;
}

// Filenames are deliberately plain and relative (not joined with outDir):
// ffmpeg's HLS muxer derives the init segment's location by splitting the
// output path on '/' only. On Windows, path.join() produces backslash
// paths, so an absolute backslash output path makes ffmpeg fail to find a
// directory component and silently write the init segment relative to its
// OWN cwd instead of next to the playlist (confirmed by direct testing in
// ffmpeg-poc). The fix: spawn ffmpeg with cwd set to outDir (see start()
// below) and use bare relative filenames here, so there's no
// path-separator to misparse.
function buildArgs(selected, runId) {
    const names = runFilenames(runId);

    // hls_list_size 0 keeps every entry in this run's PRIVATE playlist and
    // delete_segments is gone entirely: retention is the ledger's job now, and
    // it keeps files well past the point they leave the advertised window. A
    // run is bounded (it is replaced long before its source URLs expire), so
    // the private playlist stays a few hundred lines at most.
    const hlsFlags = ['-hls_list_size', '0', '-hls_flags', 'independent_segments'];

    // YouTube Live's HLS variants (mode 'combined', consumed via ffmpeg's own
    // HLS demuxer) deliver AAC as raw ADTS inside MPEG-TS segments. Muxing
    // that directly into an MP4-family container (our fMP4 HLS output) fails
    // immediately with "Malformed AAC bitstream" / "Operation not permitted"
    // (confirmed by direct testing) — it needs repackaging to ASC via this
    // bitstream filter. DASH audio-only tracks (mode 'split') are already
    // MP4-boxed and must NOT get this filter, or it errors the same way.
    // Dormant in production v1 (only 'split' mode is ever invoked here),
    // kept intact for correctness if 'combined' mode is ever routed through
    // this pipeline too.
    const needsAdtsToAsc = selected.mode === 'combined' && /m3u8/.test(selected.combined.protocol || '');

    const outputOpts = [
        '-map_metadata', '-1',
        '-c:v', 'copy',
        '-c:a', 'copy',
        ...(needsAdtsToAsc ? ['-bsf:a', 'aac_adtstoasc'] : []),
        '-f', 'hls',
        '-hls_time', '4',
        ...hlsFlags,
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', names.initFile,
        '-hls_segment_filename', names.segmentPattern,
        names.playlistFile,
    ];

    let inputArgs;
    let mapArgs;
    if (selected.mode === 'split') {
        inputArgs = [...inputBlock(selected.video), ...inputBlock(selected.audio)];
        mapArgs = ['-map', '0:v:0', '-map', '1:a:0'];
    } else {
        inputArgs = [...inputBlock(selected.combined)];
        mapArgs = ['-map', '0:v:0?', '-map', '0:a:0?'];
    }

    return ['-hide_banner', '-loglevel', 'info', '-y', ...inputArgs, ...mapArgs, ...outputOpts];
}

function runFilenames(runId) {
    return {
        initFile: `init_${runId}.mp4`,
        playlistFile: `run_${runId}.m3u8`,
        segmentPattern: `seg_${runId}_%05d.m4s`,
    };
}

// Scans ffmpeg's stderr for the "Stream mapping" confirmation that every
// mapped stream is running in copy mode (no transcode ever requested, but
// this gives an objective, observed confirmation rather than just asserting
// it by construction).
function scanCopyConfirmation(stderrText) {
    const streamLines = stderrText.split('\n').filter((l) => /Stream #\d+:\d+.*->.*#\d+:\d+/.test(l));
    if (!streamLines.length) return null;
    return streamLines.every((l) => /\(copy\)/.test(l));
}

class FfmpegPipeline extends EventEmitter {
    constructor(ffmpegPath, outDir) {
        super();
        this.ffmpegPath = ffmpegPath;
        this.outDir = outDir;
        this.runId = nextRunId();
        Object.assign(this, runFilenames(this.runId));
        this.proc = null;
        this.stderrBuf = '';
        this._stopping = false;
        this._exited = false;
        this._readyTimer = null;
    }

    start(selected) {
        fs.mkdirSync(this.outDir, { recursive: true });
        // Deliberately NOT cleaned. Everything already in here belongs to the
        // previous run and is still being served to the player while this one
        // starts; relay-hls-ledger.cjs owns retention.

        const args = buildArgs(selected, this.runId);
        this.stderrBuf = '';
        this._stopping = false;
        this.proc = spawn(this.ffmpegPath, args, { cwd: this.outDir, stdio: ['ignore', 'ignore', 'pipe'] });

        this.proc.stderr.on('data', (d) => {
            const text = d.toString();
            this.stderrBuf += text;
            if (this.stderrBuf.length > 20000) this.stderrBuf = this.stderrBuf.slice(-20000);
            this.emit('log', text);
        });

        this.proc.on('error', (err) => {
            this._clearReadyTimer();
            this.emit('error', err);
        });

        this.proc.on('close', (code, signal) => {
            this._clearReadyTimer();
            this._exited = true;
            const copyConfirmed = scanCopyConfirmation(this.stderrBuf);
            const wasIntentional = this._stopping;
            this.emit('close', { code, signal, copyConfirmed, wasIntentional, runId: this.runId, stderrTail: this.stderrBuf.slice(-2000) });
        });

        this._pollReady();

        return { pid: this.proc.pid, runId: this.runId, args };
    }

    _clearReadyTimer() {
        if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
    }

    // Ready = this run has produced at least one complete, listed segment.
    // ffmpeg writes the playlist entry only after closing the segment file, so
    // an entry is proof of a fetchable segment, never a partial one.
    _pollReady(elapsedMs = 0) {
        this._readyTimer = null;
        if (!this.proc || this.proc.killed || this._stopping) return;
        try {
            const text = fs.readFileSync(path.join(this.outDir, this.playlistFile), 'utf8');
            if (text.includes('.m4s')) {
                this.emit('ready');
                return;
            }
        } catch (_) { /* not written yet */ }
        if (elapsedMs > 30000) {
            this.emit('ready-timeout');
            return;
        }
        this._readyTimer = setTimeout(() => this._pollReady(elapsedMs + 250), 250);
        if (this._readyTimer.unref) this._readyTimer.unref();
    }

    stop() {
        this._clearReadyTimer();
        if (!this.proc) return;
        this._stopping = true;
        try { this.proc.kill('SIGTERM'); } catch { /* noop */ }
        // SIGTERM is a request. A wedged ffmpeg can ignore it indefinitely, and
        // the old code awaited a 'close' that might never arrive — which stalled
        // loadVideo() and stopRelay() behind a process that was never going to
        // exit. Escalate on a timer so shutdown is bounded.
        const hardKill = setTimeout(() => {
            try { if (!this._exited) this.proc.kill('SIGKILL'); } catch { /* noop */ }
        }, 5000);
        if (hardKill.unref) hardKill.unref();
        this.once('close', () => clearTimeout(hardKill));
    }

    // Forceful kill that does NOT mark the stop as intentional — used when the
    // process is unresponsive. The resulting 'close' event is treated as a
    // crash, triggering recovery.
    kill() {
        this._clearReadyTimer();
        if (!this.proc) return;
        try { this.proc.kill('SIGKILL'); } catch { /* noop */ }
    }

    isRunning() {
        return !!(this.proc && !this._exited);
    }

    getCopyConfirmation() {
        return scanCopyConfirmation(this.stderrBuf);
    }
}

module.exports = { FfmpegPipeline, buildArgs, runFilenames };
