// api/live.js  →  GET /api/live
// Returns: currently live streams + upcoming events from the Live Monitor channel
//
// RESPONSE FORMAT — this never changes, only lib/youtube.js changes:
// {
//   "success": true,
//   "source": "piped" | "rss",
//   "live": [ VideoObject, ... ],
//   "upcoming": [ VideoObject, ... ],
//   "updatedAt": "ISO string"
// }

import { CHANNELS, fetchStreamChannel, fetchChannelById, getLiveStreams, getUpcoming } from "../lib/youtube.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url       = new URL(req.url, `http://localhost`);
    const channelId = url.searchParams.get("channelId") || CHANNELS.streams;

    const allVideos = channelId === CHANNELS.streams
      ? await fetchStreamChannel()
      : await fetchChannelById(channelId);

    const live      = getLiveStreams(allVideos);
    const upcoming  = getUpcoming(allVideos);
    const source    = allVideos[0]?.source ?? "none";

    return res.status(200).json({
      success:    true,
      channelId,
      channelUrl: `https://www.youtube.com/channel/${channelId}/streams`,
      source,
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
