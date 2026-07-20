/**
 * Tunnel Manager — auto-starts localtunnel and patches .env with the live URL.
 * Integrated into server.cjs startup so `node server.cjs` does everything.
 */

const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const localtunnel = require('localtunnel');

// .env lives one directory up from live-tv-controller-react/
const ENV_PATH = process.pkg
    ? path.join(path.dirname(process.execPath), '.env')
    : path.resolve(__dirname, '..', '.env');

// localtunnel's client can stay connected to the LT control server while the
// public edge still answers real visitors with 502/503 — a known free-tier
// failure mode that doesn't emit a 'close'/'error' event we can react to.
// Polling the actual public URL is the only way to catch that state.
function checkTunnelHealth(url) {
    return new Promise((resolve) => {
        try {
            const req = https.get(`${url}/setup`, { timeout: 8000 }, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 400);
            });
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.on('error', () => resolve(false));
        } catch (_) {
            resolve(false);
        }
    });
}

function patchEnvFile(url) {
    try {
        let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
        if (/^TUNNEL_URL=.*/m.test(content)) {
            content = content.replace(/^TUNNEL_URL=.*$/m, `TUNNEL_URL=${url}`);
        } else {
            content += `\nTUNNEL_URL=${url}\n`;
        }
        fs.writeFileSync(ENV_PATH, content, 'utf8');
        console.log(`[Tunnel] .env patched → TUNNEL_URL=${url}`);
    } catch (err) {
        console.warn('[Tunnel] Could not patch .env:', err.message);
    }
}

// Shared across reconnects so callers (e.g. the setup-url route) can trigger
// an immediate reconnect on demand instead of waiting for the 45s poll.
let activeTunnel = null;
let reconnecting = false;
let restart = null; // set by startTunnel() to a zero-arg "reconnect now" function

function forceReconnect() {
    if (reconnecting) return false;
    if (activeTunnel) {
        try { activeTunnel.close(); } catch (_) {}
        return true;
    }
    if (restart) {
        restart();
        return true;
    }
    return false;
}

async function startTunnel(port, { maxRetries = 3, subdomain } = {}) {
    let attempt = 0;
    restart = () => { attempt = 0; tryStart(); };

    async function tryStart() {
        attempt++;
        reconnecting = true;
        console.log(`[Tunnel] Connecting to localtunnel (attempt ${attempt}/${maxRetries})…`);

        try {
            const opts = { port };
            if (subdomain) opts.subdomain = subdomain;
            const tunnel = await localtunnel(opts);
            activeTunnel = tunnel;
            reconnecting = false;

            if (subdomain && !tunnel.url.includes(subdomain)) {
                console.warn(`[Tunnel] ⚠ Requested subdomain "${subdomain}" was unavailable — got ${tunnel.url} instead. Phones registered against the old URL must re-register.`);
            }

            // Update env var in-process immediately
            process.env.TUNNEL_URL = tunnel.url;

            // Persist to .env so QR code survives restarts
            patchEnvFile(tunnel.url);

            const line = '─'.repeat(50);
            console.log(`\n[Tunnel] ${line}`);
            console.log(`[Tunnel]  ✅ Tunnel LIVE`);
            console.log(`[Tunnel]  📱 Phone setup URL:`);
            console.log(`[Tunnel]     ${tunnel.url}/setup`);
            console.log(`[Tunnel]  🔔 Notifications work on any network after setup`);
            console.log(`[Tunnel] ${line}\n`);

            // Periodically verify the public URL actually resolves. Two misses in a
            // row means the edge is stuck serving 502/503 — force a reconnect instead
            // of leaving the UI reporting "Tunnel active" against a dead link.
            let consecutiveFailures = 0;
            const healthTimer = setInterval(async () => {
                const healthy = await checkTunnelHealth(tunnel.url);
                if (healthy) {
                    consecutiveFailures = 0;
                    return;
                }
                consecutiveFailures++;
                console.warn(`[Tunnel] Health check failed (${consecutiveFailures}/2): ${tunnel.url}/setup unreachable`);
                if (consecutiveFailures >= 2) {
                    console.warn('[Tunnel] Unhealthy — forcing reconnect');
                    clearInterval(healthTimer);
                    process.env.TUNNEL_URL = '';
                    try { tunnel.close(); } catch (_) {}
                }
            }, 45000);

            // Auto-reconnect on close (localtunnel is flaky — reconnect silently)
            tunnel.on('close', () => {
                clearInterval(healthTimer);
                if (activeTunnel === tunnel) activeTunnel = null;
                reconnecting = true;
                console.warn('[Tunnel] Connection dropped — reconnecting in 10s…');
                process.env.TUNNEL_URL = '';
                setTimeout(() => { attempt = 0; tryStart(); }, 10000);
            });

            tunnel.on('error', (err) => {
                // Swallow — 503s and connection resets are normal for localtunnel free tier
                console.warn('[Tunnel] Error (will reconnect):', err.message);
            });

            return tunnel;
        } catch (err) {
            console.error(`[Tunnel] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < maxRetries) {
                const wait = attempt * 2000;
                console.log(`[Tunnel] Retrying in ${wait / 1000}s…`);
                await new Promise(r => setTimeout(r, wait));
                return tryStart();
            }
            console.error('[Tunnel] ❌ All attempts failed.');
            console.error('[Tunnel]    To set up manually: npx localtunnel --port', port);
            console.error('[Tunnel]    Then paste the URL into .env as TUNNEL_URL=https://xxx.loca.lt');
            reconnecting = false;
            return null;
        }
    }

    return tryStart();
}

module.exports = { startTunnel, checkTunnelHealth, forceReconnect };
