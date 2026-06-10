// Local PC Player logic and UI extracted from script.js
// All functions and variables are globally accessible

// --- Local PC Player Variables ---
let isLocalPCPlaying = true;
let isLocalPCMuted = false;
let isLocalPCStopped = false;
let localPCPlaylist = [];
let currentLocalPCIndex = 0;
const LOCAL_PC_PLAYER_STATE_KEY = "localPCPlayerState";
const LOCAL_PC_END_ACTION_KEY = "localPCEndActions";
let localPCDayEndActions = {
  0: "Loop Player",
  1: "Loop Player",
  2: "Loop Player",
  3: "Loop Player",
  4: "Loop Player",
  5: "Loop Player",
  6: "Loop Player",
};

// --- DOM References for Local PC Player ---
const localPCPlaylistContainer = document.getElementById(
  "localPCPlaylistContainer"
);
const addLocalPCVideoBtn = document.getElementById("addLocalPCVideoBtn");
const loadLocalPCVideoBtn = document.getElementById("loadLocalPCVideoBtn");
const togglePlayPauseLocalPCBtn = document.getElementById(
  "togglePlayPauseLocalPCBtn"
);
const stopLocalPCVideoBtn = document.getElementById("stopLocalPCVideoBtn");
const toggleMuteUnmuteLocalPCBtn = document.getElementById(
  "toggleMuteUnmuteLocalPCBtn"
);
const localPCPlayerStatus = document.getElementById("localPCPlayerStatus");
const localPCVideoTitle = document.getElementById("localPCVideoTitle");
const localPCVideoTime = document.getElementById(
  "localPCVideoTime"
);
const localPCCurrentVideoInfo = document.getElementById(
  "localPCCurrentVideoInfo"
);
const prevLocalPCVideoBtn = document.getElementById("prevLocalPCVideoBtn");
const nextLocalPCVideoBtn = document.getElementById("nextLocalPCVideoBtn");
const jumpLocalPCVideoIndexInput = document.getElementById(
  "jumpLocalPCVideoIndex"
);
const jumpLocalPCVideoBtn = document.getElementById("jumpLocalPCVideoBtn");
const resetLocalPCPlaylistBtn = document.getElementById(
  "resetLocalPCPlaylistBtn"
);
const exportLocalPCDataBtn = document.getElementById("exportLocalPCDataBtn");
const localPCEndActionContainer = document.getElementById(
  "localPCEndActionContainer"
);

// Time conversion utility functions
function timeStringToSeconds(timeString) {
  if (!timeString) return null;
  const parts = timeString.split(":").map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return Number(timeString) || null;
}

function secondsToTimeString(seconds) {
  if (!seconds && seconds !== 0) return "";
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")}`;
}

// NEW: Export function for Local PC Player
async function copyLocalPCPlayerData() {
  const currentTimestamp = getCurrentDateTimeFormatted();
  const playlistData = localPCPlaylist
    .map((item) => `${item.path}|${item.startTime || ""}|${item.endTime || ""}`)
    .join(";");

  const currentVideo = localPCPlaylist[currentLocalPCIndex];
  const currentVideoPath = currentVideo?.path || "N/A";
  const currentVideoTitle = localPCVideoTitle.textContent || "N/A";

  const header = `Current Video Path,Current Video Title,Start Time,End Time,Playlist,Timestamp`;
  const data =
    `${escapeCsvValue(currentVideoPath)},${escapeCsvValue(
      currentVideoTitle
    )},` +
    `${escapeCsvValue(currentVideo?.startTime || "")},${escapeCsvValue(
      currentVideo?.endTime || ""
    )},` +
    `${escapeCsvValue(playlistData)},${escapeCsvValue(currentTimestamp)}`;

  const exportLine = data;

  let localPCPlayerExports =
    JSON.parse(localStorage.getItem("localPCPlayerExports")) || [];
  if (localPCPlayerExports.length === 0) {
    localPCPlayerExports.push(header);
  }
  localPCPlayerExports.push(exportLine);
  localStorage.setItem(
    "localPCPlayerExports",
    JSON.stringify(localPCPlayerExports)
  );

  const allExportedData = localPCPlayerExports.join("\n");

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(allExportedData);
      console.log("Local PC Player data copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy Local PC Player data:", err);
    }
  } else {
    console.error("Clipboard API not supported.");
  }
}

