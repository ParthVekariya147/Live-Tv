'use strict';
// Manages the local PO Token provider server (bgutil-ytdlp-pot-provider).
//
// Why this exists: without a PO Token, YouTube's 'web' client — the only
// client that reports the TRUE full quality ladder, matching what a browser
// sees — returns zero usable formats, so yt-dlp falls back to clients (e.g.
// 'tv') that authenticate fine but are capped at 1080p on live streams by
// YouTube itself. That gap (confirmed via screenshot evidence against two
// separate live streams: one capped 2160p->1080p, one capped 1440p->1080p)
// is exactly what this closes. Source is vendored under pot-server-src/
// (gitignored — see README for the one-time setup command) and built to
// pot-server-src/server/build/main.js. Everything here is optional and
// best-effort: if the source isn't present or the server fails to start,
// resolveStream.js's yt-dlp calls simply fall back to their prior (capped)
// behavior rather than erroring — this never blocks startup.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SERVER_ENTRY = path.join(__dirname, '..', 'pot-server-src', 'server', 'build', 'main.js');
const DEFAULT_PORT = 4416;

function ping(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

let child = null;

// Idempotent: if a POT server (ours or someone else's, e.g. started manually
// or by another tool) already answers on the port, leaves it alone and just
// reports it as available. Only spawns a new process if nothing responds.
async function ensureRunning(port = DEFAULT_PORT) {
  if (await ping(port, 1000)) {
    return { available: true, started: false, port };
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    return { available: false, started: false, port, reason: 'pot-server-src not built (see README setup step)' };
  }
  child = spawn(process.execPath, [SERVER_ENTRY, '--port', String(port)], {
    cwd: path.dirname(SERVER_ENTRY),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.on('error', () => { child = null; });
  child.unref();

  // Poll briefly for it to come up rather than assuming a fixed delay.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await ping(port, 500)) return { available: true, started: true, port };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { available: false, started: true, port, reason: 'spawned but did not answer /ping within 8s' };
}

function stop() {
  if (child && !child.killed) {
    try { child.kill(); } catch { /* noop */ }
  }
  child = null;
}

module.exports = { ensureRunning, stop, DEFAULT_PORT };
