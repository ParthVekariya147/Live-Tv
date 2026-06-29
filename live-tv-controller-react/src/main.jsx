import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { OBSProvider } from './context/OBSContext.jsx'
import { logError, LogCategory, LogType } from './utils/logger.js'

window.onerror = (msg, src, line, col, err) => {
    logError(
        LogType.UNHANDLED_ERROR,
        LogCategory.SYSTEM,
        { message: msg, source: src, line, col, stack: err?.stack },
        `Unhandled error: ${msg}`
    );
};

window.onunhandledrejection = (event) => {
    logError(
        LogType.UNHANDLED_ERROR,
        LogCategory.SYSTEM,
        { reason: String(event.reason), stack: event.reason?.stack },
        `Unhandled promise rejection: ${event.reason}`
    );
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <OBSProvider>
      <App />
    </OBSProvider>
  </StrictMode>,
)
