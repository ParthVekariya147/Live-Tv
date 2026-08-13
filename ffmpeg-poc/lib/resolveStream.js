'use strict';
// Talks to yt-dlp to figure out (a) whether a video is LIVE or VOD and
// (b) the best streams to feed ffmpeg.
//
// Selection strategy, in priority order:
//   1. "split" mode — a video-only format AND an audio-only format both
//      exist. This is the normal YouTube DASH case for VOD (and for some
//      live streams) and is the ONLY way to reach true max quality, because
//      YouTube's combined/progressive formats are capped well below the
//      video-only ceiling (verified: on a 4K test VOD, progressive tops out
//      around 360p while video-only DASH goes up to 2160p60 VP9/AV1).
//      ffmpeg receives two inputs and muxes (copy) them together.
//   2. "combined" mode — fallback for when no video-only/audio-only pair
//      exists (typically YouTube Live, which usually only exposes HLS
//      variants that already carry audio+video together per itag). We pick
//      the highest-resolution combined format and hand its URL straight to
//      ffmpeg as a single input; ffmpeg's HLS demuxer follows master/media
//      playlists natively, so this works whether yt-dlp gives us a media
//      playlist URL, a master playlist URL, or a plain progressive URL.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HEIGHT_LADDER = [2160, 1440, 1080, 720, 480, 360, 240, 144];

// Auto-detected default so cookies just work with zero setup once exported —
// no env var needed on every run. Never committed (see .gitignore).
const DEFAULT_COOKIES_FILE = path.join(__dirname, '..', 'cookies.txt');
function resolveCookiesFile() {
  if (process.env.FFMPEG_POC_COOKIES_FILE) return process.env.FFMPEG_POC_COOKIES_FILE;
  try { return fs.existsSync(DEFAULT_COOKIES_FILE) ? DEFAULT_COOKIES_FILE : null; } catch { return null; }
}

// Root cause of the "our pipeline caps live streams at 1080p while
// youtube.com shows 1440p/2160p" bug: without a PO Token, YouTube's 'web'
// client (the one that reports the TRUE full quality ladder, same as the
// browser) returns either storyboard-only or zero usable formats — so
// yt-dlp silently falls back to other clients (e.g. 'tv'), which authenticate
// fine but are deliberately capped at 1080p for live content by YouTube
// itself. The fix is a local PO Token provider: a small HTTP server
// (bgutil-ytdlp-pot-provider, vendored under pot-server-src/, run separately
// via `node build/main.js`, default port 4416) plus a yt-dlp plugin that
// talks to it. --plugin-dirs points at our own isolated copy of that plugin
// (pot-plugin/) so nothing outside ffmpeg-poc/ is touched. If the server
// isn't running, yt-dlp just logs that the bgutil provider is unavailable
// and falls back to its prior (1080p-capped) behavior — never a hard error.
const POT_PLUGIN_DIR = path.join(__dirname, '..', 'pot-plugin');

