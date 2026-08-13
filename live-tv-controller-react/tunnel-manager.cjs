/**
 * Tunnel Manager — auto-starts a Cloudflare Quick Tunnel and patches .env with the live URL.
 * Integrated into server.cjs startup so `node server.cjs` does everything.
 *
 * Switched from localtunnel (loca.lt) to Cloudflare's account-less "Quick Tunnel"
 * — loca.lt's free edge was found to reject/drop connections outright on some
 * networks (confirmed via direct TCP tests), where Cloudflare's edge reliably
 * accepted them. Trade-off: Quick Tunnels don't support a fixed/reserved
 * subdomain like loca.lt did — every fresh connection cycle gets a new random
 * https://<random-words>.trycloudflare.com address, so phones must re-scan the
 * QR after a server restart (a fixed address requires a real Cloudflare account
 * + owned domain + one-time interactive login, which is out of scope here).
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { Tunnel, use: useCloudflaredBin } = require('cloudflared');

// cloudflared's own bin-path resolution (constants.js, hardcoded relative to its
// own __dirname) points into pkg's virtual snapshot filesystem when running as
// the packaged .exe — not a real file child_process.spawn can execute, so the
// tunnel silently fails to start there and notifications fall back to the
// LAN-only IP. Same class of fix as findFfmpegBinaries/findYtDlpBinary in
// server.cjs: the native binary must live next to the real .exe on disk, and
// cloudflared must be told to use it from there instead of its bundled default.
if (process.pkg) {
    const bundledBin = path.join(path.dirname(process.execPath), 'cloudflared.exe');
    if (fs.existsSync(bundledBin)) {
        useCloudflaredBin(bundledBin);
    } else {
        console.warn(`[Tunnel] cloudflared.exe not found next to the app (expected ${bundledBin}) — tunnel cannot start; notifications will stay LAN-only`);
    }
}

// .env lives one directory up from live-tv-controller-react/
const ENV_PATH = process.pkg
    ? path.join(path.dirname(process.execPath), '.env')
    : path.resolve(__dirname, '..', '.env');

// Cloudflare's edge can accept the tunnel connection while the quick-tunnel
// hostname itself is still propagating / the origin proxy hiccups — polling
// the actual public URL is the only way to catch that state, same as before.
//
// probeTunnel() reports *why* a probe failed, which matters a lot: a freshly
// minted <random>.trycloudflare.com name is regularly still NXDOMAIN on the
// local/ISP resolver for minutes after cloudflared prints it (confirmed here —
// 1.1.1.1 answered for a hostname this machine's router still called
// non-existent). That is DNS propagation, not a broken tunnel: phones on mobile
// data may already be reaching it fine. Treating it as "dead" and reconnecting
// mints an even *newer* hostname that is even less propagated, so the app
// spins — new URL, unresolvable, reconnect, repeat — and never settles on a QR
// code that anyone can scan.
function probeTunnel(url) {
    return new Promise((resolve) => {
        try {
            const req = https.get(`${url}/setup`, { timeout: 8000 }, (res) => {
                res.resume();
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, reason: 'http', status: res.statusCode });
            });
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
            req.on('error', (err) => {
                const dnsPending = err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN';
                resolve({ ok: false, reason: dnsPending ? 'dns' : 'error', code: err.code });
            });
        } catch (err) {
            resolve({ ok: false, reason: 'error', code: err && err.code });
        }
    });
}

function checkTunnelHealth(url) {
    return probeTunnel(url).then(r => r.ok);
}

// How long a brand-new hostname is allowed to be unresolvable before we stop
// blaming DNS and treat it as a genuinely dead tunnel.
const DNS_PROPAGATION_GRACE_MS = 5 * 60 * 1000;

// When the URL currently in process.env.TUNNEL_URL was minted.
let urlMintedAt = null;
function isUrlPropagating() {
    return !!urlMintedAt && (Date.now() - urlMintedAt) < DNS_PROPAGATION_GRACE_MS;
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

// Timestamp the current connection cycle started trying (reset to Date.now() on
// attempt 1 of each fresh cycle: initial boot, forced retry, post-drop
// reconnect, or the post-exhaustion background retry). setup-url uses this to
// grant a short grace period — "still connecting" — before giving up and
// showing the LAN-only fallback link, instead of flashing to the fallback the
// instant a fresh reconnect cycle begins.
let connectingSince = null;
function getConnectingSince() { return connectingSince; }

function forceReconnect() {
    if (reconnecting) return false;
    if (activeTunnel) {
        try { activeTunnel.stop(); } catch (_) {}
        return true;
    }
    if (restart) {
        restart();
        return true;
    }
    return false;
}

// cloudflared's quick-tunnel request to Cloudflare's API can itself hang/fail
// intermittently (observed directly) — bound how long we wait for the 'url'
// event before treating the attempt as failed and retrying.
const CONNECT_TIMEOUT_MS = 20000;

function startTunnel(port, { maxRetries = 3 } = {}) {
    let attempt = 0;
    restart = () => { attempt = 0; tryStart(); };

    function tryStart() {
        attempt++;
        if (attempt === 1) connectingSince = Date.now();
        reconnecting = true;
        console.log(`[Tunnel] Starting Cloudflare Quick Tunnel (attempt ${attempt}/${maxRetries})…`);

        const tunnel = Tunnel.quick(`http://localhost:${port}`);
        let gotUrl = false;  // true once this attempt has produced a working URL
        let settled = false; // true once the pre-success outcome (success or give-up-and-retry) is decided
        let healthTimer = null;

        const scheduleRetry = (reason) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimeout);
            console.error(`[Tunnel] Attempt ${attempt} failed: ${reason}`);
            try { tunnel.stop(); } catch (_) {}
            if (attempt < maxRetries) {
                const wait = attempt * 2000;
                console.log(`[Tunnel] Retrying in ${wait / 1000}s…`);
                setTimeout(tryStart, wait);
            } else {
                // Don't give up permanently — the free quick-tunnel API is often just
                // slow/flaky. Keep retrying quietly in the background so the tunnel
                // eventually comes up on its own instead of requiring the user to
                // notice it never connected and click "Retry connection" by hand.
                console.error(`[Tunnel] ❌ ${maxRetries} attempts failed — will keep retrying in the background every 30s.`);
                reconnecting = false;
                setTimeout(() => { attempt = 0; tryStart(); }, 30000);
            }
        };

        const connectTimeout = setTimeout(() => scheduleRetry('timed out waiting for tunnel URL'), CONNECT_TIMEOUT_MS);

        tunnel.once('url', (url) => {
            clearTimeout(connectTimeout);
            if (gotUrl) return;
            gotUrl = true;
            settled = true;
            activeTunnel = tunnel;
            reconnecting = false;

            // Update env var in-process immediately
            process.env.TUNNEL_URL = url;
            urlMintedAt = Date.now();

            // Persist to .env so the QR code survives restarts (until it reconnects
            // with a fresh URL — quick tunnels can't pin a fixed subdomain)
            patchEnvFile(url);

            const line = '─'.repeat(50);
            console.log(`\n[Tunnel] ${line}`);
            console.log(`[Tunnel]  ✅ Tunnel LIVE`);
            console.log(`[Tunnel]  📱 Phone setup URL:`);
            console.log(`[Tunnel]     ${url}/setup`);
            console.log(`[Tunnel]  🔔 Notifications work on any network after setup`);
            console.log(`[Tunnel] ${line}\n`);

            // Periodically verify the public URL actually resolves. Two misses in a
            // row means the edge/origin proxy is stuck — force a reconnect instead of
            // leaving the UI reporting "Tunnel active" against a dead link.
            let consecutiveFailures = 0;
            healthTimer = setInterval(async () => {
                const probe = await probeTunnel(url);
                if (probe.ok) {
                    consecutiveFailures = 0;
                    return;
                }
                // Hostname not in DNS yet on this machine — Cloudflare's name is
                // still propagating to the local resolver. Reconnecting now would
                // throw away a working tunnel and mint an even fresher hostname,
                // restarting the same wait. Hold, don't count it as a failure.
                if (probe.reason === 'dns' && isUrlPropagating()) {
                    console.log(`[Tunnel] ${url} not resolvable from this machine yet (DNS propagating) — keeping the tunnel`);
                    return;
                }
                consecutiveFailures++;
                console.warn(`[Tunnel] Health check failed (${consecutiveFailures}/2, ${probe.reason}${probe.code ? ' ' + probe.code : ''}): ${url}/setup unreachable`);
                if (consecutiveFailures >= 2) {
                    console.warn('[Tunnel] Unhealthy — forcing reconnect');
                    clearInterval(healthTimer);
                    process.env.TUNNEL_URL = '';
                    urlMintedAt = null;
                    try { tunnel.stop(); } catch (_) {}
                }
            }, 45000);
        });

        tunnel.on('error', (err) => {
            console.warn('[Tunnel] Error:', err.message);
        });

        // cloudflared has no 'close' event like localtunnel — the child process
        // just exits. Covers two cases: the process died before ever producing a
        // URL (treat as a failed attempt, subject to maxRetries/backoff), or it
        // was connected and then dropped (always retry after a flat 10s, same as
        // the old localtunnel 'close' behavior).
        tunnel.on('exit', (code) => {
            if (healthTimer) clearInterval(healthTimer);
            if (activeTunnel === tunnel) activeTunnel = null;
            if (!gotUrl) {
                scheduleRetry(`process exited before connecting (code=${code})`);
                return;
            }
            reconnecting = true;
            console.warn('[Tunnel] Connection dropped — reconnecting in 10s…');
            process.env.TUNNEL_URL = '';
            urlMintedAt = null;
            setTimeout(() => { attempt = 0; tryStart(); }, 10000);
        });
    }

    tryStart();
}

module.exports = { startTunnel, checkTunnelHealth, probeTunnel, isUrlPropagating, forceReconnect, getConnectingSince };
