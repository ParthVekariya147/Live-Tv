// Utility and helper functions extracted from script.js
// These functions are globally accessible

const PLAYER_EVENT_KEY = "loopPlayerEvent"; // Key for events from player to controller
const DELAY_PLAYER_EVENT_KEY = "delayLivePlayerEvent"; // Key for events from delay player to controller
const LOCAL_PLAYER_EVENT_KEY = "localPCPlayerEvent"; // NEW: Key for events from local player to controller
const LIVE_PLAYER_EVENT_KEY = "livePlayerEvent"; // NEW: Key for events from local player to controller
const allowedChannels = ["Swaminarayan Bhagwan 1", "Swaminarayan", "Swaminarayan Bhagwan"];

const titleEl = document.getElementById("title");
// --- Time Conversion Helper ---
function timeToSeconds(timeString) {
  if (!timeString || typeof timeString !== "string") {
    return null;
  }
  const parts = timeString.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    // HH:MM:SS
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    // SS
    seconds = parts[0];
  } else {
    return null; // Invalid format
  }
  return seconds;
}

function secondsToHMS(totalSeconds) {
  // 1. Input Validation: Keep the robust check for invalid inputs.
  if (totalSeconds === null || isNaN(totalSeconds) || totalSeconds < 0) {
    return "";
  }

  // Ensure we are working with an integer for calculations
  const totalIntegerSeconds = Math.floor(totalSeconds);

  // 2. Calculations: These remain the same.
  const hours = Math.floor(totalIntegerSeconds / 3600);
  const minutes = Math.floor((totalIntegerSeconds % 3600) / 60);
  // 3. The Fix: The seconds calculation now also uses Math.floor to get an integer.
  const seconds = totalIntegerSeconds % 60;

  // Helper function for padding numbers with a leading zero if needed.
  const pad = (num) => String(num).padStart(2, "0");

  // 4. Formatting: The logic is sound, but can be slightly cleaner.
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  } else {
    return `${pad(minutes)}:${pad(seconds)}`;
  }
}

function getCurrentDateTimeFormatted() {
  const now = new Date();
  const month = (now.getMonth() + 1).toString(); // Month is 0-indexed
  const day = now.getDate().toString();
  const year = now.getFullYear();
  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12; // the hour '0' should be '12'
  return `${month}/${day}/${year}, ${hours}:${minutes}:${seconds} ${ampm}`;
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return "N/A";
  }
  let stringValue = String(value);
  if (
    stringValue.includes(",") ||
    stringValue.includes('"') ||
    stringValue.includes("\n")
  ) {
    stringValue = stringValue.replace(/"/g, '""');
    return `"${stringValue}"`;
  }
  return stringValue;
}

function copyToClipboard(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
    console.log(`Copied to clipboard: ${text}`);
  } catch (err) {
    console.error("Failed to copy to clipboard:", err);
  }
  document.body.removeChild(textarea);
}

// Date formatting for Katha Monitor
const formatDateToDDMMMYYYY = (date) => {
  const day = String(date.getDate()).padStart(2, "0");
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  return `${day} ${month} ${year}`;
};

/**
 * Extracts and parses the ytInitialData JSON object from HTML text.
 * @param {string} htmlText - The HTML content as a string.
 * @returns {object} - The parsed ytInitialData object.
 * @throws {Error} If ytInitialData cannot be found or parsed.
 */
