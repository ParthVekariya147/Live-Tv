'use strict';
// Minimal static file + status-JSON HTTP server. No framework dependency —
// this whole PoC intentionally has zero npm dependencies so `node start.js`
// works right after `git clone`, no `npm install` step required.
//
// Bound to 127.0.0.1 only (not 0.0.0.0): this is an unauthenticated local
// dev server serving whatever video is currently loaded — exposing it
// LAN-wide has no benefit for a PoC and is a real (if minor) leak surface.

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(path.normalize(root))) return null;
  return resolved;
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.m3u8') headers['Cache-Control'] = 'no-cache, no-store';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function readJsonBody(req, maxBytes = 10000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('Request body too large'));
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function createServer({ publicDir, hlsDir, getStatus, onLoad }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/load') {
      readJsonBody(req)
        .then(async (payload) => {
          const videoId = typeof payload.videoId === 'string' ? payload.videoId.trim() : '';
          if (!videoId) throw Object.assign(new Error('videoId (or URL) is required'), { statusCode: 400 });
          await onLoad(videoId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
        })
        .catch((err) => {
          res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      return;
    }

    if (url.pathname === '/api/status') {
      const body = JSON.stringify(getStatus());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }

    if (url.pathname.startsWith('/hls/')) {
      const rel = url.pathname.slice('/hls/'.length);
      const filePath = safeJoin(hlsDir, rel);
      if (!filePath) { res.writeHead(400); res.end('bad path'); return; }
      serveFile(res, filePath);
      return;
    }

    const rel = url.pathname === '/' ? '/player.html' : url.pathname;
    const filePath = safeJoin(publicDir, rel);
    if (!filePath) { res.writeHead(400); res.end('bad path'); return; }
    serveFile(res, filePath);
  });
}

module.exports = { createServer };
