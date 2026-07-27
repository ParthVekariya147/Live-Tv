import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { warmChannels, getActiveChannelIds } from "./lib/youtube.js";

// ─── Crash protection — log and keep running ─────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception — keeping server alive:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection — keeping server alive:", reason);
});

// ─── Load root .env (when run standalone, e.g. `npm run dev` here) ───────────
// No-op when the launcher already injected env vars — never overwrites them.
// __dirname inside a pkg snapshot would be virtual, not the real folder next
// to the .exe, so resolve against process.execPath there instead.
// NOTE: this file gets bundled to CJS by esbuild for the EXE build, and esbuild
// empties out `import.meta` for cjs output — touching import.meta.url there
// throws synchronously and would abort the whole module. Never reference it
// when process.pkg is set, and guard the ESM path with try/catch regardless.
function loadRootEnv() {
  let baseDir = null;
  if (process.pkg) {
    baseDir = path.dirname(process.execPath);
  } else {
    try {
      baseDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    } catch {
      baseDir = null; // e.g. running the esbuild cjs bundle directly, outside pkg
    }
  }
  if (!baseDir) return;

  const envPath = path.join(baseDir, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadRootEnv();

const PORT = process.env.PORT || process.env.API_PORT || 3000;

function extractDescriptionFromHtml(html) {
    const patterns = [
        /var ytInitialPlayerResponse = ({.*?});/s,
        /ytInitialPlayerResponse\s*=\s*({.*?});/s,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (!match?.[1]) continue;

        try {
            const data = JSON.parse(match[1]);
            return (
                data?.videoDetails?.shortDescription ||
                data?.microformat?.playerMicroformatRenderer?.description?.simpleText ||
                ""
            );
        } catch {
            continue;
        }
    }

    return "";
}

// ─── Description cache + throttling ──────────────────────────────────────────
// Descriptions rarely change, so cache them for hours. Katha Monitor requests
// 30 at once — without a cache + concurrency cap that pattern got the machine's
// IP rate-limited by YouTube (HTTP 429 → Google "sorry" page).
const descCache = new Map(); // videoId → { description, fetchedAt }
const DESC_FRESH_MS = 6 * 60 * 60 * 1000; // 6h

// Max simultaneous YouTube watch-page fetches
const DESC_MAX_CONCURRENT = 3;
let descActive = 0;
const descWaiters = [];

async function withDescSlot(task) {
    if (descActive >= DESC_MAX_CONCURRENT) {
        await new Promise((resolve) => descWaiters.push(resolve));
    }
    descActive++;
    try {
        return await task();
    } finally {
        descActive--;
        const next = descWaiters.shift();
        if (next) next();
    }
}

// When YouTube answers 429, stop hitting it for a while so the block can lift
const YT_COOLDOWN_MS = 5 * 60 * 1000;
let ytBlockedUntil = 0;

async function fetchDescriptionFromYouTube(videoId) {
    if (Date.now() < ytBlockedUntil) {
        throw new Error("YouTube rate-limited (cooling down)");
    }
    const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
        signal: AbortSignal.timeout(12000),
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    });
    if (!response.ok) {
        if (response.status === 429) {
            ytBlockedUntil = Date.now() + YT_COOLDOWN_MS;
            console.warn(`[Description] YouTube 429 — cooling down for ${YT_COOLDOWN_MS / 60000}min`);
        }
        throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    return extractDescriptionFromHtml(html);
}

// Primary source: YouTube's innertube API — a small JSON call that keeps
// working even when the watch page is behind the Google "sorry" 429 block.
async function fetchDescriptionFromInnertube(videoId) {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            context: { client: { clientName: "WEB", clientVersion: "2.20240726.00.00" } },
            videoId,
        }),
    });
    if (!res.ok) throw new Error(`Innertube HTTP ${res.status}`);
    const data = await res.json();
    return data?.videoDetails?.shortDescription || "";
}

async function fetchDescription(videoId) {
    try {
        const desc = await fetchDescriptionFromInnertube(videoId);
        if (desc) return desc;
    } catch (e) {
        console.warn(`[Description] Innertube failed for ${videoId}: ${e.message}`);
    }
    // Fallback: scrape the watch page (heavier, subject to the 429 cooldown)
    return fetchDescriptionFromYouTube(videoId);
}

async function handleVideoDescription(req, res) {
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
    const videoId = requestUrl.searchParams.get("videoId");

    if (!videoId) {
        return res.status(400).json({
            success: false,
            error: "Missing videoId",
            description: "",
        });
    }

    const cached = descCache.get(videoId);
    if (cached && Date.now() - cached.fetchedAt < DESC_FRESH_MS) {
        return res.status(200).json({ success: true, videoId, description: cached.description, cached: true });
    }

    try {
        const description = await withDescSlot(() => fetchDescription(videoId));
        descCache.set(videoId, { description, fetchedAt: Date.now() });
        return res.status(200).json({ success: true, videoId, description });
    } catch (error) {
        if (cached) {
            // Expired cache beats no data while sources are down
            return res.status(200).json({ success: true, videoId, description: cached.description, stale: true });
        }
        return res.status(500).json({
            success: false,
            videoId,
            description: "",
            error: error.message,
        });
    }
}

function createResponse(res) {
    return {
        status(code) {
            res.statusCode = code;
            return this;
        },
        json(payload) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(payload));
            return this;
        },
        end(body = "") {
            res.end(body);
            return this;
        },
    };
}

// Wrap in async init to avoid top-level await (needed for esbuild CJS output)
async function init() {
    const routes = {
        "/api/live": (await import("./api/live.js")).default,
        "/api/videos": (await import("./api/videos.js")).default,
        "/api/video-description": handleVideoDescription,
        "/api/channels": (await import("./api/channels.js")).default,
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Cache-Control", "no-store");

        if (req.method === "OPTIONS") {
            res.statusCode = 200;
            return res.end();
        }

        const handler = routes[url.pathname];
        if (!handler) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            return res.end(JSON.stringify({ success: false, error: "Not Found" }));
        }

        try {
            await handler(req, createResponse(res));
        } catch (error) {
            console.error(`[${url.pathname}] Error:`, error);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
    });

    server.listen(PORT, () => {
        console.log(`live-tv-api running at http://localhost:${PORT}`);
        console.log(`GET  http://localhost:${PORT}/api/live`);
        console.log(`GET  http://localhost:${PORT}/api/videos`);
        console.log(`GET/POST http://localhost:${PORT}/api/channels`);

        // No blanket startup warm-up — channels are fetched on demand the moment
        // a monitor first requests them. The background poll below only keeps
        // already-in-use channels warm (see getActiveChannelIds in lib/youtube.js),
        // so channels nobody has selected cost nothing.
        setInterval(() => {
            const ids = getActiveChannelIds();
            if (ids.length === 0) return;
            warmChannels(ids).catch((e) => console.error("[BG] warmChannels:", e));
        }, 90 * 1000);
    });
}

init().catch((e) => {
    console.error("[FATAL] Server init failed:", e);
    process.exit(1);
});