# SMK TV — Live TV Controller

A live TV broadcast controller for a religious YouTube channel: OBS source switching, four video players, YouTube live/Katha monitors, a server-side scheduler, push notifications to phones (FCM), and a React dashboard — packaged as a single Windows EXE.

---

## Documentation Map — where to look

| Question | Read this |
|---|---|
| "Something is broken — how do I fix it?" | **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — symptom → cause → fix, with file references |
| "What does feature X do and where is its code?" | **[FEATURES-REPORT.md](FEATURES-REPORT.md)** — every feature, how it works, which files |
| "How is the controller app architected?" | **[live-tv-controller-react/PROJECT.md](live-tv-controller-react/PROJECT.md)** — deep technical reference: REST API, WebSocket, state, build |
| "What command starts/stops/builds things?" | **[COMMANDS.md](COMMANDS.md)** — ops cheat sheet (ports, PM2, kill commands) |
| "How do I deploy the YouTube data API?" | **[live-tv-api/DEPLOY.md](live-tv-api/DEPLOY.md)** |
| Push notifications — original design docs | [FCM-PUSH-NOTIFICATIONS.md](FCM-PUSH-NOTIFICATIONS.md), [FCM-PARALLEL-PLAN.md](FCM-PARALLEL-PLAN.md) (historical; current behavior is in FEATURES-REPORT §8) |

---

## Requirements

- **Node.js v18+** — https://nodejs.org
- **OBS Studio** with the WebSocket server enabled (Tools → WebSocket Server Settings), for source switching

---

## Installation

```bash
git clone https://github.com/ParthVekariya147/Live-Tv.git
cd Live-Tv
npm run install:all     # installs root + live-tv-api + live-tv-controller-react
```

Copy `.env.example` to `.env` and fill in what you use (Firebase credentials for push notifications, ports if non-default). One shared `.env` at the repo root drives all services.

---

## Run

Everything goes through the SMK CLI (`node smk.cjs`, or the equivalent npm scripts):

```bash
npm run dev      # Development: Vite UI on :3004 + Express API on :3005 + YouTube API on :3000
npm start        # Production: both services under PM2 (UI+API on :3004, YouTube API on :3000)
npm run stop     # Stop everything and free the ports
npm run build:exe  # Build the Windows EXE → windows/exe/SMK TV <N>.exe
```

Open **http://localhost:3004** in your browser.

---

## Ports

| Port | Purpose |
|---|---|
| 3000 | YouTube data API (`live-tv-api`) — live streams, Katha videos, video descriptions |
| 3004 | Dashboard UI + Controller API + WebSocket (Vite in dev, Express in production/EXE) |
| 3005 | Controller Express API, **dev mode only** (Vite proxies `/api`, `/videos`, `/ws` to it) |
| 3443 | HTTPS (self-signed) — phone notification setup page `/setup` |

---

## Repo Layout

```
Live-Tv/
├── live-tv-api/                YouTube data service (port 3000) — Piped → scrape → RSS waterfall
├── live-tv-controller-react/   Main app: React UI + Express + WebSocket + scheduler + notifications
├── smk.cjs                     CLI entry point (dev/build/exe/start/stop/install/status/logs)
├── build.cjs                   Windows EXE build pipeline (→ windows/exe/)
├── ecosystem.config.cjs        PM2 process definitions (smk-api, smk-controller)
├── env-loader.cjs              Shared .env loader for all services
└── windows/ , mac/             Double-clickable launcher scripts; windows/exe/ holds built EXEs
```

---

## Data Sources & API

The frontend never talks to YouTube directly and **no YouTube API key is required**. All YouTube data comes through the local `live-tv-api` service (port 3000):

| Endpoint | Used by | Purpose |
|---|---|---|
| `GET /api/live` | Live Monitor, Live Player | Live + upcoming streams for a channel |
| `GET /api/videos` | Katha Monitor | Recent uploads from the Katha channel |
| `GET /api/video-description?videoId=` | Katha Monitor, Delay Player keyword-skip | Full video description (cached 6 h, innertube-first with scrape fallback) |

Each request tries three sources in order and falls back automatically — the response's `"source"` field tells you which one answered:

```
1. Piped (public instances)  →  2. YouTube HTML scrape  →  3. YouTube RSS (no live status)
```

When YouTube breaks the parsing, fix **one file**: `live-tv-api/lib/youtube.js` (see [live-tv-api/DEPLOY.md](live-tv-api/DEPLOY.md)).
