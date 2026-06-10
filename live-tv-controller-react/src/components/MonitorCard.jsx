
import React, { useState, useEffect } from 'react';
import { copyToClipboard } from '../utils/core-utils.js';

const MonitorCard = ({ id, title, enabled, data, error, channelOptions, selectedChannelId, onChannelChange }) => {
    const [searchTerms, setSearchTerms] = useState("");

    useEffect(() => {
        const key = `savedSearchTitles${id}`;
        const saved = localStorage.getItem(key);
        if (saved) setSearchTerms(saved);
    }, [id]);

    const handleSearchChange = (e) => {
        const val = e.target.value;
        setSearchTerms(val);
        localStorage.setItem(`savedSearchTitles${id}`, val);
    };

    // Determine display content
    let displayTitle = "N/A";
    let videoId = "N/A";
    let channelName = "N/A";
    let thumbnail = "https://placehold.co/280x157.5/333333/FFFFFF?text=Monitor+Off";
    let channelUrl = "N/A";
    let isErrorState = false;

    if (!enabled) {
        displayTitle = `Live Event Monitor ${id} is Off`;
    } else if (error) {
        displayTitle = error;
        videoId = error;
        channelName = error;
        channelUrl = error;
        thumbnail = "https://placehold.co/280x157.5/FF0000/FFFFFF?text=Error";
        isErrorState = true;
    } else if (data) {
        displayTitle = data.title;
        videoId = data.videoId;
        channelName = "Swaminarayan";
        thumbnail = data.thumbnailUrl;
        channelUrl = `https://www.youtube.com/channel/UC7HQ3mzdsyvLU0Y7a2t3N7A`;
    } else {
        displayTitle = "No Live Event Found";
        thumbnail = "https://placehold.co/280x157.5/333333/FFFFFF?text=No+Live+Event";
    }

    const handleCopyId = () => {
        if (videoId && videoId !== "N/A" && !isErrorState) {
            copyToClipboard(videoId);
        }
    };

    return (
        <div className="player-control-card">
            <h3 className="live-monitor-card-h3">{title}</h3>

            {channelOptions && onChannelChange && (
                <div className="flex flex-col w-full px-2 mb-2">
                    <label className="live-monitor-label mb-1">Monitor Channel:</label>
                    <select
                        className="input-field"
                        value={selectedChannelId}
                        onChange={(e) => onChannelChange(e.target.value)}
                    >
                        {channelOptions.map((ch) => (
                            <option key={ch.id} value={ch.id}>{ch.name}</option>
                        ))}
                    </select>
                </div>
            )}

            <img src={thumbnail} alt="Thumbnail" className="live-monitor-thumbnail" />

            <div className="space-y-4 w-full p-2">
                <div>
                    <p className="live-monitor-label">Search Titles (Auto-Load):</p>
                    <input
                        type="text"
                        className="input-field"
                        value={searchTerms}
                        onChange={handleSearchChange}
                        placeholder="term1, term2"
                    />
                </div>
                <div>
                    <p className="live-monitor-label">Video Title:</p>
                    <p className={`live-monitor-text-display ${isErrorState ? 'error-message' : ''}`}>{displayTitle}</p>
                </div>
                <div>
                    <p className="live-monitor-label flex items-center justify-between">
                        Video ID:
                        {videoId !== "N/A" && !isErrorState && (
                            <button
                                onClick={handleCopyId}
                                className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded ml-2"
                            >
                                Copy
                            </button>
                        )}
                    </p>
                    <p className={`live-monitor-text-display ${isErrorState ? 'text-red-400' : ''}`}>{videoId}</p>
                </div>
                <div>
                    <p className="live-monitor-label">Channel:</p>
                    <p className={`live-monitor-text-display ${isErrorState ? 'text-red-400' : ''}`}>{channelName}</p>
                </div>
                <div>
                    <p className="live-monitor-label">URL:</p>
                    <p className={`live-monitor-text-display ${isErrorState ? 'text-red-400' : ''} text-xs break-all`}>
                        {channelUrl !== "N/A" && !isErrorState ? (
                            <a href={channelUrl} target="_blank" rel="noreferrer" className="text-blue-400 underline">
                                {channelUrl}
                            </a>
                        ) : (
                            channelUrl
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default MonitorCard;
