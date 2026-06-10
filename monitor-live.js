// Live Event Monitor and Upcoming Event Monitor logic extracted from script.js
// All functions and variables are globally accessible

// --- Live Event Monitor Variables ---
let liveDetailsPollInterval;
const LIVE_DETAILS_POLL_INTERVAL_MS = 30000;
const LOCAL_API_BASE = "http://localhost:3000";
let lastFetchedVideoId1 = null;
let lastFetchedTitle1 = null;
let lastFetchedVideoId2 = null;
let lastFetchedTitle2 = null;
let lastFetchedUpcomingVideoId = null;
let lastFetchedUpcomingTitle = null;
let liveMonitorEnabled1 = false;
let liveMonitorEnabled2 = false;
const LIVE_MONITOR_ENABLED_KEY_1 = "liveMonitorEnabled1";
const LIVE_MONITOR_ENABLED_KEY_2 = "liveMonitorEnabled2";
const LIVE_CHANNEL_SELECT_KEY = "liveSelectedChannelId";

const channelsConfig = {
  "UC7HQ3mzdsyvLU0Y7a2t3N7A": { name: "Swaminarayan" },
  "UCQXWP4gEdEwlb6vodwrU75A": { name: "Swaminarayan Bhagwan" },
};

function getSelectedChannelId() {
  const el = document.getElementById("liveChannelSelect");
  return el?.value || "UC7HQ3mzdsyvLU0Y7a2t3N7A";
}

function getSelectedChannelName() {
  const id = getSelectedChannelId();
  return channelsConfig[id]?.name || id;
}
const dataCache = {};
const LOCAL_STORAGE_SEARCH_TITLES_KEY_1 = "savedSearchTitles1";
const LOCAL_STORAGE_SEARCH_TITLES_KEY_2 = "savedSearchTitles2";
const TARGET_CHANNEL_ID = "UC7HQ3mzdsyvLU0Y7a2t3N7A";
const LIVE_PLAYER_PRIORITY_KEY = "livePlayerPriority";

