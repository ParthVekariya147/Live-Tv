/**
 * Converts all files in public/ into a single CJS module.
 * pkg always bundles require()'d CJS files, so this sidesteps
 * the unreliable pkg.assets glob system for public/ files.
 * Run before `pkg`: node generate-public-assets.cjs
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp']);
const TYPES  = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
};

const publicDir = path.join(__dirname, 'public');
const out = {};

for (const file of fs.readdirSync(publicDir)) {
    const full = path.join(publicDir, file);
    if (!fs.statSync(full).isFile()) continue;
    const ext    = path.extname(file).toLowerCase();
    const binary = BINARY.has(ext);
    out[file] = {
        contentType: TYPES[ext] || 'application/octet-stream',
        binary,
        content: binary
            ? fs.readFileSync(full).toString('base64')
            : fs.readFileSync(full, 'utf8'),
    };
}

const code = `'use strict';\n// AUTO-GENERATED — do not edit. Run: node generate-public-assets.cjs\nmodule.exports = ${JSON.stringify(out)};\n`;
const dest = path.join(__dirname, 'public-assets.cjs');
fs.writeFileSync(dest, code, 'utf8');
console.log('[generate-public-assets] Bundled:', Object.keys(out).join(', '));
