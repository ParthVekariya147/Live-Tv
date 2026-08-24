/**
 * Notification Catalog — the single source of truth for every push notification
 * this app can send.
 *
 * Before this file, each notification's title and body lived as a hardcoded
 * arrow function inside notification-service.cjs, so the wording could only be
 * changed by editing and rebuilding the exe. Everything here is data instead:
 * a default title/body written as a `{placeholder}` string, the list of
 * placeholders that event actually provides, and which group it belongs to in
 * the UI. The operator's own overrides are stored per event in
 * `notifications.settings.templates` and rendered by the same renderTemplate()
 * the defaults go through, so a custom template is never a second code path.
 *
 * Required by notification-service.cjs (rendering) and served verbatim to the
 * React panel by GET /api/notifications/catalog — the UI never keeps its own
 * copy of the event list, so adding an event here is all it takes to make it
 * appear, editable, in the Notification Panel.
 *
 * Deliberately dependency-free and CommonJS so both the packaged exe (pkg) and
 * plain `node server.cjs` load it identically.
 */

// Every event can use these on top of its own vars — filled in at send time.
const GLOBAL_VARS = [
    { name: 'appName', sample: 'SMK TV',   hint: 'Your notification name from the panel above' },
    { name: 'time',    sample: '9:42 PM',  hint: 'Local time the event happened' },
    { name: 'date',    sample: '17/8/2026', hint: 'Local date the event happened' },
];

// Groups are rendered as collapsible sections, in this order.
const GROUPS = [
    { id: 'scheduler', label: 'Scheduler',        hint: 'Fired by the shared scheduler at a set time' },
    { id: 'manual',    label: 'Manual changes',   hint: 'Fired when YOU change something by hand' },
    { id: 'playlist',  label: 'Playlists',        hint: 'Loop Playlist Automation groups and lists' },
    { id: 'obs',       label: 'OBS outputs',      hint: 'Stream, OBS recorder and virtual camera' },
    { id: 'recording', label: 'Server recording', hint: 'The built-in yt-dlp recorder' },
    { id: 'system',    label: 'System',           hint: 'Backups, memory and live detection' },
];

/**
 * clientEmit: true means the browser is allowed to raise this event through
 * POST /api/notifications/emit. Events that are proof of a server-side fact
 * (memory pressure, a backup landing on disk, a recorder exiting) are left
 * false so a paired phone can't fabricate them.
 */
