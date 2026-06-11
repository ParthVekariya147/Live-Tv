'use strict';
/**
 * SMK TV — Unified launcher
 *
 * Roles (set via SMK_ROLE env var):
 *   (none)      → Launcher: kills old ports, spawns watchdog, opens browser, exits
 *   watchdog    → Watches API + controller, restarts either if it crashes
 *   api         → Runs the YouTube live-tv API (ESM, port 3000)
 *   controller  → Runs the React UI server (CJS, port 3004)
 */

const { spawn, execSync } = require('child_process');
const { exec } = require('child_process');
const path = require('path');
const http = require('http');
const fs   = require('fs');

const EXE   = process.execPath;
const ROLE  = process.env.SMK_ROLE || '';
const ROOT  = __dirname;
const IS_WIN = process.platform === 'win32';

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
  process.env.PORT = process.env.PORT || '3000';
  require('./live-tv-api/.bundle.cjs');
}

// ─── Controller (CJS) ────────────────────────────────────────────────────────

function runController() {
  process.env.PORT = process.env.PORT || '3004';
  require('./live-tv-controller-react/server.cjs');
}

// ─── Watchdog ────────────────────────────────────────────────────────────────

function runWatchdog() {
  console.log('[Watchdog] Starting SMK TV services...');

  function spawnService(role, port, label) {
    const child = spawn(EXE, [], {
      env: { ...process.env, SMK_ROLE: role, PORT: String(port) },
      stdio: 'ignore',
      windowsHide: true,
    });

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

  spawnService('api',        3000, 'API');
  spawnService('controller', 3004, 'Controller');

  // Keep watchdog alive
  setInterval(() => {}, 60_000);
}

// ─── Launcher ────────────────────────────────────────────────────────────────

function runLauncher() {
  console.log('\n  SMK TV — Starting...\n');

  // Register for auto-start on login (Windows only, runs once)
  if (IS_WIN) registerWindowsStartup();

  // Kill anything on ports 3000 / 3004
  killPort(3000);
  killPort(3004);

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

    waitReady('http://localhost:3004', 40, () => {
      console.log('  SMK TV is ready — opening browser.');
      if (IS_WIN) exec('start http://localhost:3004');
      else exec('open http://localhost:3004');
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
