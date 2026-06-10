// Katha Monitor and Katha Scheduler logic extracted from script.js
// All functions and variables are globally accessible

// --- Katha Monitor Variables ---
const LOCAL_API_BASE = "http://localhost:3000";
const kathaChannelsConfig = {
  swaminarayanbhagwan1: {
    name: "Swaminarayan Bhagwan 1",
    videosUrl: `${LOCAL_API_BASE}/api/videos`,
  },
};
let kathaActiveDateFilter = "today";
const kathaDataCache = {};
let lastScheduledVideoId = null; // Renamed for clarity

// --- NEW: Dynamic Scheduler System ---
const kathaSchedulers = {
  contentRefresh: {
    enabled: false,
    time: "00:00",
    action: () => loadKathaContent(),
    lastTriggered: null, // To prevent multiple triggers in the same minute
    ui: {
      toggleBtn: document.getElementById("btnToggleRefreshScheduler"),
      timeInput: document.getElementById("refreshScheduleTime"),
    },
    storageKeys: {
      enabled: "kathaRefreshSchedulerEnabled",
      time: "kathaRefreshSchedulerTime",
      lastTriggered: "kathaRefreshSchedulerLastTriggered",
    },
  },
  loadToPlayer: {
    enabled: false,
    time: "00:00",
    action: () => manualLoadKathaToDelayPlayer(),
    lastTriggered: null,
    ui: {
      toggleBtn: document.getElementById("btnTogglePlayerScheduler"),
      timeInput: document.getElementById("playerScheduleTime"),
    },
    storageKeys: {
      enabled: "kathaPlayerSchedulerEnabled",
      time: "kathaPlayerSchedulerTime",
      lastTriggered: "kathaPlayerSchedulerLastTriggered",
    },
  },
};
let kathaSchedulerInterval; // A single interval for both schedulers

// --- DOM References for Katha Monitor ---
const kathaVideoListDiv = document.getElementById("katha-video-list");
const kathaLoadingDiv = document.getElementById("katha-loading");
const kathaErrorDiv = document.getElementById("katha-error-message");
const kathaErrorText = document.getElementById("katha-error-text");
const kathaRefreshButton = document.getElementById("katha-refresh-button");
const manualLoadKathaToDelayPlayerBtn = document.getElementById(
  "manualLoadKathaToDelayPlayerBtn"
);
const kathaSchedulerStatus = document.getElementById("kathaSchedulerStatus"); // Can be repurposed or removed

/**
 * Fetches and processes data for the active channel's videos for Katha Monitor.
 * Caches the result to prevent redundant API calls.
 * @param {string} channelId - The ID of the channel (e.g., 'swaminarayanbhagwan1').
 * @param {string} filterType - 'today' or 'yesterday'
 * @returns {Promise<Array>} - A promise that resolves to an array of processed video data.
 */
