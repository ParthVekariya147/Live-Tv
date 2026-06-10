
import React, { useEffect, useState } from 'react';
import { useOBS } from './context/OBSContext';
import { getCurrentDateTimeFormatted, DELAY_PLAYER_EVENT_KEY, LIVE_PLAYER_EVENT_KEY, LOCAL_PLAYER_EVENT_KEY, sendPlayerCommand } from './utils/core-utils';
import { logVideoEnd, logVideoError } from './utils/logger';
import OBSControlPanel from './components/OBSControlPanel';
import PlayerManager from './components/PlayerManager';
import MonitorManager from './components/MonitorManager';
import KathaMonitor from './components/KathaMonitor';
import Scheduler from './components/Scheduler';
import LogViewer from './components/LogViewer';
import SettingsBackup from './components/SettingsBackup';

function App() {
  const { isConnected, SCENE_NAME, sourceState, setSourceVisibility } = useOBS();
  const [currentTime, setCurrentTime] = useState(getCurrentDateTimeFormatted());
  const [monitor1Enabled, setMonitor1Enabled] = useState(true);
  const [monitor2Enabled, setMonitor2Enabled] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(getCurrentDateTimeFormatted());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const stored1 = localStorage.getItem("liveMonitorEnabled1");
    if (stored1 !== null) setMonitor1Enabled(stored1 === "true");

    const stored2 = localStorage.getItem("liveMonitorEnabled2");
    if (stored2 !== null) setMonitor2Enabled(stored2 === "true");
  }, []);

  // Global storage event listener for video ended events
  useEffect(() => {
    const handleStorageEvent = (event) => {
      // Handle Delay Player video ended or error
      if (event.key === DELAY_PLAYER_EVENT_KEY && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          if (data.playerType === 'delay' && (data.event === 'videoEnded' || data.event === 'videoError')) {
            console.log(`DelayPlayer event: ${data.event}`);
            sendPlayerCommand('delayLivePlayerCommand', 'pause');

            const nextAction = !sourceState["Live Player"] ? 'switch_to_loop' : 'hide_delay';

            // Log the event
            if (data.event === 'videoEnded') {
              logVideoEnd('Delay Live', data.videoId || 'unknown', nextAction);
            } else {
              logVideoError('Delay Live', data.videoId || 'unknown', data.errorCode, 'Video error', nextAction);
            }

            // Only switch to Loop Player if Live Player is NOT active
            if (!sourceState["Live Player"]) {
              console.log('Live Player is not active. Switching to Loop Player.');
              setSourceVisibility("Loop Player", true);
            } else {
              console.log('Live Player is active. Just hiding Delay Live.');
              setSourceVisibility("Delay Live", false);
            }
          }
        } catch (e) {
          console.error('Error parsing DelayPlayer event:', e);
        }
      }

      // Handle Live Player video ended or error
      if (event.key === LIVE_PLAYER_EVENT_KEY && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          if (data.event === 'videoEnded' || data.event === 'videoError') {
            console.log(`LivePlayer event: ${data.event}. Switching to Loop Player.`);

            // Log the event
            if (data.event === 'videoEnded') {
              logVideoEnd('Live Player', data.videoId || 'unknown', 'switch_to_loop');
            } else {
              logVideoError('Live Player', data.videoId || 'unknown', data.errorCode, 'Video error', 'switch_to_loop');
            }

            setSourceVisibility("Loop Player", true);
          }
        } catch (e) {
          console.error('Error parsing LivePlayer event:', e);
        }
      }

      // Handle Local PC Player video ended (handled by LocalPlayerCard itself for playlist logic)
      // The actual end action logic is in LocalPlayerCard
    };

    window.addEventListener('storage', handleStorageEvent);
    return () => window.removeEventListener('storage', handleStorageEvent);
  }, [sourceState, setSourceVisibility]);

  const toggleMonitor1 = () => {
    const newState = !monitor1Enabled;
    setMonitor1Enabled(newState);
    localStorage.setItem("liveMonitorEnabled1", newState);
  };

  const toggleMonitor2 = () => {
    const newState = !monitor2Enabled;
    setMonitor2Enabled(newState);
    localStorage.setItem("liveMonitorEnabled2", newState);
  };

  return (
    <div id="main-container" className="flex flex-col items-center min-h-screen">
      <div id="main-obs-layout">
        <div id="top-section-container">
          {/* OBS Live Video Preview & Controls */}
          <OBSControlPanel
            currentTime={currentTime}
            monitor1Enabled={monitor1Enabled}
            toggleMonitor1={toggleMonitor1}
            monitor2Enabled={monitor2Enabled}
            toggleMonitor2={toggleMonitor2}
          />
        </div>
      </div>

      <PlayerManager />

      {/* All Monitor Cards in a single row */}
      <div id="monitors-row" className="monitors-row-container">
        <MonitorManager monitor1Enabled={monitor1Enabled} monitor2Enabled={monitor2Enabled} />
        <div className="table-cell-wrapper"><KathaMonitor /></div>
      </div>

      <Scheduler />

      {/* Log Viewer - Collapsible at bottom */}
      <div className="w-full px-2">
        <LogViewer mode="collapsed" maxHeight="350px" />
      </div>

      {/* Settings Export / Import */}
      <div className="w-full px-2">
        <SettingsBackup />
      </div>

      <div className="footer">
        Ensure OBS WebSocket is running and configured.<br />
        OBS WebSocket connection status: <span style={{ color: isConnected ? '#00adb5' : '#999' }}>{isConnected ? "Connected" : "Disconnected"}</span>
      </div>
    </div>
  );
}

export default App;

