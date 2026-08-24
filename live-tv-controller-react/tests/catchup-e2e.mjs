// Proves a missed show/hide schedule is actually delivered to a controller after a
// restart, instead of being broadcast before server.listen() and lost.
// Usage: node tests/catchup-e2e.mjs [port]
import WebSocket from 'ws';
const PORT = process.argv[2] || '3005';
const BASE = `http://localhost:${PORT}`;
const j = async (u, o) => (await fetch(BASE + u, o)).json();
const log = (...a) => console.log('  ' + new Date().toLocaleTimeString(), ...a);

// A time earlier today so the next startup sees it as missed.
const d = new Date(Date.now() - 5 * 60000);
const overdue = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

const created = await j('/api/schedules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: overdue, source: 'Delay Live', action: 'show', recurrence: 'daily', title: 'CATCHUP probe', enabled: true }),
});
const id = created.schedule?.id;
log(`created overdue schedule for ${overdue} (id=${id}) — restart the server now`);
console.log(`::SCHEDULE_ID::${id}`);
