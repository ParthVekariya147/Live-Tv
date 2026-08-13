'use strict';
// Resolves the yt-dlp / ffmpeg / ffprobe binaries this PoC will shell out to.
//
// This PoC is standalone: it does NOT import server.cjs or anything from the
// production app. It only *reads* (never writes to) the repo's bundled
// windows/exe/yt-dlp.exe if present, purely as a convenience so a working
// yt-dlp is available even before the user installs one system-wide.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const repoRoot = path.resolve(__dirname, '..', '..'); // .../Live-Tv

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function findYtDlp() {
  const bundled = path.join(repoRoot, 'windows', 'exe', isWin ? 'yt-dlp.exe' : 'yt-dlp');
  if (exists(bundled)) return bundled;
  return isWin ? 'yt-dlp.exe' : 'yt-dlp';
}

// Windows doesn't propagate a PATH change made by an installer to shells
// that were already open, and often not even to new shells spawned from an
// already-running Explorer until logoff/logon. Rather than requiring a
// terminal restart every time, look directly inside winget's own install
// location as a fallback — this works in the *current* shell immediately.
function findWinget(exeName) {
  if (!isWin) return null;
  const packagesDir = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'Microsoft', 'WinGet', 'Packages'
  );
  try {
    const pkgDir = fs.readdirSync(packagesDir).find((d) => d.startsWith('Gyan.FFmpeg'));
    if (!pkgDir) return null;
    const versionDir = fs.readdirSync(path.join(packagesDir, pkgDir)).find((d) => d.startsWith('ffmpeg-'));
    if (!versionDir) return null;
    const candidate = path.join(packagesDir, pkgDir, versionDir, 'bin', exeName);
    return exists(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function checkVersion(bin, args) {
  try {
    const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000 });
    if (res.error || res.status !== 0) return null;
    // yt-dlp prints its version to stdout; ffmpeg/ffprobe print their banner
    // to stderr (both keep stdout free for piped media data).
    const text = (res.stdout && res.stdout.trim()) || (res.stderr && res.stderr.trim()) || '';
    return text.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

function resolveBinaries() {
  // FFMPEG_POC_YTDLP / FFMPEG_POC_FFMPEG / FFMPEG_POC_FFPROBE let you point
  // at an absolute binary path directly, bypassing PATH lookup entirely —
  // useful when a binary was just installed and the current shell's PATH
  // hasn't picked it up yet, or when it lives somewhere PATH doesn't reach.
  const ytDlpPath = process.env.FFMPEG_POC_YTDLP || findYtDlp();
  const ytDlpVersion = checkVersion(ytDlpPath, ['--version']);

  const ffmpegPathDefault = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobePathDefault = isWin ? 'ffprobe.exe' : 'ffprobe';
  let ffmpegBin = process.env.FFMPEG_POC_FFMPEG || ffmpegPathDefault;
  let ffprobeBin = process.env.FFMPEG_POC_FFPROBE || ffprobePathDefault;
  let ffmpegVersion = checkVersion(ffmpegBin, ['-version']);
  let ffprobeVersion = checkVersion(ffprobeBin, ['-version']);

  if (!ffmpegVersion && !process.env.FFMPEG_POC_FFMPEG) {
    const found = findWinget('ffmpeg.exe');
    if (found) { ffmpegBin = found; ffmpegVersion = checkVersion(ffmpegBin, ['-version']); }
  }
  if (!ffprobeVersion && !process.env.FFMPEG_POC_FFPROBE) {
    const found = findWinget('ffprobe.exe');
    if (found) { ffprobeBin = found; ffprobeVersion = checkVersion(ffprobeBin, ['-version']); }
  }

  return {
    ytDlp: { path: ytDlpPath, version: ytDlpVersion, ok: !!ytDlpVersion },
    ffmpeg: { path: ffmpegBin, version: ffmpegVersion, ok: !!ffmpegVersion },
    ffprobe: { path: ffprobeBin, version: ffprobeVersion, ok: !!ffprobeVersion },
  };
}

function printInstallHelp(bins) {
  console.error('');
  console.error('='.repeat(70));
  console.error('Missing required binaries for ffmpeg-poc:');
  if (!bins.ytDlp.ok) console.error('  - yt-dlp: not found on PATH (and no bundled copy usable)');
  if (!bins.ffmpeg.ok) console.error('  - ffmpeg: not found on PATH');
  if (!bins.ffprobe.ok) console.error('  - ffprobe: not found on PATH');
  console.error('');
  console.error('Install on Windows (pick one):');
  console.error('  winget install "FFmpeg (Essentials Build)"');
  console.error('  choco install ffmpeg');
  console.error('  scoop install ffmpeg');
  console.error('  or download from https://www.gyan.dev/ffmpeg/builds/ and add the bin/ folder to PATH');
  console.error('');
  console.error('  winget install yt-dlp.yt-dlp   (or pip install -U yt-dlp)');
  console.error('');
  console.error('After installing, restart your terminal so PATH changes take effect.');
  console.error('='.repeat(70));
}

module.exports = { resolveBinaries, printInstallHelp };
