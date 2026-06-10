import React, { useState, useEffect } from 'react';

const Shimmer = ({ className = '' }) => (
    <div className={`thumbnail-shimmer ${className}`} />
);

export default function ThumbnailLoader({ src, alt = 'Thumbnail', loading = false, className = '' }) {
    const [imgLoaded, setImgLoaded] = useState(false);
    const [imgError, setImgError] = useState(false);

    // Reset image state when src changes so shimmer re-plays for new video
    useEffect(() => {
        setImgLoaded(false);
        setImgError(false);
    }, [src]);

    const showShimmer = loading || (!imgLoaded && !imgError && src);
    const showPlaceholder = !loading && (!src || imgError);

    return (
        <div className={`thumbnail-wrapper ${className}`}>
            {showShimmer && <Shimmer />}
            {showPlaceholder && !loading && (
                <div className="thumbnail-placeholder">
                    <span className="thumbnail-placeholder-icon">▶</span>
                    <span className="thumbnail-placeholder-text">No Video</span>
                </div>
            )}
            {src && !loading && (
                <img
                    src={src}
                    alt={alt}
                    className={`thumbnail-img ${imgLoaded ? 'thumbnail-img--visible' : 'thumbnail-img--hidden'}`}
                    onLoad={() => { setImgLoaded(true); setImgError(false); }}
                    onError={() => { setImgError(true); setImgLoaded(false); }}
                />
            )}
        </div>
    );
}
