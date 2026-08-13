'use strict';
// Best-effort, dependency-free CPU/memory sampling for an external PID
// (ffmpeg). There's no single cross-platform API for this without a native
// module, so we shell out to platform tools. CPU is reported as "% of one
// core" (cumulative CPU seconds delta / wall-clock seconds delta), which is
// an approximation good enough for a PoC — not a precision profiler.

const { spawnSync } = require('child_process');
const os = require('os');

function readCpuSecondsWindows(pid) {
  const cmd = `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalSeconds`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 8000 });
  if (res.error || res.status !== 0) return null;
  const val = parseFloat((res.stdout || '').trim());
  return Number.isFinite(val) ? val : null;
}

function readMemMbWindows(pid) {
  const cmd = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64 / 1MB`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 8000 });
  if (res.error || res.status !== 0) return null;
  const val = parseFloat((res.stdout || '').trim());
  return Number.isFinite(val) ? val : null;
}

function readUnix(pid) {
  const res = spawnSync('ps', ['-o', 'cputime=,rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 8000 });
  if (res.error || res.status !== 0) return null;
  const line = (res.stdout || '').trim();
  if (!line) return null;
  const parts = line.split(/\s+/);
  const rssKb = parseFloat(parts[parts.length - 1]);
  const cputime = parts.slice(0, parts.length - 1).join(' '); // [HH:]MM:SS(.ss)
  const segs = cputime.split(':').map(Number);
  let seconds = 0;
  for (const s of segs) seconds = seconds * 60 + s;
  return { cpuSeconds: seconds, memoryMB: Number.isFinite(rssKb) ? rssKb / 1024 : null };
}

class ProcessSampler {
  constructor() {
    this.lastByPid = new Map();
  }

  // Returns { cpuPercent, memoryMB, cpuSecondsTotal } or nulls if the
  // process is gone / stats are unavailable on this platform.
  sample(pid) {
    if (!pid) return { cpuPercent: null, memoryMB: null, cpuSecondsTotal: null };
    let cpuSeconds, memoryMB;
    if (process.platform === 'win32') {
      cpuSeconds = readCpuSecondsWindows(pid);
      memoryMB = readMemMbWindows(pid);
    } else {
      const r = readUnix(pid);
      cpuSeconds = r ? r.cpuSeconds : null;
      memoryMB = r ? r.memoryMB : null;
    }
    if (cpuSeconds == null) return { cpuPercent: null, memoryMB, cpuSecondsTotal: null };

    const now = Date.now();
    const prev = this.lastByPid.get(pid);
    this.lastByPid.set(pid, { t: now, cpu: cpuSeconds });

    if (!prev) return { cpuPercent: null, memoryMB, cpuSecondsTotal: cpuSeconds };
    const dtSeconds = (now - prev.t) / 1000;
    const dCpu = cpuSeconds - prev.cpu;
    const cpuPercent = dtSeconds > 0 ? Math.max(0, (dCpu / dtSeconds) * 100) : null;
    return {
      cpuPercent: cpuPercent != null ? +cpuPercent.toFixed(1) : null,
      memoryMB: memoryMB != null ? +memoryMB.toFixed(1) : null,
      cpuSecondsTotal: +cpuSeconds.toFixed(2),
    };
  }

  forget(pid) {
    this.lastByPid.delete(pid);
  }
}

function coreCount() {
  return os.cpus() ? os.cpus().length : null;
}

module.exports = { ProcessSampler, coreCount };