const EVENTS = [
    // ── Scheduler ───────────────────────────────────────────────────────────
    {
        key: 'SCHEDULER_TRIGGER',
        label: 'Schedule triggered',
        group: 'scheduler',
        hint: 'A scheduled show/hide or action ran and was confirmed.',
        tag: 'scheduler-trigger',
        defaultEnabled: true,
        clientEmit: false,
        vars: [
            { name: 'scheduleName', sample: 'Morning Katha', hint: 'Name of the schedule row' },
            { name: 'action',       sample: 'show',          hint: 'show / hide / katha_refresh …' },
        ],
        title: 'Scheduler: {scheduleName}',
        body:  'Action "{action}" at {time}',
    },
    {
        key: 'SCHEDULER_TRIGGER_FAILED',
        label: 'Schedule did NOT run',
        group: 'scheduler',
        hint: 'The timer matched but OBS never confirmed the change.',
        tag: 'scheduler-trigger-failed',
        defaultEnabled: true,
        clientEmit: false,
        vars: [
            { name: 'scheduleName', sample: 'Morning Katha', hint: 'Name of the schedule row' },
            { name: 'action',       sample: 'show',          hint: 'What it tried to do' },
            { name: 'reason',       sample: 'not confirmed by OBS', hint: 'Why it failed' },
        ],
        title: '⚠ {scheduleName} did not run',
        body:  '"{action}" failed: {reason}',
    },
    {
        key: 'SCHEDULER_ALERT',
        label: 'Scheduler alert',
        group: 'scheduler',
        hint: 'A schedule failed repeatedly and the scheduler raised an alert.',
        tag: 'scheduler-alert',
        defaultEnabled: true,
        clientEmit: false,
        vars: [
            { name: 'scheduleName', sample: 'Morning Katha', hint: 'Name of the schedule row' },
            { name: 'retries',      sample: '3',             hint: 'How many attempts failed' },
        ],
        title: 'Scheduler Alert',
        body:  '"{scheduleName}" failed {retries} times',
    },

    // ── Manual changes ──────────────────────────────────────────────────────
    {
        key: 'PLAYER_SWITCHED_MANUAL',
        label: 'Player switched by hand',
        group: 'manual',
        hint: 'You pressed one of the four player buttons yourself.',
        tag: 'player-switch',
        defaultEnabled: true,
        clientEmit: true,
        vars: [
            { name: 'player',         sample: 'Live Player', hint: 'The player now on air' },
            { name: 'previousPlayer', sample: 'Loop Player', hint: 'What was on air before' },
        ],
        title: '🔀 {player} is now on air',
        body:  'Switched by hand from {previousPlayer} at {time}',
    },
    {
        key: 'PLAYER_SWITCHED_AUTO',
        label: 'Player switched automatically',
        group: 'manual',
        hint: 'A playlist run or an end-of-video handoff changed the on-air player (not the scheduler).',
        tag: 'player-switch',
        defaultEnabled: true,
        clientEmit: true,
        vars: [
            { name: 'player',         sample: 'Loop Player',  hint: 'The player now on air' },
            { name: 'previousPlayer', sample: 'Delay Live',   hint: 'What was on air before' },
            { name: 'trigger',        sample: 'automation',   hint: 'automation / auto_handoff' },
        ],
        title: '🔁 {player} is now on air',
        body:  'Switched automatically from {previousPlayer} ({trigger}) at {time}',
    },
    {
        key: 'VIDEO_CHANGED_MANUAL',
        label: 'Video loaded by hand',
        group: 'manual',
        hint: 'You loaded a video into a player yourself.',
        tag: 'video-change',
        defaultEnabled: true,
        clientEmit: true,
        vars: [
            { name: 'player',     sample: 'Loop Player',        hint: 'Which player it went into' },
            { name: 'videoTitle', sample: 'Evening Katha Live', hint: 'Video title (may be blank)' },
            { name: 'videoId',    sample: 'dQw4w9WgXcQ',        hint: 'YouTube video id' },
        ],
        title: '🎬 {player}: new video loaded',
        body:  '{videoTitle} — loaded by hand at {time}',
    },

    // ── Playlists ───────────────────────────────────────────────────────────
    {
        key: 'PLAYLIST_STARTED',
        label: 'Playlist started',
        group: 'playlist',
        hint: 'A Group → List run began (manually, by schedule, by chain, or as the idle fallback).',
        tag: 'playlist',
        defaultEnabled: true,
        clientEmit: true,
        vars: [
            { name: 'group',      sample: 'Daily Katha',  hint: 'Group name' },
            { name: 'list',       sample: 'Morning Set',  hint: 'List name' },
            { name: 'videoCount', sample: '12',           hint: 'Videos in the list' },
            { name: 'trigger',    sample: 'Manual',       hint: 'Manual / Chained / Scheduled / Idle fallback / Live event' },
        ],
        title: '▶️ Playlist: {list}',
        body:  '{trigger} — "{list}" from "{group}" ({videoCount} videos) at {time}',
    },
    {
        key: 'PLAYLIST_STOPPED',
        label: 'Playlist stopped',
        group: 'playlist',
        hint: 'A playlist run ended and the Loop Player went back to manual control.',
        tag: 'playlist',
        defaultEnabled: true,
        clientEmit: true,
        vars: [
            { name: 'group',   sample: 'Daily Katha', hint: 'Group that was running' },
            { name: 'list',    sample: 'Morning Set', hint: 'List that was running' },
            { name: 'trigger', sample: 'Manual stop', hint: 'Manual stop / Chain ended' },
        ],
        title: '⏹️ Playlist stopped',
        body:  '{trigger} — "{list}" from "{group}" at {time}',
    },
    {
        key: 'PLAYLIST_VIDEO_CHANGED',
        label: 'Playlist moved to next video',
        group: 'playlist',
        hint: 'Chatty by design — one push per video inside a running list. Off by default.',
        tag: 'playlist-video',
        defaultEnabled: false,
        clientEmit: true,
        vars: [
            { name: 'group',      sample: 'Daily Katha',  hint: 'Group name' },
            { name: 'list',       sample: 'Morning Set',  hint: 'List name' },
            { name: 'position',   sample: '2',            hint: 'Which video of this run' },
            { name: 'total',      sample: '3',            hint: 'Videos this run will play' },
        ],
        title: '⏭️ {list}: video {position}/{total}',
        body:  'Now playing from "{group}" at {time}',
    },

    // ── OBS outputs ─────────────────────────────────────────────────────────
    {
        key: 'STREAM_STARTED',
        label: 'OBS stream started',
        group: 'obs',
        hint: 'Fires however it was started — from this app or from OBS itself.',
        tag: 'obs-stream',
        defaultEnabled: true,
        clientEmit: true,
        vars: [],
        title: '🟢 Stream is LIVE',
        body:  'OBS started streaming at {time}',
    },
    {
        key: 'STREAM_STOPPED',
        label: 'OBS stream stopped',
        group: 'obs',
        hint: 'Fires however it was stopped — from this app or from OBS itself.',
        tag: 'obs-stream',
        defaultEnabled: true,
        clientEmit: true,
        vars: [],
        title: '🔴 Stream stopped',
        body:  'OBS stopped streaming at {time}',
    },
    {
        key: 'OBS_RECORDING_STARTED',
        label: "OBS recorder started",
        group: 'obs',
        hint: "OBS's own recorder — separate from the server's yt-dlp recorder below.",
        tag: 'obs-record',
        defaultEnabled: true,
        clientEmit: true,
        vars: [],
        title: '⏺️ OBS recording started',
        body:  'Started at {time}',
    },
    {
        key: 'OBS_RECORDING_STOPPED',
        label: 'OBS recorder stopped',
        group: 'obs',
        hint: "OBS's own recorder — separate from the server's yt-dlp recorder below.",
        tag: 'obs-record',
        defaultEnabled: true,
        clientEmit: true,
        vars: [],
        title: '⏹️ OBS recording stopped',
        body:  'Stopped at {time}',
    },
    {
        key: 'VIRTUALCAM_TOGGLED',
        label: 'Virtual camera toggled',
        group: 'obs',
        hint: 'OBS virtual camera started or stopped.',
        tag: 'obs-vcam',
        defaultEnabled: false,
        clientEmit: true,
        vars: [
            { name: 'state', sample: 'started', hint: 'started / stopped' },
        ],
        title: '📷 Virtual camera {state}',
        body:  'At {time}',
    },

    // ── Server recording (yt-dlp) ───────────────────────────────────────────
    {
        key: 'RECORDING_STARTED',
        label: 'Recording started',
        group: 'recording',
        hint: 'The built-in recorder began writing a file.',
        tag: 'recording',
        defaultEnabled: true,
        clientEmit: false,
        vars: [
            { name: 'filename', sample: 'katha-2026-08-17.mp4', hint: 'File being written' },
            { name: 'trigger',  sample: 'manual',               hint: 'manual / auto' },
        ],
        title: 'Recording Started',
        body:  'Recording: {filename}',
    },
    {
        key: 'RECORDING_STOPPED',
        label: 'Recording stopped',
        group: 'recording',
        hint: 'The built-in recorder finished and saved a file.',
        tag: 'recording',
        defaultEnabled: true,
        clientEmit: false,
        vars: [
            { name: 'filename', sample: 'katha-2026-08-17.mp4', hint: 'File saved' },
            { name: 'trigger',  sample: 'manual',               hint: 'manual / auto' },
        ],
        title: 'Recording Stopped',
        body:  'Saved: {filename}',
    },
    {
        key: 'RECORDING_ERROR',
        label: 'Recording error',
        group: 'recording',
        hint: 'The recorder failed or exited unexpectedly.',
        tag: 'recording-error',
        defaultEnabled: true,
        clientEmit: false,
        vars: [
            { name: 'message', sample: 'yt-dlp exited with code 1', hint: 'What went wrong' },
        ],
        title: 'Recording Error',
        body:  '{message}',
    },

    // ── System ──────────────────────────────────────────────────────────────
    {
        key: 'MONITOR_LIVE',
        label: 'Live stream detected',
        group: 'system',
        hint: 'A monitored channel went live and the Live Player took the screen.',
        tag: 'monitor-live',
        defaultEnabled: true,
        clientEmit: true,
        vars: [
            { name: 'channelName', sample: 'SMK Channel',        hint: 'Channel that went live' },
            { name: 'title',       sample: 'Evening Katha Live', hint: 'Stream title' },
            { name: 'videoId',     sample: 'dQw4w9WgXcQ',        hint: 'YouTube video id' },
        ],
        title: '🔴 Live: {channelName}',
        body:  '{title}',
    },
    {
        key: 'BACKUP_COMPLETED',
        label: 'Backup completed',
        group: 'system',
        hint: 'A settings backup was written to disk.',
        tag: 'backup',
        defaultEnabled: false,
        clientEmit: false,
        vars: [
            { name: 'type', sample: 'auto', hint: 'auto / manual' },
        ],
        title: 'Backup Complete',
        body:  '{type} backup saved',
    },
    {
        key: 'MEMORY_WARNING',
        label: 'Memory warning',
        group: 'system',
        hint: 'Server heap crossed the warning threshold.',
        tag: 'memory',
        defaultEnabled: true,
        clientEmit: false,
        vars: [
            { name: 'mb', sample: '412', hint: 'Heap used, in MB' },
        ],
        title: 'Memory Warning',
        body:  'Server memory at {mb} MB',
    },
];

