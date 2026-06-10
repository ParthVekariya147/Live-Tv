// monitor-live.js
// Live Event Monitor 1, Live Event Monitor 2, Upcoming Event Monitor
// Matches the logic extracted from live-tv-controller.exe

// ─── Config ───────────────────────────────────────────────────────────────────
// Proxy selection: local dev server takes priority if reachable, else falls back.
// For production deploy to Vercel (see live-tv-api/) and set API_BASE_URL there.
const _LOCAL_PROXY   = "http://localhost:8765/proxy?url=";
const _CODETABS      = "https://api.codetabs.com/v1/proxy?quest=";
let   CORS_PROXY     = _LOCAL_PROXY; // resolved on first poll via _resolveProxy()

async function _resolveProxy() {
  try {
    const r = await fetch(_LOCAL_PROXY + encodeURIComponent("https://example.com"), { signal: AbortSignal.timeout(3000) });
    if (r.ok) { CORS_PROXY = _LOCAL_PROXY; return; }
  } catch { /* local not running */ }
  CORS_PROXY = _CODETABS;
  console.warn("[Monitor] Local proxy not reachable — using codetabs (may be slow or blocked)");
}

const STREAMS_URL    = "https://www.youtube.com/@swaminarayan/streams";
const POLL_MS        = 30000; // 30 seconds — matches the exe
const ALLOWED_CH     = ["Swaminarayan Bhagwan 1", "Swaminarayan", "Swaminarayan Bhagwan"];

// ─── State ────────────────────────────────────────────────────────────────────
let monitor1Active   = true;
let monitor2Active   = true;
let pollTimer        = null;
let lastAutoLoadedId = null;          // prevents re-triggering same video

// Shared: player-live.js reads these for its own auto-load
window.detectedLiveStreams     = [];
window.detectedUpcomingStreams = [];

// ─── Parse ytInitialData from raw HTML (3 regex strategies) ──────────────────
function parseYtInitialDataFull(html) {
  if (!html || html.length === 0) throw new Error("HTML is empty");

  const patterns = [
    /(?:var|window\["|)ytInitialData(?:\]|) = ({.*?});/s,
    /ytInitialData\s*=\s*({.*?});/s,
    /(?:window\.)?ytInitialData\s*=\s*({[\s\S]*?^})/m,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1]) {
      try { return JSON.parse(m[1]); }
      catch { continue; }
    }
  }

  // Deep fallback — extract videoRenderer blocks directly
  const items = deepExtractVideoRenderers(html);
  if (items.length > 0) {
    return {
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [{ tabRenderer: { content: { sectionListRenderer: {
            contents: [{ itemSectionRenderer: { contents: items } }]
          } } } }]
        }
      }
    };
  }

  throw new Error("Could not find or parse ytInitialData — HTML structure may have changed");
}

function deepExtractVideoRenderers(html) {
  const results = [];
  const re = /"videoRenderer":\{"videoId":"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ videoRenderer: { videoId: m[1], title: { runs: [{ text: "Unknown" }] } } });
  }
  return results;
}

