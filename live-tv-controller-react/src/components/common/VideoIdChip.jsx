import React, { useState, useRef, useEffect } from 'react';
import { copyToClipboard } from '../../utils/copyToClipboard';

// Shows the identifier of whatever a player card is currently playing — the YouTube
// video ID for the three YouTube players, the file path for Local PC Player — and makes
// it copyable. The whole value is a click target, and there is a 📋 button beside it for
// anyone who doesn't realise the text itself is clickable. Either one flashes "Copied!"
// on success, or "Copy failed" if the browser refused (see utils/copyToClipboard.js).
//
// Renders nothing when there is no value, so an idle card keeps its old layout.
const FEEDBACK_MS = 1400;

export default function VideoIdChip({
    value,
    label = 'ID',
    title = 'Click to copy',
    truncate = false,
}) {
    const [feedback, setFeedback] = useState(null); // 'copied' | 'failed' | null
    const timerRef = useRef(null);

    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    const id = (value ?? '').toString().trim();
    if (!id) return null;

    const handleCopy = async (e) => {
        e.stopPropagation();
        const ok = await copyToClipboard(id);
        setFeedback(ok ? 'copied' : 'failed');
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    };

    return (
        <div className="video-id-chip">
            <span className="video-id-chip__label">{label}</span>
            <button
                type="button"
                className={`video-id-chip__value${truncate ? ' video-id-chip__value--truncate' : ''}`}
                onClick={handleCopy}
                title={`${title}: ${id}`}
            >
                {id}
            </button>
            <button
                type="button"
                className="video-id-chip__btn"
                onClick={handleCopy}
                title={`Copy ${label.toLowerCase()} to clipboard`}
                aria-label={`Copy ${label.toLowerCase()} to clipboard`}
            >
                📋
            </button>
            <span
                className={`video-id-chip__toast${feedback ? ' video-id-chip__toast--show' : ''}${feedback === 'failed' ? ' video-id-chip__toast--error' : ''}`}
                role="status"
                aria-live="polite"
            >
                {feedback === 'failed' ? '✗ Copy failed' : '✓ Copied!'}
            </span>
        </div>
    );
}
