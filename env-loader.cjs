'use strict';
/**
 * Tiny .env loader shared by every CJS entry point (smk-launcher, server.cjs,
 * ecosystem.config.cjs, smk.cjs). No dependency on the `dotenv` package so it
 * works unmodified inside the pkg-bundled EXE.
 *
 * Never overwrites a variable that is already set in process.env, so real
 * shell env vars / PM2 env / launcher-injected env always win over the file.
 */
const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  const resolved = path.isAbsolute(envPath) ? envPath : path.join(__dirname, envPath);
  if (!fs.existsSync(resolved)) return;

  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

module.exports = { loadEnv };