// ─── Normalize lockupViewModel (new YouTube format, 2024+) ───────────────────
function normalizeLockupViewModel(lockup) {
  const videoId = lockup.contentId;
  if (!videoId) return null;

  const title =
    lockup.metadata?.lockupMetadataViewModel?.title?.content ||
    lockup.title?.content ||
    "No Title";

  // Thumbnail: YouTube 2026 uses contentImage, older used thumbnail
  const thumbViewModel =
    lockup.contentImage?.thumbnailViewModel ||
    lockup.thumbnail?.thumbnailViewModel;
  const sources = thumbViewModel?.image?.sources || [];
  const thumbnailUrl =
    sources[sources.length - 1]?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  // Overlays: same path change as thumbnail
  const overlays = thumbViewModel?.overlays || [];

  // Helper: extract badge text from any overlay object
  function getBadgeText(o) {
    // New format (2026): thumbnailBottomOverlayViewModel.badges[]
    const bottom = o.thumbnailBottomOverlayViewModel;
    if (bottom?.badges) {
      for (const b of bottom.badges) {
        const t = b.thumbnailBadgeViewModel?.text;
        const s = b.thumbnailBadgeViewModel?.badgeStyle || "";
        if (t) return { text: t.toUpperCase(), style: s };
      }
    }
    // Old format: thumbnailOverlayTimeStatusRenderer / thumbnailOverlayBadgeViewModel
    const ts = o.thumbnailOverlayTimeStatusRenderer || o.thumbnailOverlayTimeStatusViewModel;
    if (ts?.style) return { text: ts.style.toUpperCase(), style: ts.style };
    const bv = o.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel;
    if (bv?.style) return { text: bv.style.toUpperCase(), style: bv.style };
    return null;
  }

  let isLive     = false;
  let isUpcoming = false;

  for (const o of overlays) {
    const badge = getBadgeText(o);
    if (!badge) continue;
    if (badge.text === "LIVE" || badge.style.includes("LIVE")) isLive = true;
    if (badge.text === "UPCOMING" || badge.style.includes("UPCOMING")) isUpcoming = true;
  }

  // Scheduled start time: in metadataRows as "Scheduled for M/D/YY, H:MM AM/PM"
  let startTime = null;
  if (isUpcoming) {
    const rows =
      lockup.metadata?.lockupMetadataViewModel?.metadata
        ?.contentMetadataViewModel?.metadataRows || [];
    for (const row of rows) {
      for (const part of row.metadataParts || []) {
        const txt = part.text?.content || "";
        if (txt.toLowerCase().startsWith("scheduled for")) {
          try { startTime = new Date(txt.replace(/^scheduled for\s*/i, "")); } catch {}
          break;
        }
      }
      if (startTime) break;
    }
  }

  // Duration badge: when text is not LIVE/UPCOMING it's "H:MM:SS" or "MM:SS"
  let duration = "";
  for (const o of overlays) {
    const bottom = o.thumbnailBottomOverlayViewModel;
    if (bottom?.badges) {
      for (const b of bottom.badges) {
        const t = b.thumbnailBadgeViewModel?.text || "";
        const up = t.toUpperCase();
        if (up !== "LIVE" && up !== "UPCOMING" && /^\d+:\d+/.test(t)) {
          duration = t;
        }
      }
    }
  }

  // Upload date / view count from metadataRows
  let uploadedDate = "";
  const metaRows =
    lockup.metadata?.lockupMetadataViewModel?.metadata
      ?.contentMetadataViewModel?.metadataRows || [];
  for (const row of metaRows) {
    for (const part of row.metadataParts || []) {
      const txt = part.text?.content || "";
      if (/\d+.*(ago|view|watch)/i.test(txt) && !txt.toLowerCase().startsWith("scheduled")) {
        if (!uploadedDate) uploadedDate = txt;
      }
    }
  }

  return {
    videoId,
    title,
    thumbnailUrl: thumbnailUrl.replace(/^\/\//, "https://"),
    isLive,
    isUpcoming,
    startTime,
    duration,
    uploadedDate,
    channelName: "",
    channelUrl: "https://www.youtube.com/@swaminarayan",
  };
}

// ─── Normalize legacy videoRenderer (old YouTube format) ─────────────────────
function normalizeVideoRenderer(vr) {
  const videoId = vr.videoId;
  if (!videoId) return null;

  const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || "No Title";

  const thumbs = vr.thumbnail?.thumbnails || [];
  const thumbnailUrl =
    thumbs[thumbs.length - 1]?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const isLive =
    vr.badges?.some((b) => b.liveTabBadgeRenderer) ||
    vr.thumbnailOverlays?.some(
      (b) => b.thumbnailOverlayTimeStatusRenderer?.style === "LIVE"
    ) ||
    false;

  const isUpcoming = !!vr.upcomingEventData;

  let startTime = null;
  if (vr.upcomingEventData?.startTime) {
    startTime = new Date(parseInt(vr.upcomingEventData.startTime, 10) * 1000);
  }

  const channelName =
    vr.ownerText?.runs?.[0]?.text ||
    vr.longBylineText?.runs?.[0]?.text ||
    "";

  const channelUrlPath =
    vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
    vr.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
    "";

  return {
    videoId,
    title,
    thumbnailUrl: thumbnailUrl.replace(/^\/\//, "https://"),
    isLive,
    isUpcoming,
    startTime,
    channelName,
    channelUrl: channelUrlPath
      ? `https://www.youtube.com${channelUrlPath}`
      : "https://www.youtube.com/@swaminarayan",
  };
}

// ─── Extract all video items from parsed ytInitialData ────────────────────────
function extractVideoItems(ytData) {
  const tabs =
    ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];

  // Find the streams tab (param starts with EgdzdHJlYW1z = base64 "streams")
  const streamsTab =
    tabs.find((t) => {
      const params = t.tabRenderer?.endpoint?.browseEndpoint?.params || "";
      return params === "EgdzdHJlYW1z" || params.startsWith("EgdzdHJlYW1z");
    }) || tabs.find((t) => t.tabRenderer?.selected) || tabs[0];

  const results = [];

  // ── New format: richGridRenderer → richItemRenderer → lockupViewModel ───
  const richContents =
    streamsTab?.tabRenderer?.content?.richGridRenderer?.contents || [];

  if (richContents.length > 0) {
    for (const item of richContents) {
      const lockup = item?.richItemRenderer?.content?.lockupViewModel;
      if (lockup) {
        const v = normalizeLockupViewModel(lockup);
        if (v) results.push(v);
      }
    }
    if (results.length > 0) {
      console.log("[Monitor] Using new lockupViewModel format, count:", results.length);
      return results;
    }
  }

  // ── Old format: sectionListRenderer → itemSectionRenderer → videoRenderer ─
  const sections =
    streamsTab?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  for (const section of sections) {
    const items =
      section?.itemSectionRenderer?.contents ||
      section?.shelfRenderer?.content?.horizontalListRenderer?.items ||
      [];
    for (const item of items) {
      if (item?.videoRenderer) {
        const v = normalizeVideoRenderer(item.videoRenderer);
        if (v) results.push(v);
      }
    }
  }

  if (results.length > 0) {
    console.log("[Monitor] Using legacy videoRenderer format, count:", results.length);
    return results;
  }

  // ── Deep search as last resort ────────────────────────────────────────────
  const deepSearch = (obj) => {
    let found = [];
    if (typeof obj !== "object" || obj === null) return found;
    if (obj.videoRenderer) {
      const v = normalizeVideoRenderer(obj.videoRenderer);
      if (v) found.push(v);
    }
    if (obj.lockupViewModel?.contentId) {
      const v = normalizeLockupViewModel(obj.lockupViewModel);
      if (v) found.push(v);
    }
    for (const key of Object.keys(obj)) {
      found = found.concat(deepSearch(obj[key]));
    }
    return found;
  };

  const deep = deepSearch(ytData);
  console.log("[Monitor] Used deep search, count:", deep.length);
  return deep;
}

// ─── Verify video channel via oEmbed (same as allowedChannels in core-utils) ─
async function verifyChannel(video) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${video.videoId}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!ALLOWED_CH.includes(data.author_name)) return null;
    // Use oEmbed channel name (most accurate)
    return { ...video, channelName: data.author_name, channelUrl: data.author_url || video.channelUrl };
  } catch {
    return null;
  }
}

