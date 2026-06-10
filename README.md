# Live TV Controller

A live TV controller dashboard with YouTube API integration, scheduler, OBS control, and a React UI.

---

## Requirements

- **Node.js v18+** — https://nodejs.org

---

## Installation

Clone the repo and run **one command** to install all dependencies:

```bash
git clone https://github.com/ParthVekariya147/Live-Tv.git
cd Live-Tv
npm run install:all
```

Then build the React app:

```bash
npm run build
```

---

## Run

Start all services with **one command**:

```bash
npm start
```

Then open your browser at:

```
http://localhost:3004
```

Terminal will show:

```
╔══════════════════════════════════════════════════╗
║           LIVE TV CONTROLLER — RUNNING           ║
╠══════════════════════════════════════════════════╣
║  Frontend (Dashboard)  →  http://localhost:3004  ║
║  YouTube API           →  http://localhost:3000  ║
║  Controller API        →  http://localhost:3004/api ║
║  WebSocket             →  ws://localhost:3004/ws ║
╚══════════════════════════════════════════════════╝
```

---

## Services

| Service | URL | Description |
|---|---|---|
| Live TV API | http://localhost:3000 | YouTube live stream data |
| Controller + UI | http://localhost:3004 | Main dashboard |

---

## Ports

| Port | Purpose |
|---|---|
| 3000 | YouTube API proxy (`live-tv-api`) |
| 3004 | React UI + Scheduler + WebSocket (`live-tv-controller-react`) |

---

## Data Sources & API

The frontend always calls the **local API at `http://localhost:3000`** — no YouTube API key is required anywhere in this project.

### Local API Endpoints

| Endpoint | Used By | Purpose |
|---|---|---|
| `GET /api/live` | Monitor, Live Player | Live streams + upcoming events for a channel |
| `GET /api/videos` | Katha Monitor | Last 30 recent videos from Katha channel |

### How Data is Fetched — 3-Layer Waterfall

Every request tries 3 sources in order. If one fails, it automatically falls back to the next:

```
1. Piped  →  2. YouTube Scrape  →  3. YouTube RSS
```

**Layer 1 — Piped (Open Source, no API key)**
Tries 4 public Piped instances in order, first success wins:
```
https://pipedapi.kavin.rocks
https://api.piped.yt
https://pipedapi.adminforge.de
https://piped-api.coke.cx
```
Response includes `"source": "piped"`

**Layer 2 — YouTube HTML Scrape (fallback)**
Fetches `youtube.com/channel/{id}/streams` directly and parses `ytInitialData` JSON embedded in the page.
- No API key needed
- Can detect live/upcoming status
- Response includes `"source": "youtube-scrape"`

**Layer 3 — YouTube RSS Feed (last resort)**
Fetches the official YouTube RSS feed:
```
https://www.youtube.com/feeds/videos.xml?channel_id={id}
```
- Stable since 2006, never breaks
- Limitation: no live/upcoming status — past videos only
- Response includes `"source": "rss"`

### Other External APIs

| API | Purpose |
|---|---|
| `youtube.com/oembed` | Get video title + channel name from a video ID |
| `ws://localhost:3004/ws` | Real-time scheduler events (local WebSocket) |

### Summary

> No YouTube API key required. The local API auto-selects the best available data source on every request.
