/**
 * LAN IP Detector
 * Returns all non-loopback IPv4 addresses of this machine.
 */

const os = require('os');

function getLANIPs() {
    const ips = [];
    const ifaces = os.networkInterfaces();

    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }

    // Always include localhost as fallback
    if (!ips.includes('127.0.0.1')) ips.push('127.0.0.1');

    return ips;
}

function getPrimaryLANIP() {
    const ips = getLANIPs();
    // Prefer 192.168.x.x, then 10.x.x.x, then 172.x.x.x, then fallback
    const preferred = ips.find(ip => ip.startsWith('192.168.')) ||
                      ips.find(ip => ip.startsWith('10.'))      ||
                      ips.find(ip => ip.startsWith('172.'))     ||
                      ips[0];
    return preferred || '127.0.0.1';
}

module.exports = { getLANIPs, getPrimaryLANIP };
