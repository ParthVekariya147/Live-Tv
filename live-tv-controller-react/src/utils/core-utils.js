
export const PLAYER_EVENT_KEY = "loopPlayerEvent";
export const DELAY_PLAYER_EVENT_KEY = "delayLivePlayerEvent";
export const LOCAL_PLAYER_EVENT_KEY = "localPCPlayerEvent";
export const LIVE_PLAYER_EVENT_KEY = "livePlayerEvent";
export const ALLOWED_CHANNELS = ["Swaminarayan Bhagwan 1", "Swaminarayan", "Swaminarayan Bhagwan"];

// --- Time Conversion Helper ---
export function timeToSeconds(timeString) {
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

export function secondsToHMS(totalSeconds) {
    if (totalSeconds === null || isNaN(totalSeconds) || totalSeconds < 0) {
        return "";
    }

    const totalIntegerSeconds = Math.floor(totalSeconds);
    const hours = Math.floor(totalIntegerSeconds / 3600);
    const minutes = Math.floor((totalIntegerSeconds % 3600) / 60);
    const seconds = totalIntegerSeconds % 60;

    const pad = (num) => String(num).padStart(2, "0");

    if (hours > 0) {
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    } else {
        return `${pad(minutes)}:${pad(seconds)}`;
    }
}

export function getCurrentDateTimeFormatted() {
    const now = new Date();
    const month = (now.getMonth() + 1).toString();
    const day = now.getDate().toString();
    const year = now.getFullYear();
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const seconds = now.getSeconds().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${month}/${day}/${year}, ${hours}:${minutes}:${seconds} ${ampm}`;
}

export function escapeCsvValue(value) {
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

export function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            console.log(`Copied to clipboard: ${text}`);
        }).catch(err => {
            console.error("Failed to copy to clipboard:", err);
        });
    } else {
        // Fallback
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
}

export const formatDateToDDMMMYYYY = (date) => {
    const day = String(date.getDate()).padStart(2, "0");
    const monthNames = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
};

export function parseYtInitialData(htmlText) {
    if (!htmlText || htmlText.length === 0) {
        throw new Error("HTML text is empty");
    }

    // Try multiple regex patterns for finding ytInitialData
    const patterns = [
        /(?:var|window\["|)ytInitialData(?:\]|) = ({.*?});/s,
        /ytInitialData\s*=\s*({.*?});/s,
        /(?:window\.)?ytInitialData\s*=\s*({[\s\S]*?^})/m,
    ];

    for (const pattern of patterns) {
        const match = htmlText.match(pattern);
        if (match && match[1]) {
            try {
                return JSON.parse(match[1]);
            } catch (jsonError) {
                console.warn("Pattern matched but JSON parse failed, trying next pattern...");
                continue;
            }
        }
    }

    // If no pattern matched or JSON parse failed, try fallback extraction
    console.warn("No ytInitialData found using standard patterns, attempting deep video extraction...");
    
    // Try to extract video data directly using multiple strategies
    const fallbackStrategies = [
        // Strategy 1: Look for video renderers with complete data
        /"videoRenderer":\{(?:[^{}]|(?:\{[^{}]*\}))*?"title":\{[^}]*?"runs":\[\{[^}]*?"text":/g,
        // Strategy 2: Extract complete objects that look like videos
        /"videoRenderer":\{[\s\S]*?"videoId":"[^"]+"/g,
    ];

    for (const regex of fallbackStrategies) {
        const matches = htmlText.match(regex);
        if (matches && matches.length > 0) {
            console.log(`Found ${matches.length} potential video items using fallback strategy`);
            // Try to construct a minimal valid response
            const potentialVideos = extractVideosFromHtmlDeeply(htmlText);
            if (potentialVideos.length > 0) {
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
            }
        }
    }

    // Last resort: try to find any JSON object that looks like video data
    throw new Error("Could not find or parse ytInitialData - HTML structure may have changed or response is invalid");
}

// Helper function to extract videos deeply from HTML
function extractVideosFromHtmlDeeply(htmlText) {
    const videoPatterns = [
        /"videoRenderer":\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g,
    ];
    
    const videos = [];
    for (const pattern of videoPatterns) {
        let match;
        const regex = new RegExp(pattern);
        while ((match = regex.exec(htmlText)) !== null) {
            try {
                const videoObj = JSON.parse('{' + match[1] + '}');
                if (videoObj.videoId && videoObj.title) {
                    videos.push({ videoRenderer: videoObj });
                }
            } catch (e) {
                // Skip malformed JSON
            }
        }
    }
    return videos;
}

export function sendPlayerCommand(
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
    commandData.startSeconds = startSeconds !== null ? startSeconds : 0;
    commandData.endSeconds = endSeconds !== null ? endSeconds : 0;

    if (videoPath) {
        commandData.videoPath = videoPath;
    }

    localStorage.setItem(playerKey, JSON.stringify(commandData));
    setTimeout(() => {
        localStorage.removeItem(playerKey);
    }, 100);
}

// Refactored to return data Promise instead of mutating DOM
export async function fetchVideoDetails(videoIdOrPath) {
    const result = {
        title: "No video loaded",
        thumbnail: "https://placehold.co/300x170?text=No+Video",
        isLocal: false,
        found: false
    };

    if (!videoIdOrPath) return result;

    const isLocalPath =
        videoIdOrPath &&
        (videoIdOrPath.startsWith("C:\\") ||
            videoIdOrPath.startsWith("/") ||
            videoIdOrPath.includes(":") ||
            videoIdOrPath.startsWith("file:///"));

    if (isLocalPath) {
        result.isLocal = true;
        result.title = videoIdOrPath.split("\\").pop().split("/").pop();
        result.found = true;
        return result;
    }

    // Set thumbnail
    result.thumbnail = `https://i.ytimg.com/vi/${videoIdOrPath}/hqdefault.jpg`;

    // Fetch Title
    const oEmbedUrl = `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${videoIdOrPath}&format=json`;
    try {
        const response = await fetch(oEmbedUrl);
        if (response.ok) {
            const data = await response.json();
            if (data.title) {
                result.title = data.title;
                result.found = true;
            } else {
                result.title = "Title not found";
            }
        } else {
            result.title = "Title unavailable";
        }
    } catch (error) {
        console.error("Error fetching video title:", error);
        result.title = "Title unavailable";
    }
    return result;
}

export async function verifyAndFilterByChannelName(events, allowedChannels) {
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
                return null;
            }

            const oembedData = await oembedResponse.json();
            const authorName = oembedData.author_name;

            if (allowedChannels.includes(authorName) && oembedData.title) {
                return event;
            } else {
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
    return verifiedEvents.filter(Boolean);
}

export async function fetchHtml(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error("fetchHtml failed:", error);
        throw error;
    }
}

