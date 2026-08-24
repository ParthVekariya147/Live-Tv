// Read-only sweep of every GET endpoint the controller exposes. Safe to point at a
// live broadcasting instance — it never writes. Usage: node tests/api-sweep.mjs [port]
const PORT = process.argv[2] || '3005';
const BASE = `http://localhost:${PORT}`;

const ENDPOINTS = [
    ['Scheduler status', '/api/scheduler/status'], ['Scheduler health', '/api/scheduler/health'],
    ['Scheduler next', '/api/scheduler/next?count=3'], ['Scheduler alerts', '/api/scheduler/alerts'],
    ['Scheduler history', '/api/scheduler/history'], ['Scheduler retries', '/api/scheduler/retries'],
    ['Schedules', '/api/schedules'], ['State (all)', '/api/state'],
    ['Active source', '/api/state/obs.activeSource'], ['OBS status', '/api/obs/status'],
    ['Logs', '/api/logs?limit=5'], ['Log months', '/api/logs/months'],
    ['Notif devices', '/api/notifications/devices'], ['Notif settings', '/api/notifications/settings'],
    ['Notif status', '/api/notifications/status'], ['Notif history', '/api/notifications/history?limit=3'],
    ['Backup list', '/api/backup/list'], ['Backup status', '/api/backup/status'],
    ['Backup auto-settings', '/api/backup/auto-settings'], ['Recording status', '/api/recording/status'],
    ['Recording list', '/api/recording/list'], ['Recording settings', '/api/recording/settings'],
    ['Videos root', '/api/videos/root-folder'], ['Videos scan', '/api/videos/scan'],
    ['Relay status', '/api/relay/status'], ['Settings export', '/api/settings/export'],
];

let ok = 0, bad = 0;
console.log(`  sweeping ${BASE}\n`);
for (const [name, p] of ENDPOINTS) {
    try {
        const res = await fetch(BASE + p, { signal: AbortSignal.timeout(15000) });
        const body = await res.text();
        if (res.ok) { ok++; console.log(`  OK        ${name}`); }
        else { bad++; console.log(`  HTTP ${res.status}  ${name}\n            ${body.slice(0, 100)}`); }
    } catch (err) { bad++; console.log(`  ERROR     ${name}\n            ${err.message}`); }
}
console.log(`\n  ${ok} ok, ${bad} failing`);
process.exit(bad ? 1 : 0);
