# live-tv-controller-react

The main SMK TV controller app: React UI (Vite + Tailwind) + Express server (`server.cjs`) with WebSocket, server-side scheduler, FCM push notifications, and OBS integration.

**Start here:**

- **[PROJECT.md](PROJECT.md)** — full technical reference for this app (architecture, every REST/WS endpoint, players, scheduler, notifications, build/packaging).
- **[../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)** — symptom → cause → fix when something breaks.
- **[../FEATURES-REPORT.md](../FEATURES-REPORT.md)** — feature-by-feature overview of the whole project.
- **[../COMMANDS.md](../COMMANDS.md)** — ops commands (run, stop, build, PM2).

## Quick reference

```bash
# Development — run from the REPO ROOT (starts everything):
node smk.cjs dev          # Vite UI :3004 + this Express API :3005 + live-tv-api :3000

# Or manually, inside this folder (two terminals):
npm run dev:api           # Express + WebSocket on :3005
npm run dev               # Vite on :3004 (proxies /api /videos /ws → :3005)

# Release EXE — run from the REPO ROOT:
npm run build:exe         # → windows/exe/SMK TV <N>.exe
```

Open **http://localhost:3004**. OBS Browser Sources point at the player pages on the same origin (e.g. `http://localhost:3004/DelayLive.html`).

> ⚠ Files in `public/` are embedded into the EXE via the generated `public-assets.cjs` — a change there needs a rebuild (`npm run build:exe` at the root) to reach a packaged exe.
