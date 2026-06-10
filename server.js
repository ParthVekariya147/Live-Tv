// server.js — local dev server + CORS proxy for SMK TV
// Usage: node server.js
// Serves static files on http://localhost:8765
// Proxy endpoint: http://localhost:8765/proxy?url=<encoded-url>

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PORT = 8765;
const DIR  = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html", ".js": "application/javascript",
  ".css": "text/css",   ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".json": "application/json",
};

function proxyFetch(targetUrl, res, redirectCount = 0) {
  if (redirectCount > 5) {
    res.writeHead(508, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
    return res.end("Too many redirects");
  }

  const parsed = new URL(targetUrl);
  const lib    = parsed.protocol === "https:" ? https : http;

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers:  {
      "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language":           "en-US,en;q=0.9",
      "Accept-Encoding":           "identity",
      "Upgrade-Insecure-Requests": "1",
    },
  };

  const upstream = lib.request(options, (upRes) => {
    // Follow redirects (301, 302, 303, 307, 308)
    if ([301, 302, 303, 307, 308].includes(upRes.statusCode) && upRes.headers.location) {
      upRes.resume(); // discard body
      let location = upRes.headers.location;
      if (!location.startsWith("http")) {
        location = parsed.origin + (location.startsWith("/") ? "" : "/") + location;
      }
      return proxyFetch(location, res, redirectCount + 1);
    }

    const chunks = [];
    upRes.on("data", (c) => chunks.push(c));
    upRes.on("end", () => {
      const body = Buffer.concat(chunks);
      res.writeHead(upRes.statusCode, {
        "Content-Type":                upRes.headers["content-type"] || "text/plain",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    });
  });

  upstream.on("error", (e) => {
    res.writeHead(502, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
    res.end("Proxy error: " + e.message);
  });

  upstream.setTimeout(25000, () => {
    upstream.destroy();
    res.writeHead(504, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
    res.end("Proxy timeout");
  });

  upstream.end();
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" });
    return res.end();
  }

  // Proxy endpoint: /proxy?url=<encoded>
  if (urlObj.pathname === "/proxy") {
    const target = urlObj.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Missing ?url= parameter");
    }
    try {
      proxyFetch(decodeURIComponent(target), res);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad URL: " + e.message);
    }
    return;
  }

  // Static file serving
  let filePath = path.join(DIR, urlObj.pathname === "/" ? "index.html" : urlObj.pathname);
  filePath = path.normalize(filePath);

  // Security: don't serve files outside the project dir
  if (!filePath.startsWith(DIR)) {
    res.writeHead(403); return res.end();
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
      return res.end(err.code === "ENOENT" ? "Not Found: " + urlObj.pathname : "Server Error");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type":  MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`SMK TV dev server → http://localhost:${PORT}`);
  console.log(`CORS proxy         → http://localhost:${PORT}/proxy?url=<encoded-url>`);
});
