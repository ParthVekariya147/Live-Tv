// Delay Live Player logic and UI extracted from script.js
// All functions and variables are globally accessible

// --- Delay Live Player Variables ---
let isDelayPlaying = true;
let isDelayMuted = false;
let isDelayStopped = false;

// --- DOM References for Delay Live Player ---
const delayVideoIdInput = document.getElementById("delayVideoId");
const delayStartTimeInput = document.getElementById("delayStartTime");
const delayEndTimeInput = document.getElementById("delayEndTime");
const loadDelayVideoBtn = document.getElementById("loadDelayVideoBtn");
const togglePlayPauseDelayBtn = document.getElementById(
  "togglePlayPauseDelayBtn"
);
const stopDelayVideoBtn = document.getElementById("stopDelayVideoBtn");
const toggleMuteUnmuteDelayBtn = document.getElementById(
  "toggleMuteUnmuteDelayBtn"
);
const delayPlayerStatus = document.getElementById("delayPlayerStatus");
const delayVideoThumbnail = document.getElementById("delayVideoThumbnail");
const delayVideoTitle = document.getElementById("delayVideoTitle");
const delayVideoTime = document.getElementById("delayVideoTime");
const exportDelayLiveDataBtn = document.getElementById(
  "exportDelayLiveDataBtn"
);

// NEW: Export function for Delay Live Player
async function copyDelayLiveData() {
  const currentTimestamp = getCurrentDateTimeFormatted();
  const videoId = delayVideoIdInput.value.trim() || "N/A";
  const startTime = delayStartTimeInput.value.trim() || "N/A";
  const endTime = delayEndTimeInput.value.trim() || "N/A";
  const videoTitle = delayVideoTitle.textContent || "N/A"; // Get video title for Delay Live Player

  // Format: Video ID,Video Title,Video Start Time,Video End Time,Timestamp
  const header = `Video ID,Video Title,Video Start Time,Video End Time,Timestamp`;
  const data = `${escapeCsvValue(videoId)},${escapeCsvValue(
    videoTitle
  )},${escapeCsvValue(startTime)},${escapeCsvValue(endTime)},${escapeCsvValue(
    currentTimestamp
  )}`;

  const exportLine = data; // Only the data line, header is for context

  // Store the exported data in local storage
  let delayLivePlayerExports =
    JSON.parse(localStorage.getItem("delayPlayerExports")) || [];
  // If the array is empty, add the header first
  if (delayLivePlayerExports.length === 0) {
    delayLivePlayerExports.push(header);
  }
  delayLivePlayerExports.push(exportLine);
  localStorage.setItem(
    "delayPlayerExports",
    JSON.stringify(delayLivePlayerExports)
  );

  // Copy all stored data to clipboard
  const allExportedData = delayLivePlayerExports.join("\n");

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(allExportedData);
      console.log("Delay Live Player data copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy Delay Live Player data:", err);
    }
  } else {
    console.error("Clipboard API not supported.");
  }
}

// --- Delay Live Player Functions ---
if (loadDelayVideoBtn)
  loadDelayVideoBtn.addEventListener("click", () => {
    const videoId = delayVideoIdInput.value.trim();
    const startTimeString = delayStartTimeInput.value.trim();
    const endTimeString = delayEndTimeInput.value.trim();
    const startSeconds =
      timeToSeconds(startTimeString) !== null
        ? timeToSeconds(startTimeString)
        : 0;
    const endSeconds =
      timeToSeconds(endTimeString) !== null ? timeToSeconds(endTimeString) : 0;
    if (videoId) {
      sendPlayerCommand(
        "delayLivePlayerCommand",
        "loadVideo",
        videoId,
        startSeconds,
        endSeconds
      );
      delayPlayerStatus.textContent = "Video loaded, playing.";
      isDelayPlaying = true;
      isDelayStopped = false;
      isDelayMuted = false;
      updateButtonAppearance(
        togglePlayPauseDelayBtn,
        isDelayPlaying,
        "Playing",
        "Paused"
      );
      updateStopButtonAppearance(stopDelayVideoBtn, isDelayStopped);
      updateButtonAppearance(
        toggleMuteUnmuteDelayBtn,
        !isDelayMuted,
        "Unmuted",
        "Muted"
      );
      fetchVideoInfo(videoId, delayVideoThumbnail, delayVideoTitle);
      delayVideoIdInput.value = videoId;
      savePlayerState("delay");
      sendPlayerCommand("delayLivePlayerCommand", "unmute");
    } else {
      delayPlayerStatus.textContent = "Please enter a YouTube Video ID.";
      fetchVideoInfo("", delayVideoThumbnail, delayVideoTitle);
    }
  });
if (togglePlayPauseDelayBtn)
  togglePlayPauseDelayBtn.addEventListener("click", () => {
    if (isDelayPlaying) {
      sendPlayerCommand("delayLivePlayerCommand", "pause");
      delayPlayerStatus.textContent = "Paused";
      isDelayStopped = false;
    } else {
      sendPlayerCommand("delayLivePlayerCommand", "play");
      delayPlayerStatus.textContent = "Playing.";
      isDelayStopped = false;
    }
    isDelayPlaying = !isDelayPlaying;
    updateButtonAppearance(
      togglePlayPauseDelayBtn,
      isDelayPlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopDelayVideoBtn, isDelayStopped);
    savePlayerState("delay");
  });
if (stopDelayVideoBtn)
  stopDelayVideoBtn.addEventListener("click", () => {
    sendPlayerCommand("delayLivePlayerCommand", "stop");
    delayPlayerStatus.textContent = "Stopped";
    isDelayPlaying = false;
    isDelayStopped = true;
    updateButtonAppearance(
      togglePlayPauseDelayBtn,
      isDelayPlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopDelayVideoBtn, isDelayStopped);
    savePlayerState("delay");
  });
if (toggleMuteUnmuteDelayBtn)
  toggleMuteUnmuteDelayBtn.addEventListener("click", () => {
    if (isDelayMuted) {
      sendPlayerCommand("delayLivePlayerCommand", "unmute");
      delayPlayerStatus.textContent = "Unmuted";
    } else {
      sendPlayerCommand("delayLivePlayerCommand", "mute");
      delayPlayerStatus.textContent = "Muted";
    }
    isDelayMuted = !isDelayMuted;
    updateButtonAppearance(
      toggleMuteUnmuteDelayBtn,
      !isDelayMuted,
      "Unmuted",
      "Muted"
    );
    savePlayerState("delay");
  });
if (exportDelayLiveDataBtn)
  exportDelayLiveDataBtn.addEventListener("click", copyDelayLiveData);
