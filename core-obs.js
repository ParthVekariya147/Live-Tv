// OBS WebSocket connection and control logic extracted from script.js
// All functions and variables are globally accessible

// --- Global OBS Variables ---
let socket;
const SCENE_NAME = "Scene";
const sourceNames = [
  "Loop Player",
  "Live Player",
  "Delay Live",
  "OrdaChesta",
  "Local Player",
];
const sourceState = {};
const sourceIds = {};
let streamActive = false;
let recordActive = false;
let virtualCamActive = false;
let lastVirtualCamActiveState = false;
let obsStatusPollInterval;
const POLL_INTERVAL_MS = 1000;

// --- SOLUTION: Key for localStorage and state initialization ---
const OBS_PREVIEW_STOPPED_KEY = "obsPreviewManuallyStopped";
// On page load, read the saved state from localStorage. Defaults to false if not set.
let isPreviewManuallyStopped =
  localStorage.getItem(OBS_PREVIEW_STOPPED_KEY) === "true";

const btnStream = document.getElementById("btnStream");
const btnRecord = document.getElementById("btnRecord");
const btnVirtualCam = document.getElementById("btnVirtualCam");
const btnLiveLoop = document.getElementById("btnLiveLoop");
const btnDelayLive = document.getElementById("btnDelayLive");
const btnOrdaChesta = document.getElementById("btnOrdaChesta");
const btnLocalPlayer = document.getElementById("btnLocalPlayer");
const btnObsLive = document.getElementById("btnObsLive");

// NEW: Live Event Monitor Toggle Buttons
const btnToggleLiveMonitor1 = document.getElementById("btnToggleLiveMonitor1");
const btnToggleLiveMonitor2 = document.getElementById("btnToggleLiveMonitor2");
// NEW: Live Event Monitor Toggle Buttons
btnToggleLiveMonitor1.addEventListener("click", () => toggleLiveMonitor(1));
btnToggleLiveMonitor2.addEventListener("click", () => toggleLiveMonitor(2));

// OBS Control Button Event Listeners
btnStream.addEventListener("click", toggleStream);
btnRecord.addEventListener("click", toggleRecord);
btnVirtualCam.addEventListener("click", toggleVirtualCam);
btnLiveLoop.addEventListener("click", toggleLiveLoop);
btnDelayLive.addEventListener("click", () => toggleExclusive("Delay Live"));
btnOrdaChesta.addEventListener("click", () => toggleExclusive("OrdaChesta"));
btnLocalPlayer.addEventListener("click", () => toggleExclusive("Local Player"));

// --- SOLUTION: Updated click handler to save state and update button text ---
btnObsLive.addEventListener("click", () => {
  if (virtualCamVideoElement.srcObject) {
    // User is turning the preview OFF
    virtualCamVideoElement.srcObject
      .getTracks()
      .forEach((track) => track.stop());
    virtualCamVideoElement.srcObject = null;
    btnObsLive.className = "toggle-btn off";
    btnObsLive.textContent = "Show Preview"; // Set text
    isPreviewManuallyStopped = true; // Set the flag
    localStorage.setItem(OBS_PREVIEW_STOPPED_KEY, "true"); // Save state
  } else {
    // User is turning the preview ON
    isPreviewManuallyStopped = false; // Clear the flag
    localStorage.setItem(OBS_PREVIEW_STOPPED_KEY, "false"); // Save state
    tryDisplayVirtualCam(); // Manually attempt to start the preview
  }
});

// Set initial button text
btnObsLive.textContent = "Show Preview";

