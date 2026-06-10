
import React from 'react';
import LoopPlayerCard from './LoopPlayerCard';
import LivePlayerCard from './LivePlayerCard';
import DelayPlayerCard from './DelayPlayerCard';
import LocalPlayerCard from './LocalPlayerCard';

const PlayerManager = () => {
    return (
        <div className="flex flex-col items-center w-full">
            <div className="flex gap-4 mb-4">
                <a href="/LoopPlayer.html" target="_blank" className="text-blue-400 hover:text-blue-300 underline">Open Loop Player</a>
                <a href="/LivePlayer.html" target="_blank" className="text-blue-400 hover:text-blue-300 underline">Open Live Player</a>
                <a href="/DelayLive.html" target="_blank" className="text-blue-400 hover:text-blue-300 underline">Open Delay Player</a>
                <a href="/LocalPCPlayer.html" target="_blank" className="text-blue-400 hover:text-blue-300 underline">Open Local Player</a>
            </div>

            <div className="player-cards-container">
                <div className="table-cell-wrapper"><LoopPlayerCard /></div>
                <div className="table-cell-wrapper"><LivePlayerCard /></div>
                <div className="table-cell-wrapper"><DelayPlayerCard /></div>
                <div className="table-cell-wrapper"><LocalPlayerCard /></div>
            </div>
        </div>
    );
};

export default PlayerManager;

