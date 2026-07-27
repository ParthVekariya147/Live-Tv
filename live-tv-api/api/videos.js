// api/videos.js  →  GET /api/videos
// Returns: last 30 recent videos from a given channel (Katha Monitor)
//
// RESPONSE FORMAT — this never changes, only lib/youtube.js changes:
// {
//   "success": true,
//   "source": "piped" | "rss",
//   "data": [ VideoObject, ... ],
//   "updatedAt": "ISO string"
// }

import { fetchKathaChannel, getRecentVideos } from "../lib/youtube.js";
import { getDefaultChannelId } from "../lib/channels-store.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url       = new URL(req.url, "http://localhost");
    const channelId = url.searchParams.get("channelId") || getDefaultChannelId();
    const force     = url.searchParams.get("force") === "1";

    if (!channelId) {
      return res.status(400).json({
        success: false,
        error: "No channelId provided and no channels configured — add one via /api/channels",
        data: [],
      });
    }

    const allVideos = await fetchKathaChannel(channelId, force);
    const videos    = getRecentVideos(allVideos, 30);
    const source    = allVideos[0]?.source ?? "none";
    const stale     = allVideos.some((v) => v.stale === true);

    return res.status(200).json({
      success:   true,
      channelId,
      channelUrl: `https://www.youtube.com/channel/${channelId}/videos`,
      limit:     30,
      count:     videos.length,
      source,
      stale,
      data:      videos,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[/api/videos] Error:", err);
    return res.status(500).json({
      success: false,
      error:   err.message,
      data:    [],
    });
  }
}
