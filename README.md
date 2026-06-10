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
