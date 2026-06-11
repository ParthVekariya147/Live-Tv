import http from "http";
import { warmCache, fetchStreamChannel, fetchKathaChannel } from "./lib/youtube.js";

// ─── Crash protection — log and keep running ─────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception — keeping server alive:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection — keeping server alive:", reason);
});

const PORT = process.env.PORT || 3000;

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

    try {
        const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
            signal: AbortSignal.timeout(12000),
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();
        const description = extractDescriptionFromHtml(html);

        return res.status(200).json({
            success: true,
            videoId,
            description,
        });
    } catch (error) {
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
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
        console.log(`GET http://localhost:${PORT}/api/live`);
        console.log(`GET http://localhost:${PORT}/api/videos`);

        warmCache().catch((e) => console.error("[Startup] warmCache error:", e));

        setInterval(() => {
            fetchStreamChannel().catch((e) => console.error("[BG] streams:", e));
            fetchKathaChannel().catch((e) => console.error("[BG] katha:", e));
        }, 90 * 1000);
    });
}

init().catch((e) => {
    console.error("[FATAL] Server init failed:", e);
    process.exit(1);
});