/**
 * Runtime isolation test — drives the REAL public/LivePlayer.html and
 * public/LoopPlayer.html in Chromium and asserts what each pipeline actually does.
 *
 * This is the check that unit tests cannot make: that an ordinary Video ID loaded
 * into the Live Player never reaches the server's relay (yt-dlp + cookies.txt +
 * ffmpeg), and that every event a player publishes carries the identity of the load
 * it belongs to, so a stale event can be rejected.
 *
 * The YouTube IFrame API and hls.js are stubbed — this exercises OUR branching, not
 * YouTube's, and needs no network.
 *
 * Run: node tests/playback-isolation-e2e.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/tmp/claude-0/node_modules/playwright');

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(APP, 'public');

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n          got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
};

// ── a static server for public/, plus a recorder for every API call the page makes
const apiCalls = [];
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            apiCalls.push({ path: url.pathname, method: req.method, body });
            res.setHeader('Content-Type', 'application/json');
            if (url.pathname === '/api/state/obs.activeSource') return res.end(JSON.stringify({ value: 'Loop Player' }));
            if (url.pathname === '/api/relay/load') return res.end(JSON.stringify({ success: true, report: { type: 'VOD' } }));
            return res.end(JSON.stringify({ success: true }));
        });
        return;
    }
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'application/javascript');
    res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── stub YT + hls.js so the pages' own branching is what gets exercised
const STUBS = `
window.__published = [];
window.YT = {
  PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: function (el, cfg) {
    window.__ytPlayer = this;
    this.cfg = cfg;
    this.loaded = [cfg.videoId];
    this.loadVideoById = (o) => { this.loaded.push(o.videoId || o); };
    this.cueVideoById  = (o) => { this.loaded.push(o.videoId || o); };
    this.playVideo = () => {}; this.pauseVideo = () => {}; this.stopVideo = () => {};
    this.mute = () => {}; this.unMute = () => {}; this.isMuted = () => false;
    this.setVolume = () => {}; this.seekTo = () => {}; this.destroy = () => {};
    this.getPlaybackQuality = () => 'hd1080';
    this.getAvailableQualityLevels = () => ['hd1080', 'hd720'];
    this.setPlaybackQuality = () => {};
    this.getVideoLoadedFraction = () => 1;
    this.getPlayerState = () => 1;
    this.getVideoData = () => ({ video_id: cfg.videoId });
    this.getDuration = () => 100; this.getCurrentTime = () => 1;
    this.getPlaybackRate = () => 1; this.getOptions = () => [];
    setTimeout(() => { if (cfg.events && cfg.events.onReady) cfg.events.onReady({ target: this }); }, 5);
  },
};
window.Hls = function () {
  this.on = () => {}; this.loadSource = () => {}; this.attachMedia = () => {}; this.destroy = () => {};
};
window.Hls.isSupported = () => true;
window.Hls.Events = { FRAG_BUFFERED: 'f', MANIFEST_PARSED: 'm', ERROR: 'e' };
window.Hls.ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'md' };
window.Hls.ErrorDetails = { BUFFER_STALLED_ERROR: 'b' };

// Capture every event the page publishes, without stopping the real POST.
const _beacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
navigator.sendBeacon = function (url, blob) {
  if (blob && blob.text) blob.text().then((t) => { try { window.__published.push(JSON.parse(t)); } catch (e) {} });
  return _beacon ? _beacon(url, blob) : true;
};
// Fire a command exactly the way the controller does — a storage event.
window.__send = function (key, cmd) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(cmd) }));
};
`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext();
await ctx.addInitScript(STUBS);
await ctx.route('**/www.youtube.com/**', (route) => route.abort());

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nLive Player — a NORMAL video must never reach the relay (yt-dlp/cookies/ffmpeg)');
{
    const page = await ctx.newPage();
    await page.goto(`${BASE}/LivePlayer.html`);
    await page.waitForFunction('typeof window.__send === "function"');

    // Direct Relay deliberately left ON for the whole test — the point is that the
    // toggle alone must no longer be able to pull an ordinary video through yt-dlp.
    await page.evaluate(() => window.__send('livePlayerCommand', { command: 'setRelayMode', useRelay: true }));
    apiCalls.length = 0;

    await page.evaluate(() => window.__send('livePlayerCommand', {
        command: 'loadVideo', videoId: 'NORMALVID1', mode: 'normal', playbackSessionId: 'sess-normal-1',
    }));
    await page.waitForTimeout(400);
    check('normal mode + relay toggle ON -> /api/relay/load NOT called',
        apiCalls.filter((c) => c.path === '/api/relay/load').length, 0);

    apiCalls.length = 0;
    await page.evaluate(() => window.__send('livePlayerCommand', {
        command: 'loadVideo', videoId: 'LIVEVID1', mode: 'live', playbackSessionId: 'sess-live-1',
    }));
    await page.waitForTimeout(400);
    check('live mode + relay toggle ON -> /api/relay/load IS called (live path intact)',
        apiCalls.filter((c) => c.path === '/api/relay/load').length, 1);

    // A command with no mode at all is what every pre-upgrade caller sends.
    apiCalls.length = 0;
    await page.evaluate(() => window.__send('livePlayerCommand', { command: 'loadVideo', videoId: 'LEGACYVID' }));
    await page.waitForTimeout(400);
    check('no mode given -> treated as live (no regression for existing callers)',
        apiCalls.filter((c) => c.path === '/api/relay/load').length, 1);

    check('the YouTube iframe played every one of them regardless',
        await page.evaluate(() => window.__ytPlayer.loaded.slice(-3)),
        ['NORMALVID1', 'LIVEVID1', 'LEGACYVID']);
    await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nEvent identity — every published event must say which load it belongs to');
{
    const page = await ctx.newPage();
    await page.goto(`${BASE}/LivePlayer.html`);
    await page.waitForFunction('typeof window.__send === "function"');
    await page.evaluate(() => window.__send('livePlayerCommand', {
        command: 'loadVideo', videoId: 'VIDA', mode: 'normal', playbackSessionId: 'sess-A',
    }));
    await page.waitForTimeout(300);
    // Force the player to report an end, the way YouTube would.
    await page.evaluate(() => {
        window.__ytPlayer.cfg.events.onStateChange({ data: window.YT.PlayerState.PLAYING, target: window.__ytPlayer });
        window.__ytPlayer.cfg.events.onStateChange({ data: window.YT.PlayerState.ENDED, target: window.__ytPlayer });
    });
    await page.waitForTimeout(300);
    const ended = await page.evaluate(() => window.__published.filter((e) => e.event === 'videoEnded').pop());
    check('videoEnded carries its session', ended?.playbackSessionId, 'sess-A');
    check('videoEnded carries its videoId', ended?.videoId, 'VIDA');
    check('videoEnded carries its mode', ended?.mode, 'normal');

    // Load the next video, then let the OLD one report an error late.
    await page.evaluate(() => window.__send('livePlayerCommand', {
        command: 'loadVideo', videoId: 'VIDB', mode: 'normal', playbackSessionId: 'sess-B',
    }));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__ytPlayer.cfg.events.onError({ data: 150, target: window.__ytPlayer }));
    await page.waitForTimeout(300);
    const err = await page.evaluate(() => window.__published.filter((e) => e.event === 'videoError').pop());
    check('a later event is stamped with the CURRENT session, so the stale one is identifiable',
        err?.playbackSessionId, 'sess-B');
    await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nLoop Player — ordinary Video IDs, identity on every event, no live machinery');
{
    const page = await ctx.newPage();
    await page.goto(`${BASE}/LoopPlayer.html`);
    await page.waitForFunction('typeof window.__send === "function"');
    await page.waitForTimeout(400); // let resolveVisibilityFromServer settle
    apiCalls.length = 0;

    await page.evaluate(() => window.__send('loopPlayerCommand', {
        command: 'loadVideo', videoId: 'LOOPVID1', mode: 'normal', playbackSessionId: 'sess-loop-1',
    }));
    await page.waitForTimeout(400);
    check('Loop Player never calls the relay',
        apiCalls.filter((c) => c.path.startsWith('/api/relay')).length, 0);

    await page.evaluate(() => {
        window.__ytPlayer.cfg.events.onStateChange({ data: window.YT.PlayerState.PLAYING, target: window.__ytPlayer });
        window.__ytPlayer.cfg.events.onStateChange({ data: window.YT.PlayerState.ENDED, target: window.__ytPlayer });
    });
    await page.waitForTimeout(300);
    const loopEnded = await page.evaluate(() => window.__published.filter((e) => e.event === 'videoEnded').pop());
    check('Loop videoEnded now carries a videoId (it carried none before)', loopEnded?.videoId, 'LOOPVID1');
    check('Loop videoEnded carries its session', loopEnded?.playbackSessionId, 'sess-loop-1');
    check('Loop mode is normal', loopEnded?.mode, 'normal');

    await page.evaluate(() => window.__ytPlayer.cfg.events.onError({ data: 150, target: window.__ytPlayer }));
    await page.waitForTimeout(200);
    const loopErr = await page.evaluate(() => window.__published.filter((e) => e.event === 'videoError').pop());
    check('Loop videoError is published as an ERROR with its code, not as an end',
        [loopErr?.event, loopErr?.errorCode, loopErr?.videoId], ['videoError', 150, 'LOOPVID1']);
    await page.close();
}

await browser.close();
server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