function fetchInfo(ytDlpPath, url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-warnings', '--no-playlist', '--no-check-certificates'];
    // Required for YouTube's current JS-based signature/challenge handling —
    // without a JS runtime, yt-dlp silently falls back to a degraded client
    // (confirmed: returns storyboard-only formats, no real video/audio) even
    // with valid cookies. Node is already a hard dependency of this whole
    // PoC, so this is always safe to enable.
    args.push('--js-runtimes', 'node');
    if (fs.existsSync(POT_PLUGIN_DIR)) {
      args.push('--plugin-dirs', POT_PLUGIN_DIR);
    }
    // YouTube sometimes bot-checks a request ("Sign in to confirm you're not
    // a bot") depending on the video and yt-dlp's current fingerprint —
    // unrelated to this pipeline, and yt-dlp's own suggested fix. Preferred:
    // a Netscape-format cookies.txt exported once (e.g. via a "cookies.txt"
    // browser extension, or `yt-dlp --cookies-from-browser chrome --cookies
    // cookies.txt` with the browser closed just for that one export) and
    // dropped at ffmpeg-poc/cookies.txt — auto-detected below, or override
    // the location with FFMPEG_POC_COOKIES_FILE. Reading a plain file works
    // with the browser left open; confirmed --cookies-from-browser alone
    // does NOT, since Chrome/Edge lock their cookie database while running.
    const cookiesFile = resolveCookiesFile();
    if (cookiesFile) {
      args.push('--cookies', cookiesFile);
    } else if (process.env.FFMPEG_POC_COOKIES_FROM_BROWSER) {
      args.push('--cookies-from-browser', process.env.FFMPEG_POC_COOKIES_FROM_BROWSER);
    }
    args.push(url);
    console.log('[ffmpeg-poc] Launching yt-dlp:');
    console.log('[ffmpeg-poc]   Executable:', ytDlpPath);
    console.log('[ffmpeg-poc]   Arguments: ', args.join(' '));
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* noop */ }
      reject(new Error('yt-dlp timed out after 25s'));
    }, 25000);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().slice(0, 400) || '(no stderr)'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp JSON output: ${err.message}`));
      }
    });
  });
}

function classifyLiveStatus(info) {
  switch (info.live_status) {
    case 'is_live': return { isLive: true, playable: true, note: null };
    case 'is_upcoming': return { isLive: true, playable: false, note: 'Stream has not started broadcasting yet.' };
    case 'was_live':
    case 'post_live': return { isLive: false, playable: true, note: 'Finished live broadcast — treated as VOD.' };
    default: return { isLive: false, playable: true, note: null };
  }
}

function isUsableFormat(f) {
  // Storyboards and other non-media formats have both codecs 'none' and are
  // already excluded by the video/audio-only filters below; this just
  // guards against formats yt-dlp listed without a fetchable URL.
  return !!(f && f.url);
}

function pickBestVideoOnly(formats) {
  const candidates = formats.filter((f) =>
    isUsableFormat(f) && f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  return candidates[0];
}

function pickBestAudioOnly(formats) {
  const candidates = formats.filter((f) =>
    isUsableFormat(f) && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.abr || 0) - (a.abr || 0) || (b.tbr || 0) - (a.tbr || 0));
  return candidates[0];
}

function pickBestCombined(formats) {
  const candidates = formats.filter((f) =>
    isUsableFormat(f) && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  return candidates[0];
}

function describeFormat(f) {
  if (!f) return null;
  return {
    formatId: f.format_id,
    url: f.url,
    ext: f.ext,
    height: f.height || null,
    width: f.width || null,
    fps: f.fps || null,
    vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
    acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
    tbr: f.tbr || null,
    abr: f.abr || null,
    protocol: f.protocol || null,
    httpHeaders: f.http_headers || {},
  };
}

function buildAvailableHeights(formats) {
  const heights = new Set(
    formats
      .filter((f) => f.height && ((f.vcodec && f.vcodec !== 'none') || (f.acodec && f.acodec !== 'none')))
      .map((f) => f.height)
  );
  return HEIGHT_LADDER.map((h) => ({ height: h, available: heights.has(h) }));
}

async function resolveStream(ytDlpPath, url) {
  const info = await fetchInfo(ytDlpPath, url);
  const { isLive, playable, note } = classifyLiveStatus(info);

  if (!playable) {
    const err = new Error(note || 'Video is not currently playable.');
    err.code = 'NOT_PLAYABLE';
    throw err;
  }

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const bestVideo = pickBestVideoOnly(formats);
  const bestAudio = pickBestAudioOnly(formats);
  const bestCombined = pickBestCombined(formats);

  const availableHeights = buildAvailableHeights(formats);
  const allHeightCandidates = formats.filter((f) => f.height).map((f) => f.height);
  const highestAvailableHeight = allHeightCandidates.length ? Math.max(...allHeightCandidates) : null;

  let mode, video, audio, combined;
  if (bestVideo && bestAudio) {
    mode = 'split';
    video = describeFormat(bestVideo);
    audio = describeFormat(bestAudio);
    combined = null;
  } else if (bestCombined) {
    mode = 'combined';
    video = null;
    audio = null;
    combined = describeFormat(bestCombined);
  } else {
    throw new Error('No usable video/audio formats found for this video.');
  }

  return {
    videoId: info.id,
    title: info.title || null,
    isLive,
    liveNote: note,
    mode,
    video,
    audio,
    combined,
    availableHeights,
    highestAvailableHeight,
    resolvedAt: Date.now(),
  };
}

module.exports = { resolveStream, HEIGHT_LADDER };