function parseYtInitialData(htmlText) {
  // console.log("[Parse] Attempting to parse ytInitialData...");
  // Regex to find ytInitialData, handling 'var ytInitialData =' and 'window["ytInitialData"] ='
  const ytInitialDataRegex =
    /(?:var|window\["|)ytInitialData(?:\]|) = ({.*?});/s;
  const match = htmlText.match(ytInitialDataRegex);

  if (match && match[1]) {
    try {
      return JSON.parse(match[1]);
    } catch (jsonError) {
      console.error("Failed to parse ytInitialData JSON:", jsonError);
      // Fallback: try to find a more generic JSON-like structure if ytInitialData fails
      const fallbackRegex =
        /"videoRenderer":({[^}]*?(?:title|descriptionSnippet|publishedTimeText|lengthText|viewCountText|navigationEndpoint)[^}]*?webCommandMetadata[^}]*?})/g;
      let fallbackMatches;
      const potentialVideos = [];
      while ((fallbackMatches = fallbackRegex.exec(htmlText)) !== null) {
        try {
          // Attempt to parse each potential video renderer
          const videoObj = JSON.parse(fallbackMatches[1]);
          potentialVideos.push({ videoRenderer: videoObj });
        } catch (e) {
          // Ignore malformed JSON snippets
        }
      }
      if (potentialVideos.length > 0) {
        // Reconstruct a minimal ytInitialData structure for fallback
        return {
          contents: {
            twoColumnBrowseResultsRenderer: {
              tabs: [
                {
                  tabRenderer: {
                    content: {
                      sectionListRenderer: {
                        contents: [
                          {
                            itemSectionRenderer: {
                              contents: potentialVideos,
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        };
      } else {
        throw new Error(
          "Could not find or parse ytInitialData or fallback video data."
        );
      }
    }
  } else {
    throw new Error("ytInitialData not found in the HTML content.");
  }
}

// --- Player Control Functions using localStorage ---
// Added videoPath parameter for local player
function sendPlayerCommand(
  playerKey,
  command,
  videoId = null,
  startSeconds = null,
  endSeconds = null,
  videoPath = null
) {
  const commandData = { command: command };
  if (videoId) {
    commandData.videoId = videoId;
  }
  // Always include startSeconds and endSeconds, defaulting to 0 if null
  commandData.startSeconds = startSeconds !== null ? startSeconds : 0;
  commandData.endSeconds = endSeconds !== null ? endSeconds : 0;

  // NEW: Include videoPath for local player
  if (videoPath) {
    commandData.videoPath = videoPath;
  }

  localStorage.setItem(playerKey, JSON.stringify(commandData));
  // Clear the item after a short delay to ensure the 'storage' event fires cleanly
  setTimeout(() => {
    localStorage.removeItem(playerKey);
  }, 100);
}

function savePlayerState(playerPrefix) {
  // Get common player states
  const isPlaying =
    window[
      `is${playerPrefix.charAt(0).toUpperCase() + playerPrefix.slice(1)}Playing`
    ];
  const isMuted =
    window[
      `is${playerPrefix.charAt(0).toUpperCase() + playerPrefix.slice(1)}Muted`
    ];
  const isStopped =
    window[
      `is${playerPrefix.charAt(0).toUpperCase() + playerPrefix.slice(1)}Stopped`
    ];

  let playerState = {
    isPlaying: isPlaying,
    isMuted: isMuted,
    isStopped: isStopped,
  };

  // Player-specific data
  if (playerPrefix === "loop") {
    playerState.videoId = loopPlaylist[currentLoopIndex] || ""; // Save current video ID
    playerState.playlist = loopPlaylist;
    playerState.currentIndex = currentLoopIndex;
  } else if (playerPrefix === "live") {
    playerState.videoId = document.getElementById(
      `${playerPrefix}VideoId`
    ).value;
  } else if (playerPrefix === "delay") {
    playerState.videoId = document.getElementById(
      `${playerPrefix}VideoId`
    ).value;
    playerState.startTime = delayStartTimeInput.value; // Save time strings directly
    playerState.endTime = delayEndTimeInput.value; // Save time strings directly
  } else if (playerPrefix === "localPC") {
    // Save state for Local PC Player (single video)
    playerState.playlist = localPCPlaylist; // Save the entire playlist
    playerState.currentIndex = currentLocalPCIndex; // Save current index
    playerState.endActions = localPCDayEndActions; // Save end actions
  }
  localStorage.setItem(
    `${playerPrefix}PlayerState`,
    JSON.stringify(playerState)
  );
}

function loadPlayerState(playerPrefix) {
  const savedState = localStorage.getItem(`${playerPrefix}PlayerState`);
  if (savedState) {
    try {
      const playerState = JSON.parse(savedState);
      // Set common player states
      window[
        `is${
          playerPrefix.charAt(0).toUpperCase() + playerPrefix.slice(1)
        }Playing`
      ] = playerState.isPlaying;
      window[
        `is${playerPrefix.charAt(0).toUpperCase() + playerPrefix.slice(1)}Muted`
      ] = playerState.isMuted;
      window[
        `is${
          playerPrefix.charAt(0).toUpperCase() + playerPrefix.slice(1)
        }Stopped`
      ] = playerState.isStopped;

      // Player-specific loading
      if (playerPrefix === "loop") {
        loopPlaylist = playerState.playlist || [];
        currentLoopIndex = playerState.currentIndex || 0;
        // Ensure loopVideoIdInput reflects the current video in playlist
        if (loopPlaylist.length > 0 && loopPlaylist[currentLoopIndex]) {
          loopVideoIdInput.value = loopPlaylist.join(","); // Display full playlist
          fetchVideoInfo(
            loopPlaylist[currentLoopIndex],
            loopVideoThumbnail,
            loopVideoTitle,
            loopCurrentVideoInfo,
            currentLoopIndex,
            loopPlaylist.length
          );
        } else {
          fetchVideoInfo(
            "",
            loopVideoThumbnail,
            loopVideoTitle,
            loopCurrentVideoInfo
          ); // Clear if no valid video
        }
      } else if (playerPrefix === "live") {
        document.getElementById(`${playerPrefix}VideoId`).value =
          playerState.videoId || "";
        fetchVideoInfo(playerState.videoId, liveVideoThumbnail, liveVideoTitle);
      } else if (playerPrefix === "delay") {
        document.getElementById(`${playerPrefix}VideoId`).value =
          playerState.videoId || "";
        delayStartTimeInput.value = playerState.startTime || ""; // Load saved time string
        delayEndTimeInput.value = playerState.endTime || ""; // Load saved time string
        fetchVideoInfo(
          playerState.videoId,
          delayVideoThumbnail,
          delayVideoTitle
        );
      } else if (playerPrefix === "localPC") {
        // Load state for Local PC Player (single video)
        localPCPlaylist = playerState.playlist || [];
        currentLocalPCIndex = playerState.currentIndex || 0;
        localPCDayEndActions = playerState.endActions || localPCDayEndActions; // Load end actions, default if not found
        renderLocalPCPlaylist(); // Re-render the playlist UI
        renderLocalPCEndActions(); // Re-render end actions UI

        if (
          localPCPlaylist.length > 0 &&
          localPCPlaylist[currentLocalPCIndex]
        ) {
          fetchVideoInfo(
            localPCPlaylist[currentLocalPCIndex].path,
            null,
            localPCVideoTitle,
            localPCCurrentVideoInfo,
            currentLocalPCIndex,
            localPCPlaylist.length
          );
        } else {
          fetchVideoInfo("", null, localPCVideoTitle, localPCCurrentVideoInfo); // Clear if no valid video
        }
      }

      // Update status message based on loaded state
      const statusElement = document.getElementById(
        `${playerPrefix}PlayerStatus`
      );
      if (statusElement) {
        // Ensure element exists before updating
        if (playerState.isStopped) {
          statusElement.textContent = "Stopped";
        } else if (playerState.isPlaying) {
          statusElement.textContent = "Playing.";
        } else {
          statusElement.textContent = "Paused";
        }
      }
    } catch (e) {
      console.error(`Error parsing saved state for ${playerPrefix} player:`, e);
      // Clear corrupted data
      localStorage.removeItem(`${playerPrefix}PlayerState`);
    }
  } else {
    // If no saved state, ensure thumbnails and titles are reset
    if (playerPrefix === "loop") {
      fetchVideoInfo(
        "",
        loopVideoThumbnail,
        loopVideoTitle,
        loopCurrentVideoInfo
      );
    } else if (playerPrefix === "live") {
      fetchVideoInfo("", liveVideoThumbnail, liveVideoTitle);
    } else if (playerPrefix === "delay") {
      fetchVideoInfo("", delayVideoThumbnail, delayVideoTitle);
    } else if (playerPrefix === "localPC") {
      // Reset for Local PC Player (single video)
      fetchVideoInfo("", null, localPCVideoTitle, localPCCurrentVideoInfo);
      renderLocalPCPlaylist(); // Ensure empty playlist is rendered
      renderLocalPCEndActions(); // Ensure default end actions are rendered
    }
  }
}

// --- Video Info Fetching (Thumbnail & Title) ---
// This function is now also used for Local PC Player, but with simplified logic for local files.
async function fetchVideoInfo(
  videoIdOrPath,
  thumbnailElement,
  titleElement,
  infoElement = null,
  currentIndex = null,
  totalVideos = null
) {
  // Check if this is a local file path (heuristic: starts with C:\ or /home/user/ or similar)
  const isLocalPath =
    videoIdOrPath &&
    (videoIdOrPath.startsWith("C:\\") ||
      videoIdOrPath.startsWith("/") ||
      videoIdOrPath.includes(":") ||
      videoIdOrPath.startsWith("file:///"));

  if (!videoIdOrPath) {
    if (thumbnailElement) {
      // Only set if thumbnail element exists
      thumbnailElement.src = "https://placehold.co/300x170?text=No+Video";
    }
    titleElement.textContent = "No video loaded";
    if (infoElement) infoElement.textContent = "";
    return false; // Indicate failure or no video ID
  }

  if (isLocalPath) {
    // For local files, display the filename as the title and use a generic thumbnail
    const filename = videoIdOrPath.split("\\").pop().split("/").pop(); // Extract filename from path
    titleElement.textContent = filename;
    // No thumbnail for local PC player, so no need to set thumbnailElement.src
    if (infoElement) {
      if (currentIndex !== null && totalVideos !== null) {
        infoElement.textContent = `Video ${currentIndex + 1} of ${totalVideos}`;
      } else {
        infoElement.textContent = ""; // No index/playlist info for single local video
      }
    }
    return true; // Indicate success for local files as we can display the path
  }

  // YouTube Thumbnail URL (high quality)
  if (thumbnailElement) {
    // Only set if thumbnail element exists
    thumbnailElement.src = `https://i.ytimg.com/vi/${videoIdOrPath}/hqdefault.jpg`;
    thumbnailElement.onerror = () => {
      thumbnailElement.src =
        "https://placehold.co/300x170?text=Thumbnail+Error";
    };
  }

  // Fetch video title using oEmbed endpoint
  // NOTE: The following oEmbed URL is a placeholder. For real functionality,
  // you would need a valid YouTube Data API key and endpoint.
  const oEmbedUrl = `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${videoIdOrPath}&format=json`; // Corrected YouTube oEmbed URL
  try {
    const response = await fetch(oEmbedUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (data.title) {
      titleElement.textContent = data.title;
      if (infoElement) {
        infoElement.textContent = `Video ID: ${videoIdOrPath} (Index: ${currentLoopIndex}/${loopPlaylist.length})`;
      }
      return true; // Indicate success
    } else {
      titleElement.textContent = "Title not found";
      return false; // Indicate title not found
    }
  } catch (error) {
    console.error("Error fetching video title:", error);
    titleElement.textContent = "Title unavailable";
    return false; // Indicate fetch error
  }
}

// Helper to update button class based on state (true for active/blue, false for inactive/red)
function updateButtonAppearance(button, isActive, activeText, inactiveText) {
  button.classList.remove("btn-success", "btn-danger", "btn-neutral"); // Remove all color classes
  if (isActive) {
    button.textContent = activeText;
    button.classList.add("btn-success"); // Green
  } else {
    button.textContent = inactiveText;
    button.classList.add("btn-danger"); // Red
  }
}

function updateStopButtonAppearance(button, isStopped) {
  button.classList.remove("btn-success", "btn-danger", "btn-neutral"); // Remove all color classes
  if (isStopped) {
    button.classList.add("btn-danger"); // Red
  } else {
    button.classList.add("btn-neutral"); // Gray
  }
}

/**
 * Verifies an array of events by checking the video's channel name via the oEmbed API.
 * @param {Array<Object>} events - An array of event objects to verify (must contain a videoId).
 * @param {Array<string>} allowedChannels - An array of channel names to allow.
 * @returns {Promise<Array<Object>>} - A promise that resolves to a new, filtered array of events.
 */
async function verifyAndFilterByChannelName(events, allowedChannels) {
  if (!events || events.length === 0) {
    return [];
  }

  const verificationPromises = events.map(async (event) => {
    if (!event.videoId) {
      return null;
    }

    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${event.videoId}&format=json`;
      const oembedResponse = await fetch(oembedUrl);

      if (!oembedResponse.ok) {
        console.warn(
          `oEmbed check failed for videoId ${event.videoId}: Status ${oembedResponse.status}`
        );
        return null;
      }

      const oembedData = await oembedResponse.json();
      // console.log("oembedData", oembedData);
      const authorName = oembedData.author_name;

      // If the channel name is in our allowed list, keep the event
      if (allowedChannels.includes(authorName) && oembedData.title) {
        return event;
      } else {
        // console.log(
        //   `Filtering out video from unverified channel: "${authorName}"`
        // );
        return null;
      }
    } catch (error) {
      console.error(
        `Error during oEmbed verification for videoId ${event.videoId}:`,
        error
      );
      return null;
    }
  });

  const verifiedEvents = await Promise.all(verificationPromises);
  return verifiedEvents.filter(Boolean); // Filter out any nulls from failed or non-matching checks
}
