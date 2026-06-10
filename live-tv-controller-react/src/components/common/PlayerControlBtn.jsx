
import React from 'react';

const PlayerControlBtn = ({ onClick, className, children, id }) => {
    return (
        <button id={id} className={`common-btn-style ${className}`} onClick={onClick}>
            {children}
        </button>
    );
};

export default PlayerControlBtn;
