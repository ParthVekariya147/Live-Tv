# SMK TV — Command Reference

## Ports

| Service            | Port |
|--------------------|------|
| YouTube API server | 3000 |
| Vite dev server    | 3003 |
| Controller server  | 3004 |

---

## SMK CLI (Main Entry Point)

All commands run from the **project root** using `node smk.cjs`:

```bash
node smk.cjs           # Interactive menu (choose from list)
node smk.cjs dev       # Start dev mode (Vite :3003 + API :3004)
node smk.cjs build     # Build React UI → live-tv-controller-react/dist/
node smk.cjs exe       # Build Windows EXE → windows/exe/
node smk.cjs start     # Start production services via PM2
node smk.cjs stop      # Stop all PM2 services + free ports
node smk.cjs restart   # Restart PM2 services
node smk.cjs install   # Install all npm dependencies
node smk.cjs status    # Show PM2 process status
node smk.cjs logs      # Tail PM2 logs (Ctrl+C to exit)
node smk.cjs help      # Show help
```

Or via npm scripts (same thing):

```bash
npm run dev            # node smk.cjs dev
npm run build          # node smk.cjs build
npm run exe            # node smk.cjs exe
npm start              # node smk.cjs start
npm run stop           # node smk.cjs stop
npm run install:all    # node smk.cjs install
```

---

## Stop Everything

### Recommended (uses SMK — stops PM2 + frees all ports)
```bash
node smk.cjs stop
```

### Mac — manual kill by ports
```bash
lsof -ti :3000,:3003,:3004 | xargs kill -9
```

### Mac — nuclear (kill ALL node processes)
```bash
pkill -9 node
```

### Windows — manual kill by port (find PID first, then kill)
```cmd
netstat -ano | findstr :3000
netstat -ano | findstr :3003
netstat -ano | findstr :3004

taskkill /PID <PID> /F
```

### Windows — nuclear (kill ALL node processes)
```cmd
taskkill /IM node.exe /F
```

---

## Check What Is Running

### Mac
```bash
lsof -i :3000 -i :3003 -i :3004
```

### Windows
```cmd
netstat -ano | findstr :3000
netstat -ano | findstr :3003
netstat -ano | findstr :3004
```

### PM2 status
```bash
pm2 list
pm2 logs
```

---

## PM2 Commands (Production)

```bash
pm2 list                          # Show all running processes
pm2 logs                          # Tail all logs
pm2 logs smk-controller           # Logs for controller only
pm2 logs smk-api                  # Logs for YouTube API only
pm2 stop all                      # Stop all processes
pm2 delete all                    # Remove all from PM2 list
pm2 kill                          # Kill PM2 daemon entirely
pm2 restart smk-controller        # Restart controller
pm2 restart smk-api               # Restart YouTube API
pm2 startOrRestart ecosystem.config.cjs --update-env
```

---

## Build

```bash
# Build React UI only
node smk.cjs build

# Build Windows EXE (builds React first, then packages)
node smk.cjs exe

# Or directly
node build.cjs
```

---

## Install Dependencies

```bash
# All at once (root + live-tv-api + live-tv-controller-react)
node smk.cjs install

# Manually
npm install                                      # root
cd live-tv-api && npm install                    # YouTube API
cd live-tv-controller-react && npm install       # React app
```

---

## Git

```bash
git status
git diff
git add live-tv-controller-react/server.cjs live-tv-controller-react/src/components/LivePlayerCard.jsx
git commit -m "your message"
git push origin main
git log --oneline -5
```

---

## Launcher Files (Windows)

Located in `windows/`:

| File                | Action                        |
|---------------------|-------------------------------|
| `Start SMK TV.bat`  | Start production via PM2      |
| `Stop SMK TV.bat`   | Stop all PM2 services         |
| `Build SMK TV.bat`  | Build Windows EXE             |

---

## Launcher Files (Mac)

Located in `mac/`:

| File                  | Action                   |
|-----------------------|--------------------------|
| `SMK TV.app`          | Launch app (double-click)|
| `Build SMK TV.command`| Build EXE                |
| `stop.command`        | Stop all services        |