// --- Local PC Player Functions ---
function renderLocalPCPlaylist() {
  localPCPlaylistContainer.innerHTML = "";
  if (localPCPlaylist.length === 0) {
    localPCPlaylistContainer.innerHTML =
      '<p class="text-gray-400 text-center text-sm">No videos in playlist. Add some!</p>';
    localPCVideoTitle.textContent = "No local video loaded";
    localPCCurrentVideoInfo.textContent = "";
    return;
  }

  localPCPlaylist.forEach((item, index) => {
    const itemDiv = document.createElement("div");
    itemDiv.id = `local-pc-item-${item.id}`;
    itemDiv.draggable = true;
    itemDiv.className = "local-pc-video-item";

    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle";
    dragHandle.textContent = "☰";
    itemDiv.appendChild(dragHandle);

    // Create a container for the path and time inputs
    const inputContainer = document.createElement("div");
    inputContainer.className = "flex flex-col gap-1 flex-grow";

    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "input-field";
    pathInput.placeholder = `Video Path ${index + 1}`;
    pathInput.value = item.path;
    pathInput.addEventListener("change", (e) => {
    // 1. Get the raw path from the input and remove any surrounding quotes.
    const rawPath = e.target.value;
    const cleanedPath = rawPath.trim().replace(/^["']|["']$/g, '');
    // -> result: "C:\Users\Admin\Videos\01 Chesta.mp4"

    // 2. Replace all backslashes with forward slashes for URL compatibility.
    const pathWithForwardSlashes = cleanedPath.replace(/\\/g, '/');
    // -> result: "C:/Users/Admin/Videos/01 Chesta.mp4"

    // 3. Encode the path to handle spaces and other special characters correctly.
    // This will turn "01 Chesta.mp4" into "01%20Chesta.mp4".
    // -> result: "C:/Users/Admin/Videos/01%20Chesta.mp4"

    // Assign this valid URL to your item's path.
    item.path = pathWithForwardSlashes;
    pathInput.value = pathWithForwardSlashes;
    
    // Save the updated state.
    savePlayerState("localPC");
});
    inputContainer.appendChild(pathInput);

    // Add time inputs container
    const timeContainer = document.createElement("div");
    timeContainer.className = "flex gap-2";

    // Start time input
    const startTimeInput = document.createElement("input");
    startTimeInput.type = "text";
    startTimeInput.className = "input-field w-24";
    startTimeInput.placeholder = "Start (HH:MM:SS)";
    startTimeInput.value = item.startTime
      ? secondsToTimeString(item.startTime)
      : "";
    startTimeInput.addEventListener("change", (e) => {
      item.startTime = timeStringToSeconds(e.target.value);
      savePlayerState("localPC");
    });

    // End time input
    const endTimeInput = document.createElement("input");
    endTimeInput.type = "text";
    endTimeInput.className = "input-field w-24";
    endTimeInput.placeholder = "End (HH:MM:SS)";
    endTimeInput.value = item.endTime ? secondsToTimeString(item.endTime) : "";
    endTimeInput.addEventListener("change", (e) => {
      item.endTime = timeStringToSeconds(e.target.value);
      savePlayerState("localPC");
    });

    timeContainer.appendChild(startTimeInput);
    timeContainer.appendChild(endTimeInput);
    inputContainer.appendChild(timeContainer);

    itemDiv.appendChild(inputContainer);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "X";
    deleteBtn.onclick = () => deleteLocalPCVideoInput(item.id);
    itemDiv.appendChild(deleteBtn);

    itemDiv.addEventListener("dragstart", handleLocalPCDragStart);
    itemDiv.addEventListener("dragover", handleLocalPCDragOver);
    itemDiv.addEventListener("dragleave", handleLocalPCDragLeave);
    itemDiv.addEventListener("drop", handleLocalPCDrop);
    itemDiv.addEventListener("dragend", handleLocalPCDragEnd);
    localPCPlaylistContainer.appendChild(itemDiv);
  });

  if (localPCPlaylist.length > 0 && localPCPlaylist[currentLocalPCIndex]) {
    const currentVideoPath = localPCPlaylist[currentLocalPCIndex].path;
    const filename = currentVideoPath.split("\\").pop().split("/").pop();
    localPCVideoTitle.textContent = filename;
    localPCCurrentVideoInfo.textContent = `Video ${
      currentLocalPCIndex + 1
    } of ${localPCPlaylist.length}`;
  } else {
    localPCVideoTitle.textContent = "No local video loaded";
    localPCCurrentVideoInfo.textContent = "";
  }
}

function addLocalPCVideoInput() {
  const newId = Date.now();
  localPCPlaylist.push({
    id: newId,
    path: "",
    startTime: null,
    endTime: null,
  });
  renderLocalPCPlaylist();
  savePlayerState("localPC");
}

function deleteLocalPCVideoInput(id) {
  localPCPlaylist = localPCPlaylist.filter((item) => item.id !== id);
  if (currentLocalPCIndex >= localPCPlaylist.length) {
    currentLocalPCIndex = Math.max(0, localPCPlaylist.length - 1);
  }
  renderLocalPCPlaylist();
  savePlayerState("localPC");
  if (
    localPCPlaylist.length === 0 ||
    localPCPlaylist[currentLocalPCIndex]?.id !== id
  ) {
    sendPlayerCommand("localPCPlayerCommand", "stop");
    localPCPlayerStatus.textContent = "Stopped";
    isLocalPCPlaying = false;
    isLocalPCStopped = true;
    updateButtonAppearance(
      togglePlayPauseLocalPCBtn,
      isLocalPCPlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLocalPCVideoBtn, isLocalPCStopped);
  }
}

async function loadAndPlayLocalPCVideoByIndex(index) {
  if (localPCPlaylist.length === 0) {
    localPCPlayerStatus.textContent = "No videos in playlist.";
    localPCVideoTitle.textContent = "No local video loaded";
    localPCCurrentVideoInfo.textContent = "";
    return;
  }

  currentLocalPCIndex = index % localPCPlaylist.length;
  if (currentLocalPCIndex < 0) {
    currentLocalPCIndex = localPCPlaylist.length - 1;
  }

  const currentVideo = localPCPlaylist[currentLocalPCIndex];
  const videoPathToLoad = currentVideo.path;
  console.log("currentVideo", currentVideo);
  if (videoPathToLoad) {
    const startTime = currentVideo.startTime || 0;
    const endTime = currentVideo.endTime;
    sendPlayerCommand(
      "localPCPlayerCommand",
      "loadVideo",
      null,
      startTime,
      endTime,
      videoPathToLoad
    );

    localPCPlayerStatus.textContent = `Loading: ${videoPathToLoad
      .split("\\")
      .pop()
      .split("/")
      .pop()}`;
    isLocalPCPlaying = true;
    isLocalPCStopped = false;
    isLocalPCMuted = false;

    updateButtonAppearance(
      togglePlayPauseLocalPCBtn,
      isLocalPCPlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLocalPCVideoBtn, isLocalPCStopped);
    updateButtonAppearance(
      toggleMuteUnmuteLocalPCBtn,
      !isLocalPCMuted,
      "Unmuted",
      "Muted"
    );
    fetchVideoInfo(
      videoPathToLoad,
      null,
      localPCVideoTitle,
      localPCCurrentVideoInfo,
      currentLocalPCIndex,
      localPCPlaylist.length
    );
    savePlayerState("localPC");
    sendPlayerCommand("localPCPlayerCommand", "unmute");
  } else {
    localPCPlayerStatus.textContent = `Video path at index ${currentLocalPCIndex} is empty. Skipping...`;
    currentLocalPCIndex++;
    if (currentLocalPCIndex < localPCPlaylist.length) {
      loadAndPlayLocalPCVideoByIndex(currentLocalPCIndex);
    } else {
      handleLocalPCVideoEnded();
    }
  }
}

async function handleLocalPCVideoEnded() {
  console.log(
    `LocalPCPlayer: Video ended. Current index: ${currentLocalPCIndex}, Playlist length: ${localPCPlaylist.length}`
  );

  currentLocalPCIndex++;

  if (currentLocalPCIndex < localPCPlaylist.length) {
    console.log(
      `LocalPCPlayer: Loading next video at index ${currentLocalPCIndex}.`
    );
    loadAndPlayLocalPCVideoByIndex(currentLocalPCIndex);
  } else {
    console.log(
      "LocalPCPlayer: End of playlist reached. Triggering end action."
    );
    sendPlayerCommand("localPCPlayerCommand", "stop");
    localPCPlayerStatus.textContent = "Playlist Ended.";
    isLocalPCPlaying = false;
    isLocalPCStopped = true;
    updateButtonAppearance(
      togglePlayPauseLocalPCBtn,
      isLocalPCPlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLocalPCVideoBtn, isLocalPCStopped);
    savePlayerState("localPC");

    const currentDay = new Date().getDay();
    const targetScene = localPCDayEndActions[currentDay];

    if (
      targetScene &&
      sourceNames.includes(targetScene) &&
      sourceState["Local Player"]
    ) {
      console.log(
        `LocalPCPlayer: Switching to OBS scene: "${targetScene}" for ${daysMap[currentDay]}.`
      );
      if (sourceState["Live Player"] && targetScene === "Loop Player") {
        await setSourceVisibility("Live Player", false);
      }
      setSourceVisibility(targetScene, true);
    } else {
      console.warn(
        `LocalPCPlayer: No valid scene configured for ${daysMap[currentDay]} after playlist ends, or target scene "${targetScene}" is not a recognized OBS source.`
      );
    }
    currentLocalPCIndex = 0;
    renderLocalPCPlaylist();
  }
}

function renderLocalPCEndActions() {
  localPCEndActionContainer.innerHTML = "";
  const obsSourcesForDropdown = sourceNames.filter(
    (name) => name !== "OrdaChesta"
  );

  daysMap.forEach((dayName, dayIndex) => {
    const div = document.createElement("div");
    div.className = "flex flex-col";

    const label = document.createElement("label");
    label.textContent = dayName + ":";
    label.className = "text-gray-300 text-xs mb-1";
    div.appendChild(label);

    const select = document.createElement("select");
    select.id = `localPC-end-action-day-${dayIndex}`;
    select.className = "input-field";

    const offOption = document.createElement("option");
    offOption.value = "";
    offOption.textContent = "Do Nothing";
    select.appendChild(offOption);

    obsSourcesForDropdown.forEach((source) => {
      const option = document.createElement("option");
      option.value = source;
      option.textContent = source;
      select.appendChild(option);
    });

    select.value = localPCDayEndActions[dayIndex] || "";
    select.addEventListener("change", (e) => {
      localPCDayEndActions[dayIndex] = e.target.value;
      savePlayerState("localPC");
    });
    div.appendChild(select);
    localPCEndActionContainer.appendChild(div);
  });
}

// Drag-and-drop event handlers
let draggedLocalPCItemId = null;

function handleLocalPCDragStart(e) {
  draggedLocalPCItemId = parseInt(e.target.id.replace("local-pc-item-", ""));
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedLocalPCItemId);
  setTimeout(() => e.target.classList.add("dragging"), 0);
}

function handleLocalPCDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const targetItem = e.target.closest(".local-pc-video-item");
  if (targetItem && targetItem.id !== `local-pc-item-${draggedLocalPCItemId}`) {
    Array.from(localPCPlaylistContainer.children).forEach((item) => {
      item.classList.remove("drag-over-top", "drag-over-bottom");
    });

    const targetRect = targetItem.getBoundingClientRect();
    const centerY = targetRect.top + targetRect.height / 2;

    if (e.clientY < centerY) {
      targetItem.classList.add("drag-over-top");
    } else {
      targetItem.classList.add("drag-over-bottom");
    }
  }
}

