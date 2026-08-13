'use strict';
/**
 * Windows: keep every child process off the screen — and off a shared console.
 *
 * Every sidecar this server starts (cloudflared, the PO-Token node server,
 * yt-dlp, ffmpeg, the `cmd /c start` browser opener) is a console application.
 * When Node spawns one on Windows without `windowsHide`, Windows allocates a
 * *visible* console for it — and on Windows 11, where Windows Terminal is the
 * default console host, that means a whole terminal window flashing onto the
 * user's desktop. cloudflared reconnects and the PO-Token server restarts on
 * their own timers, so this was a new window popping up every few seconds.
 *
 * Worse than the flashing: children that end up sharing a console also share
 * its control events. One console window going away delivers CTRL_CLOSE_EVENT
 * to everything attached to it, killing unrelated sidecars with exit code
 * 3221225786 (0xC000013A / STATUS_CONTROL_C_EXIT) — which is exactly what the
 * logs showed, cloudflared and the PO-Token server dying in lockstep and
 * restarting each other forever.
 *
 * `windowsHide: true` maps to CREATE_NO_WINDOW: the child gets its own
 * *invisible* console, so nothing is drawn and no other process's console
 * events can reach it. That breaks the restart loop at the same time.
 *
 * Patched centrally rather than at each call site because the worst offender —
 * cloudflared — is spawned inside the `cloudflared` npm package
 * (node_modules/cloudflared/lib/tunnel.js), which hardcodes its spawn options
 * and gives us no way to pass them in. The package looks the function up on the
 * child_process module object at call time, so replacing it here covers it.
 *
 * Must be required before anything spawns. No-op off Windows.
 */

if (process.platform === 'win32') {
    const cp = require('child_process');

    for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync']) {
        const original = cp[name];
        if (typeof original !== 'function') continue;

        cp[name] = function (...args) {
            // Options are the last plain-object argument; callbacks and the
            // args array are the other shapes these functions accept. Only
            // fill in a default — an explicit windowsHide:false stays honored.
            const opts = args.find(
                (a) => a && typeof a === 'object' && !Array.isArray(a) && typeof a !== 'function'
            );
            if (opts) {
                if (opts.windowsHide === undefined) opts.windowsHide = true;
            } else {
                // No options object at all: insert one before any callback.
                const cbIndex = args.findIndex((a) => typeof a === 'function');
                const injected = { windowsHide: true };
                if (cbIndex === -1) args.push(injected);
                else args.splice(cbIndex, 0, injected);
            }
            return original.apply(this, args);
        };
    }
}
