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

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

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
    return [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-reconnect_on_network_error', '1',
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
function buildArgs(selected) {
    const m3u8Path = 'stream.m3u8';
    const segPath = 'seg_%05d.m4s';

    // LIVE relay always uses a rolling window (bounded list, old segments
    // deleted) — the player only ever needs to join near the live edge.
    const hlsFlags = ['-hls_list_size', '8', '-hls_flags', 'independent_segments+delete_segments+append_list'];

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
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', segPath,
        m3u8Path,
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
        this.proc = null;
        this.stderrBuf = '';
        this._stopping = false;
    }

    start(selected) {
        fs.mkdirSync(this.outDir, { recursive: true });
        for (const f of fs.readdirSync(this.outDir)) {
            fs.rmSync(path.join(this.outDir, f), { force: true });
        }

        const args = buildArgs(selected);
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
            this.emit('error', err);
        });

        this.proc.on('close', (code, signal) => {
            const copyConfirmed = scanCopyConfirmation(this.stderrBuf);
            const wasIntentional = this._stopping;
            this.emit('close', { code, signal, copyConfirmed, wasIntentional, stderrTail: this.stderrBuf.slice(-2000) });
        });

        this._pollReady();

        return { pid: this.proc.pid, args };
    }

    _pollReady(elapsedMs = 0) {
        if (!this.proc || this.proc.killed) return;
        const m3u8Path = path.join(this.outDir, 'stream.m3u8');
        if (fs.existsSync(m3u8Path)) {
            const text = fs.readFileSync(m3u8Path, 'utf8');
            if (text.includes('.m4s')) {
                this.emit('ready');
                return;
            }
        }
        if (elapsedMs > 30000) {
            this.emit('ready-timeout');
            return;
        }
        setTimeout(() => this._pollReady(elapsedMs + 250), 250);
    }

    stop() {
        if (!this.proc) return;
        this._stopping = true;
        try { this.proc.kill('SIGTERM'); } catch { /* noop */ }
    }

    // Forceful kill that does NOT mark the stop as intentional — used when the
    // process is unresponsive. The resulting 'close' event is treated as a
    // crash, triggering recovery.
    kill() {
        if (!this.proc) return;
        try { this.proc.kill('SIGKILL'); } catch { /* noop */ }
    }

    getCopyConfirmation() {
        return scanCopyConfirmation(this.stderrBuf);
    }
}

module.exports = { FfmpegPipeline, buildArgs };