function connectOBS() {
  socket = new WebSocket("ws://localhost:4455");
  socket.onopen = async () => {
    console.log("Connected to OBS");
    titleEl.style.color = "#00adb5";
    socket.send(
      JSON.stringify({
        op: 1,
        d: {
          rpcVersion: 1,
          eventSubscriptions:
            (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5),
        },
      })
    );
    await getStreamStatus();
    await getRecordStatus();
    await getVirtualCamStatus();
    await getSceneItems();

    if (obsStatusPollInterval) clearInterval(obsStatusPollInterval);
    obsStatusPollInterval = setInterval(() => {
      getSceneItems();
      getStreamStatus();
      getRecordStatus();
      getVirtualCamStatus();
    }, POLL_INTERVAL_MS);
  };
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.op === 7 && msg.d.requestStatus.result) {
      switch (msg.d.requestType) {
        case "GetSceneItemList":
          const items = msg.d.responseData.sceneItems;
          for (const item of items) {
            const name = item.sourceName;
            if (sourceNames.includes(name)) {
              sourceState[name] = item.sceneItemEnabled;
              sourceIds[name] = item.sceneItemId;
            }
          }
          updateAllObsButtons();
          let visibleSourcesCount = 0;
          let firstVisibleSource = null;
          for (const s of sourceNames) {
            if (sourceState[s]) {
              visibleSourcesCount++;
              if (!firstVisibleSource) {
                firstVisibleSource = s;
              }
            }
          }
          if (visibleSourcesCount > 1) {
            setSourceVisibility(firstVisibleSource, true);
          } else if (visibleSourcesCount === 0) {
            setSourceVisibility("Loop Player", true);
          }
          break;
        case "GetStreamStatus":
          const newStreamActive = msg.d.responseData.outputActive;
          if (streamActive !== newStreamActive) {
            streamActive = newStreamActive;
            updateStreamButton();
          }
          break;
        case "GetRecordStatus":
          const newRecordActive = msg.d.responseData.outputActive;
          if (recordActive !== newRecordActive) {
            recordActive = newRecordActive;
            updateRecordButton();
          }
          break;
        case "GetVirtualCamStatus":
          const newVirtualCamActive = msg.d.responseData.outputActive;
          if (virtualCamActive !== newVirtualCamActive) {
            virtualCamActive = newVirtualCamActive;
            updateVirtualCamButton();
          }
          break;
      }
    }
    if (msg.op === 5) {
      switch (msg.d.eventType) {
        case "SceneItemEnableStateChanged":
          const changedItemName = msg.d.eventData.sceneItemSourceName;
          if (sourceNames.includes(changedItemName)) {
            const newEnabledState = msg.d.eventData.sceneItemEnabled;
            if (sourceState[changedItemName] !== newEnabledState) {
              sourceState[changedItemName] = newEnabledState;
              updateAllObsButtons();
            }
          }
          break;
        case "StreamStateChanged":
          const streamOutputState = msg.d.eventData.outputState;
          const isStreamActive =
            streamOutputState === "OBS_WEBSOCKET_OUTPUT_STARTING" ||
            streamOutputState === "OBS_WEBSOCKET_OUTPUT_STARTED";
          if (streamActive !== isStreamActive) {
            streamActive = isStreamActive;
            updateStreamButton();
          }
          break;
        case "RecordStateChanged":
          const recordOutputState = msg.d.eventData.outputState;
          const isRecordActive =
            recordOutputState === "OBS_WEBSOCKET_OUTPUT_STARTING" ||
            recordOutputState === "OBS_WEBSOCKET_OUTPUT_STARTED";
          if (recordActive !== isRecordActive) {
            recordActive = isRecordActive;
            updateRecordButton();
          }
          break;
        case "VirtualCamStateChanged":
          const virtualCamOutputActive = msg.d.eventData.outputActive;
          if (virtualCamActive !== virtualCamOutputActive) {
            virtualCamActive = virtualCamOutputActive;
            updateVirtualCamButton();
          }
          break;
      }
    }
  };
  socket.onclose = async () => {
    console.log(
      "Disconnected from OBS. Attempting to reconnect in 5 seconds..."
    );
    titleEl.style.color = "#999";
    if (obsStatusPollInterval) {
      clearInterval(obsStatusPollInterval);
      obsStatusPollInterval = null;
    }
    if (virtualCamVideoElement.srcObject) {
      virtualCamVideoElement.srcObject
        .getTracks()
        .forEach((track) => track.stop());
      virtualCamVideoElement.srcObject = null;
    }
    virtualCamErrorMessage.textContent =
      "Disconnected from OBS. Reconnecting...";
    btnObsLive.className = "toggle-btn off";
    btnObsLive.textContent = "Show Preview"; // Reset text on disconnect
    setTimeout(connectOBS, 5000);
  };
  socket.onerror = (err) => {
    console.error("OBS WebSocket error:", err);
    virtualCamErrorMessage.textContent = "OBS WebSocket Error. Check console.";
  };
}

