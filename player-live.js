// Live Player logic and UI extracted from script.js
// All functions and variables are globally accessible

// --- Live Player Variables ---
let isLivePlaying = true;
let isLiveMuted = false;
let isLiveStopped = false;
const DEFAULT_LIVE_VIDEO_ID = "T3wvnwSSw8g";

// --- DOM References for Live Player ---
const liveVideoIdInput = document.getElementById("liveVideoId");
const loadLiveVideoBtn = document.getElementById("loadLiveVideoBtn");
const togglePlayPauseLiveBtn = document.getElementById(
  "togglePlayPauseLiveBtn"
);
const stopLiveVideoBtn = document.getElementById("stopLiveVideoBtn");
const toggleMuteUnmuteLiveBtn = document.getElementById(
  "toggleMuteUnmuteLiveBtn"
);
const livePlayerStatus = document.getElementById("livePlayerStatus");
const liveVideoThumbnail = document.getElementById("liveVideoThumbnail");
const liveVideoTitle = document.getElementById("liveVideoTitle");
const liveVideoTime = document.getElementById("liveVideoTime");
const exportLiveDataBtn = document.getElementById("exportLiveDataBtn");
const livePlayerPrioritySelect = document.getElementById(
  "livePlayerPrioritySelect"
);

// NEW: Export function for Live Player
async function copyLiveData() {
  const currentTimestamp = getCurrentDateTimeFormatted();
  const videoId = liveVideoIdInput.value.trim() || "N/A";
  const videoTitle = liveVideoTitle.textContent || "N/A";

  // Format: Video ID,Video Title,Timestamp
  const header = `Video ID,Video Title,Timestamp`;
  const data = `${escapeCsvValue(videoId)},${escapeCsvValue(
    videoTitle
  )},${escapeCsvValue(currentTimestamp)}`;

  const exportLine = data; // Only the data line, header is for context

  // Store the exported data in local storage
  let livePlayerExports =
    JSON.parse(localStorage.getItem("livePlayerExports")) || [];
  // If the array is empty, add the header first
  if (livePlayerExports.length === 0) {
    livePlayerExports.push(header);
  }
  livePlayerExports.push(exportLine);
  localStorage.setItem("livePlayerExports", JSON.stringify(livePlayerExports));

  // Copy all stored data to clipboard
  const allExportedData = livePlayerExports.join("\n");

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(allExportedData);
      console.log("Live Player data copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy Live Player data:", err);
    }
  } else {
    console.error("Clipboard API not supported.");
  }
}

function saveLivePlayerPriority() {
  localStorage.setItem(
    LIVE_PLAYER_PRIORITY_KEY,
    livePlayerPrioritySelect.value
  );
}

// --- Live Player Functions ---
async function loadLiveVideoAndPlay(videoId) {
  if (!videoId) {
    livePlayerStatus.textContent = "Please enter a YouTube Video ID.";
    fetchVideoInfo("", liveVideoThumbnail, liveVideoTitle);
    return;
  }
  const titleFetched = await fetchVideoInfo(
    videoId,
    liveVideoThumbnail,
    liveVideoTitle
  );
  if (titleFetched) {
    sendPlayerCommand("livePlayerCommand", "loadVideo", videoId);
    livePlayerStatus.textContent = "Video loaded, playing.";
    isLivePlaying = true;
    isLiveStopped = false;
    isLiveMuted = false;
    updateButtonAppearance(
      togglePlayPauseLiveBtn,
      isLivePlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLiveVideoBtn, isLiveStopped);
    updateButtonAppearance(
      toggleMuteUnmuteLiveBtn,
      !isLiveMuted,
      "Unmuted",
      "Muted"
    );
    await savePlayerState("live");
    sendPlayerCommand("livePlayerCommand", "unmute");
  } else {
    liveVideoIdInput.value = DEFAULT_LIVE_VIDEO_ID;
    sendPlayerCommand("livePlayerCommand", "loadVideo", DEFAULT_LIVE_VIDEO_ID);
    livePlayerStatus.textContent =
      "Video title unavailable or not found. Loaded default video.";
    isLivePlaying = true;
    isLiveStopped = false;
    isLiveMuted = false;
    updateButtonAppearance(
      togglePlayPauseLiveBtn,
      isLivePlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLiveVideoBtn, isLiveStopped);
    updateButtonAppearance(
      toggleMuteUnmuteLiveBtn,
      !isLiveMuted,
      "Unmuted",
      "Muted"
    );
    await fetchVideoInfo(
      DEFAULT_LIVE_VIDEO_ID,
      liveVideoThumbnail,
      liveVideoTitle
    );
    await savePlayerState("live");
    sendPlayerCommand("livePlayerCommand", "unmute");
  }
}

// --- Event Listeners for Live Player ---
if (loadLiveVideoBtn)
  loadLiveVideoBtn.addEventListener("click", async () => {
    const videoId = liveVideoIdInput.value.trim();
    await loadLiveVideoAndPlay(videoId);
  });
if (togglePlayPauseLiveBtn)
  togglePlayPauseLiveBtn.addEventListener("click", () => {
    if (isLivePlaying) {
      sendPlayerCommand("livePlayerCommand", "pause");
      livePlayerStatus.textContent = "Paused";
      isLiveStopped = false;
    } else {
      sendPlayerCommand("livePlayerCommand", "play");
      livePlayerStatus.textContent = "Playing.";
      isLiveStopped = false;
    }
    isLivePlaying = !isLivePlaying;
    updateButtonAppearance(
      togglePlayPauseLiveBtn,
      isLivePlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLiveVideoBtn, isLiveStopped);
    savePlayerState("live");
  });
if (stopLiveVideoBtn)
  stopLiveVideoBtn.addEventListener("click", () => {
    sendPlayerCommand("livePlayerCommand", "stop");
    livePlayerStatus.textContent = "Stopped";
    isLivePlaying = false;
    isLiveStopped = true;
    updateButtonAppearance(
      togglePlayPauseLiveBtn,
      isLivePlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLiveVideoBtn, isLiveStopped);
    savePlayerState("live");
  });
if (toggleMuteUnmuteLiveBtn)
  toggleMuteUnmuteLiveBtn.addEventListener("click", () => {
    if (isLiveMuted) {
      sendPlayerCommand("livePlayerCommand", "unmute");
      livePlayerStatus.textContent = "Unmuted";
    } else {
      sendPlayerCommand("livePlayerCommand", "mute");
      livePlayerStatus.textContent = "Muted";
    }
    isLiveMuted = !isLiveMuted;
    updateButtonAppearance(
      toggleMuteUnmuteLiveBtn,
      !isLiveMuted,
      "Unmuted",
      "Muted"
    );
    savePlayerState("live");
  });
if (exportLiveDataBtn)
  exportLiveDataBtn.addEventListener("click", copyLiveData);
if (livePlayerPrioritySelect)
  livePlayerPrioritySelect.addEventListener("change", saveLivePlayerPriority);
