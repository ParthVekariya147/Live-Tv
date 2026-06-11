import { useState, useEffect, useRef } from 'react';

const DEBOUNCE_MS = 700;
const TITLE_FETCH_TIMEOUT_MS = 6000;

function getYtThumbnail(id) {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/**
 * Auto-fetches video title whenever videoId changes (debounced).
 * Thumbnail is set immediately from the video ID — no API wait.
 * Returns { title, thumbnail, loading }
 */
export function useVideoInfo(videoId) {
    const [info, setInfo] = useState({ title: '', thumbnail: null });
    const [loading, setLoading] = useState(false);
    const timerRef = useRef(null);

    useEffect(() => {
        if (timerRef.current) clearTimeout(timerRef.current);

        const id = videoId?.trim();

        if (!id || id.length < 5) {
            setInfo({ title: '', thumbnail: null });
            setLoading(false);
            return;
        }

        // Set thumbnail immediately — no need to wait for any API
        setInfo({ title: '', thumbnail: getYtThumbnail(id) });
        setLoading(true);

        timerRef.current = setTimeout(async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TITLE_FETCH_TIMEOUT_MS);

            try {
                const oEmbedUrl = `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${id}&format=json`;
                const res = await fetch(oEmbedUrl, { signal: controller.signal });
                const data = res.ok ? await res.json() : null;
                setInfo(prev => ({ ...prev, title: data?.title || '' }));
            } catch {
                // Title fetch failed/timed out — thumbnail already visible, just clear title loading
                setInfo(prev => ({ ...prev, title: '' }));
            } finally {
                clearTimeout(timeoutId);
                setLoading(false);
            }
        }, DEBOUNCE_MS);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [videoId]);

    return { ...info, loading };
}