function enforceSingleSourceVisibility(recentlyChangedSource) {
  if (sourceState[recentlyChangedSource]) {
    for (const s of sourceNames) {
      if (s !== recentlyChangedSource && sourceState[s]) {
        setSourceVisibility(s, false);
      }
    }
  } else {
    let anySourceVisible = false;
    for (const s of sourceNames) {
      if (sourceState[s]) {
        anySourceVisible = true;
        break;
      }
    }
    if (!anySourceVisible) {
      setSourceVisibility("Loop Player", true);
    }
  }
  updateAllObsButtons();
}

async function setSourceVisibility(sourceName, visible) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn(`setSourceVisibility for ${sourceName}: OBS not connected.`);
    return;
  }
  if (sourceIds[sourceName] === undefined) {
    console.error(
      `Source "${sourceName}" not found or ID not fetched. Cannot set visibility.`
    );
    return;
  }

  sourceState[sourceName] = visible;
  updateAllObsButtons();
  enforceSingleSourceVisibility(sourceName);

  console.log(
    `Sending OBS command: Set source '${sourceName}' (ID: ${sourceIds[sourceName]}) visibility to ${visible}`
  );
  socket.send(
    JSON.stringify({
      op: 6,
      d: {
        requestType: "SetSceneItemEnabled",
        requestId: `set${sourceName.replace(/\s/g, "")}Visibility`,
        requestData: {
          sceneName: SCENE_NAME,
          sceneItemId: sourceIds[sourceName],
          sceneItemEnabled: visible,
        },
      },
    })
  ); // --- Player Control Logic based on visibility ---

  if (sourceName === "Loop Player") {
    if (visible) {
      loadSavedLoopPlaylistBtn.click();
      loopPlayerStatus.textContent = "Loop Player Active";
    } else {
      sendPlayerCommand("loopPlayerCommand", "pause");
      loopPlayerStatus.textContent = "Loop Player Paused";
      isLoopPlaying = false;
      isLoopStopped = false;
      updateButtonAppearance(
        togglePlayPauseLoopBtn,
        isLoopPlaying,
        "Playing",
        "Paused"
      );
      updateStopButtonAppearance(stopLoopVideoBtn, isLoopStopped);
      savePlayerState("loop");
    }
  } else if (sourceName === "Live Player") {
    if (visible) {
      const videoId = liveVideoIdInput.value.trim();
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
        savePlayerState("live");
        sendPlayerCommand("livePlayerCommand", "unmute");
      } else {
        console.warn(
          `Failed to fetch title for active Live Player video ID: ${videoId}. Loading default video.`
        );
        liveVideoIdInput.value = DEFAULT_LIVE_VIDEO_ID;
        sendPlayerCommand(
          "livePlayerCommand",
          "loadVideo",
          DEFAULT_LIVE_VIDEO_ID
        );
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
        savePlayerState("live");
        sendPlayerCommand("livePlayerCommand", "unmute");
      }
    } else {
      sendPlayerCommand("livePlayerCommand", "pause");
      livePlayerStatus.textContent = "Live Player Paused";
      isLivePlaying = false;
      isLiveStopped = false;
      updateButtonAppearance(
        togglePlayPauseLiveBtn,
        isLivePlaying,
        "Playing",
        "Paused"
      );
      updateStopButtonAppearance(stopLiveVideoBtn, isLiveStopped);
      savePlayerState("live");
    }
  } else if (sourceName === "Delay Live") {
    if (visible) {
      loadDelayVideoBtn.click();
      delayPlayerStatus.textContent = "Delay Live Player Active";
    } else {
      sendPlayerCommand("delayLivePlayerCommand", "pause");
      delayPlayerStatus.textContent = "Delay Live Player Paused";
      isDelayPlaying = false;
      isDelayStopped = false;
      updateButtonAppearance(
        togglePlayPauseDelayBtn,
        isDelayPlaying,
        "Playing",
        "Paused"
      );
      updateStopButtonAppearance(stopDelayVideoBtn, isDelayStopped);
      savePlayerState("delay");
    }
  } else if (sourceName === "OrdaChesta") {
    if (visible) {
      console.log("OrdaChesta source is now visible.");
    } else {
      console.log("OrdaChesta source is now hidden.");
    }
  } else if (sourceName === "Local Player") {
    if (visible) {
      loadLocalPCVideoBtn.click();
      localPCPlayerStatus.textContent = "Local Player Active";
    } else {
      sendPlayerCommand("localPCPlayerCommand", "pause");
      localPCPlayerStatus.textContent = "Local Player Paused";
      isLocalPCPlaying = false;
      isLocalPCStopped = false;
      updateButtonAppearance(
        togglePlayPauseLocalPCBtn,
        isLocalPCPlaying,
        "Playing",
        "Paused"
      );
      updateStopButtonAppearance(stopLocalPCVideoBtn, isLocalPCStopped);
      savePlayerState("localPC");
    }
  }
}