function getLiveEventStartMs(event) {
  const startValue = event.startTime || event.startedAt || event.publishedTime;
  if (!startValue || startValue === "Unknown") return 0;

  const date = new Date(startValue);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

// --- DOM References for Live Event Monitor ---
const videoThumbnailDisplay1 = document.getElementById(
  "video-thumbnail-display-1"
);
const videoTitleSearchInput1 = document.getElementById(
  "videoTitleSearchInput-1"
);
const videoTitleDisplay1 = document.getElementById("video-title-display-1");
const videoIdDisplay1 = document.getElementById("video-id-display-1");
const channelNameDisplay1 = document.getElementById("channel-name-display-1");
const channelUrlDisplay1 = document.getElementById("channel-url-display-1");
const copyVideoIdBtn1 = document.getElementById("copy-video-id-btn-1");
const videoThumbnailDisplay2 = document.getElementById(
  "video-thumbnail-display-2"
);
const videoTitleSearchInput2 = document.getElementById(
  "videoTitleSearchInput-2"
);
const videoTitleDisplay2 = document.getElementById("video-title-display-2");
const videoIdDisplay2 = document.getElementById("video-id-display-2");
const channelNameDisplay2 = document.getElementById("channel-name-display-2");
const channelUrlDisplay2 = document.getElementById("channel-url-display-2");
const copyVideoIdBtn2 = document.getElementById("copy-video-id-btn-2");
const upcomingVideoThumbnailDisplay = document.getElementById(
  "upcoming-video-thumbnail-display"
);
const upcomingVideoTitleDisplay = document.getElementById(
  "upcoming-video-title-display"
);
const upcomingVideoIdDisplay = document.getElementById(
  "upcoming-video-id-display"
);
const upcomingChannelNameDisplay = document.getElementById(
  "upcoming-channel-name-display"
);
const upcomingChannelUrlDisplay = document.getElementById(
  "upcoming-channel-url-display"
);
const copyUpcomingVideoIdBtn = document.getElementById(
  "copy-upcoming-video-id-btn"
);
const upcomingStartTimeDisplay = document.getElementById(
  "upcoming-start-time-display"
);

// --- Live Event Monitor Functions ---
async function fetchLiveVideoDetails() {
  if (!liveMonitorEnabled1 && !liveMonitorEnabled2) {
    // console.log("Both Live Event Monitors are disabled. Skipping fetch.");
    clearMonitorDisplay(
      videoThumbnailDisplay1,
      videoTitleDisplay1,
      videoIdDisplay1,
      channelNameDisplay1,
      channelUrlDisplay1,
      "Live Event Monitor 1 is Off"
    );
    clearMonitorDisplay(
      videoThumbnailDisplay2,
      videoTitleDisplay2,
      videoIdDisplay2,
      channelNameDisplay2,
      channelUrlDisplay2,
      "Live Event Monitor 2 is Off"
    );
    clearMonitorDisplay(
      upcomingVideoThumbnailDisplay,
      upcomingVideoTitleDisplay,
      upcomingVideoIdDisplay,
      upcomingChannelNameDisplay,
      upcomingChannelUrlDisplay,
      "Upcoming Event Monitor is Off",
      upcomingStartTimeDisplay
    );
    return;
  }

  [
    videoTitleDisplay1,
    videoIdDisplay1,
    channelNameDisplay1,
    channelUrlDisplay1,
    videoTitleDisplay2,
    videoIdDisplay2,
    channelNameDisplay2,
    channelUrlDisplay2,
    upcomingVideoTitleDisplay,
    upcomingVideoIdDisplay,
    upcomingChannelNameDisplay,
    upcomingChannelUrlDisplay,
    upcomingStartTimeDisplay,
  ].forEach((el) => el.classList.remove("error-message"));

  try {
    // Define the channels you want to see content from
    const allChannelEvents = await getChannelContent("swaminarayan", "streams");
    // 2. Create initial lists of live and upcoming events
    let liveEvents = allChannelEvents
      .filter((event) => event.isLive)
      .sort((a, b) => getLiveEventStartMs(b) - getLiveEventStartMs(a));
    let upcomingEvents = allChannelEvents.filter((event) => event.isUpcoming);

    // 3. Sort the upcoming list from the local API
    upcomingEvents.sort((a, b) => a.startTime - b.startTime);

    const nextUpcomingEvent =
      upcomingEvents.length > 0 ? upcomingEvents[0] : null;
    updateUpcomingMonitorDisplay(nextUpcomingEvent);

    const liveEvent1 = liveEvents.length > 0 ? liveEvents[0] : null;
    updateLiveMonitorDisplay(
      1,
      liveEvent1,
      videoThumbnailDisplay1,
      videoTitleDisplay1,
      videoIdDisplay1,
      channelNameDisplay1,
      channelUrlDisplay1
    );

    const liveEvent2 = liveEvents.length > 1 ? liveEvents[1] : null;
    updateLiveMonitorDisplay(
      2,
      liveEvent2,
      videoThumbnailDisplay2,
      videoTitleDisplay2,
      videoIdDisplay2,
      channelNameDisplay2,
      channelUrlDisplay2
    );

    let videoIdToAutoLoad = null;
    const currentPriority = livePlayerPrioritySelect.value;

    if (currentPriority === "firstLive" && liveEvent1) {
      videoIdToAutoLoad = liveEvent1.videoId;
    } else if (currentPriority === "secondLive" && liveEvent2) {
      videoIdToAutoLoad = liveEvent2.videoId;
    } else if (currentPriority === "matchSearchTerms") {
      videoIdToAutoLoad = findMatchingVideoId(
        videoTitleSearchInput1.value,
        liveEvents
      );
    }

    if (
      videoIdToAutoLoad &&
      liveVideoIdInput.value.trim() !== videoIdToAutoLoad
    ) {
      console.log(
        `Live Event Monitor: Auto-loading fetched live video ID "${videoIdToAutoLoad}" to Live Player based on priority "${currentPriority}".`
      );
      liveVideoIdInput.value = videoIdToAutoLoad;
      await loadLiveVideoAndPlay(videoIdToAutoLoad);

      setSourceVisibility("Live Player", true);
      setSourceVisibility("Loop Player", false);
      setSourceVisibility("Delay Live", false);
      setSourceVisibility("OrdaChesta", false);
      setSourceVisibility("Local Player", false);
    }
    // else if (!videoIdToAutoLoad && sourceState["Live Player"]) {
    //   console.warn(
    //     "No live video found matching priority. Live Player is active. Switching to Loop Player."
    //   );
    //   setSourceVisibility("Live Player", false);
    //   setSourceVisibility("Loop Player", true);
    // } 
    else if (
      videoIdToAutoLoad &&
      liveVideoIdInput.value.trim() === videoIdToAutoLoad
    ) {
      // console.log(
      //   `Live Event Monitor: Video ID "${videoIdToAutoLoad}" is already loaded in Live Player. Skipping reload.`
      // );
    }
  } catch (error) {
    console.error(
      "Error fetching live video details for Live Event Monitor:",
      error
    );
    const errorMessage = `Error: ${error.message}. Please check console for details.`;
    applyErrorToMonitorDisplay(
      videoTitleDisplay1,
      videoIdDisplay1,
      channelNameDisplay1,
      channelUrlDisplay1,
      videoThumbnailDisplay1,
      errorMessage
    );
    applyErrorToMonitorDisplay(
      videoTitleDisplay2,
      videoIdDisplay2,
      channelNameDisplay2,
      channelUrlDisplay2,
      videoThumbnailDisplay2,
      errorMessage
    );
    applyErrorToMonitorDisplay(
      upcomingVideoTitleDisplay,
      upcomingVideoIdDisplay,
      upcomingChannelNameDisplay,
      upcomingChannelUrlDisplay,
      upcomingVideoThumbnailDisplay,
      errorMessage,
      upcomingStartTimeDisplay
    );
  }
}

function updateLiveMonitorDisplay(
  monitorNumber,
  event,
  thumbnailEl,
  titleEl,
  idEl,
  channelNameEl,
  channelUrlEl
) {
  let currentLastFetchedVideoId =
    monitorNumber === 1 ? lastFetchedVideoId1 : lastFetchedVideoId2;
  let currentLastFetchedTitle =
    monitorNumber === 1 ? lastFetchedTitle1 : lastFetchedTitle2;

  if (event) {
    const videoId = event.videoId;
    const title = event.title;
    const thumbnailUrl = event.thumbnailUrl;
    const channelId = getSelectedChannelId();
    const channelName = getSelectedChannelName();
    let channelUrl = `https://www.youtube.com/channel/${channelId}`;

    if (
      videoId !== currentLastFetchedVideoId ||
      title !== currentLastFetchedTitle
    ) {
      titleEl.textContent = title;
      idEl.textContent = videoId;
      channelNameEl.textContent = channelName;
      thumbnailEl.src = thumbnailUrl;

      const channelLink = document.createElement("a");
      channelLink.href = channelUrl;
      channelLink.textContent = channelUrl;
      channelLink.target = "_blank";
      channelUrlEl.innerHTML = "";
      channelUrlEl.appendChild(channelLink);

      titleEl.classList.remove("error-message");
      idEl.classList.remove("error-message");
      channelNameEl.classList.remove("error-message");
      channelUrlEl.classList.remove("error-message");
    }
    if (monitorNumber === 1) {
      lastFetchedVideoId1 = videoId;
      lastFetchedTitle1 = title;
    } else {
      lastFetchedVideoId2 = videoId;
      lastFetchedTitle2 = title;
    }
  } else {
    clearMonitorDisplay(
      thumbnailEl,
      titleEl,
      idEl,
      channelNameEl,
      channelUrlEl,
      `Live Event Monitor ${monitorNumber} is Off`,
      null,
      true
    );
    if (monitorNumber === 1) {
      lastFetchedVideoId1 = null;
      lastFetchedTitle1 = null;
    } else {
      lastFetchedVideoId2 = null;
      lastFetchedTitle2 = null;
    }
  }
}

function updateUpcomingMonitorDisplay(event) {
  if (event) {
    const videoId = event.videoId;
    const title = event.title;
    const thumbnailUrl = event.thumbnailUrl;
    const channelId = getSelectedChannelId();
    const channelName = getSelectedChannelName();
    let channelUrl = `https://www.youtube.com/channel/${channelId}`;
    const startTime = event.startTime
      ? event.startTime.toLocaleString()
      : "N/A";

    if (
      videoId !== lastFetchedUpcomingVideoId ||
      title !== lastFetchedUpcomingTitle
    ) {
      upcomingVideoTitleDisplay.textContent = title;
      upcomingVideoIdDisplay.textContent = videoId;
      upcomingChannelNameDisplay.textContent = channelName;
      upcomingVideoThumbnailDisplay.src = thumbnailUrl;
      upcomingStartTimeDisplay.textContent = `Starts: ${startTime}`;

      const channelLink = document.createElement("a");
      channelLink.href = channelUrl;
      channelLink.textContent = channelUrl;
      channelLink.target = "_blank";
      upcomingChannelUrlDisplay.innerHTML = "";
      upcomingChannelUrlDisplay.appendChild(channelLink);

      upcomingVideoTitleDisplay.classList.remove("error-message");
      upcomingVideoIdDisplay.classList.remove("error-message");
      upcomingChannelNameDisplay.classList.remove("error-message");
      upcomingChannelUrlDisplay.classList.remove("error-message");
      upcomingStartTimeDisplay.classList.remove("error-message");
    }
    lastFetchedUpcomingVideoId = videoId;
    lastFetchedUpcomingTitle = title;
  } else {
    clearMonitorDisplay(
      upcomingVideoThumbnailDisplay,
      upcomingVideoTitleDisplay,
      upcomingVideoIdDisplay,
      upcomingChannelNameDisplay,
      upcomingChannelUrlDisplay,
      "No Upcoming Event Found",
      upcomingStartTimeDisplay,
      true
    );
    lastFetchedUpcomingVideoId = null;
    lastFetchedUpcomingTitle = null;
  }
}

function clearMonitorDisplay(
  thumbnailEl,
  titleEl,
  idEl,
  channelNameEl,
  channelUrlEl,
  message,
  startTimeEl = null,
  isError = false
) {
  thumbnailEl.src = isError
    ? "https://placehold.co/280x157.5/FF0000/FFFFFF?text=Error"
    : "https://placehold.co/280x157.5/333333/FFFFFF?text=Monitor+Off";
  titleEl.textContent = message;
  idEl.textContent = "N/A";
  channelNameEl.textContent = "N/A";
  channelUrlEl.innerHTML = "N/A";
  if (startTimeEl) startTimeEl.textContent = "N/A";

  const elements = [titleEl, idEl, channelNameEl, channelUrlEl];
  if (startTimeEl) elements.push(startTimeEl);
  elements.forEach((el) => {
    if (isError) {
      el.classList.add("error-message");
    } else {
      el.classList.remove("error-message");
    }
  });
}

function applyErrorToMonitorDisplay(
  titleEl,
  idEl,
  channelNameEl,
  channelUrlEl,
  thumbnailEl,
  errorMessage,
  startTimeEl = null
) {
  titleEl.textContent = errorMessage;
  idEl.textContent = errorMessage;
  channelNameEl.textContent = errorMessage;
  channelUrlEl.textContent = errorMessage;
  thumbnailEl.src = "https://placehold.co/280x157.5/FF0000/FFFFFF?text=Error";

  const elements = [titleEl, idEl, channelNameEl, channelUrlEl];
  if (startTimeEl) elements.push(startTimeEl);
  elements.forEach((el) => el.classList.add("error-message"));
}

function toggleLiveMonitor(monitorNumber) {
  if (monitorNumber === 1) {
    liveMonitorEnabled1 = !liveMonitorEnabled1;
    localStorage.setItem(LIVE_MONITOR_ENABLED_KEY_1, liveMonitorEnabled1);
    updateLiveMonitorToggleButton(1);
  } else if (monitorNumber === 2) {
    liveMonitorEnabled2 = !liveMonitorEnabled2;
    localStorage.setItem(LIVE_MONITOR_ENABLED_KEY_2, liveMonitorEnabled2);
    updateLiveMonitorToggleButton(2);
  }

  if (liveMonitorEnabled1 || liveMonitorEnabled2) {
    if (!liveDetailsPollInterval) {
      liveDetailsPollInterval = setInterval(
        fetchLiveVideoDetails,
        LIVE_DETAILS_POLL_INTERVAL_MS
      );
      fetchLiveVideoDetails();
    }
  } else {
    if (liveDetailsPollInterval) {
      clearInterval(liveDetailsPollInterval);
      liveDetailsPollInterval = null;
    }
    clearMonitorDisplay(
      videoThumbnailDisplay1,
      videoTitleDisplay1,
      videoIdDisplay1,
      channelNameDisplay1,
      channelUrlDisplay1,
      "Live Event Monitor 1 is Off"
    );
    clearMonitorDisplay(
      videoThumbnailDisplay2,
      videoTitleDisplay2,
      videoIdDisplay2,
      channelNameDisplay2,
      channelUrlDisplay2,
      "Live Event Monitor 2 is Off"
    );
    clearMonitorDisplay(
      upcomingVideoThumbnailDisplay,
      upcomingVideoTitleDisplay,
      upcomingVideoIdDisplay,
      upcomingChannelNameDisplay,
      upcomingChannelUrlDisplay,
      "Upcoming Event Monitor is Off",
      upcomingStartTimeDisplay
    );
  }
}

function updateLiveMonitorToggleButton(monitorNumber) {
  const btn = document.getElementById(`btnToggleLiveMonitor${monitorNumber}`);
  const isEnabled =
    monitorNumber === 1 ? liveMonitorEnabled1 : liveMonitorEnabled2;
  btn.className = "toggle-btn " + (isEnabled ? "on-monitor" : "off");
  btn.textContent = `Monitor ${monitorNumber}: ` + (isEnabled ? "On" : "Off");
}

function loadLiveMonitorStates() {
  const storedState1 = localStorage.getItem(LIVE_MONITOR_ENABLED_KEY_1);
  if (storedState1 !== null) {
    liveMonitorEnabled1 = storedState1 === "true";
  } else {
    liveMonitorEnabled1 = true;
  }
  updateLiveMonitorToggleButton(1);

  const storedState2 = localStorage.getItem(LIVE_MONITOR_ENABLED_KEY_2);
  if (storedState2 !== null) {
    liveMonitorEnabled2 = storedState2 === "true";
  } else {
    liveMonitorEnabled2 = true;
  }
  updateLiveMonitorToggleButton(2);

  // Restore saved channel selection
  const savedChannelId = localStorage.getItem(LIVE_CHANNEL_SELECT_KEY);
  const select = document.getElementById("liveChannelSelect");
  if (select && savedChannelId) {
    select.value = savedChannelId;
  }
}

function loadLivePlayerPriority() {
  const savedPriority = localStorage.getItem(LIVE_PLAYER_PRIORITY_KEY);
  if (savedPriority) {
    livePlayerPrioritySelect.value = savedPriority;
  } else {
    livePlayerPrioritySelect.value = "matchSearchTerms";
  }
}

function loadSavedSearchTitles(monitorNumber) {
  const key =
    monitorNumber === 1
      ? LOCAL_STORAGE_SEARCH_TITLES_KEY_1
      : LOCAL_STORAGE_SEARCH_TITLES_KEY_2;
  const savedTitles = localStorage.getItem(key);
  if (savedTitles) {
    const inputElement =
      monitorNumber === 1 ? videoTitleSearchInput1 : videoTitleSearchInput2;
    inputElement.value = savedTitles;
  }
}

function saveSearchTitles(monitorNumber, titles) {
  const key =
    monitorNumber === 1
      ? LOCAL_STORAGE_SEARCH_TITLES_KEY_1
      : LOCAL_STORAGE_SEARCH_TITLES_KEY_2;
  localStorage.setItem(key, titles);
}

function findMatchingVideoId(searchTitlesInputText, liveEvents) {
  if (!searchTitlesInputText.trim() || liveEvents.length === 0) {
    return null;
  }

  const searchTerms = searchTitlesInputText
    .toLowerCase()
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term);
  if (searchTerms.length === 0) {
    return null;
  }

  for (const event of liveEvents) {
    const title = event.title.toLowerCase();
    const matchesAllTerms = searchTerms.some((term) => title.includes(term));
    matchesAllTerms
    if (matchesAllTerms) {
      return event.videoId;
    }
  }

  return null;
}

