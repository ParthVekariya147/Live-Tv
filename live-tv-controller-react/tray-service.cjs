'use strict';
// System tray icon for the packaged EXE — lets the user stop the running
// build from the notification area instead of hunting it down in Task Manager.
const path = require('path');
const { spawn } = require('child_process');

function initTray({ port, onExit }) {
    let SysTray;
    try {
        SysTray = require('systray2').default;
    } catch (err) {
        console.warn('[Tray] systray2 not available, skipping tray icon:', err.message);
        return null;
    }

    const iconPath = path.join(__dirname, 'assets', 'tray-icon.ico');
    // The tray helper is a native .exe — inside a pkg snapshot it can't be
    // spawned directly, so copyDir extracts it next to the running exe once.
    const trayBinDir = path.join(path.dirname(process.execPath), 'systray-bin');

    let exiting = false;
    const doExit = () => {
        if (exiting) return;
        exiting = true;
        try { systray.kill(false); } catch (_) { /* ignore */ }
        onExit();
    };

    const itemOpen = {
        title: 'Open Dashboard',
        tooltip: 'Open the Live TV Controller dashboard in your browser',
        checked: false,
        enabled: true,
        click: () => {
            spawn('cmd', ['/c', 'start', `http://localhost:${port}`], {
                shell: true,
                detached: true,
                stdio: 'ignore',
            }).unref();
        },
    };

    const itemExit = {
        title: 'Exit / Stop Service',
        tooltip: 'Stop the server and close this build',
        checked: false,
        enabled: true,
        click: doExit,
    };

    const systray = new SysTray({
        menu: {
            icon: iconPath,
            title: 'Live TV Controller',
            tooltip: 'Live TV Controller is running',
            items: [itemOpen, SysTray.separator, itemExit],
        },
        debug: false,
        copyDir: trayBinDir,
    });

    systray.onClick((action) => {
        if (action.item.click != null) action.item.click();
    });

    systray.ready().catch((err) => {
        console.warn('[Tray] Failed to start tray icon:', err.message);
    });

    return systray;
}

module.exports = { initTray };
