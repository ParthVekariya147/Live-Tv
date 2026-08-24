
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useOBS } from './context/OBSContext';
import { getCurrentDateTimeFormatted, DELAY_PLAYER_EVENT_KEY, LIVE_PLAYER_EVENT_KEY, LOCAL_PLAYER_EVENT_KEY, sendPlayerCommand } from './utils/core-utils';
import { logVideoEnd, logVideoError } from './utils/logger';
import OBSControlPanel from './components/OBSControlPanel';
import PlayerManager from './components/PlayerManager';
import MonitorManager from './components/MonitorManager';
import KathaMonitor from './components/KathaMonitor';
import Scheduler from './components/Scheduler';
import LogViewer from './components/LogViewer';
import BuildFooter from './components/BuildFooter';
import { CHANNELS_UPDATED_EVENT } from './components/ChannelManager';

const LOCAL_API_BASE = import.meta.env.VITE_LOCAL_API_BASE || "http://localhost:3000";
// Single shared channel selection driving Live Monitor 1, Live Monitor 2, and
// Upcoming Event Monitor together — one place to change it, one channel's
// data fetched and shared across all three instead of each polling
// independently. Katha Monitor keeps its own independent channel selector
// (see KathaMonitor.jsx) since it's meant to run on a separate channel.
const CHANNEL_SELECT_KEY = "liveSelectedChannelId";

function App() {
  const { isConnected, SCENE_NAME, sourceState, setSourceVisibility } = useOBS();
  const sourceStateRef = useRef(sourceState);
  useEffect(() => { sourceStateRef.current = sourceState; }, [sourceState]);
  const [currentTime, setCurrentTime] = useState(getCurrentDateTimeFormatted());
  const [monitor1Enabled, setMonitor1Enabled] = useState(true);
  const [monitor2Enabled, setMonitor2Enabled] = useState(true);
  const [channelOptions, setChannelOptions] = useState([]);
  const [selectedChannelId, setSelectedChannelId] = useState(
    () => localStorage.getItem(CHANNEL_SELECT_KEY) || ''
  );

  const loadChannelOptions = useCallback(async () => {
    try {
      const res = await fetch(`${LOCAL_API_BASE}/api/channels`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) return;
      setChannelOptions(data.channels);
      setSelectedChannelId((prev) =>
        prev && data.channels.some((c) => c.channelId === prev) ? prev : (data.channels[0]?.channelId || '')
      );
    } catch (err) {
      console.warn('[App] Failed to load channel list:', err.message);
    }
  }, []);

  useEffect(() => {
    loadChannelOptions();
    window.addEventListener(CHANNELS_UPDATED_EVENT, loadChannelOptions);
    return () => window.removeEventListener(CHANNELS_UPDATED_EVENT, loadChannelOptions);
  }, [loadChannelOptions]);

  const handleChannelChange = useCallback((newId) => {
    setSelectedChannelId(newId);
    localStorage.setItem(CHANNEL_SELECT_KEY, newId);
  }, []);

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

  // WebSocket listener for server-initiated flush (pre-auto-backup)
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'FLUSH_STATE_FOR_BACKUP') {
          window.dispatchEvent(new CustomEvent('flushPlayerState'));
        }
      } catch {}
    };
    return () => ws.close();
  }, []);

  // Global storage event listener for video ended events — uses ref so this never re-registers
  useEffect(() => {
    const handleStorageEvent = (event) => {
      const ss = sourceStateRef.current;

      if (event.key === DELAY_PLAYER_EVENT_KEY && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          if (data.playerType === 'delay' && (data.event === 'videoEnded' || data.event === 'videoError')) {
            sendPlayerCommand('delayLivePlayerCommand', 'pause');
            const nextAction = !ss["Live Player"] ? 'switch_to_loop' : 'hide_delay';
            if (data.event === 'videoEnded') {
              logVideoEnd('Delay Live', data.videoId || 'unknown', nextAction);
            } else {
              logVideoError('Delay Live', data.videoId || 'unknown', data.errorCode, 'Video error', nextAction);
            }
            // 'auto_handoff', not the default 'manual' — this is the delay player
            // reaching the end of its video and handing the screen on by itself.
            // The trigger is what decides which notification the operator gets, so
            // mislabelling it here would report an automatic switch as one they made.
            if (!ss["Live Player"]) {
              setSourceVisibility("Loop Player", true, 'auto_handoff');
            } else {
              setSourceVisibility("Delay Live", false, 'auto_handoff');
            }
          }
        } catch (e) {
          console.error('Error parsing DelayPlayer event:', e);
        }
      }

      if (event.key === LIVE_PLAYER_EVENT_KEY && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          if (data.event === 'videoEnded' || data.event === 'videoError') {
            if (data.event === 'videoEnded') {
              logVideoEnd('Live Player', data.videoId || 'unknown', 'switch_to_loop');
            } else {
              logVideoError('Live Player', data.videoId || 'unknown', data.errorCode, 'Video error', 'switch_to_loop');
            }
            setSourceVisibility("Loop Player", true, 'auto_handoff');
          }
        } catch (e) {
          console.error('Error parsing LivePlayer event:', e);
        }
      }
    };

    window.addEventListener('storage', handleStorageEvent);
    return () => window.removeEventListener('storage', handleStorageEvent);
  }, [setSourceVisibility]); // setSourceVisibility is stable; sourceState read via ref

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
        <MonitorManager
          monitor1Enabled={monitor1Enabled}
          monitor2Enabled={monitor2Enabled}
          channelOptions={channelOptions}
          selectedChannelId={selectedChannelId}
          onChannelChange={handleChannelChange}
        />
        <div className="table-cell-wrapper"><KathaMonitor /></div>
      </div>

      <Scheduler />

      {/* Log Viewer - Collapsible at bottom */}
      <div className="w-full px-2">
        <LogViewer mode="collapsed" maxHeight="350px" />
      </div>

      <div className="footer">
        Ensure OBS WebSocket is running and configured.<br />
        OBS WebSocket connection status: <span style={{ color: isConnected ? '#00adb5' : '#999' }}>{isConnected ? "Connected" : "Disconnected"}</span>
      </div>

      <BuildFooter />
    </div>
  );
}

export default App;

