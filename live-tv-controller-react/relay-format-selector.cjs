'use strict';
// Picks which yt-dlp format(s) to feed ffmpeg for the LIVE relay's
// split-mux path. Ported from ffmpeg-poc/lib/resolveStream.js's format
// selection (pickBestVideoOnly/pickBestAudioOnly/pickBestCombined) — that
// PoC validated end-to-end that video-only + audio-only DASH pairs reach
// true max quality where combined/progressive formats are capped well
// below the video-only ceiling. relay-service.cjs already has its own
// yt-dlp invocation (fetchVideoInfo) and its own combined-only master-
// playlist path for when no split pair exists — this module is purely the
// yt-dlp `formats` array -> {mode, video, audio, combined} decision, no
// process spawning of its own.

function isUsableFormat(f) {
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

// Priority: split (video-only + audio-only pair) is the only way to reach
// true max quality, since combined/progressive formats are capped well
// below the video-only ceiling. Falls back to combined when no usable
// split pair exists (the normal case for most YouTube Live streams).
function selectFormats(info) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const bestVideo = pickBestVideoOnly(formats);
    const bestAudio = pickBestAudioOnly(formats);
    const bestCombined = pickBestCombined(formats);

    if (bestVideo && bestAudio) {
        return { mode: 'split', video: describeFormat(bestVideo), audio: describeFormat(bestAudio), combined: null };
    }
    if (bestCombined) {
        return { mode: 'combined', video: null, audio: null, combined: describeFormat(bestCombined) };
    }
    return { mode: 'none', video: null, audio: null, combined: null };
}

module.exports = { selectFormats };
