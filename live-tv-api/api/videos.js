// api/videos.js  →  GET /api/videos
// Returns: recent (non-live) videos from both channels — used by Katha Monitor
//
// RESPONSE FORMAT — this never changes, only lib/youtube.js changes:
// {
//   "success": true,
//   "source": "piped" | "rss",
//   "data": [ VideoObject, ... ],
//   "updatedAt": "ISO string"
// }

import { fetchAllChannels, getRecentVideos } from "../lib/youtube.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const allVideos = await fetchAllChannels();
    const videos    = getRecentVideos(allVideos);
    const source    = allVideos[0]?.source ?? "none";

    return res.status(200).json({
      success:   true,
      source,
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
