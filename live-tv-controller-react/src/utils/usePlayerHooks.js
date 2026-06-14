import { useState, useEffect, useRef } from 'react';
import { secondsToHMS } from './core-utils';

/**
 * Custom hook to receive and format video time updates from player HTML pages.
 * 
 * @param {string} playerEventKey - The localStorage key for player events (e.g., 'loopPlayerEvent')
 * @param {string} playerType - The player type to filter events (e.g., 'loop', 'live', 'local')
 * @returns {{ currentTime: string, remainingTime: string, duration: string, isPlaying: boolean }}
 */
export function usePlayerTime(playerEventKey, playerType) {
    const [timeInfo, setTimeInfo] = useState({
        currentTime: '00:00',
        remainingTime: '00:00',
        duration: '00:00',
        currentSeconds: 0,
        remainingSeconds: 0,
        durationSeconds: 0
    });

    // Use ref to track if we've received any time updates (player is active)
    const hasReceivedUpdate = useRef(false);

    useEffect(() => {
        const handleStorageEvent = (event) => {
            if (event.key !== playerEventKey || !event.newValue) return;

            try {
                const data = JSON.parse(event.newValue);

                if (playerType && data.playerType && data.playerType !== playerType) return;

                if (data.event === 'durationUpdate') {
                    const dur = typeof data.duration === 'number' && isFinite(data.duration) && data.duration > 0
                        ? data.duration
                        : 0;
                    setTimeInfo(prev => ({
                        ...prev,
                        duration: secondsToHMS(dur),
                        durationSeconds: dur,
                        currentSeconds: 0,
                        currentTime: '00:00',
                        remainingTime: secondsToHMS(dur),
                        remainingSeconds: dur,
                    }));
                    return;
                }

                // Only process timeUpdate events beyond this point
                if (data.event !== 'timeUpdate') return;

                hasReceivedUpdate.current = true;

                // Calculate duration from currentTime + remainingTime if not provided directly
                const currentSeconds = data.currentTime || 0;
                const remainingSeconds = data.remainingTime || 0;
                const durationSeconds = data.duration || (currentSeconds + remainingSeconds);

                setTimeInfo({
                    currentTime: secondsToHMS(currentSeconds),
                    remainingTime: secondsToHMS(remainingSeconds),
                    duration: secondsToHMS(durationSeconds),
                    currentSeconds,
                    remainingSeconds,
                    durationSeconds
                });
            } catch (e) {
                // Ignore parse errors
            }
        };

        window.addEventListener('storage', handleStorageEvent);
        return () => window.removeEventListener('storage', handleStorageEvent);
    }, [playerEventKey, playerType]);

    return timeInfo;
}

/**
 * Hook to listen for specific player events (videoEnded, videoError, etc.)
 * 
 * @param {string} playerEventKey - The localStorage key for player events
 * @param {string} playerType - The player type to filter events
 * @param {function} onVideoEnded - Callback when video ends
 * @param {function} onVideoError - Callback when video has error
 */
export function usePlayerEvents(playerEventKey, playerType, onVideoEnded, onVideoError) {
    useEffect(() => {
        const handleStorageEvent = (event) => {
            if (event.key !== playerEventKey || !event.newValue) return;

            try {
                const data = JSON.parse(event.newValue);

                // Filter by player type if specified
                if (playerType && data.playerType && data.playerType !== playerType) return;

                if (data.event === 'videoEnded' && onVideoEnded) {
                    onVideoEnded(data);
                }
                if (data.event === 'videoError' && onVideoError) {
                    onVideoError(data);
                }
            } catch (e) {
                // Ignore parse errors
            }
        };

        window.addEventListener('storage', handleStorageEvent);
        return () => window.removeEventListener('storage', handleStorageEvent);
    }, [playerEventKey, playerType, onVideoEnded, onVideoError]);
}