function handleLocalPCDragLeave(e) {
  e.target.classList.remove("drag-over-top", "drag-over-bottom");
}

function handleLocalPCDrop(e) {
  e.preventDefault();

  Array.from(localPCPlaylistContainer.children).forEach((item) => {
    item.classList.remove("drag-over-top", "drag-over-bottom");
  });

  const targetItem = e.target.closest(".local-pc-video-item");
  if (
    !targetItem ||
    targetItem.id === `local-pc-item-${draggedLocalPCItemId}`
  ) {
    return;
  }

  const targetId = parseInt(targetItem.id.replace("local-pc-item-", ""));
  const draggedIndex = localPCPlaylist.findIndex(
    (item) => item.id === draggedLocalPCItemId
  );
  let targetIndex = localPCPlaylist.findIndex((item) => item.id === targetId);

  if (draggedIndex === -1 || targetIndex === -1) return;

  const draggedItem = localPCPlaylist[draggedIndex];

  const targetRect = targetItem.getBoundingClientRect();
  const centerY = targetRect.top + targetRect.height / 2;
  const dropPosition = e.clientY < centerY ? "before" : "after";

  localPCPlaylist.splice(draggedIndex, 1);

  if (draggedIndex < targetIndex) {
    targetIndex--;
  }

  if (dropPosition === "after") {
    localPCPlaylist.splice(targetIndex + 1, 0, draggedItem);
  } else {
    localPCPlaylist.splice(targetIndex, 0, draggedItem);
  }

  savePlayerState("localPC");
  renderLocalPCPlaylist();
}