// --- Event Listeners for Live Event Monitor ---
if (copyVideoIdBtn1)
  copyVideoIdBtn1.addEventListener("click", () => {
    const videoId = videoIdDisplay1.textContent;
    if (videoId && videoId !== "N/A") {
      copyToClipboard(videoId);
    }
  });
if (copyVideoIdBtn2)
  copyVideoIdBtn2.addEventListener("click", () => {
    const videoId = videoIdDisplay2.textContent;
    if (videoId && videoId !== "N/A") {
      copyToClipboard(videoId);
    }
  });
if (copyUpcomingVideoIdBtn)
  copyUpcomingVideoIdBtn.addEventListener("click", () => {
    const videoId = upcomingVideoIdDisplay.textContent;
    if (videoId && videoId !== "N/A") {
      copyToClipboard(videoId);
    }
  });
if (videoTitleSearchInput1)
  videoTitleSearchInput1.addEventListener("input", (e) => {
    saveSearchTitles(1, e.target.value);
  });
if (videoTitleSearchInput2)
  videoTitleSearchInput2.addEventListener("input", (e) => {
    saveSearchTitles(2, e.target.value);
  });

const liveChannelSelectEl = document.getElementById("liveChannelSelect");
const liveChannelSelectStatus = document.getElementById("liveChannelSelectStatus");
if (liveChannelSelectEl) {
  liveChannelSelectEl.addEventListener("change", (e) => {
    const newId = e.target.value;
    localStorage.setItem(LIVE_CHANNEL_SELECT_KEY, newId);
    if (liveChannelSelectStatus) liveChannelSelectStatus.textContent = "Fetching...";
    // Reset last-fetched cache so display refreshes immediately
    lastFetchedVideoId1 = null;
    lastFetchedTitle1 = null;
    lastFetchedVideoId2 = null;
    lastFetchedTitle2 = null;
    lastFetchedUpcomingVideoId = null;
    lastFetchedUpcomingTitle = null;
    fetchLiveVideoDetails().then(() => {
      if (liveChannelSelectStatus) liveChannelSelectStatus.textContent = "";
    });
  });
}