const EVENTS_BY_KEY = Object.fromEntries(EVENTS.map(e => [e.key, e]));

// ── Limits ──────────────────────────────────────────────────────────────────
// Counted in code points, not UTF-16 units, so a 4-byte emoji costs 1 and can
// never be sliced in half into a replacement character (see truncate below).
const MAX_TITLE = 120;
const MAX_BODY = 300;
const MAX_APP_NAME = 40;

/**
 * Length in user-visible characters. 'a'.length === '😀'.length === 1 here,
 * where plain .length reports 2 for the emoji (it's a surrogate pair).
 */
function charLength(str) {
    return Array.from(String(str ?? '')).length;
}

/**
 * Truncate on a code-point boundary. Plain String.slice() can cut between the
 * two halves of an emoji's surrogate pair, which renders as a lone "�" and, in
 * the FCM payload, as an invalid UTF-8 sequence — the practical reason emoji
 * "didn't work" in notification text before this.
 */
function truncate(str, maxChars) {
    const chars = Array.from(String(str ?? ''));
    return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('');
}

/**
 * Fill `{placeholders}` from `data`.
 *
 * A placeholder with no value resolves to an empty string rather than being
 * left as literal "{videoTitle}" on the operator's phone. That leaves gaps, so
 * the leftovers are tidied afterwards: runs of spaces collapse, and a line that
 * ends up as nothing but punctuation/quotes is dropped entirely. Newlines are
 * preserved — a two-line body is a normal thing to write in the panel.
 */
