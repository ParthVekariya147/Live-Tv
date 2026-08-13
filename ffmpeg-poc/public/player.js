(() => {
  'use strict';

  const video = document.getElementById('player');
  const MASTER_URL = '/hls/master.m3u8';
  const MEDIA_URL = '/hls/stream.m3u8';
  const $ = (id) => document.getElementById(id);

  let hls = null;
  let lastGeneration = null;
  let lastServerStatus = null;
  // Prefer the master playlist — it carries RESOLUTION/BANDWIDTH/CODECS
  // level metadata the media playlist alone doesn't (see ffmpegPipeline.js).
  // But ffmpeg can't always populate it (confirmed: for live sources, whose
  // input bitrate is unknown up front, the generated master ends up with no
  // #EXT-X-STREAM-INF variant at all — a valid but unusable empty
  // playlist), so on a parsing/load failure we fall back to the media
  // playlist directly; playback still works, just without that metadata.
  let usingMasterUrl = true;

  // --- Client-side leg of the switch-latency instrumentation ---
  // Correlated with the server's switchTimings by generation number: the
  // server stamps VIDEO_ID_RECEIVED..PLAYLIST_READY, the client adds
  // BROWSER_REQUEST (when hls.js is told to load this generation's source)
  // and FIRST_FRAME (when the video element actually has a decoded frame),
  // both measured against the server's switchStartedAt origin so the whole
  // pipeline shows on one timeline.
  let currentSwitchGeneration = null;
  let clientTimings = null;

  function fmtBps(bps) {
    if (!bps && bps !== 0) return '–';
    if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
    return Math.round(bps / 1000) + ' kbps';
  }

  function fmtMs(ms) {
    if (ms == null) return '–';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  function attachHls() {
    clientTimings = { generation: currentSwitchGeneration, browserRequestAt: Date.now(), firstFrameAt: null };
    video.addEventListener('loadeddata', onFirstFrame, { once: true });

    if (window.Hls && window.Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: 15,
        // How many segments behind the live edge hls.js targets as its
        // start position for a live stream. Tried lowering this to 1 (from
        // 3) for faster perceived startup, paired with ffmpeg's shorter
        // segment length — reverted: with less buffer cushion, real-world
        // testing showed more frequent rebuffering/stalling, which reads as
        // "quality dropped" even though the actual selected resolution and
        // bitrate never changed. Playback stability lost to that trade
        // wasn't worth a latency win that wasn't even clearly measurable in
        // the first place (yt-dlp resolution time dominates the total
        // switch latency by roughly 8-to-1 — see README latency section).
        liveSyncDurationCount: 3,
        enableWorker: true,
      });
      hls.loadSource(usingMasterUrl ? MASTER_URL : MEDIA_URL);
      hls.attachMedia(video);

      hls.on(Hls.Events.LEVEL_LOADED, () => {
        video.play().catch(() => { /* autoplay may still require a user gesture */ });
      });

      // LEVEL_SWITCHED only fires on a level *change* — with a single level
      // (the normal case here, since we serve one already-highest-quality
      // rendition) hls.js starts on it directly and never "switches", so
      // rendering is also driven from the periodic poll below.
      hls.on(Hls.Events.LEVEL_SWITCHED, renderLevelInfo);

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        appendLog(`[hls.js] ${data.fatal ? 'FATAL' : 'warn'} ${data.type}: ${data.details}`);
        if (!data.fatal) return;

        const isUnusableMaster = usingMasterUrl &&
          (data.details === 'manifestParsingError' || data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut' || data.details === 'levelEmptyError');
        if (isUnusableMaster) {
          appendLog('Master playlist unusable — falling back to the media playlist directly.');
          usingMasterUrl = false;
          reloadSource(false);
          return;
        }

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            reloadSource();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = usingMasterUrl ? MASTER_URL : MEDIA_URL; // Safari native HLS
    } else {
      appendLog('This browser supports neither MSE/hls.js nor native HLS.');
    }
  }

  function renderLevelInfo() {
    if (!hls || hls.currentLevel < 0 || !hls.levels) return;
    const level = hls.levels[hls.currentLevel];
    if (!level) return;
    $('resolution').textContent = level.width && level.height ? `${level.width}x${level.height}` : '–';
    $('bitrate').textContent = fmtBps(level.bitrate);
    $('vcodec').textContent = level.videoCodec || parseCodecs(level).video || '–';
    $('acodec').textContent = level.audioCodec || parseCodecs(level).audio || '–';
  }

  function parseCodecs(level) {
    const codecs = (level.attrs && level.attrs.CODECS) || '';
    const parts = codecs.split(',').map((s) => s.trim());
    const video = parts.find((p) => /^(avc1|hev1|hvc1|vp0?9|av01)/i.test(p));
    const audio = parts.find((p) => /^mp4a|opus|ac-3|ec-3/i.test(p));
    return { video, audio };
  }

  function reloadSource(resetToMaster = true) {
    appendLog('Reloading HLS source (ffmpeg pipeline restarted)...');
    if (resetToMaster) {
      // Same reasoning as the initial attach: skip the master playlist
      // entirely for live sources rather than discovering it's empty.
      usingMasterUrl = !(lastServerStatus && lastServerStatus.isLive);
    }
    if (hls) { hls.destroy(); hls = null; }
    attachHls();
  }

  function onFirstFrame() {
    if (!clientTimings || clientTimings.firstFrameAt) return;
    clientTimings.firstFrameAt = Date.now();
    reportClientSwitchTiming();
  }

  function reportClientSwitchTiming() {
    const t = clientTimings;
    const server = lastServerStatus && lastServerStatus.switchTimings;
    if (!server || server.generation !== t.generation || server.switchStartedAt == null) {
      appendLog(`FIRST_FRAME for generation ${t.generation} (no matching server timing to correlate against)`);
      return;
    }
    const origin = server.switchStartedAt;
    const lines = [
      `SWITCH TIMING (client) — generation ${t.generation}`,
      `  BROWSER_REQUEST  +${t.browserRequestAt - origin}ms`,
      `  FIRST_FRAME      +${t.firstFrameAt - origin}ms  (end-to-end: video-id-received to visible frame)`,
    ];
    lines.forEach((l) => appendLog(l));
    console.log('[ffmpeg-poc]', lines.join('\n'));
  }

  function appendLog(line) {
    const el = $('log');
    el.textContent += `[${new Date().toLocaleTimeString()}] ${line}\n`;
    el.scrollTop = el.scrollHeight;
  }

  // --- Client-observed playback stats (independent of hls.js internals) ---
  function pollPlaybackStats() {
    renderLevelInfo();
    $('currentTime').textContent = video.currentTime ? video.currentTime.toFixed(1) + ' s' : '–';

    if (video.buffered && video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      $('bufferLen').textContent = Math.max(0, end - video.currentTime).toFixed(1) + ' s';
    }

    if (typeof video.getVideoPlaybackQuality === 'function') {
      const q = video.getVideoPlaybackQuality();
      $('dropped').textContent = `${q.droppedVideoFrames} / ${q.totalVideoFrames}`;
    }

    setTimeout(pollPlaybackStats, 1000);
  }

  // --- Rendered FPS via requestVideoFrameCallback (fallback: n/a) ---
  function startFpsCounter() {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      $('fps').textContent = 'n/a (no rVFC)';
      return;
    }
    let count = 0;
    let windowStart = performance.now();
    const tick = () => {
      count++;
      const now = performance.now();
      if (now - windowStart >= 1000) {
        $('fps').textContent = count.toString();
        count = 0;
        windowStart = now;
      }
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  // --- Server ground-truth status (also drives auto-reload on ffmpeg restart) ---
  let hasVideo = false;
  async function pollServerStatus() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      const data = await res.json();
      lastServerStatus = data;
      renderServerStatus(data);

      // Gate on `pipelineReady`, not `videoId` or `mode`: those are set the
      // instant a load starts (resetForVideo / ffmpeg spawn, synchronous),
      // but the actual playlist + segments don't exist on disk until ffmpeg
      // has been running for several seconds. Attaching hls.js before that
      // hits a 404 on its very first request — confirmed by direct testing
      // that hls.js can get permanently stuck after that (MSE attached,
      // readyState never leaves HAVE_NOTHING, no further requests, even
      // though the server is producing valid segments the whole time).
      // pipelineReady flips true only once the server's ffmpeg pipeline has
      // actually confirmed a playable playlist for the CURRENT generation.
      if (data.pipelineReady) {
        if (!hasVideo) {
          // First video the page has seen (either given on the CLI at
          // startup, or loaded via the input box) — attach for the first
          // time rather than waiting for a generation *change*.
          // Decide master-vs-media proactively from isLive rather than
          // reactively after an hls.js error: for live sources ffmpeg has
          // no input bitrate up front, so the generated master playlist
          // reliably comes out with no variants (see ffmpegPipeline.js).
          usingMasterUrl = !data.isLive;
          hasVideo = true;
          lastGeneration = data.generation;
          currentSwitchGeneration = data.generation;
          attachHls();
        } else if (lastGeneration !== null && data.generation !== lastGeneration) {
          lastGeneration = data.generation;
          currentSwitchGeneration = data.generation;
          reloadSource();
        }
      }
    } catch (err) {
      appendLog(`status poll failed: ${err.message}`);
    } finally {
      setTimeout(pollServerStatus, 2000);
    }
  }

  function renderServerStatus(data) {
    $('title').textContent = data.title || data.videoId || '(no video loaded)';
    $('modeBadge').textContent = data.mode ? `mode: ${data.mode}` : '';
    $('liveBadge').textContent = data.isLive ? 'LIVE' : 'VOD';

    const selHeight = data.selected ? data.selected.height : null;
    $('selHeight').textContent = selHeight ? `${selHeight}p` : '–';
    $('highestHeight').textContent = data.highestAvailableHeight ? `${data.highestAvailableHeight}p` : '–';

    const qc = $('qualityCheck');
    if (selHeight && data.highestAvailableHeight) {
      const pass = selHeight >= data.highestAvailableHeight;
      qc.textContent = pass ? 'PASS (highest selected)' : `FAIL (${selHeight}p < ${data.highestAvailableHeight}p)`;
      qc.className = pass ? 'pass' : 'fail';
    } else {
      qc.textContent = '–';
      qc.className = '';
    }

    const cm = $('copyMode');
    if (data.copyConfirmed === true) { cm.textContent = 'copy (no transcode)'; cm.className = 'pass'; }
    else if (data.copyConfirmed === false) { cm.textContent = 'NOT pure copy — check log'; cm.className = 'fail'; }
    else { cm.textContent = 'pending confirmation'; cm.className = 'warn'; }

    $('startupTime').textContent = fmtMs(data.startupTimeMs);
    $('reconnects').textContent = data.reconnectCount != null ? String(data.reconnectCount) : '–';
    $('generation').textContent = data.generation != null ? String(data.generation) : '–';

    $('cpu').textContent = data.cpuPercent != null ? `${data.cpuPercent}% (1 core = 100%)` : 'n/a';
    $('mem').textContent = data.memoryMB != null ? `${data.memoryMB} MB` : 'n/a';
    $('uptime').textContent = fmtMs(data.pocUptimeMs);
  }

  // --- Load button: POST /api/load, then let pollServerStatus's
  // videoId/generation tracking pick up the new stream automatically ---
  async function submitLoad() {
    const val = $('videoIdInput').value.trim();
    if (!val) return;
    const btn = $('loadBtn');
    const status = $('loadStatus');
    btn.disabled = true;
    status.textContent = 'Loading…';
    status.className = '';
    try {
      const res = await fetch('/api/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: val }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Load failed');
      status.textContent = '';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  $('loadBtn').addEventListener('click', submitLoad);
  $('videoIdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitLoad();
  });

  startFpsCounter();
  pollPlaybackStats();
  pollServerStatus();
})();
