#!/usr/bin/env node
'use strict';
/**
 * SMK TV — Unified Command Runner
 * Usage:  node smk.cjs [command]
 *
 * Commands:
 *   dev       Start dev mode  (Vite on :3003 + API server on :3004)
 *   build     Build React UI  (creates live-tv-controller-react/dist/)
 *   exe       Build Windows EXE  (runs build.cjs, outputs to windows/exe/)
 *   start     Start production services via PM2
 *   stop      Stop all PM2 services
 *   restart   Restart PM2 services
 *   install   Install all npm dependencies
 *   status    Show PM2 status
 *   logs      Tail PM2 logs
 *   help      Show this help
 *
 * Run with no argument for interactive menu.
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const readline = require('readline');

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT    = __dirname;
const REACT   = path.join(ROOT, 'live-tv-controller-react');
const API     = path.join(ROOT, 'live-tv-api');
const ECOS    = path.join(ROOT, 'ecosystem.config.cjs');
const IS_WIN  = process.platform === 'win32';

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    cyan:   '\x1b[36m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    red:    '\x1b[31m',
    gray:   '\x1b[90m',
    white:  '\x1b[97m',
};
const cyan   = s => C.cyan   + s + C.reset;
const green  = s => C.green  + s + C.reset;
const yellow = s => C.yellow + s + C.reset;
const red    = s => C.red    + s + C.reset;
const gray   = s => C.gray   + s + C.reset;
const bold   = s => C.bold   + s + C.reset;

// ── Helpers ───────────────────────────────────────────────────────────────────
function run(cmd, cwd, opts = {}) {
    console.log(gray(`\n> ${cmd}`));
    execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit', shell: true, ...opts });
}

function tryRun(cmd, cwd) {
    try { run(cmd, cwd); return true; }
    catch { return false; }
}

function header(title) {
    const line = '─'.repeat(50);
    console.log('\n' + cyan(line));
    console.log(cyan('  SMK TV — ') + bold(title));
    console.log(cyan(line));
}

function ok(msg)   { console.log(green('  ✓ ') + msg); }
function warn(msg) { console.log(yellow('  ⚠ ') + msg); }
function err(msg)  { console.log(red('  ✗ ') + msg); }
function info(msg) { console.log(cyan('  → ') + msg); }

function nodeRequired() {
    try { execSync('node --version', { stdio: 'ignore' }); }
    catch { err('Node.js is not installed. Get it from: https://nodejs.org'); process.exit(1); }
}

function pm2Cmd() {
    // Try global pm2, then local npm bin
    const candidates = ['pm2'];
    if (IS_WIN) candidates.push(path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd'));
    const local = path.join(ROOT, 'node_modules', '.bin', IS_WIN ? 'pm2.cmd' : 'pm2');
    candidates.push(local);

    for (const c of candidates) {
        try { execSync(`"${c}" --version`, { stdio: 'ignore' }); return `"${c}"`; }
        catch { /* try next */ }
    }
    return null;
}

function ensurePm2() {
    let cmd = pm2Cmd();
    if (!cmd) {
        info('PM2 not found — installing globally...');
        run('npm install -g pm2');
        cmd = pm2Cmd();
        if (!cmd) { err('PM2 install failed. Run: npm install -g pm2'); process.exit(1); }
    }
    return cmd;
}

