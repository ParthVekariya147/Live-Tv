import WebSocket from 'ws';
const PORT = process.argv[2] || '3005';
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const got = [];
ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'SCHEDULER_TRIGGER') {
        got.push(m.data);
        console.log(`  <- SCHEDULER_TRIGGER  ${m.data.action} "${m.data.source}"  title="${m.data.title}"  reason=${m.data.reason}`);
    }
});
ws.on('open', () => console.log('  controller connected, listening for catch-up triggers...'));
setTimeout(() => {
    const hit = got.find((t) => t.title === 'CATCHUP probe');
    console.log(hit
        ? `\n  PASS  missed schedule was delivered to the connected controller (reason=${hit.reason})`
        : `\n  FAIL  no catch-up trigger arrived — got ${got.length} trigger(s)`);
    process.exit(hit ? 0 : 1);
}, 20000);
