'use strict';
/**
 * Shared PID registry for the SMK TV watchdog + its two role processes
 * (api, controller). All three run from the same packaged EXE, so Task
 * Manager shows three identical "SMK TV N.exe" entries with no obvious way
 * to tell them apart or stop them together — killing just one lets the
 * watchdog respawn it a few seconds later, which looks like "the app won't
 * close". The tray's "Exit / Stop Service" item uses killSiblings() here to
 * take down the watchdog and its other child before exiting itself, so a
 * single click actually stops everything.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROLES = ['watchdog', 'api', 'controller'];

function pidFile(envDir) {
    return path.join(envDir, '.smk-runtime.json');
}

function writePid(envDir, role, pid) {
    const file = pidFile(envDir);
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first write */ }
    data[role] = pid;
    try { fs.writeFileSync(file, JSON.stringify(data)); } catch (_) { /* best effort */ }
}

function readPids(envDir) {
    try { return JSON.parse(fs.readFileSync(pidFile(envDir), 'utf8')); } catch (_) { return {}; }
}

// Kills the watchdog first (so it can't react to its children exiting and
// respawn them), then any other tracked role process. The caller's own role
// is skipped — the caller shuts itself down normally.
function killSiblings(envDir, exceptRole) {
    const pids = readPids(envDir);
    for (const role of ROLES) {
        if (role === exceptRole) continue;
        const pid = pids[role];
        if (!pid || pid === process.pid) continue;
        try {
            if (process.platform === 'win32') {
                execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
            } else {
                process.kill(pid, 'SIGKILL');
            }
        } catch (_) { /* already gone */ }
    }
}

module.exports = { pidFile, writePid, readPids, killSiblings };
