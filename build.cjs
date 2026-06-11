'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT    = __dirname;
const EXE_DIR = path.join(ROOT, 'exe');

function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });
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

const BUILD_NUM  = nextBuildNumber();
const EXE_NAME   = `SMK TV ${BUILD_NUM}.exe`;
const EXE_OUT    = path.join(EXE_DIR, EXE_NAME);
const EXE_TEMP   = path.join(ROOT, EXE_NAME);  // pkg writes here first

console.log(`\n  ====================================`);
console.log(`   SMK TV — Build #${BUILD_NUM}`);
console.log(`   Output: exe/${EXE_NAME}`);
console.log(`  ====================================`);

// Ensure exe/ output folder exists
fs.mkdirSync(EXE_DIR, { recursive: true });

// Step 1: Build React UI (generates live-tv-controller-react/dist/)
console.log('\n[1/4] Building React UI...');
run('npm run build', path.join(ROOT, 'live-tv-controller-react'));

// Step 2: Install root devDeps (gets esbuild + @yao-pkg/pkg)
console.log('\n[2/4] Installing build tools...');
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'esbuild')) ||
    !fs.existsSync(path.join(ROOT, 'node_modules', '@yao-pkg'))) {
  run('npm install');
}

// Step 3: Bundle ESM API → CJS (pkg can't handle ESM top-level await)
console.log('\n[3/4] Bundling API (ESM → CJS)...');
run(
  'node_modules/.bin/esbuild live-tv-api/server.js' +
  ' --bundle --platform=node --format=cjs' +
  ' --outfile=live-tv-api/.bundle.cjs'
);

// Step 4: Bundle everything into the versioned exe
console.log(`\n[4/4] Bundling ${EXE_NAME}...`);
run(`node_modules/.bin/pkg . --no-bytecode --public-packages "*" --public --output "${EXE_NAME}"`);

// Clean up temp bundle
try { fs.unlinkSync(path.join(ROOT, 'live-tv-api', '.bundle.cjs')); } catch {}

// Move output to exe/ folder
if (fs.existsSync(EXE_TEMP)) {
  fs.renameSync(EXE_TEMP, EXE_OUT);
  const size = (fs.statSync(EXE_OUT).size / 1024 / 1024).toFixed(1);
  console.log(`\n  ====================================`);
  console.log(`   Build #${BUILD_NUM} complete!`);
  console.log(`   File:  exe/${EXE_NAME}  (${size} MB)`);
  console.log(`   Copy to any Windows PC — double-click to run.`);
  console.log(`  ====================================\n`);
} else {
  console.error(`\n  Build failed — ${EXE_NAME} not found.\n`);
  process.exit(1);
}