function freePorts() {
    if (IS_WIN) {
        for (const port of [3000, 3003, 3004]) {
            try {
                const pids = execSync(`netstat -aon 2>nul | findstr ":${port} "`, { shell: true })
                    .toString().trim().split('\n')
                    .map(l => l.trim().split(/\s+/).pop())
                    .filter(p => p && /^\d+$/.test(p));
                pids.forEach(pid => tryRun(`taskkill /F /PID ${pid}`));
            } catch { /* port already free */ }
        }
    } else {
        tryRun('lsof -ti :3000,:3003,:3004 | xargs kill -9 2>/dev/null || true');
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdInstall() {
    header('Install Dependencies');
    nodeRequired();

    info('Installing root dependencies...');
    run('npm install', ROOT);

    if (fs.existsSync(path.join(API, 'package.json'))) {
        info('Installing live-tv-api dependencies...');
        run('npm install', API);
    }

    info('Installing live-tv-controller-react dependencies...');
    run('npm install', REACT);

    ok('All dependencies installed.');
}

function cmdBuild() {
    header('Build React UI');
    nodeRequired();

    if (!fs.existsSync(path.join(REACT, 'node_modules'))) {
        warn('node_modules missing — running install first...');
        run('npm install', REACT);
    }

    info('Running Vite build...');
    run('npm run build', REACT);

    ok('React build complete → live-tv-controller-react/dist/');
}

function cmdExe() {
    header('Build Windows EXE');
    nodeRequired();

    if (!fs.existsSync(path.join(ROOT, 'build.cjs'))) {
        err('build.cjs not found in project root.');
        process.exit(1);
    }

    run('node build.cjs', ROOT);
}

function cmdDev() {
    header('Dev Mode');
    nodeRequired();

    if (!fs.existsSync(path.join(REACT, 'node_modules'))) {
        warn('node_modules missing — running install first...');
        run('npm install', REACT);
    }
    if (fs.existsSync(path.join(API, 'package.json')) && !fs.existsSync(path.join(API, 'node_modules'))) {
        warn('API node_modules missing — running install first...');
        run('npm install', API);
    }

    info('Freeing ports 3000, 3003, 3004...');
    freePorts();

    console.log('\n' + cyan('  Starting services:'));
    info('API server  → http://localhost:3004 (and ws://localhost:3004/ws)');
    info('Vite dev    → http://localhost:3003');
    if (fs.existsSync(path.join(API, 'server.js'))) {
        info('YouTube API → http://localhost:3000');
    }
    console.log('\n' + yellow('  Press Ctrl+C to stop all services.\n'));

    const procs = [];

    // API server (controller)
    const api = spawn('node', ['server.cjs'], { cwd: REACT, stdio: 'inherit', shell: false });
    procs.push(api);

    // YouTube API (optional)
    if (fs.existsSync(path.join(API, 'server.js'))) {
        const yt = spawn('node', ['live-tv-api/server.js'], { cwd: ROOT, stdio: 'inherit', shell: false });
        procs.push(yt);
    }

    // Vite dev server
    const vite = spawn(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'dev'], { cwd: REACT, stdio: 'inherit', shell: false });
    procs.push(vite);

    const cleanup = () => {
        procs.forEach(p => { try { p.kill(); } catch {} });
        process.exit(0);
    };
    process.on('SIGINT',  cleanup);
    process.on('SIGTERM', cleanup);
}

function cmdStart() {
    header('Start (Production via PM2)');
    nodeRequired();
    const pm2 = ensurePm2();

    if (!fs.existsSync(path.join(REACT, 'node_modules'))) {
        warn('node_modules missing — running install first...');
        run('npm install', REACT);
    }
    if (fs.existsSync(path.join(API, 'package.json')) && !fs.existsSync(path.join(API, 'node_modules'))) {
        warn('API node_modules missing — running install first...');
        run('npm install', API);
    }
    if (!fs.existsSync(path.join(REACT, 'dist', 'index.html'))) {
        warn('React build missing — building now...');
        run('npm run build', REACT);
    }

    info('Freeing ports...');
    freePorts();

    if (fs.existsSync(ECOS)) {
        info('Starting services via ecosystem config...');
        run(`${pm2} startOrRestart "${ECOS}" --update-env`);
    } else {
        info('No ecosystem.config.cjs found — starting services directly...');
        run(`${pm2} start live-tv-controller-react/server.cjs --name smk-controller`);
        if (fs.existsSync(path.join(API, 'server.js'))) {
            run(`${pm2} start live-tv-api/server.js --name smk-api`);
        }
    }

    run(`${pm2} save`);

    ok('SMK TV is running!');
    info('Dashboard → http://localhost:3004');
    info('To stop   → node smk.cjs stop');
}

function cmdStop() {
    header('Stop ALL Services');

    const pm2 = pm2Cmd();
    if (pm2) {
        info('Stopping all PM2 processes...');
        tryRun(`${pm2} stop all`);

        info('Deleting all PM2 processes...');
        tryRun(`${pm2} delete all`);

        info('Killing PM2 daemon...');
        tryRun(`${pm2} kill`);

        ok('PM2 fully stopped.');
    } else {
        warn('PM2 not found — skipping PM2 shutdown.');
    }

    info('Freeing ports 3000, 3003, 3004...');
    if (IS_WIN) {
        for (const port of [3000, 3003, 3004]) {
            try {
                const pids = execSync(`netstat -aon 2>nul | findstr ":${port} "`, { shell: true })
                    .toString().trim().split('\n')
                    .map(l => l.trim().split(/\s+/).pop())
                    .filter(p => p && /^\d+$/.test(p));
                pids.forEach(pid => tryRun(`taskkill /F /PID ${pid}`));
            } catch { /* already free */ }
        }
    } else {
        for (const port of [3000, 3003, 3004]) {
            tryRun(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`);
        }
    }

    ok('All services stopped. Ports 3000 / 3003 / 3004 are free.');
}

function cmdRestart() {
    header('Restart Services');
    const pm2 = ensurePm2();

    if (fs.existsSync(ECOS)) {
        run(`${pm2} startOrRestart "${ECOS}" --update-env`);
    } else {
        run(`${pm2} restart smk-api smk-controller`);
    }
    ok('Services restarted.');
}

function cmdStatus() {
    header('Service Status');
    const pm2 = pm2Cmd();
    if (!pm2) { warn('PM2 not found.'); return; }
    tryRun(`${pm2} list`);
}

function cmdLogs() {
    header('PM2 Logs  (Ctrl+C to exit)');
    const pm2 = pm2Cmd();
    if (!pm2) { warn('PM2 not found.'); return; }
    const p = spawn(pm2.replace(/"/g, ''), ['logs'], { stdio: 'inherit', shell: false });
    process.on('SIGINT', () => { p.kill(); process.exit(0); });
}

function cmdHelp() {
    header('Help');
    const cmds = [
        ['dev',     'Start development mode (Vite + API)'],
        ['build',   'Build React UI  → dist/'],
        ['exe',     'Build Windows EXE  → windows/exe/'],
        ['start',   'Start production via PM2'],
        ['stop',    'Stop all PM2 services'],
        ['restart', 'Restart PM2 services'],
        ['install', 'Install all npm dependencies'],
        ['status',  'Show PM2 process status'],
        ['logs',    'Tail PM2 logs'],
        ['help',    'Show this help'],
    ];
    console.log();
    cmds.forEach(([name, desc]) => {
        console.log('  ' + cyan(name.padEnd(10)) + gray(desc));
    });
    console.log('\n  ' + gray('Example: ') + 'node smk.cjs dev');
    console.log();
}

// ── Interactive Menu ──────────────────────────────────────────────────────────
function interactiveMenu() {
    const items = [
        { key: '1', label: 'Dev mode       (Vite + API server)',      fn: cmdDev     },
        { key: '2', label: 'Build React UI (Vite build)',              fn: cmdBuild   },
        { key: '3', label: 'Build Windows EXE',                        fn: cmdExe     },
        { key: '4', label: 'Start production (PM2)',                   fn: cmdStart   },
        { key: '5', label: 'Stop services (PM2)',                      fn: cmdStop    },
        { key: '6', label: 'Restart services (PM2)',                   fn: cmdRestart },
        { key: '7', label: 'Install all dependencies',                 fn: cmdInstall },
        { key: '8', label: 'Show PM2 status',                          fn: cmdStatus  },
        { key: '9', label: 'Tail PM2 logs',                            fn: cmdLogs    },
        { key: '0', label: 'Exit',                                     fn: null       },
    ];

    const line = '═'.repeat(52);
    console.log('\n' + cyan('╔' + line + '╗'));
    console.log(cyan('║') + bold('           SMK TV — Command Center              ') + cyan('  ║'));
    console.log(cyan('╠' + line + '╣'));
    items.forEach(item => {
        const label = `  [${item.key}]  ${item.label}`;
        console.log(cyan('║') + '  ' + cyan(`[${item.key}]`) + '  ' + item.label.padEnd(46) + cyan('║'));
    });
    console.log(cyan('╚' + line + '╝'));
    console.log();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(cyan('  Select command: '), (answer) => {
        rl.close();
        const choice = items.find(i => i.key === answer.trim());
        if (!choice) { warn('Invalid choice. Run: node smk.cjs help'); return; }
        if (!choice.fn) { console.log(gray('\n  Bye!\n')); return; }
        try { choice.fn(); }
        catch (e) { err(e.message); process.exit(1); }
    });
}

// ── Entry Point ───────────────────────────────────────────────────────────────
const arg = (process.argv[2] || '').trim().toLowerCase();

const MAP = {
    dev:     cmdDev,
    build:   cmdBuild,
    exe:     cmdExe,
    start:   cmdStart,
    stop:    cmdStop,
    restart: cmdRestart,
    install: cmdInstall,
    status:  cmdStatus,
    logs:    cmdLogs,
    help:    cmdHelp,
    '':      interactiveMenu,
};

const fn = MAP[arg];
if (!fn) {
    err(`Unknown command: "${arg}"`);
    cmdHelp();
    process.exit(1);
}

try { fn(); }
catch (e) {
    err(e.message);
    process.exit(1);
}