// Marks the spot where a placeholder had no value, so the tidy-up below can see
// which quotes and brackets were wrapping nothing. Never appears in output.
const MISSING = '\u0000';

function renderTemplate(tpl, data = {}) {
    const filled = String(tpl ?? '').replace(/\{(\w+)\}/g, (_, name) => {
        const v = data[name];
        return v === undefined || v === null || v === '' ? MISSING : String(v);
    });

    const lines = filled
        .split('\n')
        .map(line => line
            // A bracket or quote pair whose contents were a missing placeholder
            // wrapped nothing, so the wrapper goes too — otherwise a template like
            // «"{list}" ({videoCount} videos)» renders as «"" ( videos)».
            .replace(/\([^()]*\u0000[^()]*\)/g, '')
            .replace(/\[[^[\]]*\u0000[^[\]]*\]/g, '')
            .replace(/"[^"]*\u0000[^"]*"/g, '')
            .replace(/'[^']*\u0000[^']*'/g, '')
            .replace(/[“][^”]*\u0000[^”]*[”]/g, '')
            .replace(/\u0000/g, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/^[\s\-–—:,·|]+/, '')
            .replace(/[\s\-–—:,·|]+$/, '')
            .trim()
        )
        // A line that rendered down to nothing (or to nothing but punctuation)
        // is dropped rather than shipped as a blank row on the phone.
        .filter(line => line !== '' && !/^[\s\-–—:,·|"'“”()\[\]]+$/.test(line));

    return lines.join('\n');
}

/**
 * The effective template for an event: the operator's override where present,
 * the catalog default for anything they haven't touched.
 */
function resolveTemplate(eventKey, settings) {
    const def = EVENTS_BY_KEY[eventKey];
    if (!def) return null;
    const custom = settings?.templates?.[eventKey] || {};
    return {
        key: eventKey,
        title: typeof custom.title === 'string' && custom.title.trim() ? custom.title : def.title,
        body:  typeof custom.body === 'string' && custom.body.trim() ? custom.body : def.body,
        // Keeps the pre-panel behaviour as the default: the push is titled with
        // the operator's app name and the event's own title becomes line 1 of
        // the message. Unticking it in the panel promotes the custom title to
        // the real notification title — which is where a title emoji shows up
        // biggest on a phone.
        useAppNameAsTitle: custom.useAppNameAsTitle !== false,
        tag: def.tag,
        icon: def.icon || '/icon-192.png',
        isCustom: !!(custom.title || custom.body || custom.useAppNameAsTitle === false),
    };
}

/**
 * Is this event allowed to send right now? Explicit operator choice wins;
 * otherwise the catalog's own default decides, so a newly added event behaves
 * sensibly against a settings blob saved before it existed.
 */
function isEventEnabled(eventKey, settings) {
    if (settings?.enabled === false) return false;
    const explicit = settings?.events?.[eventKey];
    if (typeof explicit === 'boolean') return explicit;
    return EVENTS_BY_KEY[eventKey]?.defaultEnabled !== false;
}

/**
 * Turn an event + its data into the exact { title, body } pair that will reach
 * the device. Used by notification-service for real sends and by the panel's
 * "Test this message" so the preview and the push can't drift apart.
 */
function buildPayload(eventKey, data = {}, settings = null, overrides = null) {
    const def = EVENTS_BY_KEY[eventKey];
    if (!def) return null;

    const resolved = resolveTemplate(eventKey, settings);
    const titleTpl = overrides?.title != null ? overrides.title : resolved.title;
    const bodyTpl  = overrides?.body  != null ? overrides.body  : resolved.body;
    const useAppName = overrides?.useAppNameAsTitle != null
        ? overrides.useAppNameAsTitle
        : resolved.useAppNameAsTitle;

    const now = new Date();
    const appName = truncate(settings?.appName || 'SMK TV', MAX_APP_NAME);
    const vars = {
        appName,
        time: now.toLocaleTimeString(),
        date: now.toLocaleDateString(),
        ...data,
    };

    const renderedTitle = renderTemplate(titleTpl, vars);
    const renderedBody  = renderTemplate(bodyTpl, vars);

    if (useAppName) {
        return {
            title: truncate(appName, MAX_TITLE),
            // The event's title carries the emoji and the headline, so it stays
            // as the first line of the message rather than being thrown away.
            body: truncate([renderedTitle, renderedBody].filter(Boolean).join('\n'), MAX_BODY),
            icon: resolved.icon,
            tag: resolved.tag,
        };
    }

    return {
        title: truncate(renderedTitle || appName, MAX_TITLE),
        body: truncate(renderedBody, MAX_BODY),
        icon: resolved.icon,
        tag: resolved.tag,
    };
}

/** Default per-event on/off map, for seeding fresh settings. */
function defaultEventFlags() {
    return Object.fromEntries(EVENTS.map(e => [e.key, e.defaultEnabled !== false]));
}

/** Sample data for previews and "Test this message" — one value per declared var. */
function sampleData(eventKey) {
    const def = EVENTS_BY_KEY[eventKey];
    if (!def) return {};
    return Object.fromEntries((def.vars || []).map(v => [v.name, v.sample]));
}

module.exports = {
    EVENTS,
    EVENTS_BY_KEY,
    GROUPS,
    GLOBAL_VARS,
    MAX_TITLE,
    MAX_BODY,
    MAX_APP_NAME,
    charLength,
    truncate,
    renderTemplate,
    resolveTemplate,
    isEventEnabled,
    buildPayload,
    defaultEventFlags,
    sampleData,
    isClientEmittable: (key) => !!EVENTS_BY_KEY[key]?.clientEmit,
};
