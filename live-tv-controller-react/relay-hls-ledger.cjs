'use strict';
/**
 * Server-side HLS origin (packager) for the LIVE relay's ffmpeg split-mux path.
 *
 * WHY THIS EXISTS
 * ---------------
 * Previously the relay served ffmpeg's own stream.m3u8 straight off disk, and
 * every ffmpeg restart (watchdog URL refresh, crash recovery) wiped the output
 * directory and started the playlist again from #EXT-X-MEDIA-SEQUENCE:0 with
 * the same segment filenames and a brand-new init.mp4 at the same URL. To
 * hls.js that is a playlist travelling backwards in time plus a silently
 * swapped initialisation segment — it fataled with bufferAppendError /
 * levelLoadError, and LivePlayer.html turned any fatal error into a permanent
 * fallback to the YouTube iframe. That is the "live stream stops after a while"
 * bug, and it fired on a ~20 minute timer.
 *
 * THE FIX (how real packagers do it)
 * ----------------------------------
 * ffmpeg is demoted to a segmenter: each ffmpeg run writes uniquely-named
 * segments (seg_<runId>_NNNNN.m4s), its own init (init_<runId>.mp4) and its own
 * private playlist (run_<runId>.m3u8) that nothing outside this file ever
 * serves. This ledger tails those private playlists and maintains ONE global,
 * strictly monotonic segment list across every run, then synthesises the
 * playlist the player actually consumes. A restart becomes an ordinary HLS
 * period change: #EXT-X-DISCONTINUITY plus a new #EXT-X-MAP, which every
 * compliant player (hls.js included) handles without dropping the stream.
 *
 * Consequences that fall out of this design:
 *   - #EXT-X-MEDIA-SEQUENCE never goes backwards, so the player never rewinds.
 *   - Segment filenames are never reused, so nothing is served from a stale
 *     cache and no two runs can overwrite each other's output.
 *   - The playlist keeps serving the previous run's segments while a new
 *     ffmpeg is still starting, so a restart is a buffer dip, not a 404 storm.
 *   - Retention is decoupled from the advertised window: files live on disk
 *     well past the point they scroll out of the playlist, which kills the
 *     "segment deleted while a slow client was still fetching it" 404.
 *   - Segments are only published once ffmpeg has written their entry into its
 *     own playlist, which it does after closing the file — so a half-written
 *     segment can never be advertised.
 */

const fs = require('fs');
const path = require('path');

// Advertised window. Bigger than ffmpeg's old 8 because window size costs no
// latency (hls.js joins liveSyncDurationCount segments from the END, not the
// start) and it buys a late/slow client room to catch up.
const DEFAULT_WINDOW = 12;   // ~48s at 4s segments
// Files kept on disk after they scroll out of the window. This is the fix for
// ffmpeg's delete_segments + default hls_delete_threshold 1, which unlinked a
// segment one segment after it left the list — any client hiccup became a 404
// and then a fatal fragLoadError.
const DEFAULT_RETAIN = 30;   // ~120s at 4s segments
const POLL_MS = 500;

function parseRunPlaylist(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let pendingDuration = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXTINF:')) {
            const v = parseFloat(line.slice(8));
            pendingDuration = Number.isFinite(v) ? v : null;
            continue;
        }
        if (line.startsWith('#')) continue;
        out.push({ name: line, duration: pendingDuration == null ? 4 : pendingDuration });
        pendingDuration = null;
    }
    return out;
}

