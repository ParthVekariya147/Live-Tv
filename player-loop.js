// Loop Player logic and UI extracted from script.js
// All functions and variables are globally accessible

// --- Loop Player Variables ---
let isLoopPlaying = true;
let isLoopMuted = false;
let isLoopStopped = false;
let loopPlaylist = [];
let currentLoopIndex = 0;

// --- DOM References for Loop Player ---
const loopVideoIdInput = document.getElementById("loopVideoId");
const loopPlayerStatus = document.getElementById("loopPlayerStatus");
const loadLoopVideoBtn = document.getElementById("loadLoopVideoBtn");
const togglePlayPauseLoopBtn = document.getElementById(
  "togglePlayPauseLoopBtn"
);
const stopLoopVideoBtn = document.getElementById("stopLoopVideoBtn");
const toggleMuteUnmuteLoopBtn = document.getElementById(
  "toggleMuteUnmuteLoopBtn"
);
const prevLoopVideoBtn = document.getElementById("prevLoopVideoBtn");
const nextLoopVideoBtn = document.getElementById("nextLoopVideoBtn");
const jumpLoopVideoBtn = document.getElementById("jumpLoopVideoBtn");
const loadSavedLoopPlaylistBtn = document.getElementById(
  "loadSavedLoopPlaylistBtn"
);
const resetLoopPlaylistBtn = document.getElementById("resetLoopPlaylistBtn");
const exportLoopDataBtn = document.getElementById("exportLoopDataBtn");
const loopVideoThumbnail = document.getElementById("loopVideoThumbnail");
const loopVideoTitle = document.getElementById("loopVideoTitle");
const loopVideoTime = document.getElementById("loopVideoTime");
const loopCurrentVideoInfo = document.getElementById("loopCurrentVideoInfo");
const jumpLoopVideoIndexInput = document.getElementById("jumpLoopVideoIndex");

// --- Loop Player Functions ---
async function loadAndPlayLoopVideoByIndex(index) {
  if (loopPlaylist.length === 0) {
    loopPlayerStatus.textContent = "No videos in playlist.";
    fetchVideoInfo(
      "",
      loopVideoThumbnail,
      loopVideoTitle,
      loopCurrentVideoInfo
    );
    return;
  }

  currentLoopIndex = index % loopPlaylist.length;
  if (currentLoopIndex < 0) {
    currentLoopIndex = loopPlaylist.length - 1;
  }

  let videoIdToLoad = loopPlaylist[currentLoopIndex];
  let videoFound = false;
  let attempts = 0;
  const maxAttempts = loopPlaylist.length * 2;

  while (!videoFound && attempts < maxAttempts) {
    if (videoIdToLoad) {
      const oEmbedUrl = `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${videoIdToLoad}&format=json`;
      try {
        const response = await fetch(oEmbedUrl);
        if (response.ok) {
          const data = await response.json();
          if (data.title) {
            videoFound = true;
          }
        }
      } catch (error) {
        console.warn(
          `Video ID ${videoIdToLoad} might be unavailable or private:`,
          error
        );
      }
    }

    if (videoFound) {
      sendPlayerCommand("loopPlayerCommand", "loadVideo", videoIdToLoad);
      loopPlayerStatus.textContent = `Loading: ${videoIdToLoad}`;
      isLoopPlaying = true;
      isLoopStopped = false;
      isLoopMuted = false;
      updateButtonAppearance(
        togglePlayPauseLoopBtn,
        isLoopPlaying,
        "Playing",
        "Paused"
      );
      updateStopButtonAppearance(stopLoopVideoBtn, isLoopStopped);
      updateButtonAppearance(
        toggleMuteUnmuteLoopBtn,
        !isLoopMuted,
        "Unmuted",
        "Muted"
      );
      fetchVideoInfo(
        videoIdToLoad,
        loopVideoThumbnail,
        loopVideoTitle,
        loopCurrentVideoInfo,
        currentLoopIndex,
        loopPlaylist.length
      );
      savePlayerState("loop");
      sendPlayerCommand("loopPlayerCommand", "unmute");
    } else {
      loopPlayerStatus.textContent = `Video ID ${videoIdToLoad} unavailable. Skipping...`;
      currentLoopIndex = (currentLoopIndex + 1) % loopPlaylist.length;
      videoIdToLoad = loopPlaylist[currentLoopIndex];
      attempts++;
      if (attempts >= maxAttempts) {
        loopPlayerStatus.textContent = "No available videos in playlist.";
        fetchVideoInfo(
          "",
          loopVideoThumbnail,
          loopVideoTitle,
          loopCurrentVideoInfo
        );
        break;
      }
    }
  }
}

function onLoadLoopVideo() {
  if (!loopVideoIdInput) return;
  const videoIdsString = loopVideoIdInput.value.trim();
  if (!videoIdsString) {
    if (loopPlayerStatus)
      loopPlayerStatus.textContent =
        "Please enter comma-separated YouTube Video IDs.";
    return;
  }
  loopPlaylist = videoIdsString
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id);
  if (loopPlaylist.length > 0) {
    currentLoopIndex = 0;
    loadAndPlayLoopVideoByIndex(currentLoopIndex);
  } else {
    if (loopPlayerStatus)
      loopPlayerStatus.textContent = "No valid video IDs entered.";
  }
}

