import { spawn, execSync } from "child_process";

// Kill any process already using these ports
function freePort(port) {
  try {
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
  } catch {}
}

[3000, 3004].forEach(freePort);

const services = [
  { name: "live-tv-api",        cmd: "node", args: ["live-tv-api/server.js"] },
  { name: "live-tv-controller", cmd: "node", args: ["live-tv-controller-react/server.cjs"] },
];

services.forEach(({ name, cmd, args }) => {
  const proc = spawn(cmd, args, { stdio: "inherit", shell: false });
  proc.on("error", (err) => console.error(`[${name}] Error:`, err.message));
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[${name}] Exited with code ${code}`);
  });
});

setTimeout(() => {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║           LIVE TV CONTROLLER — RUNNING           ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log("║                                                  ║");
  console.log("║  Frontend (Dashboard)                            ║");
  console.log("║  → http://localhost:3004                         ║");
  console.log("║                                                  ║");
  console.log("║  Services                                        ║");
  console.log("║  → YouTube API   :  http://localhost:3000        ║");
  console.log("║  → Controller API:  http://localhost:3004/api    ║");
  console.log("║  → WebSocket     :  ws://localhost:3004/ws       ║");
  console.log("║                                                  ║");
  console.log("║  Press Ctrl+C to stop all services               ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("\n");
}, 2000);
