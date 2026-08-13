'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT    = __dirname;
const EXE_DIR = path.join(ROOT, 'windows', 'exe');
const IS_WIN  = process.platform === 'win32';

// Resolve a node_modules/.bin binary correctly on both Mac and Windows
function bin(name) {
  return path.join(ROOT, 'node_modules', '.bin', IS_WIN ? `${name}.cmd` : name);
}

function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit', shell: true });
}

// ── Determine next build number by scanning exe/ folder ──────────────────────
function nextBuildNumber() {
  if (!fs.existsSync(EXE_DIR)) return 1;
  const files = fs.readdirSync(EXE_DIR);
  let max = 0;
  for (const f of files) {
    const m = f.match(/SMK TV (\d+)\.exe$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

const BUILD_NUM = nextBuildNumber();
const EXE_NAME  = `SMK TV ${BUILD_NUM}.exe`;
const EXE_OUT   = path.join(EXE_DIR, EXE_NAME);
const EXE_TEMP  = path.join(ROOT, EXE_NAME);

console.log(`\n  ====================================`);
console.log(`   SMK TV — Build #${BUILD_NUM}`);
console.log(`   Output: exe/${EXE_NAME}`);
console.log(`  ====================================`);

// Ensure exe/ output folder exists
fs.mkdirSync(EXE_DIR, { recursive: true });

// Sync .env into the exe folder. The packaged exe reads its env from next to
// process.execPath (windows/exe/.env), not the repo root — that copy silently
// drifted out of sync after Firebase Admin credentials were added to the root
// .env, so every build kept shipping without server-side push notifications
// even though the UI and tunnel worked fine.
const rootEnvPath = path.join(ROOT, '.env');
if (fs.existsSync(rootEnvPath)) {
  fs.copyFileSync(rootEnvPath, path.join(EXE_DIR, '.env'));
  console.log('  .env synced to exe/.env');
}

// Copy cloudflared's native binary next to the exe. Same reason as ffmpeg.exe /
// yt-dlp.exe living here: pkg's snapshot filesystem is virtual, so a binary
// resolved only from inside node_modules (as the cloudflared npm package does
// by default) can't be spawned at runtime — it must exist as a real file next
// to process.execPath. tunnel-manager.cjs points cloudflared at this path via
// cloudflared.use() when process.pkg is set.
const cloudflaredBinSrc = path.join(ROOT, 'live-tv-controller-react', 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
const cloudflaredBinDest = path.join(EXE_DIR, 'cloudflared.exe');
if (fs.existsSync(cloudflaredBinSrc)) {
  try {
    fs.copyFileSync(cloudflaredBinSrc, cloudflaredBinDest);
    console.log('  cloudflared.exe synced to exe/cloudflared.exe');
  } catch (err) {
    // A previous build's app is still running and holding the tunnel open, so
    // the destination is locked. The copy already there came from this same
    // npm package, so this is a no-op worth skipping — aborting the whole
    // build over it just means you can never rebuild without stopping the app.
    if ((err.code === 'EBUSY' || err.code === 'EPERM') && fs.existsSync(cloudflaredBinDest)) {
      console.warn(`  ⚠ cloudflared.exe is locked (${err.code}) — a running SMK TV/tunnel is using it. Keeping the existing copy.`);
    } else {
      throw err;
    }
  }
} else {
  console.warn('  ⚠ cloudflared.exe not found in node_modules — tunnel will not work in this build');
}

// ── Stage the sidecar payload embedded INSIDE the exe ───────────────────────
// Everything above only syncs files into exe/ — they help on THIS machine and
// are lost the moment someone copies just the .exe to another PC. That's how
// the "Direct Relay toggle does nothing on the other PC" bug happened: yt-dlp
// never travelled with the exe, so every relay load failed with "yt-dlp not
// found" and the player silently fell back to the YouTube iframe.
//
// bundled-bin/ is embedded as a pkg asset (see package.json) and unpacked at
// first run by live-tv-controller-react/bundled-sidecars.cjs, so a bare exe is
// self-sufficient. ffmpeg/ffprobe are ~200 MB together and only buy the
// higher-quality split-mux path (the relay falls back to proxy-combined
// without them), so they're opt-in via BUNDLE_FFMPEG=1 rather than doubling
// every build's size.
const PAYLOAD_DIR = path.join(ROOT, 'bundled-bin');

function stagePayload() {
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });

  const wanted = [
    { name: 'yt-dlp.exe',  executable: true,  required: true  },
    { name: 'cookies.txt', executable: false, required: false },
  ];
  if (process.env.BUNDLE_FFMPEG === '1') {
    wanted.push({ name: 'ffmpeg.exe',  executable: true, required: false });
    wanted.push({ name: 'ffprobe.exe', executable: true, required: false });
  }

  const files = [];
  for (const item of wanted) {
    const src = path.join(EXE_DIR, item.name);
    const dest = path.join(PAYLOAD_DIR, item.name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else if (item.name === 'yt-dlp.exe' && downloadYtDlp(dest)) {
      // downloaded into place
    } else {
      if (item.required) {
        console.warn(`  ⚠ ${item.name} not found in exe/ — this build will NOT carry it; Direct Relay and recording will fail on a PC that doesn't already have it`);
      } else {
        console.log(`  · ${item.name} not present in exe/ — skipping (optional)`);
      }
      continue;
    }
    const size = fs.statSync(dest).size;
    files.push({ name: item.name, size, executable: item.executable });
    console.log(`  ✓ bundled ${item.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }

  fs.writeFileSync(
    path.join(PAYLOAD_DIR, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2),
    'utf8'
  );

  if (files.some(f => f.name === 'cookies.txt')) {
    console.warn('  ⚠ cookies.txt is baked into this exe — it contains a live YouTube session. Treat the exe itself as a secret and only share it with machines you trust.');
  }
}

// Fetch the latest yt-dlp release build when exe/ doesn't already have one, so
// a fresh clone still produces a working exe. Best-effort: a failure warns and
// the build continues (same outcome as before this step existed).
function downloadYtDlp(dest) {
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  console.log('  ↓ yt-dlp.exe missing from exe/ — downloading latest release...');
  try {
    execSync(
      `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing"`,
      { stdio: 'inherit' }
    );
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
      // Keep exe/ in sync too, so dev runs (which read from there) get it as well.
      fs.copyFileSync(dest, path.join(EXE_DIR, 'yt-dlp.exe'));
      return true;
    }
  } catch (err) {
    console.warn(`  ⚠ yt-dlp download failed: ${err.message}`);
  }
  try { fs.unlinkSync(dest); } catch {}
  return false;
}

console.log('\n[0/5] Staging bundled sidecars (yt-dlp, cookies)...');
stagePayload();

// Step 1: Build React UI
console.log('\n[1/5] Building React UI...');
run('npm run build', path.join(ROOT, 'live-tv-controller-react'));

// Step 2: Install root devDeps — check for platform-correct binaries
console.log('\n[2/5] Installing build tools...');
const esbuildBin = bin('esbuild');
const pkgBin     = bin('pkg');
if (!fs.existsSync(esbuildBin) || !fs.existsSync(pkgBin)) {
  run('npm install');
}

// Step 3: Bundle ESM API → CJS
console.log('\n[3/5] Bundling API (ESM -> CJS)...');
run(
  `"${esbuildBin}" live-tv-api/server.js` +
  ` --bundle --platform=node --format=cjs` +
  ` --outfile=live-tv-api/.bundle.cjs`
);

// Step 4: Re-bake public/ (LivePlayer.html, LoopPlayer.html, etc.) into
// public-assets.cjs. The packaged EXE serves THIS bundle, never the real
// public/ files on disk (pkg's asset-glob handling for that folder proved
// unreliable — see generate-public-assets.cjs) — skipping this step means
// any edit to public/*.html silently ships stale in the exe even though
// dev mode (which reads the real files) looks correct.
console.log('\n[4/5] Baking public/ assets...');
run('node generate-public-assets.cjs', path.join(ROOT, 'live-tv-controller-react'));

// Step 5: Bundle everything into the versioned exe
console.log(`\n[5/5] Bundling ${EXE_NAME}...`);
run(`"${pkgBin}" . --no-bytecode --public-packages "*" --public --output "${EXE_NAME}"`);

// Clean up temp bundle
try { fs.unlinkSync(path.join(ROOT, 'live-tv-api', '.bundle.cjs')); } catch {}

// Move output to exe/ folder (with retry for OneDrive / antivirus locks)
function moveFile(src, dest, retries = 5, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      if (i < retries - 1) {
        console.log(`  ⏳ File locked (${err.code}), retrying in ${delayMs / 1000}s... (${i + 1}/${retries})`);
        execSync(`powershell -Command "Start-Sleep -Milliseconds ${delayMs}"`, { stdio: 'ignore' });
      }
    }
  }
  // Final fallback: copy + delete
  console.log('  ⏳ Rename failed after retries, falling back to copy + delete...');
  fs.copyFileSync(src, dest);
  try { fs.unlinkSync(src); } catch {}
}

if (fs.existsSync(EXE_TEMP)) {
  moveFile(EXE_TEMP, EXE_OUT);
  const size = (fs.statSync(EXE_OUT).size / 1024 / 1024).toFixed(1);
  console.log(`\n  ====================================`);
  console.log(`   Build #${BUILD_NUM} complete!`);
  console.log(`   File:  exe/${EXE_NAME}  (${size} MB)`);
  console.log(`   Copy to any Windows PC - double-click to run.`);
  console.log(`  ====================================\n`);
} else {
  console.error(`\n  Build failed - ${EXE_NAME} not found.\n`);
  process.exit(1);
}
