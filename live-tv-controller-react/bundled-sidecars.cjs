'use strict';
/**
 * Self-extracting sidecar payload for the packaged EXE.
 *
 * yt-dlp.exe can't be spawned from inside pkg's snapshot filesystem — it's a
 * virtual FS, so a real child process can only be launched from a real file on
 * disk. That's why findYtDlpBinary() in server.cjs only ever looks NEXT TO
 * process.execPath. The consequence was that copying just "SMK TV NN.exe" to
 * another PC produced an app where Direct Relay (and recording) silently did
 * nothing: yt-dlp.exe never travelled with it, so every /api/relay/load failed
 * with "yt-dlp not found" and LivePlayer.html quietly fell back to the YouTube
 * iframe — which reads to the operator as "the Direct Relay toggle is broken".
 *
 * Fix: build.cjs stages yt-dlp.exe (plus cookies.txt, and optionally
 * ffmpeg/ffprobe) into bundled-bin/ with a manifest.json, and package.json
 * embeds that folder as a pkg asset. On startup the packaged EXE unpacks any
 * of those files that aren't already sitting next to it — so a bare EXE copied
 * to a fresh PC becomes self-sufficient on first run.
 *
 * Rules that matter:
 *   - Extract ONLY when the target is missing. yt-dlp needs frequent updates
 *     and cookies.txt is a live session token refreshed from the controller UI
 *     (see relay-service.cjs's /api/relay/cookies); clobbering either with the
 *     stale copy baked in at build time would be a regression, not a fix.
 *   - Never throw. A failed unpack must degrade to the old "yt-dlp not found"
 *     behaviour, never stop the server from booting.
 *   - If the EXE lives somewhere unwritable (Program Files, a read-only share),
 *     fall back to a temp folder and tell the binary finders to look there too.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// __dirname inside a pkg snapshot is the virtual path of THIS file, so the
// staged payload resolves relative to it — not to process.execPath.
const PAYLOAD_DIR = path.join(__dirname, '..', 'bundled-bin');
const MANIFEST_PATH = path.join(PAYLOAD_DIR, 'manifest.json');

// Set once extraction runs, to whichever directory actually received the
// files. Null in dev (nothing to extract) and when the EXE dir was writable
// (in which case that's already the first place the finders look).
let fallbackDir = null;

function readManifest() {
    try {
        const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.files) ? parsed.files : [];
    } catch (_) {
        return []; // no payload staged in this build — nothing to unpack
    }
}

function writeFileAtomic(targetPath, buffer, mode) {
    // Write to a temp name in the same folder first: a half-written yt-dlp.exe
    // left behind by a crash/antivirus interruption would look "present" to
    // findYtDlpBinary() forever after, and never be re-extracted.
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, buffer);
    try { fs.chmodSync(tmpPath, mode); } catch (_) { /* no-op on Windows */ }
    fs.renameSync(tmpPath, targetPath);
}

function extractInto(dir, files) {
    const extracted = [];
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of files) {
        const target = path.join(dir, entry.name);
        if (fs.existsSync(target)) continue; // operator's copy always wins
        const buffer = fs.readFileSync(path.join(PAYLOAD_DIR, entry.name));
        writeFileAtomic(target, buffer, entry.executable ? 0o755 : 0o644);
        extracted.push(entry.name);
    }
    return extracted;
}

/**
 * Unpack any bundled sidecars that aren't already next to the EXE.
 * No-op outside a packaged build. Safe to call more than once.
 */
function extractBundledSidecars() {
    if (!process.pkg) return { extracted: [], dir: null };

    const files = readManifest();
    if (!files.length) {
        console.warn('[Sidecars] This build has no bundled yt-dlp — Direct Relay and recording need yt-dlp.exe placed next to the EXE manually.');
        return { extracted: [], dir: null };
    }

    const exeDir = path.dirname(process.execPath);
    try {
        const extracted = extractInto(exeDir, files);
        if (extracted.length) console.log(`[Sidecars] Unpacked next to the EXE: ${extracted.join(', ')}`);
        return { extracted, dir: exeDir };
    } catch (err) {
        console.warn(`[Sidecars] Could not unpack next to the EXE (${err.message}) — falling back to a temp folder.`);
    }

    // EXE folder unwritable — unpack somewhere we're allowed to write and let
    // the finders pick it up from there.
    try {
        const tmpDir = path.join(os.tmpdir(), 'smk-tv-bin');
        const extracted = extractInto(tmpDir, files);
        fallbackDir = tmpDir;
        if (extracted.length) console.log(`[Sidecars] Unpacked to ${tmpDir}: ${extracted.join(', ')}`);
        return { extracted, dir: tmpDir };
    } catch (err) {
        console.error(`[Sidecars] Unpack failed entirely: ${err.message} — Direct Relay will report "yt-dlp not found".`);
        return { extracted: [], dir: null };
    }
}

/** Extra directory the binary finders should search, or null. */
function getFallbackDir() {
    return fallbackDir;
}

module.exports = { extractBundledSidecars, getFallbackDir };
