# SMK TV — Live TV & Scene Scheduler: Full Project Report

**Generated:** 2026-06-09  
**Repository:** `live-tv-old-main`  
**Type:** Pure Frontend Browser Application (no backend)

---

## 1. What This Project Is

**SMK TV** is a browser-based live television broadcast control panel for the **Swaminarayan** religious channel. It acts as the operator's dashboard to control what OBS Studio displays on a live stream. The system manages four different video sources, monitors YouTube for live events, schedules automatic scene switches, and communicates with OBS via WebSocket — all from a single browser tab with no server required.

The name "SMK TV" appears in the UI title bar. All content filtering is locked to Swaminarayan-affiliated YouTube channels (`Swaminarayan Bhagwan 1`, `Swaminarayan`, `Swaminarayan Bhagwan`).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Browser Tab 1: index.html              │
│              (Master Controller / Dashboard)            │
│                                                         │
│  OBS Controls │ Player Cards │ Live Monitors │ Scheduler│
└────────┬──────────────┬──────────────┬──────────────────┘
         │              │ localStorage │
         │    ┌──────────┴───────────────────┐
         │    │  Inter-Window Message Bus     │
         │    │  (localStorage storage events)│
         │    └──┬───┬───┬──────┬────────────┘
         │       │   │   │      │
    OBS  │   Tab2│Tab3│Tab4│  Tab5│
  WebSocket│  Loop│Live│Delay│LocalPC│
         │  Player│Player│Player│Player│