/**
 * Normalize a lockupViewModel item (new YouTube format) into the legacy videoRenderer shape
 * so the rest of the codebase can process it without changes.
 */
function normalizeLockupViewModelItem(lvm) {
    const videoId = lvm.contentId;
    const title = lvm.metadata?.lockupMetadataViewModel?.title?.content || 'No Title';
    const thumbnailSources = lvm.contentImage?.thumbnailViewModel?.image?.sources || [];
    const thumbnailUrl = thumbnailSources[thumbnailSources.length - 1]?.url ||
        thumbnailSources[0]?.url ||
        `https://placehold.co/320x180/cccccc/333333?text=No+Image`;

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

    // Try to extract scheduled start time from metadata rows
    // YouTube returns text like "Planifié pour le 13/05/2026 17:15"
    if (isUpcoming) {
        const rows = lvm.metadata?.lockupMetadataViewModel?.metadata
            ?.contentMetadataViewModel?.metadataRows || [];
        for (const row of rows) {
            for (const part of (row.metadataParts || [])) {
                const content = part?.text?.content || '';
                // Match various date formats: DD/MM/YYYY HH:MM or similar
                const dateMatch = content.match(
                    /(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[\s,]+|T)(\d{1,2}):(\d{2})/
                );
                if (dateMatch) {
                    const [, dayOrMonth, monthOrDay, year, hour, minute] = dateMatch;
                    // European format: DD/MM/YYYY
                    const parsed = new Date(`${year}-${monthOrDay.padStart(2,'0')}-${dayOrMonth.padStart(2,'0')}T${hour.padStart(2,'0')}:${minute}:00`);
                    if (!isNaN(parsed.getTime())) {
                        startTime = parsed;
                    }
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

export function extractVideoItems(ytInitialData) {
    const contents =
        ytInitialData?.contents?.twoColumnBrowseResultsRenderer?.tabs;
    let videoItems = [];

    if (contents) {
        // YouTube uses different tab titles depending on browser locale.
        // Support both old ("Live") and new ("En direct") titles, plus
        // the new browseEndpoint params value.
        const LIVE_TAB_TITLES = new Set(['live', 'en direct', 'en vivo', 'ao vivo', 'canlı']);
        const targetTab = contents.find(
            (tab) => {
                const title = (tab.tabRenderer?.title || '').toLowerCase();
                const params = tab.tabRenderer?.endpoint?.browseEndpoint?.params || '';
                return LIVE_TAB_TITLES.has(title) ||
                    params === 'EgZsaXZlcw%3D%3D' || // old param
                    params.startsWith('EgdzdHJlYW1z');  // new param ("streams")
            }
        );

        if (targetTab) {
            // --- New YouTube format: richGridRenderer → richItemRenderer → lockupViewModel ---
            const richGridItems =
                targetTab.tabRenderer?.content?.richGridRenderer?.contents || [];
            if (richGridItems.length > 0) {
                videoItems = richGridItems
                    .filter(item => item?.richItemRenderer?.content?.lockupViewModel)
                    .map(item => normalizeLockupViewModelItem(
                        item.richItemRenderer.content.lockupViewModel
                    ));
                console.log('[extractVideoItems] Using new lockupViewModel format, count:', videoItems.length);
                return videoItems;
            }

            // --- Old YouTube format: sectionListRenderer → itemSectionRenderer → videoRenderer ---
            const legacyItems =
                targetTab.tabRenderer?.content?.sectionListRenderer?.contents[0]
                    ?.itemSectionRenderer?.contents || [];
            if (legacyItems.length > 0) {
                console.log('[extractVideoItems] Using legacy videoRenderer format, count:', legacyItems.length);
                return legacyItems;
            }
        }

        // Fallback: deep search for any videoRenderer or lockupViewModel
        console.warn('[extractVideoItems] Tab not found or empty, doing deep search...');
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
