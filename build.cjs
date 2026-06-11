'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;

function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });
}

// Step 1: Build React UI (generates live-tv-controller-react/dist/)
console.log('\n[1/4] Building React UI...');
run('npm run build', path.join(ROOT, 'live-tv-controller-react'));

// Step 2: Install root devDeps (gets esbuild + @yao-pkg/pkg)
console.log('\n[2/4] Installing build tools...');
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'esbuild')) ||
    !fs.existsSync(path.join(ROOT, 'node_modules', '@yao-pkg'))) {
  run('npm install');
}

// Step 3: Bundle ESM API into a single CJS file using esbuild
// (pkg can't handle ESM top-level await; esbuild converts it cleanly)
console.log('\n[3/4] Bundling API (ESM → CJS)...');
run(
  'node_modules/.bin/esbuild live-tv-api/server.js' +
  ' --bundle --platform=node --format=cjs' +
  ' --outfile=live-tv-api/.bundle.cjs'
);

// Step 4: Bundle everything into SMK TV.exe
console.log('\n[4/4] Bundling SMK TV.exe...');
run('node_modules/.bin/pkg . --no-bytecode --public-packages "*" --public --output "SMK TV.exe"');

// Clean up temp bundle
try { fs.unlinkSync(path.join(ROOT, 'live-tv-api', '.bundle.cjs')); } catch {}

const exePath = path.join(ROOT, 'SMK TV.exe');
if (fs.existsSync(exePath)) {
  const size = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  console.log(`\n  Done!  "SMK TV.exe"  (${size} MB)`);
  console.log('  Copy this single file to any Windows PC — double-click to run.\n');
} else {
  console.error('\n  Build failed — SMK TV.exe not found.\n');
  process.exit(1);
}