```

**Key architectural decision:** All cross-window communication uses `localStorage` + the browser `storage` event. The controller writes a JSON command to a specific localStorage key; the target player window listens for the `storage` event on that key and executes the command. After 100ms, the key is deleted to reset state.

---

## 3. File Inventory

### Files Present in Repository

| File | Size/Role | Status |
|------|-----------|--------|
| `index.html` | Master controller UI (744 lines) | Complete |
| `core-utils.js` | Shared utility library (547 lines) | Complete |
| `LivePlayer.html` | YouTube live stream player (231 lines) | Complete |
| `DelayLive.html` | YouTube delayed/clipped player (308 lines) | Complete |
| `LoopPlayer.html` | YouTube playlist loop player (269 lines) | Complete |
| `LocalPCPlayer.html` | Local file video player (237 lines) | Complete |
| `live-tv-controller-react/` | Empty React scaffold directory | Incomplete |

### Files Referenced in `index.html` but MISSING from repo

These scripts are listed at the bottom of `index.html` but do not exist in the repository. The application **cannot run** without them.

| Missing File | Expected Role |
|--------------|--------------|
| `styles.css` | All custom CSS styling |
| `core-obs.js` | OBS WebSocket connection & control logic |
| `core-scheduler.js` | Time-based scene scheduler logic |
| `player-loop.js` | Loop player controller-side logic |
| `player-live.js` | Live player controller-side logic |
| `player-delay.js` | Delay player controller-side logic |
| `player-localpc.js` | Local PC player controller-side logic |
| `monitor-live.js` | Live event monitor scraping logic |
| `monitor-katha.js` | Katha content monitor logic |
| `main.js` | Application bootstrap & initialization |

> **Critical:** This is an "old-main" snapshot. The 10 missing JS/CSS files mean only `core-utils.js` and the player HTML pages are runnable in isolation. The full dashboard (`index.html`) requires all missing files.

---

## 4. Detailed File Analysis

### `index.html` — Master Controller

The main dashboard UI. Contains no JavaScript of its own — all logic is in the external scripts listed above. Defines the complete HTML structure:

**Top Section:**
- OBS virtual camera preview (`<video>` element via `getUserMedia`)
- SMK TV branding with live clock display
- Main output toggle buttons: Live/Loop, Delay Live, OrdaChesta, Local Player
- OBS control buttons: Start Stream, Start Record, Start Virtual Cam
- Live Event Monitor toggles (Monitor 1 & 2)

**Player Cards Section (horizontal scroll):**
1. **Loop Player Card** — playlist input, play/pause/stop/mute, prev/next, jump-to-index, export
2. **Live Player Card** — single video ID input, auto-load priority selector (First Live / Second Live / Match Search Terms)
3. **Delay Live Player Card** — video ID + start/end time inputs, play controls
4. **Local PC Player Card** — multi-video path playlist, end-of-playlist action configuration
5. **Live Event Monitor 1 Card** — shows current live video info, channel name, copy-ID button, title search textarea
6. **Live Event Monitor 2 Card** — same as Monitor 1 (dual monitor support)
7. **Upcoming Event Monitor Card** — shows next scheduled YouTube premiere/event with start time
8. **Katha Monitor Card** — special monitor with scheduler for Katha content, load-to-player button, refresh/auto-load scheduling

**OBS Scene Scheduler Section:**
- Add schedule form: time picker, scene/source selector, show/hide action, daily/specific-days recurrence, optional title
- Schedule list table with status and delete actions
- Import/Export via clipboard (JSON format)

---

### `core-utils.js` — Shared Utility Library

The only JavaScript file present. Contains globally-scoped functions used by all other scripts:

**Constants:**
```js
PLAYER_EVENT_KEY        // "loopPlayerEvent"
DELAY_PLAYER_EVENT_KEY  // "delayLivePlayerEvent"
LOCAL_PLAYER_EVENT_KEY  // "localPCPlayerEvent"
LIVE_PLAYER_EVENT_KEY   // "livePlayerEvent"
allowedChannels         // ["Swaminarayan Bhagwan 1", "Swaminarayan", "Swaminarayan Bhagwan"]
```

**Functions:**

| Function | Purpose |
|----------|---------|
| `timeToSeconds(str)` | Parses `HH:MM:SS` / `MM:SS` / `SS` → integer seconds |
| `secondsToHMS(n)` | Formats seconds → `HH:MM:SS` or `MM:SS` string |
| `getCurrentDateTimeFormatted()` | Returns `M/D/YYYY, H:MM:SS AM/PM` string |
| `escapeCsvValue(v)` | CSV-safe string encoding with quote escaping |
| `copyToClipboard(text)` | Clipboard copy via legacy `execCommand` |
| `formatDateToDDMMMYYYY(date)` | Formats date → `DD Mon YYYY` (used by Katha monitor) |
| `parseYtInitialData(html)` | Regex-extracts and parses `ytInitialData` JSON from raw YouTube page HTML |
| `sendPlayerCommand(key, cmd, ...)` | Writes a command to localStorage, auto-deletes after 100ms |
| `savePlayerState(prefix)` | Serializes player state (playlist, index, mute, etc.) to localStorage |
| `loadPlayerState(prefix)` | Restores player state from localStorage on page load |
| `fetchVideoInfo(idOrPath, ...)` | Fetches YouTube video title via oEmbed API; handles local file paths by filename extraction |
| `updateButtonAppearance(btn, ...)` | Toggles button CSS classes between active/inactive states |
| `verifyAndFilterByChannelName(events, allowed)` | Async — calls YouTube oEmbed for each video to verify channel authorship against allowedChannels whitelist |

**Notable design:** `parseYtInitialData` scrapes raw YouTube HTML to extract video data without an API key. It has a fallback regex if the main JSON parse fails. This is fragile by design — YouTube HTML changes break it.

---

### `LivePlayer.html` — YouTube Live Stream Player

Full-screen YouTube IFrame player opened as a separate browser window. Designed to fill the entire OBS browser source.

- Listens on `localStorage` key `"livePlayerCommand"`
- Supports: `loadVideo`, `play`, `pause`, `stop`, `mute`, `unmute`, `setVolume`, `seekTo`, `destroy`
- Reports `videoEnded` and `timeUpdate` events back via `"livePlayerEvent"` key
- Sends `timeUpdate` every 1 second while playing (includes `currentTime` and `remainingTime`)
- On video end or error, fires `videoEnded` to trigger controller to load next content

---

### `DelayLive.html` — Delayed/Clipped YouTube Player

Same structure as LivePlayer but adds **start/end time clamping**:

- Listens on `"delayLivePlayerCommand"`
- Reports on `"delayLivePlayerEvent"`
- `createPlayer(videoId, startSeconds, endSeconds)` — passes `start` and `end` to YouTube `playerVars`
- `startDurationTimer()` — polls `getCurrentTime()` every 500ms; fires `videoEnded` when current time ≥ `endSeconds`
- `clearDurationTimer()` — clears the interval on pause/stop
- The controller uses this for playing previously recorded Katha content at specific timestamp ranges

---

### `LoopPlayer.html` — Playlist Loop Player

Same structure. The controller-side `player-loop.js` (missing) manages advancing through the playlist — this page just plays one video at a time and reports `videoEnded` when done.

- Listens on `"loopPlayerCommand"`
- Reports on `"loopPlayerEvent"`
- `reportEvent` function has a bug: it sets `playerType: "delay"` instead of `"loop"` (copy-paste error)
- Sends `timeUpdate` every 1 second

---

### `LocalPCPlayer.html` — Local File Player

Uses the native HTML5 `<video>` element instead of YouTube IFrame API. Designed for playing local `.mp4`/`.mkv` files.

- Listens on `"localPCPlayerCommand"`
- Reports on `"localPCPlayerEvent"`
- `loadVideo` command takes `videoPath` (file system path) instead of a YouTube ID
- Supports `startSeconds`/`endSeconds` clamping via a 250ms polling interval (`timeCheckInterval`)
- Handles `MediaError` codes: aborted, network, decode, src-not-supported
- On `pause` event, fires `videoEnded` — this means pausing triggers "next video" logic in the controller
- Sends `timeUpdate` every 1 second including `remainingTime`

---

## 5. Inter-Window Communication Protocol

All player windows and the controller communicate via this pattern:

**Command (Controller → Player):**
```js
localStorage.setItem("loopPlayerCommand", JSON.stringify({
  command: "loadVideo",
  videoId: "abc123",
  startSeconds: 0,
  endSeconds: 3600
}));
setTimeout(() => localStorage.removeItem("loopPlayerCommand"), 100);
```

**Event (Player → Controller):**
```js
localStorage.setItem("loopPlayerEvent", JSON.stringify({
  playerType: "loop",
  event: "videoEnded",
  timestamp: Date.now()
}));
setTimeout(() => localStorage.removeItem("loopPlayerEvent"), 100);
```

**All localStorage Keys:**

| Key | Direction | Player |
|-----|-----------|--------|
| `loopPlayerCommand` | Controller → Loop | LoopPlayer.html |
| `livePlayerCommand` | Controller → Live | LivePlayer.html |
| `delayLivePlayerCommand` | Controller → Delay | DelayLive.html |
| `localPCPlayerCommand` | Controller → Local | LocalPCPlayer.html |
| `loopPlayerEvent` | Loop → Controller | LoopPlayer.html |
| `livePlayerEvent` | Live → Controller | LivePlayer.html |
| `delayLivePlayerEvent` | Delay → Controller | DelayLive.html |
| `localPCPlayerEvent` | Local → Controller | LocalPCPlayer.html |
| `loopPlayerState` | Persistent state | Loop |
| `livePlayerState` | Persistent state | Live |
| `delayPlayerState` | Persistent state | Delay |
| `localPCPlayerState` | Persistent state | LocalPC |

---

## 6. Feature Summary

| Feature | Description |
|---------|-------------|
| **4 Video Sources** | Loop (YouTube playlist), Live (YouTube live), Delay Live (YouTube with time range), Local PC (local files) |
| **OBS WebSocket Control** | Start/stop stream, recording, virtual cam directly from the dashboard |
| **OBS Virtual Cam Preview** | Shows OBS virtual cam output in the controller via `getUserMedia` |
| **Live Event Monitor x2** | Monitors YouTube channels for active live streams; shows title, video ID, channel; supports title keyword filtering |
| **Upcoming Event Monitor** | Shows next scheduled YouTube premiere with start time |
| **Katha Monitor** | Specialized monitor that fetches and lists Katha content; supports scheduled auto-load to Delay Player |
| **OBS Scene Scheduler** | Time-based rules to show/hide OBS scenes; supports daily or specific-days-of-week recurrence |
| **Channel Allowlist** | All content is verified against Swaminarayan channel names via YouTube oEmbed before being accepted |
| **YouTube Scraping** | `parseYtInitialData()` extracts live/upcoming video data from raw YouTube HTML (no API key needed) |
| **Persistent State** | All player playlists, current index, play/pause/mute state saved to localStorage across refreshes |
| **Data Export** | CSV export for loop, live, delay, and local player playback data |
| **Schedule Import/Export** | JSON clipboard-based import/export for the OBS scene schedule |
| **Local File Playlist** | Multi-video playlist for local files with configurable end-of-playlist actions |
| **Time-Clamped Playback** | Delay player can play any YouTube video from a specific `HH:MM:SS` start to end |

---

## 7. Technology Stack

| Layer | Technology |
|-------|-----------|
| UI Framework | Vanilla HTML + Tailwind CSS (CDN) |
| Fonts | Google Fonts — Inter |
| Video (YouTube) | YouTube IFrame API (`youtube.com/iframe_api`) |
| Video (Local) | HTML5 `<video>` element |
| Video Info | YouTube oEmbed API (no API key) |
| YouTube Scraping | Regex on raw HTML (`ytInitialData`) |
| OBS Integration | OBS WebSocket (via `core-obs.js`, missing) |
| State Persistence | `localStorage` |
| IPC | `localStorage` + `window.addEventListener("storage")` |
| Build System | None — raw HTML/JS files |

---

## 8. Known Issues & Bugs

1. **`LoopPlayer.html` — wrong `playerType` in `reportEvent`:** Sets `playerType: "delay"` instead of `"loop"` (line 238). The controller may misinterpret loop events as delay events.

2. **`LocalPCPlayer.html` — pause fires `videoEnded`:** The `pause` event listener calls `reportEvent("videoEnded")` on every pause, including manual user pauses. This will unintentionally advance the playlist.

3. **`DelayLive.html` — reads stale localStorage for start/end times:** `onPlayerReady` reads `localStorage.getItem(PLAYER_KEY)` to get start/end times, but the command key is deleted after 100ms. If `onPlayerReady` fires after 100ms, it reads `{}` and defaults to `startSec=0, endSec=null`.

4. **`core-utils.js` — `fetchVideoInfo` references global `currentLoopIndex`/`loopPlaylist`:** The `infoElement.textContent` line (line 460) references globals `currentLoopIndex` and `loopPlaylist` even when called for non-loop players. These globals are defined in the missing `player-loop.js`.

5. **YouTube scraping is fragile:** `parseYtInitialData` depends on YouTube's internal HTML structure. YouTube frequently changes this, so scraping may break without notice.

6. **Missing files make the project non-functional:** 10 out of 11 JS files are absent. Only the player HTML files are independently usable.

7. **`copyToClipboard` uses deprecated `execCommand`:** Modern browsers are deprecating this API; should use `navigator.clipboard.writeText()`.

---

## 9. React Migration (Incomplete)

The directory `live-tv-controller-react/` exists with the following empty scaffold:

```
live-tv-controller-react/
├── data/
│   └── backups/     (empty)
├── public/          (empty)
└── src/
    ├── assets/      (empty)
    ├── components/
    │   └── common/  (empty)
    ├── context/     (empty)
    ├── hooks/       (empty)
    └── utils/       (empty)
```

No source files have been written yet. This represents a planned but not started migration of the vanilla JS app to React, likely to address the global-state and inter-file coupling issues inherent in the current architecture.

---

## 10. Summary

SMK TV is a **purpose-built broadcast control panel** for a Swaminarayan religious TV channel. It is a technically sophisticated piece of vanilla browser software that:

- Controls **OBS Studio** to switch between four video sources (YouTube live, YouTube loop playlist, time-delayed YouTube, local files)
- Monitors YouTube channels for live and upcoming events without needing a YouTube API key (via HTML scraping)
- Filters all content to verified Swaminarayan channels
- Provides a **Katha scheduler** to automatically load pre-recorded religious discourses at scheduled times
- Persists all operator state across browser refreshes via localStorage

The architecture is clever (localStorage as IPC bus, separate full-screen player windows as OBS browser sources) but fragile (YouTube HTML scraping, deprecated clipboard API, missing files). The project is in an **incomplete "old-main" state**: the player HTML files and utility library are present, but all the controller-side JavaScript files that wire everything together are absent from this snapshot.
