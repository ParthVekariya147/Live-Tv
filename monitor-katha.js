// monitor-katha.js
// Handles: Katha Monitor — video list, selection, Delay Player loading, schedulers
// CORS_PROXY, parseYtInitialDataFull, normalizeLockupViewModel defined in monitor-live.js (loaded first)

// Videos tab — scrapes the channel's latest 30 videos via lockupViewModel (same format as Live Monitor)
const KATHA_VIDEOS_URL = "https://www.youtube.com/channel/UCQXWP4gEdEwlb6vodwrU75A/videos";
const KATHA_CHANNEL_ID = "UCQXWP4gEdEwlb6vodwrU75A";

let kathaVideos = [];
let selectedKathaVideo = null;

// Scheduler state
let isRefreshSchedulerOn = false;
let isPlayerSchedulerOn = false;
let refreshSchedulerTimer = null;
let playerSchedulerTimer = null;

// ─── Extract all lockupViewModel items from a Videos/Streams tab ─────────────
function extractAllLockups(ytData) {
  const tabs = ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  // Use selected tab, or first tab with richGridRenderer content
  const tab =
    tabs.find((t) => t.tabRenderer?.selected) ||
    tabs.find((t) => t.tabRenderer?.content?.richGridRenderer) ||
    tabs[0];
  const contents = tab?.tabRenderer?.content?.richGridRenderer?.contents || [];

  const videos = [];
  for (const item of contents) {
    const lockup = item?.richItemRenderer?.content?.lockupViewModel;
    if (!lockup) continue;
    const v = normalizeLockupViewModel(lockup);
    if (v) videos.push(v);
  }
  return videos;
}

