import React from 'react';
import { copyToClipboard } from '../utils/core-utils';

const UpcomingEventMonitor = ({ enabled, data, error }) => {
    // Format start time
    const formatStartTime = (startTime) => {
        if (!startTime) return 'N/A';
        try {
            return new Date(startTime).toLocaleString();
        } catch {
            return 'N/A';
        }
    };

    // Determine what to display
    const getDisplayContent = () => {
        if (!enabled) {
            return {
                thumbnail: "https://placehold.co/280x157.5/333333/FFFFFF?text=Monitor+Off",
                title: "Upcoming Event Monitor is Off",
                videoId: "N/A",
                channelName: "N/A",
                channelUrl: null,
                startTime: "N/A",
                isError: false
            };
        }

        if (error) {
            return {
                thumbnail: "https://placehold.co/280x157.5/FF0000/FFFFFF?text=Error",
                title: `Error: ${error}`,
                videoId: "N/A",
                channelName: "N/A",
                channelUrl: null,
                startTime: "N/A",
                isError: true
            };
        }

        if (!data) {
            return {
                thumbnail: "https://placehold.co/280x157.5/333333/FFFFFF?text=No+Upcoming",
                title: "No Upcoming Event Found",
                videoId: "N/A",
                channelName: "N/A",
                channelUrl: null,
                startTime: "N/A",
                isError: false
            };
        }

        return {
            thumbnail: data.thumbnailUrl || "https://placehold.co/280x157.5/333333/FFFFFF?text=No+Thumbnail",
            title: data.title || "Unknown",
            videoId: data.videoId || "N/A",
            channelName: "Swaminarayan",
            channelUrl: "https://www.youtube.com/@swaminarayan",
            startTime: formatStartTime(data.startTime),
            isError: false
        };
    };

    const content = getDisplayContent();

    const handleCopyVideoId = () => {
        if (content.videoId && content.videoId !== "N/A") {
            copyToClipboard(content.videoId);
        }
    };

    return (
        <div className="player-control-card">
            <h3 className="live-monitor-card-h3">Upcoming Event Monitor</h3>
            <img
                src={content.thumbnail}
                alt="Video Thumbnail"
                className="live-monitor-thumbnail"
            />
            <div className="space-y-4 w-full">
                <div>
                    <p className="live-monitor-label">Video Title:</p>
                    <p className={`live-monitor-text-display ${content.isError ? 'error-message' : ''}`}>
                        {content.title}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <p className="live-monitor-label">Video ID:</p>
                    <p className={`live-monitor-text-display ${content.isError ? 'error-message' : ''}`}>
                        {content.videoId}
                    </p>
                    <button
                        onClick={handleCopyVideoId}
                        className="ml-2 px-3 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 common-btn-style"
                        disabled={content.videoId === "N/A"}
                    >
                        Copy
                    </button>
                </div>
                <div>
                    <p className="live-monitor-label">Channel Name:</p>
                    <p className={`live-monitor-text-display ${content.isError ? 'error-message' : ''}`}>
                        {content.channelName}
                    </p>
                </div>
                <div>
                    <p className="live-monitor-label">Channel URL:</p>
                    <div className={`live-monitor-text-display live-monitor-channel-url ${content.isError ? 'error-message' : ''}`}>
                        {content.channelUrl ? (
                            <a href={content.channelUrl} target="_blank" rel="noopener noreferrer">
                                {content.channelUrl}
                            </a>
                        ) : (
                            "N/A"
                        )}
                    </div>
                </div>
                <div>
                    <p className="live-monitor-label">Starts At:</p>
                    <p className={`live-monitor-text-display ${content.isError ? 'error-message' : ''}`}>
                        {content.startTime}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default UpcomingEventMonitor;