/**
 * Fetches and processes data for a given channel and tab type.
 * Caches the result to prevent redundant API calls.
 * @param {string} channelId - The ID of the channel (e.g., 'swaminarayan').
 * @param {string} tabType - The type of content ('videos' or 'streams').
 * @returns {Promise<Array>} - A promise that resolves to an array of processed video/stream data.
 */
async function getChannelContent(channelId, tabType) {
  try {
    const selectedId = getSelectedChannelId();
    const response = await fetch(`${LOCAL_API_BASE}/api/live?channelId=${encodeURIComponent(selectedId)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const live = (payload.live || []).map((video) => ({
      title: video.title || "No Title",
      descriptionSnippet: "",
      publishedTime: video.publishedAt || "Unknown",
      length: video.duration === -1 ? "LIVE" : secondsToHMS(video.duration),
      viewCount: "0 views",
      thumbnailUrl:
        video.thumbnail ||
        `https://placehold.co/320x180/cccccc/333333?text=No+Image`,
      videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      videoId: video.videoId,
      isLive: true,
      isUpcoming: false,
      startedAt: video.startedAt || null,
      startTime: video.startedAt ? new Date(video.startedAt) : null,
      isPast: false,
    }));

    const upcoming = (payload.upcoming || []).map((video) => ({
      title: video.title || "No Title",
      descriptionSnippet: "",
      publishedTime: video.publishedAt || "Unknown",
      length: secondsToHMS(video.duration),
      viewCount: "0 views",
      thumbnailUrl:
        video.thumbnail ||
        `https://placehold.co/320x180/cccccc/333333?text=No+Image`,
      videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      videoId: video.videoId,
      isLive: false,
      isUpcoming: true,
      startTime: video.scheduledStart ? new Date(video.scheduledStart) : null,
      isPast: false,
    }));

    return [...live, ...upcoming];
  } catch (error) {
    console.error(`Error loading streams for ${channelId}:`, error);
    throw error; // Re-throw to be caught by the calling function
  }
}