async function getKathaChannelContent(channelId, filterType) {
  const cacheKey = `${channelId}-videos-${filterType}`; // Updated cache key to include filter type
  // if (kathaDataCache[cacheKey]) {
  //   console.log(`[Katha Monitor Cache] Serving from cache for ${cacheKey}`);
  //   return kathaDataCache[cacheKey];
  // }

  try {
    const response = await fetch(`${LOCAL_API_BASE}/api/videos`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const rawVideoItems = (payload.data || [])
      .filter((video) => video.channelId === "UCQXWP4gEdEwlb6vodwrU75A")
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const targetDateFormatted =
      filterType === "today"
        ? formatDateToDDMMMYYYY(today)
        : formatDateToDDMMMYYYY(yesterday);

    // console.log(
    //   `[Katha Monitor] Filtering titles for: "${targetDateFormatted}"`
    // );

    let processedData = [];

    for (const video of rawVideoItems) {
      const title = video.title || "No Title";
      const publishedDate = video.publishedAt ? new Date(video.publishedAt) : null;
      const matchesDate =
        publishedDate && !Number.isNaN(publishedDate.getTime())
          ? formatDateToDDMMMYYYY(publishedDate) === targetDateFormatted
          : false;

      if (title.includes(targetDateFormatted) || matchesDate) {
        const videoId = video.videoId;
        let manglaCharanTimestamp = {
          time: "00:00",
          word: "Fetching...",
        };

        const fullDescription = await fetchKathaVideoFullDescription(videoId);
        if (fullDescription.startsWith("Error fetching description:")) {
          manglaCharanTimestamp.word = `Error: ${fullDescription.substring(
            fullDescription.indexOf(":") + 2
          )}`;
          manglaCharanTimestamp.time = "00:00";
        } else {
          manglaCharanTimestamp = extractManglaCharanTimestamp(fullDescription);
        }

        const thumbnailUrl =
          video.thumbnail ||
          `https://placehold.co/320x180/cccccc/333333?text=No+Image`;
        const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : "#";

        processedData.push({
          title,
          thumbnailUrl,
          videoUrl,
          videoId,
          manglaCharanTimestamp,
        });
      }
    }

    // console.log('processedData1', processedData)
    kathaDataCache[cacheKey] = processedData;
    // console.log(
    //   `[Katha Monitor Process] Processed ${processedData.length} items for ${cacheKey} after filtering and timestamp extraction.`
    // );
    return processedData;
  } catch (error) {
    console.error(
      `[Katha Monitor Error] Failed to load content for Katha Monitor:`,
      error
    );
    throw error;
  }
}

/**
 * Renders the video cards to the DOM for Katha Monitor.
 * @param {Array} data - An array of processed video data.
 */
function renderKathaContent(data) {
  kathaVideoListDiv.innerHTML = "";
  if (data.length === 0) {
    kathaVideoListDiv.innerHTML = `<p class="text-center text-gray-600 col-span-full">No content found for ${kathaActiveDateFilter}'s date filter.</p>`;
    return;
  }

  data.forEach((video) => {
    const videoCard = `
            <div class="katha-video-card border-[3px] ${kathaActiveDateFilter === "today"
        ? "border-green-600"
        : "border-red-600"
      }">
                <a href="${video.videoUrl
      }" target="_blank" rel="noopener noreferrer">
                    <img src="${video.thumbnailUrl}" alt="${video.title
      }" class="katha-video-thumbnail">
                </a>
                <div class="p-3 flex-grow flex flex-col justify-between">
                    <h4 class="katha-video-title">
                        <a href="${video.videoUrl
      }" target="_blank" rel="noopener noreferrer" class="hover:text-blue-400">${video.title
      }</a>
                    </h4>
                    <div class="mt-2 text-sm">
                        <p class="katha-video-info">${video.manglaCharanTimestamp.word
      }: <span class="katha-timestamp">${video.manglaCharanTimestamp.time
      }</span></p>
                        <div class="flex flex-wrap justify-center gap-2 mt-2">
                            <button onclick="copyToClipboard('${video.videoId
      }')" class="katha-copy-btn">
                                Copy Video ID
                            </button>
                            ${video.manglaCharanTimestamp?.word !== "Not found." &&
        !video.manglaCharanTimestamp?.word?.startsWith("Error:")
        ? `
                                <button onclick="copyToClipboard('${video.manglaCharanTimestamp.time}')" class="katha-copy-btn bg-purple-600 hover:bg-purple-700">
                                    Copy Timestamp
                                </button>`
        : ""
      }
                        </div>
                    </div>
                </div>
            </div>
        `;
    kathaVideoListDiv.innerHTML += videoCard;
  });
}

/**
 * Handles the display of loading and error states for Katha Monitor.
 * @param {boolean} isLoading - True to show loading, false to hide.
 * @param {string} [errorMessage] - Optional error message to display.
 */
function updateKathaUIState(isLoading, errorMessage = "") {
  if (isLoading) {
    kathaLoadingDiv.classList.remove("hidden");
    kathaErrorDiv.classList.add("hidden");
    kathaVideoListDiv.innerHTML = "";
  } else {
    kathaLoadingDiv.classList.add("hidden");
    if (errorMessage) {
      kathaErrorText.textContent = errorMessage;
      kathaErrorDiv.classList.remove("hidden");
    } else {
      kathaErrorDiv.classList.add("hidden");
    }
  }
}

/**
 * Main function to load and display content for Katha Monitor based on current selections.
 */
async function loadKathaContent() {
  // console.log("[Katha Monitor] Refreshing content...");
  kathaSchedulerStatus.textContent = "Refreshing Katha content list...";
  updateKathaUIState(true);
  let content;
  try {
    // Always check today first when manually/scheduled refreshing
    kathaActiveDateFilter = "today";
    content = await getKathaChannelContent(
      "swaminarayanbhagwan1",
      kathaActiveDateFilter
    );

    if (content.length === 0) {
      // console.log(
      //   "[Katha Monitor] No content for today, checking yesterday..."
      // );
      kathaActiveDateFilter = "yesterday";
      content = await getKathaChannelContent(
        "swaminarayanbhagwan1",
        kathaActiveDateFilter
      );
    }
    renderKathaContent(content);
    updateKathaUIState(false);
    kathaSchedulerStatus.textContent = `Content updated. Showing videos for ${kathaActiveDateFilter}.`;
  } catch (error) {
    updateKathaUIState(
      false,
      `Failed to load Katha content: ${error.message}. Please try again later.`
    );
    kathaSchedulerStatus.textContent = `Error refreshing content: ${error.message}`;
  }
}

kathaRefreshButton.addEventListener("click", loadKathaContent);

// --- NEW: Dynamic Katha Scheduler Logic ---

// Initializes all schedulers
function initializeKathaSchedulers() {
  // console.log('kathaSchedulers', kathaSchedulers)
  Object.keys(kathaSchedulers).forEach((key) => {
    // console.log('key', key);

    loadSchedulerState(key);
  });
  startSchedulerCheckInterval();
}

// Loads a specific scheduler's state from local storage
function loadSchedulerState(schedulerKey) {
  const scheduler = kathaSchedulers[schedulerKey];
  if (!scheduler) return;
  // console.log('scheduler', kathaSchedulers, schedulerKey);

  const storedEnabled = localStorage.getItem(scheduler.storageKeys.enabled);
  const storedTime = localStorage.getItem(scheduler.storageKeys.time);
  const storedLastTriggered = localStorage.getItem(scheduler.storageKeys.lastTriggered);

  scheduler.enabled = storedEnabled === "true";
  if (storedTime) {
    scheduler.time = storedTime;
  }
  if (storedLastTriggered) {
    scheduler.lastTriggered = storedLastTriggered;
  }

  scheduler.ui.timeInput.value = scheduler.time;
  updateSchedulerUI(schedulerKey);
}

// Saves a specific scheduler's state to local storage
function saveKathaSchedulerState(schedulerKey) {
  const scheduler = kathaSchedulers[schedulerKey];
  scheduler.time = scheduler.ui.timeInput.value; // Get current time from input
  scheduler.enabled = scheduler.enabled; // State is already toggled before this call

  localStorage.setItem(scheduler.storageKeys.enabled, scheduler.enabled);
  localStorage.setItem(scheduler.storageKeys.time, scheduler.time);

  console.log(
    `[Katha Scheduler] Saved state for ${schedulerKey}: Enabled=${scheduler.enabled}, Time=${scheduler.time}`
  );
  updateSchedulerUI(schedulerKey);
}

// Updates the UI for a specific scheduler
function updateSchedulerUI(schedulerKey) {
  const scheduler = kathaSchedulers[schedulerKey];
  scheduler.ui.toggleBtn.className = `common-btn-style btn-primary flex-1 ${scheduler.enabled ? "on-scheduler" : "off-scheduler"
    }`;
  scheduler.ui.toggleBtn.textContent = scheduler.enabled ? "On" : "Off";
}

// Toggles a specific scheduler on/off
function toggleScheduler(schedulerKey) {
  const scheduler = kathaSchedulers[schedulerKey];
  scheduler.enabled = !scheduler.enabled;
  saveKathaSchedulerState(schedulerKey);
}

// Starts the single interval to check all schedulers
function startSchedulerCheckInterval() {
  if (kathaSchedulerInterval) clearInterval(kathaSchedulerInterval);
  kathaSchedulerInterval = setInterval(checkAllSchedules, 1000); // Check every 1 second for reliability
  // console.log(
  //   "[Katha Scheduler] Central scheduler started. Checking tasks every 1 second."
  // );
}

// The core function that checks all defined schedulers
function checkAllSchedules() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const todayIdentifier = now.toISOString().split("T")[0]; // YYYY-MM-DD

  for (const key in kathaSchedulers) {
    const scheduler = kathaSchedulers[key];

    if (!scheduler.enabled) continue;

    const [scheduleHour, scheduleMinute] = scheduler.time.split(":").map(Number);

    if (currentHour === scheduleHour && currentMinute === scheduleMinute) {
      // Use a date-based identifier to ensure it runs once per day at the scheduled time
      const triggerIdentifier = `${todayIdentifier}-${scheduler.time}`;
      if (scheduler.lastTriggered === triggerIdentifier) {
        // console.log(`[Katha Scheduler] Task '${key}' already triggered today at this time. Skipping.`);
        continue;
      }

      console.log(`[Katha Scheduler] Triggering task: '${key}'`);
      scheduler.action(); // Execute the associated function
      scheduler.lastTriggered = triggerIdentifier; // Mark as triggered for today
      // Persist lastTriggered to localStorage to survive page reloads
      localStorage.setItem(scheduler.storageKeys.lastTriggered, triggerIdentifier);
    }
  }
}

