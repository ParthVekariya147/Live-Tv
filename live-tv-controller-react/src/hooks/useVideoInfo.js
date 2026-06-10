import { useState, useEffect, useRef } from 'react';
import { fetchVideoDetails } from '../utils/core-utils';

const DEBOUNCE_MS = 700;

/**
 * Auto-fetches video title + thumbnail whenever videoId changes.
 * Debounced so rapid typing doesn't fire a request per keystroke.
 * Returns { title, thumbnail, loading }
 */
export function useVideoInfo(videoId) {
    const [info, setInfo] = useState({ title: '', thumbnail: null });
    const [loading, setLoading] = useState(false);
    const timerRef = useRef(null);
    const abortRef = useRef(null);

    useEffect(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (abortRef.current) abortRef.current.abort?.();

        if (!videoId || videoId.trim().length < 5) {
            setInfo({ title: '', thumbnail: null });
            setLoading(false);
            return;
        }

        setLoading(true);

        timerRef.current = setTimeout(async () => {
            try {
                const details = await fetchVideoDetails(videoId.trim());
                setInfo({ title: details.title || '', thumbnail: details.thumbnail || null });
            } catch {
                setInfo({ title: '', thumbnail: null });
            } finally {
                setLoading(false);
            }
        }, DEBOUNCE_MS);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [videoId]);

    return { ...info, loading };
}
