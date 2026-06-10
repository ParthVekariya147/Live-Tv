// lib/youtube.js
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS THE ONLY FILE YOU EVER NEED TO EDIT WHEN YOUTUBE BREAKS.
// The API endpoints (/api/live, /api/videos) always return the same format.
// ─────────────────────────────────────────────────────────────────────────────

// Your two channel IDs
export const CHANNELS = {
  streams: "UC7HQ3mzdsyvLU0Y7a2t3N7A",
  videos:  "UCQXWP4gEdEwlb6vodwrU75A",
};

// Piped instances — tried in order, first success wins
// If all fail → falls back to YouTube RSS
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.yt",
  "https://pipedapi.adminforge.de",
  "https://piped-api.coke.cx",
];

// ─── Fetch one channel from Piped with automatic instance fallback ────────────
async function fetchPipedChannel(channelId) {
  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${base}/channel/${channelId}`, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "SMK-TV-Monitor/1.0" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.relatedStreams?.length >= 0) {
        console.log(`[Piped] OK: ${base} → ${channelId}`);
        return { data, source: base };
      }
    } catch (e) {
      console.warn(`[Piped] FAIL: ${base} → ${e.message}`);
    }
  }
  return null;
}

// ─── Fetch channel from YouTube RSS (official feed, stable since 2006) ────────
async function fetchRSSChannel(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "SMK-TV-Monitor/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRSS(xml, channelId);
  } catch (e) {
    console.warn(`[RSS] FAIL: ${channelId} → ${e.message}`);
    return null;
  }
}

// ─── Parse YouTube RSS XML into normalized video objects ──────────────────────
function parseRSS(xml, channelId) {
  const videos = [];
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];

  for (const [, entry] of entries) {
    const videoId = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1]?.trim();
    const title   = entry.match(/<title>(.*?)<\/title>/)?.[1]?.trim();
    const channel = entry.match(/<name>(.*?)<\/name>/)?.[1]?.trim();
    const pub     = entry.match(/<published>(.*?)<\/published>/)?.[1]?.trim();

    if (!videoId) continue;
    videos.push({
      videoId,
      title:       decodeXML(title || "Untitled"),
      thumbnail:   `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      channelName: channel || "",
      channelId,
      channelUrl:  `https://www.youtube.com/channel/${channelId}`,
      isLive:      false, // RSS does not carry live status
      upcoming:    false,
      scheduledStart: null,
      duration:    0,
      publishedAt: pub || null,
      source:      "rss",
    });
  }
  return videos;
}

function decodeXML(str) {
  return (str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ─── Normalize a Piped stream into the permanent response shape ───────────────
function normalizePiped(stream, channelId, channelName) {
  const videoId = stream.url?.match(/[?&]v=([^&]+)/)?.[1];
  if (!videoId) return null;

  const isLive  = stream.isLive === true || stream.duration === -1;
  const upcoming = stream.upcoming === true;

  // scheduledStart can be in ms or seconds depending on Piped version — normalise to ms
  let scheduledStart = stream.scheduledStart || null;
  if (scheduledStart && scheduledStart < 9_999_999_999) {
    scheduledStart = scheduledStart * 1000; // convert seconds → ms
  }

  return {
    videoId,
    title:         stream.title || "Untitled",
    thumbnail:     `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    channelName:   stream.uploaderName || channelName || "",
    channelId,
    channelUrl:    `https://www.youtube.com/channel/${channelId}`,
    isLive,
    upcoming,
    scheduledStart,
    duration:      stream.duration || 0,
    publishedAt:   stream.uploaded ? new Date(stream.uploaded).toISOString() : null,
    source:        "piped",
  };
}

// ─── Main: fetch all videos from both channels ────────────────────────────────
// Returns the permanent response shape — THIS SHAPE NEVER CHANGES
export async function fetchAllChannels() {
  const channelIds = Object.values(CHANNELS);

  // Try Piped for both channels in parallel
  const pipedResults = await Promise.allSettled(
    channelIds.map((id) => fetchPipedChannel(id))
  );

  const allVideos = [];
  let anyPipedWorked = false;

  pipedResults.forEach((result, i) => {
    const channelId = channelIds[i];
    if (result.status !== "fulfilled" || !result.value) return;

    anyPipedWorked = true;
    const { data } = result.value;
    (data.relatedStreams || []).forEach((stream) => {
      const v = normalizePiped(stream, channelId, data.name);
      if (v) allVideos.push(v);
    });
  });

  // If Piped completely failed → fall back to RSS (no live status, but stable)
  if (!anyPipedWorked) {
    console.warn("[API] All Piped instances failed — falling back to RSS");
    const rssResults = await Promise.allSettled(
      channelIds.map((id) => fetchRSSChannel(id))
    );
    rssResults.forEach((result) => {
      if (result.status === "fulfilled" && result.value) {
        allVideos.push(...result.value);
      }
    });
  }

  return allVideos;
}

// ─── Filter helpers ───────────────────────────────────────────────────────────
export function getLiveStreams(videos)    { return videos.filter((v) => v.isLive); }
export function getUpcoming(videos)      { return videos.filter((v) => v.upcoming && !v.isLive); }
export function getRecentVideos(videos)  { return videos.filter((v) => !v.isLive && !v.upcoming && v.duration > 0); }
