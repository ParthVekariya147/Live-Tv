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

function toEpochMs(value) {
  if (!value) return null;

  if (typeof value === "number") {
    return value < 9_999_999_999 ? value * 1000 : value;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toISOString(value) {
  const epochMs = toEpochMs(value);
  return epochMs ? new Date(epochMs).toISOString() : null;
}

function getLiveStartMs(video) {
  return (
    toEpochMs(video.startedAt) ||
    toEpochMs(video.scheduledStart) ||
    toEpochMs(video.publishedAt) ||
    0
  );
}

// ─── Normalize a Piped stream into the permanent response shape ───────────────
function normalizePiped(stream, channelId, channelName) {
  const videoId = stream.url?.match(/[?&]v=([^&]+)/)?.[1];
  if (!videoId) return null;

  const isLive  = stream.isLive === true || stream.duration === -1;
  const upcoming = stream.upcoming === true;

  // scheduledStart can be in ms or seconds depending on Piped version — normalise to ms
  const scheduledStart = toEpochMs(stream.scheduledStart);
  const publishedAt = toISOString(stream.uploaded);

  return {
    videoId,
    title:         stream.title || "Untitled",
    thumbnail:     `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    channelName:   stream.uploaderName || channelName || "",
    channelId,
    channelUrl:    `https://www.youtube.com/channel/${channelId}`,
    isLive,
    upcoming,
    startedAt:     isLive ? toISOString(scheduledStart || stream.uploaded) : null,
    scheduledStart,
    duration:      stream.duration || 0,
    publishedAt,
    source:        "piped",
  };
}

// ─── Scrape YouTube channel /streams page for live + upcoming (ytInitialData) ──
async function fetchYouTubeScrape(channelId) {
  const url = `https://www.youtube.com/channel/${channelId}/streams`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const match =
      html.match(/var ytInitialData\s*=\s*({.*?});\s*<\/script>/s) ||
      html.match(/ytInitialData\s*=\s*({.*?});\s*(?:var |<\/script>)/s);
    if (!match?.[1]) throw new Error("ytInitialData not found");

    const ytData = JSON.parse(match[1]);
    const videos = parseYouTubeStreamsPage(ytData, channelId);
    console.log(`[YT Scrape] OK: ${channelId} → ${videos.length} items (live+upcoming)`);
    return videos;
  } catch (e) {
    console.warn(`[YT Scrape] FAIL: ${channelId} → ${e.message}`);
    return null;
  }
}

function parseYouTubeStreamsPage(ytData, channelId) {
  const tabs = ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const LIVE_PARAMS = new Set(["EgZsaXZlcw%3D%3D", "EgdzdHJlYW1z"]);
  const LIVE_TITLES = new Set(["live", "en direct", "en vivo", "ao vivo", "canlı"]);

  const liveTab = tabs.find((tab) => {
    const title = (tab.tabRenderer?.title || "").toLowerCase();
    const params = tab.tabRenderer?.endpoint?.browseEndpoint?.params || "";
    return (
      LIVE_TITLES.has(title) ||
      LIVE_PARAMS.has(params) ||
      params.startsWith("EgdzdHJlYW1z")
    );
  });

  const items = [];

  // New YouTube format (2025+): richGridRenderer → richItemRenderer → lockupViewModel
  const richItems =
    liveTab?.tabRenderer?.content?.richGridRenderer?.contents || [];
  if (richItems.length > 0) {
    for (const item of richItems) {
      const lvm = item?.richItemRenderer?.content?.lockupViewModel;
      if (lvm) items.push(normalizeLockupViewModel(lvm, channelId));
    }
    return items.filter(Boolean);
  }

  // Legacy format: sectionListRenderer → itemSectionRenderer → videoRenderer
  const legacyItems =
    liveTab?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents || [];
  for (const item of legacyItems) {
    const v = normalizeVideoRenderer(item?.videoRenderer, channelId);
    if (v) items.push(v);
  }
  return items;
}

function normalizeLockupViewModel(lvm, channelId) {
  const videoId = lvm.contentId;
  if (!videoId) return null;

  const title =
    lvm.metadata?.lockupMetadataViewModel?.title?.content || "Untitled";
  const sources = lvm.contentImage?.thumbnailViewModel?.image?.sources || [];
  const thumbnail =
    sources[sources.length - 1]?.url ||
    sources[0]?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  let isLive = false;
  let isUpcoming = false;
  let scheduledStart = null;

  // Check badge overlays — each overlay may have a thumbnailBottomOverlayViewModel
  const overlays = lvm.contentImage?.thumbnailViewModel?.overlays || [];
  for (const overlay of overlays) {
    const badges = overlay?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const bvm = badge?.thumbnailBadgeViewModel;
      if (!bvm) continue;
      const style = bvm.badgeStyle || "";
      const text = (bvm.text || "").toLowerCase();
      const iconName = bvm.icon?.sources?.[0]?.clientResource?.imageName || "";
      if (style === "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE" || iconName === "LIVE") {
        isLive = true;
      } else if (text === "upcoming" || text === "scheduled") {
        isUpcoming = true;
      }
    }
  }

  // Parse scheduled start time from metadata rows (upcoming only)
  // YouTube serves US locale: "Scheduled for M/D/YY, H:MM AM/PM"
  if (isUpcoming) {
    const rows =
      lvm.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
        ?.metadataRows || [];
    for (const row of rows) {
      for (const part of row.metadataParts || []) {
        const content = part?.text?.content || "";
        const m = content.match(
          /(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i
        );
        if (m) {
          let [, month, day, year, hour, minute, ampm] = m;
          if (year.length === 2) year = "20" + year;
          let h = parseInt(hour, 10);
          if (ampm) {
            if (ampm.toUpperCase() === "PM" && h < 12) h += 12;
            if (ampm.toUpperCase() === "AM" && h === 12) h = 0;
          }
          const parsed = new Date(
            `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${String(h).padStart(2, "0")}:${minute}:00`
          );
          if (!isNaN(parsed.getTime())) scheduledStart = parsed.getTime();
        }
      }
    }
  }

  return {
    videoId,
    title,
    thumbnail,
    channelName: "Swaminarayan",
    channelId,
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    isLive,
    upcoming: isUpcoming,
    startedAt: isLive ? new Date().toISOString() : null,
    scheduledStart,
    duration: isLive ? -1 : 0,
    publishedAt: null,
    source: "youtube-scrape",
  };
}

function normalizeVideoRenderer(vr, channelId) {
  if (!vr?.videoId) return null;

  const videoId = vr.videoId;
  const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || "Untitled";
  const thumbs = vr.thumbnail?.thumbnails || [];
  const thumbnail =
    thumbs[thumbs.length - 1]?.url ||
    thumbs[0]?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const isLive =
    (vr.badges || []).some((b) => b.liveBadge || b.liveTabBadgeRenderer) ||
    (vr.thumbnailOverlays || []).some(
      (o) => o.thumbnailOverlayTimeStatusRenderer?.style === "LIVE"
    );

  const isUpcoming = !!vr.upcomingEventData;
  const scheduledStart = vr.upcomingEventData?.startTime
    ? Number(vr.upcomingEventData.startTime) * 1000
    : null;

  return {
    videoId,
    title,
    thumbnail,
    channelName: "Swaminarayan",
    channelId,
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    isLive,
    upcoming: isUpcoming,
    startedAt: isLive ? new Date().toISOString() : null,
    scheduledStart,
    duration: isLive ? -1 : 0,
    publishedAt: null,
    source: "youtube-scrape",
  };
}

async function fetchChannels(channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];

  // 1. Try Piped for all channels in parallel
  const pipedResults = await Promise.allSettled(
    ids.map((id) => fetchPipedChannel(id))
  );

  const allVideos = [];
  const needsFallback = []; // channels where Piped failed

  pipedResults.forEach((result, i) => {
    const channelId = ids[i];
    if (result.status === "fulfilled" && result.value) {
      const { data } = result.value;
      (data.relatedStreams || []).forEach((stream) => {
        const v = normalizePiped(stream, channelId, data.name);
        if (v) allVideos.push(v);
      });
    } else {
      needsFallback.push(channelId);
    }
  });

  if (needsFallback.length === 0) return allVideos;

  // 2. YouTube scrape for failed channels (only scrapes /streams tab — good for live detection)
  console.warn(`[API] Piped failed — trying YouTube scrape for: ${needsFallback.join(", ")}`);
  const scrapeResults = await Promise.allSettled(
    needsFallback.map((id) => fetchYouTubeScrape(id))
  );

  const needsRss = []; // channels where scrape also failed OR returned nothing

  scrapeResults.forEach((result, i) => {
    const channelId = needsFallback[i];
    if (result.status === "fulfilled" && result.value !== null && result.value.length > 0) {
      // Scrape returned live/upcoming items — use them
      allVideos.push(...result.value);
    } else {
      // Scrape failed or returned empty (e.g. videos-only channel with no live streams)
      needsRss.push(channelId);
    }
  });

  if (needsRss.length === 0) return allVideos;

  // 3. RSS fallback for channels where scrape returned nothing
  console.warn(`[API] YouTube scrape empty/failed — falling back to RSS for: ${needsRss.join(", ")}`);
  const rssResults = await Promise.allSettled(
    needsRss.map((id) => fetchRSSChannel(id))
  );
  rssResults.forEach((result) => {
    if (result.status === "fulfilled" && result.value) {
      allVideos.push(...result.value);
    }
  });

  return allVideos;
}