function handleLocalPCDragEnd(e) {
  e.target.classList.remove("dragging");
  Array.from(localPCPlaylistContainer.children).forEach((item) => {
    item.classList.remove("drag-over-top", "drag-over-bottom");
  });
  draggedLocalPCItemId = null;
}

// --- Event Listeners for Local PC Player ---
if (addLocalPCVideoBtn)
  addLocalPCVideoBtn.addEventListener("click", addLocalPCVideoInput);
if (loadLocalPCVideoBtn)
  loadLocalPCVideoBtn.addEventListener("click", () => {
    if (localPCPlaylist.length > 0) {
      currentLocalPCIndex = 0;
      loadAndPlayLocalPCVideoByIndex(currentLocalPCIndex);
    } else {
      localPCPlayerStatus.textContent =
        "No videos in playlist. Add some first.";
    }
  });
if (togglePlayPauseLocalPCBtn)
  togglePlayPauseLocalPCBtn.addEventListener("click", () => {
    if (isLocalPCPlaying) {
      sendPlayerCommand("localPCPlayerCommand", "pause");
      localPCPlayerStatus.textContent = "Paused";
      isLocalPCStopped = false;
    } else {
      sendPlayerCommand("localPCPlayerCommand", "play");
      localPCPlayerStatus.textContent = "Playing.";
      isLocalPCStopped = false;
    }
    isLocalPCPlaying = !isLocalPCPlaying;
    updateButtonAppearance(
      togglePlayPauseLocalPCBtn,
      isLocalPCPlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLocalPCVideoBtn, isLocalPCStopped);
    savePlayerState("localPC");
  });