class HlsLedger {
    constructor(dir, { window = DEFAULT_WINDOW, retain = DEFAULT_RETAIN } = {}) {
        this.dir = dir;
        this.window = window;
        // Retention must always exceed the advertised window, otherwise the
        // pruner would delete files the playlist is still pointing at.
        this.retain = Math.max(retain, window + 6);
        this.runs = new Map();
        this.segments = [];
        this.nextSeq = 0;
        this.discCounter = 0;
        this.lastSegmentAt = null;
        this.targetDuration = 4;
        this.timer = null;
        this.onSegment = null;
        this._anyRunPublished = false;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            try { this.poll(); } catch (_) { /* never let a poll kill the relay */ }
        }, POLL_MS);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    /** Full reset — only on a NEW video load, never on a restart of the same one. */
    reset() {
        this.runs.clear();
        this.segments = [];
        this.nextSeq = 0;
        this.discCounter = 0;
        this.lastSegmentAt = null;
        this._anyRunPublished = false;
        try {
            for (const f of fs.readdirSync(this.dir)) {
                try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch (_) {}
            }
        } catch (_) { /* directory may not exist yet */ }
    }

    /**
     * A run's files become the ledger's responsibility the moment ffmpeg is
     * spawned, but a `staged` run contributes NOTHING to the playlist yet.
     *
     * That distinction is what makes make-before-break safe. During a restart
     * two ffmpeg processes are briefly alive at once; if both fed the playlist
     * their segments would interleave (…A6, B0, A7, B1…) and produce garbage.
     * The replacement stays staged until it has proven it can produce output,
     * at which point promoteRun() swaps the periods over atomically.
     */
    registerRun({ runId, playlistFile, initFile, staged = false }) {
        this.runs.set(runId, {
            runId,
            playlistFile,
            initFile,
            published: new Set(),
            active: true,
            staged,
            needsDiscontinuity: !staged && this._anyRunPublished,
        });
        this.start();
    }

    /**
     * Cut over to a staged run. Everything it has already written except its
     * newest segment is discarded: the outgoing run covered that wall-clock time
     * already, so replaying it would show the viewer several seconds twice.
     */
    promoteRun(runId) {
        const run = this.runs.get(runId);
        if (!run || !run.staged) return;
        let listed = [];
        try {
            listed = parseRunPlaylist(fs.readFileSync(path.join(this.dir, run.playlistFile), 'utf8'));
        } catch (_) { /* nothing written yet — nothing to skip */ }
        for (const seg of listed.slice(0, -1)) run.published.add(seg.name);
        run.staged = false;
        run.needsDiscontinuity = this._anyRunPublished;
    }

    /**
     * Stop taking segments from a run. Called the moment its replacement goes
     * live (make-before-break cutover) so the two runs' overlapping output does
     * not interleave in the ledger.
     */
    retireRun(runId) {
        const run = this.runs.get(runId);
        if (run) run.active = false;
    }

    /**
     * A run that never made it on air. Its output was never advertised, so it
     * can be deleted outright rather than left to accumulate on disk after every
     * failed restart attempt.
     */
    discardRun(runId) {
        const run = this.runs.get(runId);
        if (!run) return;
        this.runs.delete(runId);
        if (this.segments.some(s => s.runId === runId)) return; // it did publish — leave its files alone
        const prefix = `seg_${runId}_`;
        try {
            for (const f of fs.readdirSync(this.dir)) {
                if (f === run.initFile || f === run.playlistFile || f.startsWith(prefix)) {
                    try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch (_) {}
                }
            }
        } catch (_) {}
    }

    poll() {
        for (const run of this.runs.values()) {
            if (!run.active || run.staged) continue;
            let text;
            try {
                text = fs.readFileSync(path.join(this.dir, run.playlistFile), 'utf8');
            } catch (_) { continue; } // not written yet, or mid-rewrite
            for (const { name, duration } of parseRunPlaylist(text)) {
                if (run.published.has(name)) continue;
                run.published.add(name);
                this._append(run, name, duration);
            }
        }
        this._prune();
    }

    _append(run, name, duration) {
        const discontinuity = run.needsDiscontinuity;
        if (discontinuity) {
            run.needsDiscontinuity = false;
            this.discCounter++;
        }
        this.segments.push({
            runId: run.runId,
            name,
            duration,
            seq: this.nextSeq++,
            discontinuity,
            discIndex: this.discCounter,
            map: run.initFile,
            addedAt: Date.now(),
        });
        if (duration > this.targetDuration) this.targetDuration = duration;
        this.lastSegmentAt = Date.now();
        this._anyRunPublished = true;
        if (this.onSegment) { try { this.onSegment(); } catch (_) {} }
    }

    _prune() {
        if (this.segments.length > this.retain) {
            const dropped = this.segments.splice(0, this.segments.length - this.retain);
            for (const seg of dropped) {
                try { fs.rmSync(path.join(this.dir, seg.name), { force: true }); } catch (_) {}
            }
        }
        // An init segment may only go once no retained segment references it AND
        // its run has been retired — a live run's init is still needed by every
        // segment it has yet to produce.
        const stillReferenced = new Set(this.segments.map(s => s.map));
        for (const [runId, run] of this.runs) {
            if (run.active || stillReferenced.has(run.initFile)) continue;
            try { fs.rmSync(path.join(this.dir, run.initFile), { force: true }); } catch (_) {}
            try { fs.rmSync(path.join(this.dir, run.playlistFile), { force: true }); } catch (_) {}
            this.runs.delete(runId);
        }
    }

    hasSegments() { return this.segments.length > 0; }

    /**
     * ms since the last new segment appeared — the only honest liveness signal
     * for the ffmpeg path, whose process can stay alive indefinitely (via
     * -reconnect) while producing nothing at all.
     */
    msSinceLastSegment() {
        return this.lastSegmentAt == null ? null : Date.now() - this.lastSegmentAt;
    }

    buildMediaPlaylist() {
        const win = this.segments.slice(-this.window);
        if (!win.length) return null;
        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(this.targetDuration))}`,
            `#EXT-X-MEDIA-SEQUENCE:${win[0].seq}`,
            `#EXT-X-DISCONTINUITY-SEQUENCE:${win[0].discIndex}`,
        ];
        let currentMap = null;
        win.forEach((seg, i) => {
            // The window's first segment never carries an explicit tag: any
            // discontinuity at or before it is already reported by
            // EXT-X-DISCONTINUITY-SEQUENCE above, and emitting both would
            // double-count the period for the player.
            if (seg.discontinuity && i > 0) {
                lines.push('#EXT-X-DISCONTINUITY');
                currentMap = null;
            }
            if (seg.map !== currentMap) {
                lines.push(`#EXT-X-MAP:URI="${seg.map}"`);
                currentMap = seg.map;
            }
            lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
            lines.push(seg.name);
        });
        lines.push('');
        return lines.join('\n');
    }

    stats() {
        return {
            segments: this.segments.length,
            mediaSequence: this.segments.length ? this.segments[this.segments.length - 1].seq : null,
            discontinuities: this.discCounter,
            runs: this.runs.size,
            msSinceLastSegment: this.msSinceLastSegment(),
        };
    }
}

module.exports = { HlsLedger, parseRunPlaylist };