/**
 * Normalize a lockupViewModel item (new YouTube format, 2025+) into the
 * legacy videoRenderer shape so the rest of the code keeps working unchanged.
 */
function normalizeLockupViewModelItem(lvm) {
  const videoId = lvm.contentId;
  const title = lvm.metadata?.lockupMetadataViewModel?.title?.content || 'No Title';
  const thumbnailSources = lvm.contentImage?.thumbnailViewModel?.image?.sources || [];
  const thumbnailUrl =
    thumbnailSources[thumbnailSources.length - 1]?.url ||
    thumbnailSources[0]?.url ||
    'https://placehold.co/320x180/cccccc/333333?text=No+Image';

  // Detect live / upcoming from overlay badges
  const overlays = lvm.contentImage?.thumbnailViewModel?.overlays || [];
  let isLive = false;
  let isUpcoming = false;
  let startTime = null;

  for (const overlay of overlays) {
    const badges = overlay?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const bvm = badge?.thumbnailBadgeViewModel;
      if (!bvm) continue;
      const style = bvm.badgeStyle || '';
      const text = (bvm.text || '').toLowerCase();
      const iconName = bvm.icon?.sources?.[0]?.clientResource?.imageName || '';

      if (style === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' || iconName === 'LIVE') {
        isLive = true;
      } else if (
        text === 'à venir' ||
        text === 'upcoming' ||
        text === 'scheduled' ||
        text === 'a venir'
      ) {
        isUpcoming = true;
      }
    }
  }

  // Try to parse scheduled start time from localized metadata text
  // e.g. "Planifié pour le 13/05/2026 17:15" (French)
  if (isUpcoming) {
    const rows = lvm.metadata?.lockupMetadataViewModel?.metadata
      ?.contentMetadataViewModel?.metadataRows || [];
    for (const row of rows) {
      for (const part of (row.metadataParts || [])) {
        const content = part?.text?.content || '';
        const dateMatch = content.match(
          /(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[\s,]+|T)(\d{1,2}):(\d{2})/
        );
        if (dateMatch) {
          const [, dayOrMonth, monthOrDay, year, hour, minute] = dateMatch;
          // European format: DD/MM/YYYY
          const parsed = new Date(
            `${year}-${monthOrDay.padStart(2, '0')}-${dayOrMonth.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00`
          );
          if (!isNaN(parsed.getTime())) startTime = parsed;
        }
      }
    }
  }

  // Return in legacy videoRenderer wrapper shape
  return {
    videoRenderer: {
      videoId,
      title: { runs: [{ text: title }] },
      thumbnail: { thumbnails: [{ url: thumbnailUrl }] },
      badges: isLive ? [{ liveTabBadgeRenderer: {} }] : undefined,
      thumbnailOverlays: isLive
        ? [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }]
        : undefined,
      upcomingEventData: isUpcoming && startTime
        ? { startTime: String(Math.floor(startTime.getTime() / 1000)) }
        : (isUpcoming ? { startTime: undefined } : undefined),
    }
  };
}

