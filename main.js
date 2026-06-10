// main.js - Entry point for initializing all features after splitting script.js
// Assumes all split scripts are loaded before this file

document.addEventListener("DOMContentLoaded", () => {
  // Initialize player states and UI
  if (typeof loadPlayerState === "function") {
    loadPlayerState("loop");
    loadPlayerState("live");
    loadPlayerState("delay");
    loadPlayerState("localPC");
  }
  if (typeof updateButtonAppearance === "function") {
    updateButtonAppearance(
      togglePlayPauseLoopBtn,
      isLoopPlaying,
      "Playing",
      "Paused"
    );
    updateButtonAppearance(
      toggleMuteUnmuteLoopBtn,
      !isLoopMuted,
      "Unmuted",
      "Muted"
    );
    updateStopButtonAppearance(stopLoopVideoBtn, isLoopStopped);
    updateButtonAppearance(
      togglePlayPauseLiveBtn,
      isLivePlaying,
      "Playing",
      "Paused"
    );
    updateButtonAppearance(
      toggleMuteUnmuteLiveBtn,
      !isLiveMuted,
      "Unmuted",
      "Muted"
    );
    updateStopButtonAppearance(stopLiveVideoBtn, isLiveStopped);
    updateButtonAppearance(
      togglePlayPauseDelayBtn,
      isDelayPlaying,
      "Playing",
      "Paused"
    );
    updateButtonAppearance(
      toggleMuteUnmuteDelayBtn,
      !isDelayMuted,
      "Unmuted",
      "Muted"
    );
    updateStopButtonAppearance(stopDelayVideoBtn, isDelayStopped);
    updateButtonAppearance(
      togglePlayPauseLocalPCBtn,
      isLocalPCPlaying,
      "Playing",
      "Paused"
    );
    updateButtonAppearance(
      toggleMuteUnmuteLocalPCBtn,
      !isLocalPCMuted,
      "Unmuted",
      "Muted"
    );
    updateStopButtonAppearance(stopLocalPCVideoBtn, isLocalPCStopped);
  }
  // Scheduler
  if (typeof loadSchedules === "function") loadSchedules();
  if (typeof renderSchedules === "function") renderSchedules();
  if (typeof loadSchedulerState === "function") loadSchedulerState();
  if (typeof connectOBS === "function") connectOBS();
  if (
    typeof schedulerEnabled !== "undefined" &&
    schedulerEnabled &&
    typeof startScheduleChecker === "function"
  )
    startScheduleChecker();
  // Live Event Monitors
  if (typeof loadSavedSearchTitles === "function") {
    loadSavedSearchTitles(1);
    loadSavedSearchTitles(2);
  }
  if (typeof loadLiveMonitorStates === "function") loadLiveMonitorStates();
  if (typeof loadLivePlayerPriority === "function") loadLivePlayerPriority();
  if (
    (typeof liveMonitorEnabled1 !== "undefined" && liveMonitorEnabled1) ||
    (typeof liveMonitorEnabled2 !== "undefined" && liveMonitorEnabled2)
  ) {
    // Add a small delay before the initial fetch to ensure all DOM is ready
    setTimeout(() => {
      fetchLiveVideoDetails(); // Initial fetch for live video details
      if (liveDetailsPollInterval) clearInterval(liveDetailsPollInterval); // Clear any existing interval
      liveDetailsPollInterval = setInterval(
        fetchLiveVideoDetails,
        LIVE_DETAILS_POLL_INTERVAL_MS
      ); // Start polling
    }, 1000); // 1 second delay for initial fetch
  } else {
    if (typeof clearMonitorDisplay === "function") {
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
  // Katha Monitor
  if (typeof loadKathaContent === "function") loadKathaContent();
  // Katha Scheduler
  if (typeof loadKathaSchedulerState === "function") loadKathaSchedulerState();
  if (
    typeof kathaSchedulerEnabled !== "undefined" &&
    kathaSchedulerEnabled &&
    typeof startKathaScheduler === "function"
  )
    startKathaScheduler();
});

// New event listener for video ended or error event from LoopPlayer and DelayLivePlayer
window.addEventListener("storage", (event) => {
  if (event.key === PLAYER_EVENT_KEY && event.newValue) {
    // console.log("event.key", event.key);
    try {
      const data = JSON.parse(event.newValue);
      if (data.event === "timeUpdate") {
        loopVideoTime.innerHTML = `${secondsToHMS(
          data.currentTime
        )} / ${secondsToHMS(data.remainingTime)}`;
      }
      if (
        data.playerType === "loop" &&
        (data.event === "videoEnded" || data.event === "videoError")
      ) {
        console.log(
          `LoopPlayer event received: ${data.event}. Loading next video.`
        );
        // Increment index and try to load the next video
        currentLoopIndex++;
        if (currentLoopIndex < loopPlaylist.length) {
          loadAndPlayLoopVideoByIndex(currentLoopIndex);
        } else {
          // If end of playlist, loop back to start (or stop if desired)
          console.log(
            "End of loop playlist reached. Restarting from beginning."
          );
          currentLoopIndex = 0;
          loadAndPlayLoopVideoByIndex(currentLoopIndex); // Start over
        }
      }
    } catch (e) {
      console.error("Error parsing LoopPlayer event from localStorage:", e);
    }
  } else if (event.key === LIVE_PLAYER_EVENT_KEY && event.newValue) {
    // New: Handle Delay Live Player events
    try {
      const data = JSON.parse(event.newValue);
      if (data.event === "timeUpdate") {
        liveVideoTime.innerHTML = `${secondsToHMS(
          data.currentTime
        )} / ${secondsToHMS(data.remainingTime)}`;
      }
      if (data.event === "videoEnded") {
       setSourceVisibility("Live Player", false);
       setSourceVisibility("Loop Player", true);
      }
    } catch (e) {
      console.error("Error parsing LivePlayer event from localStorage:", e);
    }
  } else if (event.key === DELAY_PLAYER_EVENT_KEY && event.newValue) {
    // New: Handle Delay Live Player events
    try {
      const data = JSON.parse(event.newValue);
      if (data.event === "timeUpdate") {
        delayVideoTime.innerHTML = `${secondsToHMS(
          data.currentTime
        )} / ${secondsToHMS(data.remainingTime)}`;
      }
      if (data.playerType === "delay" && data.event === "videoEnded") {
        console.log(
          `DelayLivePlayer event received: ${data.event}. Hiding Delay Live Player.`
        );

        // 1. Pause the Delay Live video (send command to DelayLive.html)
        sendPlayerCommand("delayLivePlayerCommand", "pause");

        // 2. Hide Delay Live Player OBS source
        setSourceVisibility("Delay Live", false);

        // NEW: Only switch to Loop Player if Live Player is NOT currently visible
        if (!sourceState["Live Player"]) {
          console.log("Live Player is not active. Switching to Loop Player.");
          setSourceVisibility("Loop Player", true); // Show Loop Player OBS source
        } else {
          console.log(
            "Live Player is active. Not switching to Loop Player after Delay Live ended."
          );
        }

        // 3. Update Delay Live Player's UI status (redundant if setSourceVisibility handles it, but good for clarity)
        delayPlayerStatus.textContent = "Video Ended.";
        isDelayPlaying = false;
        isDelayStopped = true;
        updateButtonAppearance(
          togglePlayPauseDelayBtn,
          isDelayPlaying,
          "Playing",
          "Paused"
        );
        updateStopButtonAppearance(stopDelayVideoBtn, isDelayStopped);
        savePlayerState("delay"); // Save updated state
      }
    } catch (e) {
      console.error(
        "Error parsing DelayLivePlayer event from localStorage:",
        e
      );
    }
  } else if (event.key === LOCAL_PLAYER_EVENT_KEY && event.newValue) {
    // NEW: Handle Local PC Player events
    try {
      const data = JSON.parse(event.newValue);
      if (data.event === "timeUpdate") {
        // console.log("data.remainingTime", data.remainingTime);
        localPCVideoTime.innerHTML = `${secondsToHMS(
          data.currentTime
        )} / ${secondsToHMS(data.remainingTime)}`;
      }
      if (data.playerType === "local" && data.event === "videoEnded") {
        console.log(`LocalPCPlayer event received: ${data.event}.`);
        handleLocalPCVideoEnded(); // Call the new handler for local PC playlist
      } else if (data.playerType === "local" && data.event === "videoError") {
        console.error(
          `LocalPCPlayer error received: ${data.event}. Message: ${
            data.message || "N/A"
          }.`
        );
        localPCPlayerStatus.textContent = `Error: ${
          data.message || "Check console."
        }`;
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
        // Advance to next video on error, similar to videoEnded
        handleLocalPCVideoEnded();
      }
    } catch (e) {
      console.error("Error parsing LocalPCPlayer event from localStorage:", e);
    }
  }
});

const timeEl = document.getElementById("time");
const dayEl = document.getElementById("day");

function updateClock() {
  const now = new Date();

  // Time: HH:MM:SS
  const timeStr = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Day: Monday, etc.
  const dayStr = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(
    now
  );

  timeEl.textContent = timeStr;
  dayEl.textContent = dayStr;
}

updateClock();
setInterval(updateClock, 1000);
