'use strict';
/**
 * PO-Token Provider Manager — auto-starts the bgutil PO-Token HTTP server
 * that relay-service.cjs's (and RecordingService's) yt-dlp calls depend on
 * via the bgutil-ytdlp-pot-provider plugin installed at
 * windows/exe/yt-dlp-plugins/bgutil-ytdlp-pot-provider/.
 *
 * Without a PO-Token provider, YouTube's current anti-bot posture routinely
 * rejects yt-dlp's requests outright ("Sign in to confirm you're not a
 * bot") even with valid cookies — cookies alone stopped being sufficient.
 * See https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide and
 * https://github.com/Brainicism/bgutil-ytdlp-pot-provider.
 *
 * This is intentionally best-effort: if the server binary/build is missing
 * (e.g. not yet cloned+built, or not deployed alongside a packaged EXE),
 * this logs a warning and does nothing — yt-dlp calls still proceed without
 * a PO-Token provider rather than the whole app failing to start. Same
 * "safe fallback, never a hard failure" philosophy as relay-service.cjs.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 4416;

function resolveServerEntry() {
    // Dev: repo-root sibling of live-tv-controller-react/. Packaged: next to
    // the EXE (deploy pot-provider/ alongside windows/exe/, same convention
    // as ffmpeg.exe/yt-dlp.exe) — same two-tier pattern as findYtDlpBinary().
    return process.pkg
        ? path.join(path.dirname(process.execPath), 'pot-provider', 'server', 'build', 'main.js')
        : path.resolve(__dirname, '..', 'pot-provider', 'server', 'build', 'main.js');
}

function checkHealth() {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${PORT}/ping`, { timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

let proc = null;
let stopped = false;

async function startPotProvider() {
    const serverEntry = resolveServerEntry();
    if (!fs.existsSync(serverEntry)) {
        console.warn(`[PO-Token] Server build not found at ${serverEntry} — yt-dlp will run without a PO-Token provider (more likely to hit YouTube bot-checks). See pot-provider/README or the setup notes in relay-service.cjs.`);
        return;
    }

    // Another instance (e.g. a manual `node build/main.js`, or a previous
    // run that didn't exit cleanly) may already be listening — don't spawn
    // a second one competing for the same port.
    if (await checkHealth()) {
        console.log('[PO-Token] Provider already running on port', PORT, '— not starting a second instance.');
        return;
    }

    console.log('[PO-Token] Starting bgutil PO-Token provider server...');
    proc = spawn('node', [serverEntry], {
        cwd: path.dirname(serverEntry),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d) => process.stdout.write(`[PO-Token] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[PO-Token] ${d}`));

    proc.on('error', (err) => {
        console.warn('[PO-Token] Failed to start provider server:', err.message);
        proc = null;
    });

    proc.on('exit', (code, signal) => {
        proc = null;
        if (stopped) return; // intentional shutdown
        console.warn(`[PO-Token] Provider server exited (code=${code}, signal=${signal}) — restarting in 10s...`);
        setTimeout(startPotProvider, 10000);
    });
}

function stopPotProvider() {
    stopped = true;
    if (proc) { try { proc.kill(); } catch { /* noop */ } proc = null; }
}

module.exports = { startPotProvider, stopPotProvider, checkHealth };