if (stopLocalPCVideoBtn)
  stopLocalPCVideoBtn.addEventListener("click", () => {
    sendPlayerCommand("localPCPlayerCommand", "stop");
    localPCPlayerStatus.textContent = "Stopped";
    isLocalPCPlaying = false;
    isLocalPCStopped = true;
    updateButtonAppearance(
      togglePlayPauseLocalPCBtn,
      isLocalPCPlaying,
      "Playing",
      "Paused"
    );
    updateStopButtonAppearance(stopLocalPCVideoBtn, isLocalPCStopped);
    savePlayerState("localPC");
  });
if (toggleMuteUnmuteLocalPCBtn)
  toggleMuteUnmuteLocalPCBtn.addEventListener("click", () => {
    if (isLocalPCMuted) {
      sendPlayerCommand("localPCPlayerCommand", "unmute");
      localPCPlayerStatus.textContent = "Unmuted";
    } else {
      sendPlayerCommand("localPCPlayerCommand", "mute");
      localPCPlayerStatus.textContent = "Muted";
    }
    isLocalPCMuted = !isLocalPCMuted;
    updateButtonAppearance(
      toggleMuteUnmuteLocalPCBtn,
      !isLocalPCMuted,
      "Unmuted",
      "Muted"
    );
    savePlayerState("localPC");
  });
if (prevLocalPCVideoBtn)
  prevLocalPCVideoBtn.addEventListener("click", () => {
    if (localPCPlaylist.length > 0) {
      currentLocalPCIndex =
        (currentLocalPCIndex - 1 + localPCPlaylist.length) %
        localPCPlaylist.length;
      loadAndPlayLocalPCVideoByIndex(currentLocalPCIndex);
    }
  });
if (nextLocalPCVideoBtn)
  nextLocalPCVideoBtn.addEventListener("click", () => {
    if (localPCPlaylist.length > 0) {
      currentLocalPCIndex = (currentLocalPCIndex + 1) % localPCPlaylist.length;
      loadAndPlayLocalPCVideoByIndex(currentLocalPCIndex);
    }
  });
if (jumpLocalPCVideoBtn)
  jumpLocalPCVideoBtn.addEventListener("click", () => {
    console.log("jumpLocalPCVideoBtn clicked");

    const index = parseInt(jumpLocalPCVideoIndexInput.value) - 1;
    if (!isNaN(index) && index >= 0 && index < localPCPlaylist.length) {
      currentLocalPCIndex = index;
      loadAndPlayLocalPCVideoByIndex(currentLocalPCIndex);
    } else {
      localPCPlayerStatus.textContent =
        "Invalid index. Please enter a number between 1 and " +
        localPCPlaylist.length;
    }
  });
if (resetLocalPCPlaylistBtn)
  resetLocalPCPlaylistBtn.addEventListener("click", () => {
    localPCPlaylist = [];
    currentLocalPCIndex = 0;
    localPCPlayerStatus.textContent = "Playlist cleared.";
    localPCVideoTitle.textContent = "No local video loaded";
    localPCCurrentVideoInfo.textContent = "";
    renderLocalPCPlaylist();
    savePlayerState("localPC");
  });
if (exportLocalPCDataBtn)
  exportLocalPCDataBtn.addEventListener("click", copyLocalPCPlayerData);

// Initialize Local PC Player
renderLocalPCPlaylist();
renderLocalPCEndActions();