// ─── Fetch channel HTML via CORS proxy ────────────────────────────────────────
async function fetchChannelHTML(url) {
  const proxied = CORS_PROXY + encodeURIComponent(url);
  const res = await fetch(proxied, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
  return res.text();
}

// ─── Filter by comma-separated search terms (matches exe's z0 function) ──────
function filterBySearchTerms(terms, videos) {
  if (!terms || terms.trim() === "") return null;
  const keywords = terms.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (keywords.length === 0) return null;
  for (const video of videos) {
    const t = (video.title || "").toLowerCase();
    if (keywords.some((k) => t.includes(k))) return video.videoId;
  }
  return null;
}

// ─── Render a monitor card (1 or 2) ──────────────────────────────────────────
function renderMonitorCard(num, video) {
  const thumb   = document.getElementById(`video-thumbnail-display-${num}`);
  const titleEl = document.getElementById(`video-title-display-${num}`);
  const idEl    = document.getElementById(`video-id-display-${num}`);
  const chName  = document.getElementById(`channel-name-display-${num}`);
  const chUrl   = document.getElementById(`channel-url-display-${num}`);

  if (!video) {
    if (thumb)  thumb.src = "https://placehold.co/280x157.5/1a1a2e/888?text=No+Live+Stream";
    if (titleEl) titleEl.textContent = "No live stream found";
    if (idEl)    idEl.textContent    = "";
    if (chName)  chName.textContent  = "";
    if (chUrl)   chUrl.innerHTML     = "—";
    return;
  }

  if (thumb) {
    thumb.src = video.thumbnailUrl;
    thumb.onerror = () => {
      thumb.src = `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`;
    };
  }
  if (titleEl) titleEl.textContent = video.title;
  if (idEl)    idEl.textContent    = video.videoId;
  if (chName)  chName.textContent  = video.channelName || "Swaminarayan Bhagwan";
  if (chUrl) {
    const link = video.channelUrl || "https://www.youtube.com/@swaminarayan";
    chUrl.innerHTML = `<a href="${link}" target="_blank" style="color:#22d3ee;word-break:break-all;">${link}</a>`;
  }
}

// ─── Render Upcoming Event Monitor ───────────────────────────────────────────
function renderUpcomingMonitor(video) {
  const thumb   = document.getElementById("upcoming-video-thumbnail-display");
  const titleEl = document.getElementById("upcoming-video-title-display");
  const idEl    = document.getElementById("upcoming-video-id-display");
  const chName  = document.getElementById("upcoming-channel-name-display");
  const chUrl   = document.getElementById("upcoming-channel-url-display");
  const startEl = document.getElementById("upcoming-start-time-display");

  if (!video) {
    if (thumb)  thumb.src = "https://placehold.co/280x157.5/1a1a2e/888?text=No+Upcoming+Event";
    if (titleEl) titleEl.textContent = "No upcoming events found";
    if (idEl)    idEl.textContent    = "";
    if (chName)  chName.textContent  = "";
    if (chUrl)   chUrl.innerHTML     = "—";
    if (startEl) startEl.textContent = "";
    return;
  }

  if (thumb) {
    thumb.src = video.thumbnailUrl;
    thumb.onerror = () => {
      thumb.src = `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`;
    };
  }
  if (titleEl) titleEl.textContent = video.title;
  if (idEl)    idEl.textContent    = video.videoId;
  if (chName)  chName.textContent  = video.channelName || "Swaminarayan Bhagwan";
  if (chUrl) {
    const link = video.channelUrl || "https://www.youtube.com/@swaminarayan";
    chUrl.innerHTML = `<a href="${link}" target="_blank" style="color:#22d3ee;word-break:break-all;">${link}</a>`;
  }
  if (startEl) {
    startEl.textContent = video.startTime
      ? video.startTime.toLocaleString()
      : "Time not specified";
  }
}

// ─── Auto-load logic — mirrors exe exactly ────────────────────────────────────
function runAutoLoad(liveStreams) {
  if (liveStreams.length === 0) return;

  // Read live player priority setting
  let priority = "matchSearchTerms";
  let currentVideoId = null;
  try {
    const saved = localStorage.getItem("livePlayerState");
    if (saved) {
      const s = JSON.parse(saved);
      priority = s.priority || "matchSearchTerms";
      currentVideoId = s.videoId || null;
    }
  } catch {}

  let targetId = null;

  if (priority === "firstLive") {
    targetId = liveStreams[0]?.videoId || null;
  } else if (priority === "secondLive") {
    targetId = liveStreams[1]?.videoId || null;
  } else {
    // matchSearchTerms — use savedSearchTitles1 from localStorage
    const terms = localStorage.getItem("savedSearchTitles1") || "";
    targetId = filterBySearchTerms(terms, liveStreams);
    // Fallback to first live if no match
    if (!targetId) targetId = liveStreams[0]?.videoId || null;
  }

  // Only dispatch if it's a new video we haven't loaded yet
  if (targetId && targetId !== lastAutoLoadedId && targetId !== currentVideoId) {
    console.log(`[Monitor] Auto-loading "${targetId}" (priority: ${priority})`);
    lastAutoLoadedId = targetId;
    window.dispatchEvent(
      new CustomEvent("livePlayerAutoLoad", { detail: { videoId: targetId } })
    );
  }
}

// ─── Main poll function ───────────────────────────────────────────────────────
let _proxyResolved = false;
async function pollMonitors() {
  if (!monitor1Active && !monitor2Active) return;

  if (!_proxyResolved) {
    await _resolveProxy();
    _proxyResolved = true;
  }

  console.log("[Monitor] Fetching streams at", new Date().toLocaleTimeString(), "via", CORS_PROXY.split("?")[0]);

  let html;
  try {
    html = await fetchChannelHTML(STREAMS_URL);
  } catch (e) {
    console.error("[Monitor] Fetch failed:", e.message);
    return;
  }

  if (!html.includes("ytInitialData")) {
    console.warn("[Monitor] Response does not contain ytInitialData");
    return;
  }

  let ytData;
  try {
    ytData = parseYtInitialDataFull(html);
  } catch (e) {
    console.error("[Monitor] Parse error:", e.message);
    return;
  }

  // Extract all video items from the streams tab
  const allItems = extractVideoItems(ytData);
  console.log("[Monitor] Total items extracted:", allItems.length);

  // Separate live and upcoming
  const liveRaw     = allItems.filter((v) => v.isLive);
  const upcomingRaw = allItems.filter((v) => v.isUpcoming && !v.isLive);
  console.log(`[Monitor] Live: ${liveRaw.length}, Upcoming: ${upcomingRaw.length}`);

  // Verify channels in parallel (oEmbed check against ALLOWED_CH)
  const [verifiedLive, verifiedUpcoming] = await Promise.all([
    Promise.all(liveRaw.map(verifyChannel)).then((r) => r.filter(Boolean)),
    Promise.all(upcomingRaw.map(verifyChannel)).then((r) => r.filter(Boolean)),
  ]);

  // Sort upcoming by start time
  verifiedUpcoming.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  // Store globally
  window.detectedLiveStreams     = verifiedLive;
  window.detectedUpcomingStreams = verifiedUpcoming;

  console.log(`[Monitor] Verified live: ${verifiedLive.length}, upcoming: ${verifiedUpcoming.length}`);

  // Apply search-term filters for which live stream each monitor shows
  const search1  = localStorage.getItem("savedSearchTitles1") || document.getElementById("videoTitleSearchInput-1")?.value || "";
  const search2  = localStorage.getItem("savedSearchTitles2") || document.getElementById("videoTitleSearchInput-2")?.value || "";

  const match1Id = filterBySearchTerms(search1, verifiedLive);
  const match2Id = filterBySearchTerms(search2, verifiedLive);

  const video1   = verifiedLive.find((v) => v.videoId === match1Id) || verifiedLive[0] || null;
  const video2   = verifiedLive.find((v) => v.videoId === match2Id) ||
                   verifiedLive.find((v) => v.videoId !== video1?.videoId) ||
                   verifiedLive[1] || video1 || null;

  if (monitor1Active) renderMonitorCard(1, video1);
  if (monitor2Active) renderMonitorCard(2, video2);
  renderUpcomingMonitor(verifiedUpcoming[0] || null);

  // Auto-load to live player
  runAutoLoad(verifiedLive);
}

// ─── Save search terms to localStorage on every keystroke ────────────────────
function initSearchInputs() {
  const input1 = document.getElementById("videoTitleSearchInput-1");
  const input2 = document.getElementById("videoTitleSearchInput-2");

  // Restore saved search terms on load
  if (input1) {
    const saved = localStorage.getItem("savedSearchTitles1");
    if (saved) input1.value = saved;
    input1.addEventListener("input", () => {
      localStorage.setItem("savedSearchTitles1", input1.value);
      // Re-apply filter immediately against cached data (no extra fetch)
      const live = window.detectedLiveStreams || [];
      if (live.length > 0) {
        const id = filterBySearchTerms(input1.value, live);
        const v  = live.find((x) => x.videoId === id) || live[0] || null;
        if (monitor1Active) renderMonitorCard(1, v);
      }
    });
  }

  if (input2) {
    const saved = localStorage.getItem("savedSearchTitles2");
    if (saved) input2.value = saved;
    input2.addEventListener("input", () => {
      localStorage.setItem("savedSearchTitles2", input2.value);
      const live = window.detectedLiveStreams || [];
      if (live.length > 0) {
        const id = filterBySearchTerms(input2.value, live);
        const v  = live.find((x) => x.videoId === id) ||
                   live.find((x) => x.videoId !== (window.detectedLiveStreams[0]?.videoId)) ||
                   live[1] || live[0] || null;
        if (monitor2Active) renderMonitorCard(2, v);
      }
    });
  }
}

// ─── Copy buttons ─────────────────────────────────────────────────────────────
document.getElementById("copy-video-id-btn-1")?.addEventListener("click", () => {
  const id = document.getElementById("video-id-display-1")?.textContent?.trim();
  if (id) copyToClipboard(id);
});
document.getElementById("copy-video-id-btn-2")?.addEventListener("click", () => {
  const id = document.getElementById("video-id-display-2")?.textContent?.trim();
  if (id) copyToClipboard(id);
});
document.getElementById("copy-upcoming-video-id-btn")?.addEventListener("click", () => {
  const id = document.getElementById("upcoming-video-id-display")?.textContent?.trim();
  if (id) copyToClipboard(id);
});

// ─── Monitor toggle buttons ───────────────────────────────────────────────────
document.getElementById("btnToggleLiveMonitor1")?.addEventListener("click", function () {
  monitor1Active = !monitor1Active;
  localStorage.setItem("liveMonitorEnabled1", String(monitor1Active));
  this.textContent = monitor1Active ? "Monitor 1: On" : "Monitor 1: Off";
  this.className   = monitor1Active ? "toggle-btn on-monitor" : "toggle-btn off";
  if (!monitor1Active) renderMonitorCard(1, null);
  else pollMonitors();
});
document.getElementById("btnToggleLiveMonitor2")?.addEventListener("click", function () {
  monitor2Active = !monitor2Active;
  localStorage.setItem("liveMonitorEnabled2", String(monitor2Active));
  this.textContent = monitor2Active ? "Monitor 2: On" : "Monitor 2: Off";
  this.className   = monitor2Active ? "toggle-btn on-monitor" : "toggle-btn off";
  if (!monitor2Active) renderMonitorCard(2, null);
  else pollMonitors();
});

// ─── Restore toggle state from localStorage ───────────────────────────────────
function restoreToggleState() {
  const s1 = localStorage.getItem("liveMonitorEnabled1");
  const s2 = localStorage.getItem("liveMonitorEnabled2");
  const btn1 = document.getElementById("btnToggleLiveMonitor1");
  const btn2 = document.getElementById("btnToggleLiveMonitor2");

  if (s1 !== null) {
    monitor1Active = s1 === "true";
    if (btn1) {
      btn1.textContent = monitor1Active ? "Monitor 1: On" : "Monitor 1: Off";
      btn1.className   = monitor1Active ? "toggle-btn on-monitor" : "toggle-btn off";
    }
  }
  if (s2 !== null) {
    monitor2Active = s2 === "true";
    if (btn2) {
      btn2.textContent = monitor2Active ? "Monitor 2: On" : "Monitor 2: Off";
      btn2.className   = monitor2Active ? "toggle-btn on-monitor" : "toggle-btn off";
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
restoreToggleState();
initSearchInputs();
pollMonitors();                                   // immediate first fetch
pollTimer = setInterval(pollMonitors, POLL_MS);   // then every 30 seconds
console.log("[Monitor] Started — polling every", POLL_MS / 1000, "sec");
