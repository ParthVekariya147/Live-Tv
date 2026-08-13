'use strict';
// Shared in-memory state for the PoC. Single process, single video at a time.

const pocStartedAt = Date.now();

const state = {
  videoId: null,
  url: null,
  title: null,
  isLive: false,
  mode: null, // 'split' (video-only + audio-only muxed) | 'combined' (single HLS/progressive input remuxed)

  // Selected stream description (see resolveStream.js for shape)
  selected: null, // normalized {height,width,vcodec,acodec,fps,bitrateBps}
  video: null,    // raw video-only format descriptor (mode: 'split')
  audio: null,    // raw audio-only format descriptor (mode: 'split')
  combined: null, // raw combined format descriptor (mode: 'combined')

  // Everything yt-dlp reported was available, for the quality ladder printout
  availableHeights: [],
  highestAvailableHeight: null,

  // Resource usage, sampled periodically (see processStats.js)
  cpuPercent: null,
  memoryMB: null,

  // ffmpeg lifecycle
  ffmpegPid: null,
  ffmpegArgs: null,
  copyConfirmed: null, // true/false once parsed from ffmpeg stderr banner
  generation: 0, // bumped every (re)start; client reloads <video> src when this changes
  pipelineReady: false, // true once the CURRENT generation has a real fetchable playlist+segments on disk
  resolvedAt: null, // when current generation's URLs were resolved
  readyAt: null, // when the first HLS segment became available (startup complete)
  startedAt: null, // when resolution began for the currently loaded video

  reconnectCount: 0,
  watchdogRefreshCount: 0,
  lastError: null,

  // Latency instrumentation for the CURRENT in-flight or most recently
  // completed switch (see start.js loadAndStart/applyAndStart and the
  // pipeline 'ready' handler for where each field gets stamped), plus a
  // rolling history of completed switches for before/after comparison.
  switchTimings: null,
  switchHistory: [],

  log: [],
};

function logEvent(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log('[ffmpeg-poc]', msg);
  state.log.push(line);
  if (state.log.length > 400) state.log.shift();
}

function resetForVideo(videoId, url) {
  state.videoId = videoId;
  state.url = url;
  state.title = null;
  state.isLive = false;
  state.mode = null;
  state.selected = null;
  state.video = null;
  state.audio = null;
  state.combined = null;
  state.availableHeights = [];
  state.highestAvailableHeight = null;
  state.cpuPercent = null;
  state.memoryMB = null;
  state.ffmpegPid = null;
  state.ffmpegArgs = null;
  state.copyConfirmed = null;
  state.generation = 0;
  state.pipelineReady = false;
  state.resolvedAt = null;
  state.readyAt = null;
  state.startedAt = Date.now();
  state.reconnectCount = 0;
  state.watchdogRefreshCount = 0;
  state.lastError = null;
}

module.exports = { state, logEvent, resetForVideo, pocStartedAt };
