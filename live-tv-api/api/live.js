// api/live.js  →  GET /api/live
// Returns: currently live streams + upcoming events from a given channel
//
// RESPONSE FORMAT — this never changes, only lib/youtube.js changes:
// {
//   "success": true,
//   "source": "piped" | "rss",
//   "live": [ VideoObject, ... ],
//   "upcoming": [ VideoObject, ... ],
//   "updatedAt": "ISO string"
// }

import { fetchChannelById, getLiveStreams, getUpcoming } from "../lib/youtube.js";
import { getDefaultChannelId } from "../lib/channels-store.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url       = new URL(req.url, `http://localhost`);
    const channelId = url.searchParams.get("channelId") || getDefaultChannelId();

    if (!channelId) {
      return res.status(400).json({
        success: false,
        error: "No channelId provided and no channels configured — add one via /api/channels",
        live: [],
        upcoming: [],
      });
    }

    const allVideos = await fetchChannelById(channelId);

    const live      = getLiveStreams(allVideos);
    const upcoming  = getUpcoming(allVideos);
    const source    = allVideos[0]?.source ?? "none";
    const stale     = allVideos.some(v => v.stale);

    return res.status(200).json({
      success:    true,
      channelId,
      channelUrl: `https://www.youtube.com/channel/${channelId}/streams`,
      source,
      stale,
      live,
      upcoming,
      updatedAt:  new Date().toISOString(),
    });
  } catch (err) {
    console.error("[/api/live] Error:", err);
    return res.status(500).json({
      success:  false,
      error:    err.message,
      live:     [],
      upcoming: [],
    });
  }
}