function updateAllObsButtons() {
  if (sourceState["Live Player"]) {
    updateLiveLoopButton("on-live");
  } else if (sourceState["Loop Player"]) {
    updateLiveLoopButton("on-loop");
  } else {
    updateLiveLoopButton("off");
  }
  const delayLiveBtn = document.getElementById("btnDelayLive");
  delayLiveBtn.className =
    "toggle-btn " + (sourceState["Delay Live"] ? "on-delaylive" : "off");
  delayLiveBtn.textContent =
    "Delay Live: " + (sourceState["Delay Live"] ? "On" : "Off");
  const ordaBtn = document.getElementById("btnOrdaChesta");
  ordaBtn.className =
    "toggle-btn " + (sourceState.OrdaChesta ? "on-orda" : "off");
  ordaBtn.textContent =
    "OrdaChesta: " + (sourceState.OrdaChesta ? "On" : "Off");
  const localPlayerBtn = document.getElementById("btnLocalPlayer");
  localPlayerBtn.className =
    "toggle-btn " + (sourceState["Local Player"] ? "on-orda" : "off");
  localPlayerBtn.textContent =
    "Local Player: " + (sourceState["Local Player"] ? "On" : "Off");
}

function toggleStream() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn("OBS not connected. Cannot toggle stream.");
    return;
  }
  const requestType = streamActive ? "StopStream" : "StartStream";
  socket.send(
    JSON.stringify({
      op: 6,
      d: { requestType, requestId: "toggleStream" },
    })
  );
}

function updateStreamButton() {
  const btn = document.getElementById("btnStream");
  btn.className = "toggle-btn " + (streamActive ? "on-stream" : "off");
  btn.textContent = streamActive ? "Stop Stream" : "Start Stream";
}

function toggleRecord() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn("OBS not connected. Cannot toggle record.");
    return;
  }
  const requestType = recordActive ? "StopRecord" : "StartRecord";
  socket.send(
    JSON.stringify({
      op: 6,
      d: { requestType, requestId: "toggleRecord" },
    })
  );
}

function updateRecordButton() {
  const btn = document.getElementById("btnRecord");
  btn.className = "toggle-btn " + (recordActive ? "on-record" : "off");
  btn.textContent = recordActive ? "Stop Record" : "Start Record";
}

function toggleVirtualCam() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn("OBS not connected. Cannot toggle virtual cam.");
    return;
  }
  const requestType = virtualCamActive ? "StopVirtualCam" : "StartVirtualCam";
  socket.send(
    JSON.stringify({
      op: 6,
      d: { requestType, requestId: "toggleVirtualCam" },
    })
  );
}

