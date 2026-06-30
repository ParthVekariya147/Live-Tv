/**
 * SSL Certificate Manager
 * Generates a self-signed cert covering all current LAN IPs in SubjectAltName.
 * selfsigned v5+ has an async generate() — this module is fully async.
 * Regenerates automatically when the LAN IP list changes.
 */

const fs         = require('fs');
const path       = require('path');
const selfsigned = require('selfsigned');

function getCertPaths() {
    const base = process.pkg
        ? path.join(path.dirname(process.execPath), 'data')
        : path.join(__dirname, 'data');
    return {
        cert: path.join(base, 'ssl-cert.pem'),
        key:  path.join(base, 'ssl-key.pem'),
        meta: path.join(base, 'ssl-meta.json'),
    };
}

let _cached = null;

function buildAltNames(lanIPs) {
    const names = [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
    ];
    for (const ip of lanIPs) {
        if (ip !== '127.0.0.1') {
            names.push({ type: 7, ip });
        }
    }
    return names;
}

async function generate(lanIPs, paths) {
    const attrs = [
        { name: 'commonName',       value: 'Live TV Controller' },
        { name: 'organizationName', value: 'LiveTV' },
        { name: 'countryName',      value: 'IN' },
    ];
    const opts = {
        days:      825,
        algorithm: 'sha256',
        extensions: [
            { name: 'subjectAltName', altNames: buildAltNames(lanIPs) },
        ],
    };

    // selfsigned v5+ is async
    const pems = await selfsigned.generate(attrs, opts);

    const dataDir = path.dirname(paths.cert);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(paths.cert, pems.cert,    'utf8');
    fs.writeFileSync(paths.key,  pems.private, 'utf8');
    fs.writeFileSync(paths.meta, JSON.stringify({ lanIPs, generatedAt: new Date().toISOString() }), 'utf8');

    console.log('[CertManager] Generated SSL cert covering IPs:', lanIPs.join(', '));
    return { cert: pems.cert, key: pems.private };
}

async function getCert(lanIPs = []) {
    if (_cached) return _cached;

    const paths = getCertPaths();

    // Reuse existing cert only if the LAN IPs haven't changed
    if (fs.existsSync(paths.cert) && fs.existsSync(paths.key) && fs.existsSync(paths.meta)) {
        try {
            const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8'));
            const sameIPs = JSON.stringify([...lanIPs].sort()) === JSON.stringify([...meta.lanIPs].sort());
            if (sameIPs) {
                _cached = {
                    cert: fs.readFileSync(paths.cert, 'utf8'),
                    key:  fs.readFileSync(paths.key,  'utf8'),
                };
                console.log('[CertManager] Loaded existing SSL cert (IPs unchanged)');
                return _cached;
            }
            console.log('[CertManager] LAN IPs changed — regenerating cert');
        } catch (_) {
            console.log('[CertManager] Regenerating cert (meta unreadable)');
        }
    }

    try {
        _cached = await generate(lanIPs, paths);
        return _cached;
    } catch (err) {
        console.error('[CertManager] Failed to generate certificate:', err.message);
        return null;
    }
}

module.exports = { getCert };