// ─── Fetch Katha videos and populate the list ─────────────────────────────────
async function fetchKathaVideos() {
  const loadingEl  = document.getElementById("katha-loading");
  const errorEl    = document.getElementById("katha-error-message");
  const errorTextEl = document.getElementById("katha-error-text");
  const statusEl   = document.getElementById("kathaSchedulerStatus");
  const listEl     = document.getElementById("katha-video-list");

  loadingEl?.classList.remove("hidden");
  errorEl?.classList.add("hidden");
  if (listEl) listEl.innerHTML = "";
  if (statusEl) statusEl.textContent = "Loading Katha content...";

  try {
    let videos = [];

    // ── Primary: scrape YouTube playlist via CORS proxy (same as exe) ─────────
    try {
      const proxied = CORS_PROXY + encodeURIComponent(KATHA_VIDEOS_URL);
      const res = await fetch(proxied, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      if (!html.includes("ytInitialData")) throw new Error("No ytInitialData in response");

      const ytData = parseYtInitialDataFull(html);
      const raw    = extractAllLockups(ytData);

      // Map lockupViewModel → Katha card shape (thumbnail field expected by renderKathaVideoList)
      videos = raw.map((v) => ({
        videoId:      v.videoId,
        title:        v.title,
        thumbnail:    v.thumbnailUrl,
        duration:     v.duration || "",
        uploadedDate: v.uploadedDate || "",
        isLive:       v.isLive,
        channelName:  "Swaminarayan Bhagwan",
      }));

      console.log("[KathaMonitor] Videos tab scraped —", videos.length, "videos");
    } catch (e) {
      console.warn("[KathaMonitor] Videos tab scrape failed:", e.message);
    }

    // ── Fallback: YouTube RSS feed (free, stable 15 items) ───────────────────
    if (videos.length === 0) {
      console.warn("[KathaMonitor] Trying RSS fallback...");
      try {
        const rssUrl  = `https://www.youtube.com/feeds/videos.xml?channel_id=${KATHA_CHANNEL_ID}`;
        const proxied = CORS_PROXY + encodeURIComponent(rssUrl);
        const res     = await fetch(proxied, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml     = await res.text();
        const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
        for (const [, entry] of entries) {
          const id    = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1]?.trim();
          const title = entry.match(/<title>(.*?)<\/title>/)?.[1]?.trim() || "Untitled";
          const ch    = entry.match(/<name>(.*?)<\/name>/)?.[1]?.trim() || "";
          const pub   = entry.match(/<published>(.*?)<\/published>/)?.[1]?.trim() || "";
          if (!id) continue;
          videos.push({
            videoId:      id,
            title:        title.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"),
            thumbnail:    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            duration:     "",
            uploadedDate: pub ? new Date(pub).toLocaleDateString() : "",
            isLive:       false,
            channelName:  ch,
          });
        }
        console.log("[KathaMonitor] RSS fallback —", videos.length, "videos");
      } catch (e2) {
        console.error("[KathaMonitor] RSS also failed:", e2.message);
      }
    }

    kathaVideos = videos;
    renderKathaVideoList(videos);

    if (statusEl) {
      statusEl.textContent = videos.length > 0
        ? `${videos.length} videos loaded. Updated: ${getCurrentDateTimeFormatted()}`
        : "No videos found.";
    }
  } catch (e) {
    console.error("[KathaMonitor] Error:", e);
    if (errorEl) errorEl.classList.remove("hidden");
    if (errorTextEl) errorTextEl.textContent = ` ${e.message}`;
    if (statusEl) statusEl.textContent = "Error loading content. Try refreshing.";
  } finally {
    loadingEl?.classList.add("hidden");
  }
}

// ─── Render video cards in the Katha list ─────────────────────────────────────
function renderKathaVideoList(videos) {
  const listEl = document.getElementById("katha-video-list");
  if (!listEl) return;

  if (!videos || videos.length === 0) {
    listEl.innerHTML = `<p style="color:#9ca3af;text-align:center;font-size:13px;padding:16px 0;">No Katha videos found.</p>`;
    return;
  }

  listEl.innerHTML = videos
    .map(
      (v, i) => `
    <div
      class="katha-video-card"
      data-index="${i}"
      style="
        cursor: pointer;
        border: 2px solid ${selectedKathaVideo?.videoId === v.videoId ? "#22d3ee" : "#374151"};
        border-radius: 8px;
        padding: 8px;
        display: flex;
        gap: 10px;
        align-items: flex-start;
        background: ${selectedKathaVideo?.videoId === v.videoId ? "#0e2a3a" : "transparent"};
        transition: border-color 0.2s;
      "
    >
      <img
        src="${v.thumbnail}"
        alt="thumbnail"
        style="width:96px;height:54px;object-fit:cover;border-radius:4px;flex-shrink:0;"
        onerror="this.src='https://placehold.co/96x54/1a1a2e/AAAAAA?text=No+Thumb'"
      />
      <div style="flex:1;min-width:0;">
        <p style="font-size:12px;font-weight:600;color:#e5e7eb;line-height:1.4;margin:0 0 4px;word-break:break-word;">
          ${v.isLive ? '<span style="background:#dc2626;color:white;font-size:10px;padding:1px 5px;border-radius:3px;margin-right:4px;">LIVE</span>' : ""}${v.title}
        </p>
        <p style="font-size:11px;color:#6b7280;margin:0;">
          ${v.uploadedDate || ""}${v.duration ? " · " + v.duration : ""}
        </p>
      </div>
    </div>
  `
    )
    .join("");

  // Click to select
  listEl.querySelectorAll(".katha-video-card").forEach((card) => {
    card.addEventListener("click", () => {
      const idx = parseInt(card.dataset.index);
      selectedKathaVideo = kathaVideos[idx];

      // Update visual selection
      listEl.querySelectorAll(".katha-video-card").forEach((c) => {
        c.style.borderColor = "#374151";
        c.style.background = "transparent";
      });
      card.style.borderColor = "#22d3ee";
      card.style.background = "#0e2a3a";

      const statusEl = document.getElementById("kathaSchedulerStatus");
      if (statusEl) {
        statusEl.textContent = `Selected: ${selectedKathaVideo.title}`;
      }
    });
  });
}

// ─── Load selected Katha video to Delay Player ────────────────────────────────
function loadKathaToDelayPlayer() {
  if (!selectedKathaVideo) {
    const statusEl = document.getElementById("kathaSchedulerStatus");
    if (statusEl) statusEl.textContent = "No video selected. Click a video in the list first.";
    return;
  }

  const videoIdInput = document.getElementById("delayVideoId");
  const startTimeInput = document.getElementById("delayStartTime");
  const endTimeInput = document.getElementById("delayEndTime");

  if (videoIdInput) videoIdInput.value = selectedKathaVideo.videoId;
  if (startTimeInput) startTimeInput.value = ""; // clear — let user set start time
  if (endTimeInput) endTimeInput.value = "";

  const statusEl = document.getElementById("kathaSchedulerStatus");
  if (statusEl) {
    statusEl.textContent = `Loaded "${selectedKathaVideo.title}" → Delay Player. Press Load to play.`;
  }

  console.log("[KathaMonitor] Loaded to Delay Player:", selectedKathaVideo.videoId);
}

// ─── Scheduler: check time and fire action ────────────────────────────────────
function checkKathaSchedulers() {
  const now = new Date();
  const currentHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  if (isRefreshSchedulerOn) {
    const refreshTime = document.getElementById("refreshScheduleTime")?.value;
    if (refreshTime && currentHHMM === refreshTime) {
      console.log("[KathaMonitor] Refresh scheduler triggered at", currentHHMM);
      fetchKathaVideos();
    }
  }

  if (isPlayerSchedulerOn) {
    const playerTime = document.getElementById("playerScheduleTime")?.value;
    if (playerTime && currentHHMM === playerTime) {
      console.log("[KathaMonitor] Player scheduler triggered at", currentHHMM);
      loadKathaToDelayPlayer();
    }
  }
}

// ─── Refresh button ───────────────────────────────────────────────────────────
document.getElementById("katha-refresh-button")?.addEventListener("click", fetchKathaVideos);

// ─── Load to Player button ────────────────────────────────────────────────────
document.getElementById("manualLoadKathaToDelayPlayerBtn")?.addEventListener("click", loadKathaToDelayPlayer);

// ─── Refresh Scheduler toggle ─────────────────────────────────────────────────
document.getElementById("btnToggleRefreshScheduler")?.addEventListener("click", function () {
  isRefreshSchedulerOn = !isRefreshSchedulerOn;
  this.textContent = isRefreshSchedulerOn ? "On" : "Off";
  this.className = `common-btn-style btn-primary flex-1 ${isRefreshSchedulerOn ? "" : "off-scheduler"}`;

  if (isRefreshSchedulerOn) {
    // Check every minute
    refreshSchedulerTimer = setInterval(checkKathaSchedulers, 60000);
    console.log("[KathaMonitor] Refresh scheduler ON");
  } else {
    clearInterval(refreshSchedulerTimer);
    refreshSchedulerTimer = null;
    console.log("[KathaMonitor] Refresh scheduler OFF");
  }
});

// ─── Player Scheduler toggle ──────────────────────────────────────────────────
document.getElementById("btnTogglePlayerScheduler")?.addEventListener("click", function () {
  isPlayerSchedulerOn = !isPlayerSchedulerOn;
  this.textContent = isPlayerSchedulerOn ? "On" : "Off";
  this.className = `common-btn-style btn-primary flex-1 ${isPlayerSchedulerOn ? "" : "off-scheduler"}`;

  if (isPlayerSchedulerOn) {
    playerSchedulerTimer = setInterval(checkKathaSchedulers, 60000);
    console.log("[KathaMonitor] Player scheduler ON");
  } else {
    clearInterval(playerSchedulerTimer);
    playerSchedulerTimer = null;
    console.log("[KathaMonitor] Player scheduler OFF");
  }
});

// ─── Initial load on page ready ───────────────────────────────────────────────
fetchKathaVideos();
