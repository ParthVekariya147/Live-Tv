'use strict';
/**
 * SMK TV — Unified launcher
 *
 * Roles (set via SMK_ROLE env var):
 *   (none)      → Launcher: kills old ports, spawns watchdog, opens browser, exits
 *   watchdog    → Watches API + controller, restarts either if it crashes
 *   api         → Runs the YouTube live-tv API (ESM, port from API_PORT)
 *   controller  → Runs the React UI server (CJS, port from CONTROLLER_PORT)
 *
 * Ports and URLs are read from .env (see .env.example) — no more hardcoded ports.
 */

const { spawn, execSync } = require('child_process');
const { exec } = require('child_process');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const { loadEnv } = require('./env-loader.cjs');
const { writePid } = require('./smk-control.cjs');

const EXE   = process.execPath;
const ROLE  = process.env.SMK_ROLE || '';
const ROOT  = __dirname;
const IS_WIN = process.platform === 'win32';

// __dirname inside a pkg snapshot is a virtual path, not the real folder the
// .exe lives in — so a real .env dropped next to the .exe must be resolved
// against process.execPath's directory instead, or it would never be found.
const ENV_DIR = process.pkg ? path.dirname(EXE) : __dirname;

// Unpack the embedded payload (.env, cloudflared.exe, yt-dlp.exe, cookies.txt)
// BEFORE anything reads it. Ordering is the whole point of doing it here rather
// than leaving it to server.cjs:
//   - loadEnv() two lines down needs .env to already exist, otherwise the very
//     first run of a fresh copy boots with no Firebase credentials and every
//     push notification is silently dropped.
//   - tunnel-manager.cjs decides whether cloudflared.exe exists at *require*
//     time, and server.cjs requires it before its own extract call — so a
//     first run would have permanently logged "tunnel cannot start".
// Extraction never overwrites a file that's already there and never throws, so
// running it here as well as in server.cjs is free.
let payloadDir = null;
try {
  payloadDir = require('./live-tv-controller-react/bundled-sidecars.cjs').extractBundledSidecars().dir;
} catch (_) { /* dev tree without the payload staged — nothing to unpack */ }

loadEnv(path.join(ENV_DIR, '.env'));
// When the EXE's own folder is read-only (Program Files, a network share) the
// payload lands in a temp folder instead. loadEnv never overwrites an already
// set variable, so reading that copy second keeps the operator's real .env
// authoritative wherever one exists.
if (payloadDir && payloadDir !== ENV_DIR) loadEnv(path.join(payloadDir, '.env'));

const API_PORT        = Number(process.env.API_PORT) || 3000;
const CONTROLLER_PORT = Number(process.env.CONTROLLER_PORT) || 3004;

// ─── Role dispatch ────────────────────────────────────────────────────────────

if (ROLE === 'api') {
  runApi();
} else if (ROLE === 'controller') {
  runController();
} else if (ROLE === 'watchdog') {
  runWatchdog();
} else {
  runLauncher();
}

// ─── API (pre-bundled CJS by esbuild) ────────────────────────────────────────

function runApi() {
  process.env.PORT = process.env.PORT || String(API_PORT);
  require('./live-tv-api/.bundle.cjs');
}

// ─── Controller (CJS) ────────────────────────────────────────────────────────

function runController() {
  process.env.PORT = process.env.PORT || String(CONTROLLER_PORT);
  require('./live-tv-controller-react/server.cjs');
}

// ─── Watchdog ────────────────────────────────────────────────────────────────

function runWatchdog() {
  console.log('[Watchdog] Starting SMK TV services...');
  writePid(ENV_DIR, 'watchdog', process.pid);

  function spawnService(role, port, label) {
    const child = spawn(EXE, [], {
      env: { ...process.env, SMK_ROLE: role, PORT: String(port) },
      stdio: 'ignore',
      windowsHide: true,
    });
    writePid(ENV_DIR, role, child.pid);

    child.on('exit', (code) => {
      console.log(`[Watchdog] ${label} exited (code ${code}) — restarting in 3s`);
      setTimeout(() => spawnService(role, port, label), 3000);
    });

    child.on('error', (err) => {
      console.error(`[Watchdog] ${label} error: ${err.message} — restarting in 3s`);
      setTimeout(() => spawnService(role, port, label), 3000);
    });

    console.log(`[Watchdog] ${label} started (pid ${child.pid})`);
    return child;
  }

  spawnService('api',        API_PORT,        'API');
  spawnService('controller', CONTROLLER_PORT, 'Controller');

  // Keep watchdog alive
  setInterval(() => {}, 60_000);
}

// ─── Launcher ────────────────────────────────────────────────────────────────

function runLauncher() {
  console.log('\n  SMK TV — Starting...\n');

  // Register for auto-start on login (Windows only, runs once)
  if (IS_WIN) registerWindowsStartup();

  // Kill anything on the configured API / Controller ports
  killPort(API_PORT);
  killPort(CONTROLLER_PORT);

  setTimeout(() => {
    // Spawn watchdog as detached background process (no visible window)
    const watchdog = spawn(EXE, [], {
      env: { ...process.env, SMK_ROLE: 'watchdog' },
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    watchdog.unref();

    console.log('  Services starting in background...');

    const controllerUrl = `http://localhost:${CONTROLLER_PORT}`;
    waitReady(controllerUrl, 40, () => {
      console.log('  SMK TV is ready — opening browser.');
      if (IS_WIN) exec(`start ${controllerUrl}`);
      else exec(`open ${controllerUrl}`);
      setTimeout(() => process.exit(0), 500);
    });
  }, 1000);
}

// ─── Windows startup registration ────────────────────────────────────────────

function registerWindowsStartup() {
  try {
    const key  = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
    const name = 'SMK TV';
    const exePath = EXE.replace(/\\/g, '\\\\');

    // Check if already registered with this exact path
    try {
      const out = execSync(`reg query "${key}" /v "${name}"`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
      if (out.includes(EXE)) return; // already correct
    } catch {}

    // Register — runs minimized on login
    execSync(`reg add "${key}" /v "${name}" /t REG_SZ /d "${EXE}" /f`, { stdio: 'ignore' });
    console.log('  Auto-start on login registered.');
  } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function killPort(port) {
  try {
    if (IS_WIN) {
      const out = execSync('netstat -aon', { encoding: 'utf8', timeout: 3000 });
      out.split('\n').forEach((line) => {
        if (line.includes(`:${port} `) || line.includes(`:${port}\t`)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== '0') {
            try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 2000 }); } catch {}
          }
        }
      });
    } else {
      try { execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' }); } catch {}
    }
  } catch {}
}

function waitReady(url, maxAttempts, cb, attempt = 0) {
  if (attempt >= maxAttempts) { cb(); return; }

  const req = http.get(url, (res) => {
    if (res.statusCode === 200) { cb(); }
    else { retry(); }
  });

  req.on('error', retry);
  req.setTimeout(1000, () => { req.destroy(); retry(); });

  function retry() {
    setTimeout(() => waitReady(url, maxAttempts, cb, attempt + 1), 1000);
  }
}