// --- CORRECTED SOLUTION: This function now correctly handles initial page load ---
function updateVirtualCamButton() {
  const btn = document.getElementById("btnVirtualCam");
  btn.className = "toggle-btn " + (virtualCamActive ? "on-virtualcam" : "off");
  btn.textContent = virtualCamActive ? "Stop Virtual Cam" : "Start Virtual Cam";

  const obsStateHasChanged = virtualCamActive !== lastVirtualCamActiveState;
  // This block now ONLY handles the camera being turned OFF in OBS.
  if (
    obsStateHasChanged &&
    !virtualCamActive &&
    virtualCamVideoElement.srcObject
  ) {
    // Stop the preview if the main OBS virtual camera is turned off.
    virtualCamVideoElement.srcObject
      .getTracks()
      .forEach((track) => track.stop());
    virtualCamVideoElement.srcObject = null;
    btnObsLive.className = "toggle-btn off";
    btnObsLive.textContent = "Show Preview"; // Update text
    isPreviewManuallyStopped = true; // Set flag since it's now off
    localStorage.setItem(OBS_PREVIEW_STOPPED_KEY, "true"); // Save this state
  } // This automatic check runs every second via the polling mechanism. // It will now correctly respect the isPreviewManuallyStopped flag that was

  // loaded from localStorage on page refresh.
  if (
    virtualCamActive &&
    !virtualCamVideoElement.srcObject &&
    !isPreviewManuallyStopped
  ) {
    tryDisplayVirtualCam();
  }

  lastVirtualCamActiveState = virtualCamActive;
}

function getStreamStatus() {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return reject("OBS not connected.");
    const requestId = "getStreamStatus" + Date.now();
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.op === 7 && msg.d.requestId === requestId) {
        socket.removeEventListener("message", handler);
        if (msg.d.requestStatus.result) {
          streamActive = msg.d.responseData.outputActive;
          updateStreamButton();
          resolve(streamActive);
        } else {
          reject(msg.d.requestStatus.comment);
        }
      }
    };
    socket.addEventListener("message", handler);
    socket.send(
      JSON.stringify({
        op: 6,
        d: { requestType: "GetStreamStatus", requestId: requestId },
      })
    );
  });
}

function getRecordStatus() {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return reject("OBS not connected.");
    const requestId = "getRecordStatus" + Date.now();
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.op === 7 && msg.d.requestId === requestId) {
        socket.removeEventListener("message", handler);
        if (msg.d.requestStatus.result) {
          recordActive = msg.d.responseData.outputActive;
          updateRecordButton();
          resolve(recordActive);
        } else {
          reject(msg.d.requestStatus.comment);
        }
      }
    };
    socket.addEventListener("message", handler);
    socket.send(
      JSON.stringify({
        op: 6,
        d: { requestType: "GetRecordStatus", requestId: requestId },
      })
    );
  });
}

function getVirtualCamStatus() {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return reject("OBS not connected.");
    const requestId = "getVirtualCamStatus" + Date.now();
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.op === 7 && msg.d.requestId === requestId) {
        socket.removeEventListener("message", handler);
        if (msg.d.requestStatus.result) {
          virtualCamActive = msg.d.responseData.outputActive;
          updateVirtualCamButton();
          resolve(virtualCamActive);
        } else {
          reject(msg.d.requestStatus.comment);
        }
      }
    };
    socket.addEventListener("message", handler);
    socket.send(
      JSON.stringify({
        op: 6,
        d: { requestType: "GetVirtualCamStatus", requestId: requestId },
      })
    );
  });
}

