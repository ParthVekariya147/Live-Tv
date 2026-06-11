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

const { spawn } = require('child_process');
const { exec, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const EXE   = process.execPath;
const ROLE  = process.env.SMK_ROLE || '';
const ROOT  = __dirname;          // virtual /snapshot/... when bundled by pkg

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
      console.error(`[Watchdog] ${label} spawn error:`, err.message);
      setTimeout(() => spawnService(role, port, label), 3000);
    });

    console.log(`[Watchdog] ${label} started (pid ${child.pid})`);
    return child;
  }

  spawnService('api',        3000, 'API');
  spawnService('controller', 3004, 'Controller');

  // Keep watchdog process alive indefinitely
  setInterval(() => {}, 60_000);
}

// ─── Launcher ────────────────────────────────────────────────────────────────

function runLauncher() {
  console.log('\n  SMK TV — Starting...\n');

  // Kill anything on ports 3000 / 3004
  killPort(3000);
  killPort(3004);

  // Give killed processes a moment to fully exit
  setTimeout(() => {
    // Spawn watchdog as a detached background process (no visible window)
    const watchdog = spawn(EXE, [], {
      env: { ...process.env, SMK_ROLE: 'watchdog' },
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    watchdog.unref(); // Don't block launcher from exiting

    console.log('  Services starting in background...');
    console.log('  Waiting for http://localhost:3004\n');

    // Wait up to 40s for controller to be ready, then open browser
    waitReady('http://localhost:3004', 40, () => {
      console.log('  SMK TV is ready — opening browser.');
      exec('start http://localhost:3004');
      // Launcher exits; watchdog + services keep running
      setTimeout(() => process.exit(0), 500);
    });
  }, 1000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function killPort(port) {
  try {
    // Windows: parse netstat to find PID then kill it
    const out = execSync(`netstat -aon 2>nul`, { encoding: 'utf8', timeout: 3000 });
    const lines = out.split('\n');
    lines.forEach((line) => {
      if (line.includes(`:${port} `) || line.includes(`:${port}\t`)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') {
          try { execSync(`taskkill /F /PID ${pid} 2>nul`, { timeout: 2000 }); } catch {}
        }
      }
    });
  } catch {}
}

function waitReady(url, maxAttempts, cb, attempt = 0) {
  if (attempt >= maxAttempts) {
    // Timed out — open anyway
    cb();
    return;
  }

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
