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

// ─── Cache — cache-first, serves stale while refreshing in background ─────────
const cache = new Map(); // key → { videos, fetchedAt }
const CACHE_FRESH_MS  = 2  * 60 * 1000; // < 2min  → return instantly, no fetch
const CACHE_STALE_MS  = 60 * 60 * 1000; // < 60min → return stale + refresh bg
const refreshing = new Set();            // keys currently being refreshed

function cacheGet(key) {
  return cache.get(key) || null;
}

function cacheSet(key, videos) {
  cache.set(key, { videos, fetchedAt: Date.now() });
}

// ─── Circuit breaker for Piped — open after 3 failures, retry after 5min ─────
const CIRCUIT_THRESHOLD   = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const pipedCircuit = {
  failures: 0,
  openedAt: null,
  isOpen() {
    if (!this.openedAt) return false;
    if (Date.now() - this.openedAt > CIRCUIT_COOLDOWN_MS) {
      this.failures = 0;
      this.openedAt = null;
      console.log("[Piped Circuit] Half-open — probing Piped again");
      return false;
    }
    return true;
  },
  recordFailure() {
    this.failures++;
    if (this.failures >= CIRCUIT_THRESHOLD && !this.openedAt) {
      this.openedAt = Date.now();
      console.warn(`[Piped Circuit] OPEN — skipping Piped for ${CIRCUIT_COOLDOWN_MS / 60000}min`);
    }
  },
  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
  },
};

// Piped instances — tried in order, first success wins
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.yt",
  "https://pipedapi.adminforge.de",
  "https://piped-api.coke.cx",
];

// ─── Fetch one channel from Piped (skipped when circuit is open) ─────────────
async function fetchPipedChannel(channelId) {
  if (pipedCircuit.isOpen()) return null;

  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${base}/channel/${channelId}`, {
        signal: AbortSignal.timeout(4000), // 4s per instance (was 8s)
        headers: { "User-Agent": "SMK-TV-Monitor/1.0" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.relatedStreams?.length >= 0) {
        console.log(`[Piped] OK: ${base} → ${channelId}`);
        pipedCircuit.recordSuccess();
        return { data, source: base };
      }
    } catch (e) {
      console.warn(`[Piped] FAIL: ${base} → ${e.message}`);
    }
  }
  pipedCircuit.recordFailure();
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
    startedAt: null,
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
    startedAt: null,
    scheduledStart,
    duration: isLive ? -1 : 0,
    publishedAt: null,
    source: "youtube-scrape",
  };
}

// ─── Core fetch — Piped → YouTube scrape → RSS, caches result ────────────────
async function doFetch(ids, cacheKey) {
  const allVideos = [];

  // 1. Piped (skipped when circuit is open)
  const pipedResults = await Promise.allSettled(ids.map((id) => fetchPipedChannel(id)));
  const needsFallback = [];
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

  // 2. YouTube scrape for failed channels
  if (needsFallback.length > 0) {
    console.warn(`[API] Piped failed — scraping YouTube for: ${needsFallback.join(", ")}`);
    const scrapeResults = await Promise.allSettled(needsFallback.map((id) => fetchYouTubeScrape(id)));
    const needsRss = [];
    scrapeResults.forEach((result, i) => {
      const channelId = needsFallback[i];
      if (result.status === "fulfilled" && result.value !== null && result.value.length > 0) {
        allVideos.push(...result.value);
      } else {
        needsRss.push(channelId);
      }
    });

    // 3. RSS for channels where scrape also returned nothing
    if (needsRss.length > 0) {
      console.warn(`[API] Scrape empty — falling back to RSS for: ${needsRss.join(", ")}`);
      const rssResults = await Promise.allSettled(needsRss.map((id) => fetchRSSChannel(id)));
      rssResults.forEach((result) => {
        if (result.status === "fulfilled" && result.value) {
          allVideos.push(...result.value);
        }
      });
    }
  }

  if (allVideos.length > 0) {
    cacheSet(cacheKey, allVideos);
    return allVideos;
  }

  // All sources failed — return stale cache rather than empty
  const cached = cacheGet(cacheKey);
  if (cached) {
    const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60000);
    console.warn(`[API] All sources failed — serving cache (${ageMin}m old) for: ${cacheKey}`);
    return cached.videos.map((v) => ({ ...v, stale: true }));
  }

  return [];
}

// ─── Public fetch — cache-first, background refresh when stale ───────────────
async function fetchChannels(channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
  const cacheKey = ids.join(",");

  const cached = cacheGet(cacheKey);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;

    if (age < CACHE_FRESH_MS) {
      // Fresh — return instantly, no network call
      return cached.videos;
    }

    // Stale — return cached data immediately and refresh in the background
    if (!refreshing.has(cacheKey)) {
      refreshing.add(cacheKey);
      doFetch(ids, cacheKey)
        .catch((e) => console.error(`[Cache BG Refresh] ${cacheKey}:`, e))
        .finally(() => refreshing.delete(cacheKey));
    }

    const isVeryStale = age > CACHE_STALE_MS;
    return cached.videos.map((v) => (isVeryStale ? { ...v, stale: true } : v));
  }

  // No cache at all — must fetch now (first call or cache cleared)
  return doFetch(ids, cacheKey);
}

export function fetchStreamChannel() {
  return fetchChannels(CHANNELS.streams);
}

// Katha channel — Piped→RSS only (no scrape needed, just past videos)
async function doFetchKatha() {
  const cacheKey = `katha:${CHANNELS.videos}`;

  if (!pipedCircuit.isOpen()) {
    const piped = await fetchPipedChannel(CHANNELS.videos);
    if (piped) {
      const videos = [];
      (piped.data.relatedStreams || []).forEach((stream) => {
        const v = normalizePiped(stream, CHANNELS.videos, piped.data.name);
        if (v) videos.push(v);
      });
      if (videos.length > 0) { cacheSet(cacheKey, videos); return videos; }
    }
  }

  console.warn("[API] Piped failed for katha — falling back to RSS");
  const rss = await fetchRSSChannel(CHANNELS.videos);
  if (rss && rss.length > 0) { cacheSet(cacheKey, rss); return rss; }

  const cached = cacheGet(cacheKey);
  if (cached) {
    console.warn(`[API] All sources failed for katha — serving cache`);
    return cached.videos.map((v) => ({ ...v, stale: true }));
  }
  return [];
}

export function fetchKathaChannel() {
  const cacheKey = `katha:${CHANNELS.videos}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < CACHE_FRESH_MS) return Promise.resolve(cached.videos);
    if (!refreshing.has(cacheKey)) {
      refreshing.add(cacheKey);
      doFetchKatha().catch((e) => console.error("[Katha BG Refresh]", e)).finally(() => refreshing.delete(cacheKey));
    }
    return Promise.resolve(cached.videos.map((v) => (age > CACHE_STALE_MS ? { ...v, stale: true } : v)));
  }
  return doFetchKatha();
}

// ─── Warm cache on server startup so first real request is instant ────────────
export async function warmCache() {
  console.log("[Cache] Warming up...");
  await Promise.allSettled([
    doFetch([CHANNELS.streams], CHANNELS.streams),
    doFetchKatha(),
  ]);
  console.log("[Cache] Warm-up complete");
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