// Manually loads Katha video to Delay Live Player
async function manualLoadKathaToDelayPlayer() {
  let filterType = 'today'
  console.log(`[Katha Monitor] Load to player triggered for ${filterType} videos.`);
  kathaSchedulerStatus.textContent = `Attempting to load ${filterType}'s Katha to player...`;

  try {
    let kathaVideos = []
    kathaVideos = await getKathaChannelContent(
      "swaminarayanbhagwan1",
      filterType
    );

    if (kathaVideos.length === 0) {
      console.log(
        "[Katha Monitor] No kathaVideos for today, checking yesterday..."
      );
      filterType = "yesterday";
      kathaVideos = await getKathaChannelContent(
        "swaminarayanbhagwan1",
        filterType
      );
    }
    // console.log('kathaVideos', kathaVideos)
    if (kathaVideos.length > 0) {
      const latestVideo = kathaVideos[0]; // Get the first (latest) video
      const videoId = latestVideo.videoId;
      let startTime = latestVideo.manglaCharanTimestamp.time;

      if (startTime === "Not found." || startTime.startsWith("Error:")) {
        startTime = "00:00";
        console.warn(
          `ManglaCharan timestamp not found for video ${videoId}. Defaulting to 00:00.`
        );
      }

      // --- Interaction with Delay Live Player ---
      // Ensure you have these elements and functions available globally

      delayVideoIdInput.value = videoId;
      delayStartTimeInput.value = startTime;
      delayEndTimeInput.value = ""; // Clear end time

      await loadDelayVideoBtn.click(); // Programmatically click the button

      // setSourceVisibility("Delay Live", true);
      // setSourceVisibility("Loop Player", false);
      // setSourceVisibility("Live Player", false);
      // setSourceVisibility("OrdaChesta", false);
      // setSourceVisibility("Local Player", false);

      kathaSchedulerStatus.textContent = `Loaded "${latestVideo.title}" to Delay Player.`;
      console.log(`Successfully loaded video ${videoId} to Delay Player.`);

    } else {
      kathaSchedulerStatus.textContent = `No Katha videos found for ${filterType}.`;
      console.warn(
        `No Katha videos found for ${filterType}. Cannot load to Delay Live Player.`
      );
    }
  } catch (error) {
    kathaSchedulerStatus.textContent = `Error loading Katha: ${error.message}`;
    console.error(`Error in manualLoadKathaToDelayPlayer:`, error);
  }
}

