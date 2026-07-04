/**
 * Tunnel Manager — auto-starts localtunnel and patches .env with the live URL.
 * Integrated into server.cjs startup so `node server.cjs` does everything.
 */

const fs          = require('fs');
const path        = require('path');
const localtunnel = require('localtunnel');

// .env lives one directory up from live-tv-controller-react/
const ENV_PATH = process.pkg
    ? path.join(path.dirname(process.execPath), '.env')
    : path.resolve(__dirname, '..', '.env');

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

async function startTunnel(port, { maxRetries = 3, subdomain } = {}) {
    let attempt = 0;

    async function tryStart() {
        attempt++;
        console.log(`[Tunnel] Connecting to localtunnel (attempt ${attempt}/${maxRetries})…`);

        try {
            const opts = { port };
            if (subdomain) opts.subdomain = subdomain;
            const tunnel = await localtunnel(opts);

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

            // Auto-reconnect on close (localtunnel is flaky — reconnect silently)
            tunnel.on('close', () => {
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
            return null;
        }
    }

    return tryStart();
}

module.exports = { startTunnel };
