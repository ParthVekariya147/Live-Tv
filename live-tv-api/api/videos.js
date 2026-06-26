// api/videos.js  →  GET /api/videos
// Returns: last 30 recent videos from the Katha Monitor channel
//
// RESPONSE FORMAT — this never changes, only lib/youtube.js changes:
// {
//   "success": true,
//   "source": "piped" | "rss",
//   "data": [ VideoObject, ... ],
//   "updatedAt": "ISO string"
// }

import { CHANNELS, fetchKathaChannel, getRecentVideos } from "../lib/youtube.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const force = new URL(req.url, "http://localhost").searchParams.get("force") === "1";
    const allVideos = await fetchKathaChannel(force);
    const videos    = getRecentVideos(allVideos, 30);
    const source    = allVideos[0]?.source ?? "none";
    const stale     = allVideos.some((v) => v.stale === true);

    return res.status(200).json({
      success:   true,
      channelId: CHANNELS.videos,
      channelUrl: `https://www.youtube.com/channel/${CHANNELS.videos}/videos`,
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