function onTogglePlayPause() {
  if (isLoopPlaying) {
    sendPlayerCommand("loopPlayerCommand", "pause");
    loopPlayerStatus.textContent = "Paused";
    isLoopStopped = false;
  } else {
    sendPlayerCommand("loopPlayerCommand", "play");
    loopPlayerStatus.textContent = "Playing.";
    isLoopStopped = false;
  }
  isLoopPlaying = !isLoopPlaying;
  updateButtonAppearance(
    togglePlayPauseLoopBtn,
    isLoopPlaying,
    "Playing",
    "Paused"
  );
  updateStopButtonAppearance(stopLoopVideoBtn, isLoopStopped);
  savePlayerState("loop");
}

function onStop() {
  sendPlayerCommand("loopPlayerCommand", "stop");
  loopPlayerStatus.textContent = "Stopped";
  isLoopPlaying = false;
  isLoopStopped = true;
  updateButtonAppearance(
    togglePlayPauseLoopBtn,
    isLoopPlaying,
    "Playing",
    "Paused"
  );
  updateStopButtonAppearance(stopLoopVideoBtn, isLoopStopped);
  savePlayerState("loop");
}

function onToggleMuteUnmute() {
  if (isLoopMuted) {
    sendPlayerCommand("loopPlayerCommand", "unmute");
    loopPlayerStatus.textContent = "Unmuted";
  } else {
    sendPlayerCommand("loopPlayerCommand", "mute");
    loopPlayerStatus.textContent = "Muted";
  }
  isLoopMuted = !isLoopMuted;
  updateButtonAppearance(
    toggleMuteUnmuteLoopBtn,
    !isLoopMuted,
    "Unmuted",
    "Muted"
  );
  savePlayerState("loop");
}

function onPrev() {
  if (loopPlaylist.length > 0) {
    currentLoopIndex =
      (currentLoopIndex - 1 + loopPlaylist.length) % loopPlaylist.length;
    loadAndPlayLoopVideoByIndex(currentLoopIndex);
  }
}

function onNext() {
  if (loopPlaylist.length > 0) {
    currentLoopIndex = (currentLoopIndex + 1) % loopPlaylist.length;
    loadAndPlayLoopVideoByIndex(currentLoopIndex);
  }
}

function onJumpToIndex() {
  const index = parseInt(jumpLoopVideoIndexInput.value) - 1;
  if (!isNaN(index) && index >= 0 && index < loopPlaylist.length) {
    currentLoopIndex = index;
    loadAndPlayLoopVideoByIndex(currentLoopIndex);
  } else {
    loopPlayerStatus.textContent =
      "Invalid index. Please enter a number between 1 and " +
      loopPlaylist.length;
  }
}

function onLoadSavedPlaylist() {
  loadPlayerState("loop");
  if (loopPlaylist.length > 0) {
    loopVideoIdInput.value = loopPlaylist.join(", ");
    loadAndPlayLoopVideoByIndex(currentLoopIndex);
  }
}

function onResetPlaylist() {
  loopPlaylist = [];
  currentLoopIndex = 0;
  loopVideoIdInput.value = "";
  loopPlayerStatus.textContent = "Playlist cleared.";
  fetchVideoInfo("", loopVideoThumbnail, loopVideoTitle, loopCurrentVideoInfo);
  savePlayerState("loop");
}

function onExportData() {
  copyLoopPlayerData();
}

// --- Event Listeners for Loop Player ---
if (loadLoopVideoBtn)
  loadLoopVideoBtn.addEventListener("click", onLoadLoopVideo);
if (togglePlayPauseLoopBtn)
  togglePlayPauseLoopBtn.addEventListener("click", onTogglePlayPause);
if (stopLoopVideoBtn) stopLoopVideoBtn.addEventListener("click", onStop);
if (toggleMuteUnmuteLoopBtn)
  toggleMuteUnmuteLoopBtn.addEventListener("click", onToggleMuteUnmute);
if (prevLoopVideoBtn) prevLoopVideoBtn.addEventListener("click", onPrev);
if (nextLoopVideoBtn) nextLoopVideoBtn.addEventListener("click", onNext);
if (jumpLoopVideoBtn) jumpLoopVideoBtn.addEventListener("click", onJumpToIndex);
if (loadSavedLoopPlaylistBtn)
  loadSavedLoopPlaylistBtn.addEventListener("click", onLoadSavedPlaylist);
if (resetLoopPlaylistBtn)
  resetLoopPlaylistBtn.addEventListener("click", onResetPlaylist);
if (exportLoopDataBtn)
  exportLoopDataBtn.addEventListener("click", onExportData);

// --- Export Loop Player Data ---
async function copyLoopPlayerData() {
  const data = {
    isLoopPlaying: isLoopPlaying,
    isLoopMuted: isLoopMuted,
    isLoopStopped: isLoopStopped,
    loopPlaylist: loopPlaylist,
    currentLoopIndex: currentLoopIndex,
  };
  const dataStr = JSON.stringify(data, null, 2);
  copyToClipboard(dataStr);
  console.log("Loop Player data copied to clipboard");
}