/**
 * Extracts video/stream items from the parsed ytInitialData.
 * Supports both the legacy videoRenderer format and the new (2025+) lockupViewModel format.
 * @param {object} ytInitialData - The parsed ytInitialData object.
 * @param {string} tabType - 'videos' or 'streams'.
 * @returns {Array} - An array of video/stream items (all normalized to videoRenderer shape).
 */
function extractVideoItems(ytInitialData, tabType) {
  const contents =
    ytInitialData?.contents?.twoColumnBrowseResultsRenderer?.tabs;
  let videoItems = [];

  if (contents) {
    // Support multiple locale variants of the Live tab title and both old/new browseEndpoint params
    const LIVE_TAB_TITLES = new Set(['live', 'en direct', 'en vivo', 'ao vivo', 'canlı']);
    const targetTab = contents.find((tab) => {
      const title = (tab.tabRenderer?.title || '').toLowerCase();
      const params = tab.tabRenderer?.endpoint?.browseEndpoint?.params || '';
      return LIVE_TAB_TITLES.has(title) ||
        params === 'EgZsaXZlcw%3D%3D' ||   // old param
        params.startsWith('EgdzdHJlYW1z'); // new param ("streams")
    });

    if (targetTab) {
      // --- New YouTube format (2025+): richGridRenderer → richItemRenderer → lockupViewModel ---
      const richGridItems =
        targetTab.tabRenderer?.content?.richGridRenderer?.contents || [];
      if (richGridItems.length > 0) {
        videoItems = richGridItems
          .filter(item => item?.richItemRenderer?.content?.lockupViewModel)
          .map(item => normalizeLockupViewModelItem(item.richItemRenderer.content.lockupViewModel));
        console.log('[extractVideoItems] New lockupViewModel format, count:', videoItems.length);
        return videoItems;
      }

      // --- Legacy YouTube format: sectionListRenderer → itemSectionRenderer → videoRenderer ---
      const legacyItems =
        targetTab.tabRenderer?.content?.sectionListRenderer?.contents[0]
          ?.itemSectionRenderer?.contents || [];
      if (legacyItems.length > 0) {
        console.log('[extractVideoItems] Legacy videoRenderer format, count:', legacyItems.length);
        return legacyItems;
      }
    }

    // Deep-search fallback: handle both renderers anywhere in the tree
    console.warn('[extractVideoItems] No target tab found, doing deep search...');
    const findDeep = (obj) => {
      let found = [];
      if (typeof obj !== 'object' || obj === null) return found;
      if (obj.videoRenderer) found.push(obj);
      if (obj.lockupViewModel && obj.lockupViewModel.contentId) {
        found.push(normalizeLockupViewModelItem(obj.lockupViewModel));
      }
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key) &&
          typeof obj[key] === 'object' && obj[key] !== null) {
          found = found.concat(findDeep(obj[key]));
        }
      }
      return found;
    };
    videoItems = findDeep(ytInitialData);
  }
  return videoItems;
}