// Event Listeners for NEW Schedulers
kathaSchedulers.contentRefresh.ui.toggleBtn.addEventListener("click", () =>
  toggleScheduler("contentRefresh")
);
kathaSchedulers.contentRefresh.ui.timeInput.addEventListener("change", () =>
  saveKathaSchedulerState("contentRefresh")
);

kathaSchedulers.loadToPlayer.ui.toggleBtn.addEventListener("click", () =>
  toggleScheduler("loadToPlayer")
);
kathaSchedulers.loadToPlayer.ui.timeInput.addEventListener("change", () =>
  saveKathaSchedulerState("loadToPlayer")
);

manualLoadKathaToDelayPlayerBtn.addEventListener("click", () =>
  manualLoadKathaToDelayPlayer()
);

/**
 * Fetches HTML content from a given URL.
 * @param {string} url - The URL to fetch.
 * @returns {Promise<string>} - The HTML content as a string.
 * @throws {Error} If the network request fails.
 */
async function fetchHtml(url) {
  // console.log(`[Fetch] Attempting to fetch HTML from: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status} from ${url}`);
  }
  const htmlText = await response.text();
  // console.log(`[Fetch] Successfully fetched HTML. Length: ${htmlText.length}`);
  return htmlText;
}

/**
 * Extracts video/stream items from the parsed ytInitialData for playlist pages (Katha Monitor).
 * @param {object} ytInitialData - The parsed ytInitialData object.
 * @returns {Array} - An array of raw video/stream items (playlistVideoRenderer).
 */
