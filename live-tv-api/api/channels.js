// api/channels.js  →  GET/POST /api/channels
// User-managed table of YouTube channels (name + channel ID) that Live Event
// Monitor 1/2 and Katha Monitor pick from. Replaces the old hardcoded pair.
//
// GET  → { success: true, channels: [{ id, name, channelId }, ...] }
// POST → body { channels: [...] } replaces the whole list (validated), returns
//        the saved list in the same shape as GET.

import { loadChannels, saveChannels } from "../lib/channels-store.js";
import { warmChannels } from "../lib/youtube.js";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ success: true, channels: loadChannels() });
  }

  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const saved = saveChannels(body.channels);
      // Warm the new channels' caches in the background so switching to them
      // in a monitor dropdown doesn't hit a cold, slow first fetch.
      warmChannels(saved.map((c) => c.channelId)).catch((e) =>
        console.error("[/api/channels] warm after save failed:", e)
      );
      return res.status(200).json({ success: true, channels: saved });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