export function fetchStreamChannel() {
  return fetchChannels(CHANNELS.streams);
}

// Katha channel only needs past videos (no live detection) — skip scrape, use Piped→RSS
export async function fetchKathaChannel() {
  const piped = await fetchPipedChannel(CHANNELS.videos);
  if (piped) {
    const videos = [];
    (piped.data.relatedStreams || []).forEach((stream) => {
      const v = normalizePiped(stream, CHANNELS.videos, piped.data.name);
      if (v) videos.push(v);
    });
    if (videos.length > 0) return videos;
  }
  console.warn("[API] Piped failed for katha — falling back to RSS");
  return (await fetchRSSChannel(CHANNELS.videos)) || [];
}

export function fetchChannelById(channelId) {
  return fetchChannels(channelId);
}

// ─── Main: fetch all videos from both channels ────────────────────────────────
// Returns the permanent response shape — THIS SHAPE NEVER CHANGES
export async function fetchAllChannels() {
  return fetchChannels(Object.values(CHANNELS));
}

// ─── Filter helpers ───────────────────────────────────────────────────────────
export function getLiveStreams(videos) {
  return videos
    .filter((v) => v.isLive)
    .sort((a, b) => getLiveStartMs(b) - getLiveStartMs(a));
}
export function getUpcoming(videos)      { return videos.filter((v) => v.upcoming && !v.isLive); }
export function getRecentVideos(videos, limit = 30) {
  return videos
    .filter((v) => !v.isLive && !v.upcoming)
    .sort((a, b) => (toEpochMs(b.publishedAt) || 0) - (toEpochMs(a.publishedAt) || 0))
    .slice(0, limit);
}