function extractKathaPlaylistVideoItems(ytInitialData) {
  let videoItems = [];
  // console.log(
  //   "[Katha Monitor] Starting extractKathaPlaylistVideoItems. Looking for playlist items..."
  // );

  const playlistContents =
    ytInitialData?.contents?.twoColumnBrowseResultsRenderer?.primaryContents
      ?.playlistVideoListRenderer?.contents;

  if (playlistContents && playlistContents.length > 0) {
    videoItems = playlistContents.filter((item) => item.playlistVideoRenderer);
    // console.log(
    //   `[Katha Monitor] Extracted ${videoItems.length} playlistVideoRenderer items.`
    // );
  } else {
    console.warn(
      "[Katha Monitor] No playlistVideoRenderer items found at expected path. Trying deep search."
    );
    const findPlaylistRenderersDeep = (obj) => {
      let found = [];
      if (typeof obj !== "object" || obj === null) return found;
      if (obj.playlistVideoRenderer) {
        found.push(obj);
      }
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (typeof obj[key] === "object" && obj[key] !== null) {
            found = found.concat(findPlaylistRenderersDeep(obj[key]));
          }
        }
      }
      return found;
    };
    videoItems = findPlaylistRenderersDeep(ytInitialData);
    if (videoItems.length > 0) {
      // console.log(
      //   `[Katha Monitor] Found ${videoItems.length} items via deep search for playlist videos.`
      // );
    } else {
      console.warn(
        "[Katha Monitor] Deep search found no playlistVideoRenderer items."
      );
    }
  }
  return videoItems;
}

/**
 * Fetches the full description of a video given its ID (Katha Monitor).
 * @param {string} videoId - The ID of the video.
 * @returns {Promise<string>} - The full description text.
 */
async function fetchKathaVideoFullDescription(videoId) {
  try {
    const response = await fetch(
      `${LOCAL_API_BASE}/api/video-description?videoId=${encodeURIComponent(videoId)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    return payload.description || "";
  } catch (error) {
    console.error(
      `[Katha Monitor] Error fetching full description for ${videoId}:`,
      error
    );
    return `Error fetching description: ${error.message}`;
  }
}

/**
 * Extracts timestamp with priority: Mangla Charan variations first, then katha.
 * @param {string} fullDescriptionText - The complete description text of the video.
 * @returns {{ time: string|null, word: string|null }}
 */
function extractManglaCharanTimestamp(fullDescriptionText) {
  // Updated time pattern: matches HH:MM:SS or MM:SS
  const timePattern = /(\d{1,2}:\d{2}(?::\d{2})?)/;

  // Priority 1: Mangla Charan variations
  const manglaCharanRegex = new RegExp(
    timePattern.source +
    "\\s*(?:manglacharan|manglacharan|mangala\\s*charan|mangla\\s*charan|manglachhan|msnglachran|mangla\\s*chran|mnglacharan|mnglachharan)",
    "i"
  );
  const manglaMatch = fullDescriptionText.match(manglaCharanRegex);
  if (manglaMatch) {
    return { time: manglaMatch[1], word: "Mangla Charan" };
  }

  // Priority 2: katha
  const kathaRegex = new RegExp(timePattern.source + "\\s*katha", "i");
  const kathaMatch = fullDescriptionText.match(kathaRegex);
  if (kathaMatch) {
    return { time: kathaMatch[1], word: "katha" };
  }

  // Nothing found
  return { time: '00:00:00', word: 'Not Found' };
}

// Initial Load
loadKathaContent();
initializeKathaSchedulers(); // Initialize the new scheduler system