async function tryDisplayVirtualCam() {
  if (virtualCamVideoElement.srcObject) {
    virtualCamVideoElement.srcObject
      .getTracks()
      .forEach((track) => track.stop());
    virtualCamVideoElement.srcObject = null;
  }
  virtualCamErrorMessage.textContent = "";

  if (!virtualCamActive) {
    virtualCamErrorMessage.textContent = "OBS Virtual Camera is OFF.";
    btnObsLive.className = "toggle-btn off";
    btnObsLive.textContent = "Show Preview"; // Update text
    return;
  }

  try {
    virtualCamErrorMessage.textContent =
      "Attempting to load OBS Virtual Camera...";
    const devices = await navigator.mediaDevices.enumerateDevices();
    const obsVirtualCamera = devices.find(
      (device) =>
        device.kind === "videoinput" &&
        device.label.includes("OBS Virtual Camera")
    );

    if (obsVirtualCamera) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: obsVirtualCamera.deviceId },
          width: { ideal: 280 },
          height: { ideal: 157.5 },
        },
        audio: false,
      });
      virtualCamVideoElement.srcObject = stream;
      virtualCamErrorMessage.textContent = "";
      btnObsLive.className = "toggle-btn on-obs-live";
      btnObsLive.textContent = "Hide Preview"; // Update text on success
      isPreviewManuallyStopped = false; // Successfully displayed, so clear the flag
    } else {
      virtualCamErrorMessage.textContent =
        'OBS Virtual Camera not found. Is it "Started" in OBS?';
      btnObsLive.className = "toggle-btn off";
      btnObsLive.textContent = "Show Preview"; // Update text on failure
    }
  } catch (err) {
    console.error("Error accessing Virtual Camera:", err);
    virtualCamVideoElement.srcObject = null;
    btnObsLive.className = "toggle-btn off";
    btnObsLive.textContent = "Show Preview"; // Update text on error
    if (err.name === "NotAllowedError") {
      virtualCamErrorMessage.textContent =
        "Camera access denied. Please grant permission.";
    } else if (err.name === "NotFoundError") {
      virtualCamErrorMessage.textContent =
        "No suitable camera found. Ensure OBS Virtual Camera is started.";
    } else {
      virtualCamErrorMessage.textContent = `Error: ${err.message}.`;
    }
  }
}

function getSceneItems() {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return reject("OBS not connected.");
    const requestId = "getSceneItems" + Date.now();
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.op === 7 && msg.d.requestId === requestId) {
        socket.removeEventListener("message", handler);
        if (msg.d.requestStatus.result) {
          const items = msg.d.responseData.sceneItems;
          for (const item of items) {
            const name = item.sourceName;
            if (sourceNames.includes(name)) {
              sourceState[name] = item.sceneItemEnabled;
              sourceIds[name] = item.sceneItemId;
            }
          }
          updateAllObsButtons();
          resolve(sourceState);
        } else {
          reject(msg.d.requestStatus.comment);
        }
      }
    };
    socket.addEventListener("message", handler);
    socket.send(
      JSON.stringify({
        op: 6,
        d: {
          requestType: "GetSceneItemList",
          requestId: requestId,
          requestData: { sceneName: SCENE_NAME },
        },
      })
    );
  });
}

function updateLiveLoopButton(state) {
  const btn = document.getElementById("btnLiveLoop");
  btn.className = "toggle-btn " + state;
  btn.textContent =
    "Live/Loop: " +
    (state === "on-live" ? "Live" : state === "on-loop" ? "Loop" : "Off");
}

function toggleLiveLoop() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn("OBS not connected. Cannot toggle Live/Loop.");
    return;
  }
  const isLiveActive = sourceState["Live Player"];
  const isLoopActive = sourceState["Loop Player"];

  if (isLiveActive) {
    setSourceVisibility("Loop Player", true);
  } else if (isLoopActive) {
    setSourceVisibility("Live Player", true);
  } else {
    setSourceVisibility("Loop Player", true);
  }
}

function toggleExclusive(source) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn("OBS not connected. Cannot toggle Exclusive source.");
    return;
  }
  const newState = !sourceState[source];
  setSourceVisibility(source, newState);
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
      "Upcoming Event Monitor is Offfff",
      upcomingStartTimeDisplay
    );
  }
}
