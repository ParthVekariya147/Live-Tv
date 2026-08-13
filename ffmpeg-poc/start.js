#!/usr/bin/env node
'use strict';
// Entry point: node start.js VIDEO_ID (or full YouTube URL)
//
// Orchestrates: yt-dlp resolution -> ffmpeg copy-mux -> local HLS -> HTTP
// server -> HTML5 <video> player. See README.md for the full architecture
// diagram and component explanations.

const path = require('path');
const fs = require('fs');
const { resolveBinaries, printInstallHelp } = require('./lib/binaries');
const { resolveStream } = require('./lib/resolveStream');
const { FfmpegPipeline } = require('./lib/ffmpegPipeline');
const { createServer } = require('./lib/server');
const { ProcessSampler } = require('./lib/processStats');
const potServer = require('./lib/potServer');
const { state, logEvent, resetForVideo, pocStartedAt } = require('./lib/state');

const PORT = parseInt(process.env.FFMPEG_POC_PORT || '8090', 10);
const OUT_DIR = path.join(__dirname, 'hls_output');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATS_INTERVAL_MS = 5000;
const CONSOLE_STATUS_INTERVAL_MS = 30000;
const WATCHDOG_CHECK_INTERVAL_MS = 60 * 1000;
const LIVE_URL_REFRESH_MS = 20 * 60 * 1000; // proactively refresh live URLs every 20 min

function parseInput(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new Error('No video ID or URL given.');
  if (/^https?:\/\//i.test(trimmed)) {
    const m =
      trimmed.match(/[?&]v=([\w-]{6,})/) ||
      trimmed.match(/youtu\.be\/([\w-]{6,})/) ||
      trimmed.match(/\/live\/([\w-]{6,})/) ||
      trimmed.match(/\/shorts\/([\w-]{6,})/);
    return { videoId: m ? m[1] : trimmed, url: trimmed };
  }
  if (!/^[\w-]{6,}$/.test(trimmed)) {
    throw new Error(`"${raw}" doesn't look like a YouTube video ID or URL.`);
  }
  return { videoId: trimmed, url: `https://www.youtube.com/watch?v=${trimmed}` };
}

function computeSelectedSummary(selected) {
  if (selected.mode === 'split') {
    return {
      height: selected.video.height,
      width: selected.video.width,
      vcodec: selected.video.vcodec,
      acodec: selected.audio.acodec,
      fps: selected.video.fps,
      bitrateBps: Math.round(((selected.video.tbr || 0) + (selected.audio.abr || 0)) * 1000),
    };
  }
  return {
    height: selected.combined.height,
    width: selected.combined.width,
    vcodec: selected.combined.vcodec,
    acodec: selected.combined.acodec,
    fps: selected.combined.fps,
    bitrateBps: Math.round((selected.combined.tbr || 0) * 1000),
  };
}

function fmtKbps(bps) {
  if (!bps) return 'n/a';
  return `${Math.round(bps / 1000)} kbps`;
}

function printSelectionSummary(selected) {
  const lines = [];
  lines.push('-'.repeat(60));
  lines.push(`Video: ${state.title || state.videoId}  [${state.isLive ? 'LIVE' : 'VOD'}]`);
  lines.push(`Mode: ${selected.mode}`);
  if (selected.mode === 'split') {
    lines.push(`Selected video format: ${selected.video.formatId} — ${selected.video.height}p${selected.video.fps || ''} ${selected.video.vcodec} (${fmtKbps((selected.video.tbr || 0) * 1000)}) [${selected.video.protocol}]`);
    lines.push(`Selected audio format: ${selected.audio.formatId} — ${selected.audio.acodec} (${fmtKbps((selected.audio.abr || 0) * 1000)}) [${selected.audio.protocol}]`);
  } else {
    lines.push(`Selected combined format: ${selected.combined.formatId} — ${selected.combined.height}p${selected.combined.fps || ''} ${selected.combined.vcodec}+${selected.combined.acodec} (${fmtKbps((selected.combined.tbr || 0) * 1000)}) [${selected.combined.protocol}]`);
  }
  const summary = computeSelectedSummary(selected);
  lines.push(`Resolution: ${summary.width || '?'}x${summary.height || '?'}`);
  lines.push(`Bitrate: ${fmtKbps(summary.bitrateBps)}`);
  lines.push(`Highest available (any format): ${state.highestAvailableHeight}p`);
  lines.push(`Quality check: ${summary.height >= (state.highestAvailableHeight || 0) ? 'PASS — selected the highest available resolution' : 'FAIL — a higher resolution exists but was not selected'}`);
  lines.push('-'.repeat(60));
  console.log(lines.join('\n'));
}

async function main() {
  // The CLI arg is optional — you can also start with no video and enter
  // one later via the player page's input box (POST /api/load).
  console.log('Usage: node start.js [VIDEO_ID | YouTube URL]');
  console.log('Example: node start.js 7MppGkvYGCI');
  console.log('Example: node start.js https://www.youtube.com/watch?v=7MppGkvYGCI');
  console.log('(or omit it and enter a video ID on the player page once it loads)\n');

  const bins = resolveBinaries();
  console.log(`yt-dlp: ${bins.ytDlp.ok ? bins.ytDlp.version + ' (' + bins.ytDlp.path + ')' : 'NOT FOUND'}`);
  console.log(`ffmpeg: ${bins.ffmpeg.ok ? bins.ffmpeg.version : 'NOT FOUND'}`);
  console.log(`ffprobe: ${bins.ffprobe.ok ? bins.ffprobe.version : 'NOT FOUND (not required by this PoC, informational only)'}`);

  if (!bins.ytDlp.ok || !bins.ffmpeg.ok) {
    printInstallHelp(bins);
    process.exit(1);
  }

  // PO Token provider: closes the "youtube.com shows higher quality than we
  // detect" gap for live streams (see lib/potServer.js). Best-effort — if it
  // can't start, we still proceed with the previous (1080p-capped-on-live)
  // behavior rather than blocking the whole PoC on it.
  const pot = await potServer.ensureRunning();
  if (pot.available) {
    console.log(`PO Token provider: ${pot.started ? 'started' : 'already running'} on port ${pot.port} — full quality ladder (incl. >1080p live) enabled.`);
  } else {
    console.log(`PO Token provider: NOT available (${pot.reason}). Live streams may be capped at 1080p even when higher is available — see README "PO Token provider" section to enable it.`);
  }

  const pipeline = new FfmpegPipeline(bins.ffmpeg.path, OUT_DIR);
  const sampler = new ProcessSampler();

  // Raw ffmpeg stderr (its normal logging channel) is captured verbatim for
  // debugging — the console only gets our own summarized events.
  const ffmpegLogPath = path.join(__dirname, 'ffmpeg.log');
  fs.writeFileSync(ffmpegLogPath, '');
  pipeline.on('log', (text) => fs.appendFileSync(ffmpegLogPath, text));

  async function applyAndStart(selected, reason) {
    state.title = selected.title;
    state.isLive = selected.isLive;
    state.mode = selected.mode;
    state.video = selected.video;
    state.audio = selected.audio;
    state.combined = selected.combined;
    state.availableHeights = selected.availableHeights;
    state.highestAvailableHeight = selected.highestAvailableHeight;
    state.selected = computeSelectedSummary(selected);
    state.resolvedAt = selected.resolvedAt;

    printSelectionSummary(selected);

    state.pipelineReady = false; // this generation has no playable output on disk yet
    state.switchTimings.ffmpegStartedAt = Date.now();
    const { pid, args } = pipeline.start(selected);
    state.ffmpegPid = pid;
    state.ffmpegArgs = args;
    state.generation += 1;
    state.switchTimings.generation = state.generation;
    sampler.forget(pid);
    logEvent(`ffmpeg started (pid=${pid}, generation=${state.generation}, reason=${reason})`);
  }

  async function loadAndStart(reason) {
    // Latency instrumentation: one switchTimings record per attempt, covers
    // initial load, manual UI switch, auto-recovery, and watchdog refresh
    // uniformly since they all funnel through here.
    state.switchTimings = {
      reason,
      generation: null,
      switchStartedAt: Date.now(),
      ytDlpStartedAt: null,
      ytDlpFinishedAt: null,
      ffmpegStartedAt: null,
      playlistReadyAt: null,
    };
    logEvent(`Resolving stream via yt-dlp (${reason})...`);
    state.switchTimings.ytDlpStartedAt = Date.now();
    const selected = await resolveStream(bins.ytDlp.path, state.url);
    state.switchTimings.ytDlpFinishedAt = Date.now();
    await applyAndStart(selected, reason);
  }

  // Stops the currently-running ffmpeg (if any) and waits for it to fully
  // exit before returning — used whenever we're about to start a *different*
  // process against the same hls_output directory (manual video switch,
  // watchdog refresh), so two ffmpeg processes never write there at once.
  async function stopPipelineIfRunning() {
    if (!pipeline.proc) return;
    await new Promise((resolve) => {
      pipeline.once('close', resolve);
      pipeline.stop();
    });
  }

  let loadInProgress = false;
  // Single entry point for loading a video, whether from the CLI arg at
  // startup or from a POST /api/load request while already running.
  async function loadVideoById(rawInput, reason) {
    if (loadInProgress) {
      const err = new Error('A video is already loading — try again in a moment.');
      err.statusCode = 409;
      throw err;
    }
    loadInProgress = true;
    try {
      const { videoId, url } = parseInput(rawInput);
      await stopPipelineIfRunning();
      resetForVideo(videoId, url);
      sampler.forget(state.ffmpegPid);
      await loadAndStart(reason);
    } finally {
      loadInProgress = false;
    }
  }

  function printValidationSummary(label) {
    if (!state.mode) {
      console.log(`\nVALIDATION SUMMARY${label ? ' — ' + label : ''}: no video loaded yet.\n`);
      return;
    }
    const stats = sampler.sample(state.ffmpegPid);
    const lines = [];
    lines.push('');
    lines.push('='.repeat(60));
    lines.push(`VALIDATION SUMMARY${label ? ' — ' + label : ''}`);
    lines.push('='.repeat(60));
    lines.push(`Video ID: ${state.videoId}`);
    lines.push(`Title: ${state.title || '(unknown)'}`);
    lines.push(`Type: ${state.isLive ? 'LIVE' : 'VOD'}   Mode: ${state.mode}`);
    if (state.mode === 'split') {
      lines.push(`Selected video format: ${state.video.formatId} (${state.video.height}p, ${state.video.vcodec})`);
      lines.push(`Selected audio format: ${state.audio.formatId} (${state.audio.acodec}, ${fmtKbps((state.audio.abr || 0) * 1000)})`);
    } else {
      lines.push(`Selected combined format: ${state.combined.formatId} (${state.combined.height}p, ${state.combined.vcodec}+${state.combined.acodec})`);
    }
    lines.push(`Resolution: ${state.selected.width || '?'}x${state.selected.height || '?'}`);
    lines.push(`Bitrate: ${fmtKbps(state.selected.bitrateBps)}`);
    lines.push(`ffmpeg mode: ${state.copyConfirmed === true ? 'COPY confirmed (no transcode)' : state.copyConfirmed === false ? 'NOT pure copy (unexpected!)' : 'copy requested, confirmation pending'}`);
    lines.push(`Startup time: ${state.readyAt ? (state.readyAt - state.startedAt) + ' ms' : 'not ready yet'}`);
    lines.push(`Memory usage (ffmpeg): ${stats.memoryMB != null ? stats.memoryMB + ' MB' : 'n/a (sampling — check again shortly)'}`);
    lines.push(`CPU usage (ffmpeg): ${stats.cpuPercent != null ? stats.cpuPercent + '% of one core' : 'n/a (needs a second sample ~5s later)'}`);
    lines.push(`Reconnect count: ${state.reconnectCount}   Watchdog refreshes: ${state.watchdogRefreshCount}`);
    lines.push('='.repeat(60));
    console.log(lines.join('\n'));
  }

  function printSwitchTimingReport(t) {
    const rel = (ts) => (ts != null ? ts - t.switchStartedAt : null);
    const fmt = (ms) => (ms == null ? 'n/a' : `+${ms}ms`);
    const stageMs = (a, b) => (a != null && b != null ? `${b - a}ms` : 'n/a');
    const lines = [];
    lines.push('');
    lines.push('-'.repeat(50));
    lines.push(`SWITCH TIMING — generation ${t.generation} (${t.reason})`);
    lines.push('-'.repeat(50));
    lines.push(`VIDEO_ID_RECEIVED   ${fmt(0)}`);
    lines.push(`YT_DLP_START        ${fmt(rel(t.ytDlpStartedAt))}`);
    lines.push(`YT_DLP_FINISH       ${fmt(rel(t.ytDlpFinishedAt))}   (yt-dlp: ${stageMs(t.ytDlpStartedAt, t.ytDlpFinishedAt)})`);
    lines.push(`FFMPEG_START        ${fmt(rel(t.ffmpegStartedAt))}`);
    lines.push(`PLAYLIST_READY      ${fmt(rel(t.playlistReadyAt))}   (ffmpeg-to-first-segment: ${stageMs(t.ffmpegStartedAt, t.playlistReadyAt)})`);
    lines.push(`TOTAL_SWITCH_TIME   ${fmt(rel(t.playlistReadyAt))}`);
    lines.push('-'.repeat(50));
    console.log(lines.join('\n'));
  }

  pipeline.on('ready', () => {
    if (!state.readyAt) state.readyAt = Date.now();
    state.copyConfirmed = pipeline.getCopyConfirmation();
    state.pipelineReady = true; // this generation now has a real, fetchable playlist + segments
    if (state.switchTimings && state.switchTimings.playlistReadyAt == null) {
      state.switchTimings.playlistReadyAt = Date.now();
      printSwitchTimingReport(state.switchTimings);
      state.switchHistory.push({ ...state.switchTimings });
      if (state.switchHistory.length > 50) state.switchHistory.shift();
    }
    printValidationSummary('startup');
  });

  pipeline.on('ready-timeout', () => {
    logEvent('ffmpeg did not produce a playable HLS output within 30s — killing and triggering recovery.');
    pipeline.kill();
  });

  pipeline.on('error', (err) => {
    logEvent(`ffmpeg process error: ${err.message}`);
  });

  pipeline.on('close', ({ code, signal, copyConfirmed, wasIntentional, stderrTail }) => {
    if (copyConfirmed != null) state.copyConfirmed = copyConfirmed;
    if (wasIntentional) {
      logEvent(`ffmpeg stopped (code=${code}, signal=${signal}) — intentional, no auto-recovery.`);
      return;
    }
    if (code === 0 && !state.isLive) {
      logEvent('ffmpeg finished muxing the VOD to completion (natural end-of-stream) — no recovery needed.');
      return;
    }
    state.lastError = `ffmpeg exited unexpectedly (code=${code}, signal=${signal})`;
    logEvent(state.lastError);
    if (stderrTail) logEvent(`ffmpeg stderr tail (last 500 chars):\n${stderrTail.slice(-500)}`);
    state.reconnectCount += 1;
    const delay = Math.min(2000 * state.reconnectCount, 15000);
    logEvent(`Auto-recovery: re-resolving with yt-dlp and restarting ffmpeg in ${delay}ms (reconnect #${state.reconnectCount})...`);
    setTimeout(() => attemptRecovery(1), delay);
  });

  async function attemptRecovery(attempt) {
    try {
      await loadAndStart(`recovery attempt ${attempt}`);
    } catch (err) {
      logEvent(`Recovery attempt ${attempt} failed: ${err.message}`);
      const delay = Math.min(3000 * attempt, 30000);
      setTimeout(() => attemptRecovery(attempt + 1), delay);
    }
  }

  async function watchdogCheck() {
    if (!state.isLive || !state.resolvedAt) return;
    if (Date.now() - state.resolvedAt < LIVE_URL_REFRESH_MS) return;
    logEvent('Watchdog: proactively refreshing live stream URLs before they can expire...');
    state.watchdogRefreshCount += 1;
    await stopPipelineIfRunning();
    await loadAndStart('watchdog: proactive refresh');
  }

  // ---- HTTP server (starts regardless of whether a video was given on the
  // CLI — the player page has its own "enter a video ID" box that POSTs to
  // /api/load, so the server needs to be reachable before any video loads) ----
  const server = createServer({
    publicDir: PUBLIC_DIR,
    hlsDir: OUT_DIR,
    onLoad: (rawInput) => loadVideoById(rawInput, 'manual load via UI'),
    getStatus: () => ({
      videoId: state.videoId,
      title: state.title,
      isLive: state.isLive,
      mode: state.mode,
      selected: state.selected,
      video: state.video,
      audio: state.audio,
      combined: state.combined,
      availableHeights: state.availableHeights,
      highestAvailableHeight: state.highestAvailableHeight,
      copyConfirmed: state.copyConfirmed,
      generation: state.generation,
      pipelineReady: state.pipelineReady,
      reconnectCount: state.reconnectCount,
      watchdogRefreshCount: state.watchdogRefreshCount,
      startupTimeMs: state.readyAt ? state.readyAt - state.startedAt : null,
      cpuPercent: state.cpuPercent != null ? state.cpuPercent : null,
      memoryMB: state.memoryMB != null ? state.memoryMB : null,
      pocUptimeMs: Date.now() - pocStartedAt,
      lastError: state.lastError,
      recentLog: state.log.slice(-40),
      pid: state.ffmpegPid,
      switchTimings: state.switchTimings,
      switchHistory: state.switchHistory,
    }),
  });

  server.listen(PORT, '127.0.0.1', () => {
    logEvent(`Server listening on http://localhost:${PORT}`);
    logEvent(`Player: http://localhost:${PORT}/player.html`);
  });

  // ---- Initial video: CLI arg is now optional — you can also just open
  // the player page and enter a video ID there (POST /api/load) ----
  const initialArg = process.argv[2];
  if (initialArg) {
    try {
      await loadVideoById(initialArg, 'initial load');
    } catch (err) {
      // Not fatal anymore: the server is already up, so the user can just
      // fix the ID from the player page's input box instead of restarting.
      logEvent(`Could not resolve/start "${initialArg}": ${err.message}`);
      state.lastError = err.message;
    }
  } else {
    logEvent('No video ID given on the command line — open the player page and enter one there.');
  }

  // ---- Periodic sampling + console status ----
  setInterval(() => {
    const stats = sampler.sample(state.ffmpegPid);
    state.cpuPercent = stats.cpuPercent;
    state.memoryMB = stats.memoryMB;
  }, STATS_INTERVAL_MS);

  setInterval(() => {
    logEvent(
      `status: res=${state.selected ? state.selected.width + 'x' + state.selected.height : '?'} ` +
      `cpu=${state.cpuPercent != null ? state.cpuPercent + '%' : 'n/a'} ` +
      `mem=${state.memoryMB != null ? state.memoryMB + 'MB' : 'n/a'} ` +
      `reconnects=${state.reconnectCount} uptime=${Math.round((Date.now() - pocStartedAt) / 1000)}s`
    );
  }, CONSOLE_STATUS_INTERVAL_MS);

  setInterval(() => {
    watchdogCheck().catch((err) => logEvent(`watchdog error: ${err.message}`));
  }, WATCHDOG_CHECK_INTERVAL_MS);

  // ---- Graceful shutdown ----
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('Shutting down...');
    printValidationSummary('FINAL');
    pipeline.stop();
    potServer.stop();
    server.close();
    setTimeout(() => process.exit(0), 500);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
