import React, { useState, useEffect, useCallback } from 'react'
import { getFCMStatus, unregisterFCM, requestNotificationPermission } from '../services/fcm.js'

const EVENT_LABELS = {
    SCHEDULER_TRIGGER: 'Schedule triggered',
    SCHEDULER_ALERT:   'Scheduler alert',
    RECORDING_STARTED: 'Recording started',
    RECORDING_STOPPED: 'Recording stopped',
    RECORDING_ERROR:   'Recording error',
    BACKUP_COMPLETED:  'Backup completed',
    MEMORY_WARNING:    'Memory warning',
    MONITOR_LIVE:      'Live stream detected',
}

const DEFAULT_EVENTS = Object.fromEntries(Object.keys(EVENT_LABELS).map(k => [k, k !== 'BACKUP_COMPLETED']))

function deviceIcon(userAgent = '') {
    const ua = userAgent.toLowerCase()
    if (/ipad|tablet|kindle/i.test(ua)) return '📟'
    if (/mobile|android|iphone/i.test(ua)) return '📱'
    return '💻'
}

function timeAgo(iso) {
    if (!iso) return '—'
    try {
        const diff = Date.now() - new Date(iso).getTime()
        const mins = Math.floor(diff / 60000)
        if (mins < 1)  return 'just now'
        if (mins < 60) return `${mins}m ago`
        const hrs = Math.floor(mins / 60)
        if (hrs  < 24) return `${hrs}h ago`
        return `${Math.floor(hrs / 24)}d ago`
    } catch (_) { return iso }
}

// The app re-registers on every load, on tab-visible, on network-online, and on a
// 6h heartbeat (see src/services/fcm.js) — so a device that hasn't checked in for
// well over a day is a real signal its browser is closed or offline, not noise.
const STALE_HOURS = 26
function isStale(iso) {
    if (!iso) return false
    try { return (Date.now() - new Date(iso).getTime()) > STALE_HOURS * 60 * 60 * 1000 } catch (_) { return false }
}

export default function NotificationSettings() {
    const [open, setOpen]           = useState(false)
    const [settings, setSettings]   = useState({ enabled: true, appName: 'SMK TV', events: DEFAULT_EVENTS })
    const [appNameDraft, setAppNameDraft] = useState('SMK TV')
    const [installPrompt, setInstallPrompt] = useState(null)
    const [devices, setDevices]     = useState([])
    const [testStatus, setTestStatus] = useState({}) // { [deviceId]: 'idle'|'sending'|'sent'|'error' }
    const [removing, setRemoving]   = useState({})   // { [deviceId]: true } while a delete is in flight
    const [globalTest, setGlobalTest] = useState('idle')
    const [saving, setSaving]       = useState(false)
    const [setup, setSetup]         = useState(null)    // { primaryUrl, qrDataUrl }
    const [qrLoading, setQrLoading] = useState(false)
    const [tunnelRetrying, setTunnelRetrying] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [, setFcmTick]            = useState(0)   // bumped to force a re-read of getFCMStatus() after enabling
    const [enabling, setEnabling]   = useState(false)
    const fcmStatus = getFCMStatus()

    const load = useCallback(async () => {
        setRefreshing(true)
        try {
            const [sRes, dRes] = await Promise.all([
                fetch('/api/notifications/settings'),
                fetch('/api/notifications/devices'),
            ])
            if (sRes.ok) {
                const s = await sRes.json()
                setSettings(s)
                setAppNameDraft(s.appName || 'SMK TV')
            }
            if (dRes.ok) {
                const d = await dRes.json()
                setDevices(d.devices || [])
            }
        } catch (_) {} finally { setRefreshing(false) }
    }, [])

    const loadSetupUrl = useCallback(async () => {
        setQrLoading(true)
        try {
            const res = await fetch('/api/notifications/setup-url')
            if (res.ok) setSetup(await res.json())
        } catch (_) {} finally { setQrLoading(false) }
    }, [])

    useEffect(() => {
        if (open) {
            load()
            loadSetupUrl()
        }
    }, [open, load, loadSetupUrl])

    // The tunnel connects in the background on server startup (retries + a pinned
    // subdomain — see tunnel-manager.cjs) and can take a few seconds after the app
    // launches. Poll while the panel is open and not yet on the tunnel URL so the
    // QR code upgrades itself instead of leaving the user stuck on the one-shot
    // fallback fetched when the panel first opened.
    useEffect(() => {
        if (!open || setup?.tunnel) return
        const timer = setInterval(loadSetupUrl, 8000)
        return () => clearInterval(timer)
    }, [open, setup?.tunnel, loadSetupUrl])

    async function retryTunnel() {
        setTunnelRetrying(true)
        try {
            await fetch('/api/notifications/tunnel/retry', { method: 'POST' })
            await new Promise(r => setTimeout(r, 3000))
            await loadSetupUrl()
        } catch (_) {} finally { setTunnelRetrying(false) }
    }

    // Installed PWAs get a real persistent background service; a plain browser
    // tab is what Android/OEM battery optimizers kill in the background, which
    // is the usual cause of notifications silently stopping after a while.
    useEffect(() => {
        function onBeforeInstall(e) {
            e.preventDefault()
            setInstallPrompt(e)
        }
        window.addEventListener('beforeinstallprompt', onBeforeInstall)
        return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall)
    }, [])

    async function installApp() {
        if (!installPrompt) return
        installPrompt.prompt()
        await installPrompt.userChoice
        setInstallPrompt(null)
    }

    async function saveSettings(patch) {
        const updated = { ...settings, ...patch }
        setSettings(updated)
        setSaving(true)
        try {
            await fetch('/api/notifications/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updated),
            })
        } catch (_) {} finally { setSaving(false) }
    }

    function toggleEvent(key) {
        saveSettings({ events: { ...settings.events, [key]: !settings.events[key] } })
    }

    // Only ever called from a real click — auto-requesting permission on page
    // load is what gets an origin permanently auto-blocked by the browser.
    async function enableNotifications() {
        setEnabling(true)
        try {
            await requestNotificationPermission()
        } finally {
            setEnabling(false)
            setFcmTick(t => t + 1)
            load()
        }
    }

    function saveAppName() {
        const name = appNameDraft.trim()
        if (!name || name === settings.appName) return
        saveSettings({ appName: name })
    }

    async function sendGlobalTest() {
        const token = fcmStatus.token
        if (!token) { setGlobalTest('error'); return }
        setGlobalTest('sending')
        try {
            const res = await fetch('/api/notifications/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            })
            setGlobalTest(res.ok ? 'sent' : 'error')
        } catch (_) { setGlobalTest('error') }
        setTimeout(() => setGlobalTest('idle'), 3000)
    }

    async function sendDeviceTest(deviceId) {
        setTestStatus(p => ({ ...p, [deviceId]: 'sending' }))
        try {
            const res = await fetch('/api/notifications/test-device', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId }),
            })
            setTestStatus(p => ({ ...p, [deviceId]: res.ok ? 'sent' : 'error' }))
        } catch (_) {
            setTestStatus(p => ({ ...p, [deviceId]: 'error' }))
        }
        setTimeout(() => setTestStatus(p => ({ ...p, [deviceId]: 'idle' })), 3000)
    }

    async function removeDevice(deviceId) {
        setRemoving(p => ({ ...p, [deviceId]: true }))
        try {
            // The devices API never exposes raw tokens — delete by deviceId. The
            // token store does an atomic write, so a 200 with removed:true means
            // it's gone from data/fcm-tokens.json on disk, not just this list.
            const res = await fetch('/api/notifications/register', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId }),
            })
            const body = res.ok ? await res.json().catch(() => ({})) : null
            if (body?.removed) {
                // Re-fetch from the server instead of trusting the optimistic
                // local filter — proves the row is actually gone server-side.
                await load()
            } else {
                setRemoving(p => ({ ...p, [deviceId]: false }))
            }
        } catch (_) {
            setRemoving(p => ({ ...p, [deviceId]: false }))
        }
    }

    const notSupported = !fcmStatus.supported
    const permDenied   = fcmStatus.permission === 'denied'

    return (
        <div className="flex flex-col gap-1 items-end">
            <button
                onClick={() => setOpen(o => !o)}
                className="px-2 py-1 rounded text-xs font-medium transition-all bg-gray-700 hover:bg-gray-600 text-cyan-400 border border-cyan-800/40"
                title="Push notification settings"
            >
                🔔 Notifications
            </button>

            {open && (
                <div className="bg-gray-900 border border-cyan-700/40 rounded-lg p-3 w-80 text-xs mt-1">
                    <p className="text-cyan-400 font-semibold mb-2">Push Notifications</p>

                    {/* Browser support warnings */}
                    {notSupported && (
                        <p className="text-yellow-500 mb-2 bg-yellow-900/20 rounded p-2">
                            Your browser does not support push notifications.
                        </p>
                    )}
                    {!notSupported && permDenied && (
                        <p className="text-red-400 mb-2 bg-red-900/20 rounded p-2">
                            Notifications blocked in browser settings. Enable them in the address bar.
                        </p>
                    )}

                    {/* Add New Device — QR Code */}
                    <div className="border border-gray-700 rounded-lg p-2 mb-3 bg-gray-800/50">
                        <p className="text-gray-400 font-medium mb-2">📱 Add Device via QR Code</p>
                        {qrLoading && (
                            <p className="text-gray-600 italic text-center py-2">Loading…</p>
                        )}
                        {!qrLoading && setup?.qrDataUrl && (
                            <div className="flex flex-col items-center gap-2">
                                <img
                                    src={setup.qrDataUrl}
                                    alt="QR code"
                                    className="rounded bg-white p-1"
                                    style={{ width: 120, height: 120 }}
                                />
                                {setup.tunnel ? (
                                    <p className="text-green-400 text-center" style={{ fontSize: 10 }}>
                                        ✓ Tunnel active — scan with any device on any network.
                                    </p>
                                ) : (
                                    <div className="text-yellow-500 text-center bg-yellow-900/20 rounded p-1" style={{ fontSize: 10 }}>
                                        <p>⚠ Self-signed cert — Chrome may block the service worker on other networks.</p>
                                        <p className="text-gray-500 mt-1">Connecting a secure tunnel automatically in the background — this can take a few seconds after startup.</p>
                                        <button
                                            onClick={retryTunnel}
                                            disabled={tunnelRetrying}
                                            className="mt-1 px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-cyan-400 disabled:opacity-50"
                                        >
                                            {tunnelRetrying ? 'Retrying…' : 'Retry connection'}
                                        </button>
                                    </div>
                                )}
                                <p
                                    className="text-cyan-600 break-all text-center cursor-pointer hover:text-cyan-400"
                                    style={{ fontSize: 10 }}
                                    onClick={() => navigator.clipboard?.writeText(setup.primaryUrl)}
                                    title="Click to copy"
                                >
                                    {setup.primaryUrl}
                                </p>
                            </div>
                        )}
                        {!qrLoading && !setup && (
                            <p className="text-gray-600 italic text-center py-1">
                                HTTPS server not available
                            </p>
                        )}
                    </div>

                    {/* Notification display name — shown as the title on every push */}
                    <div className="border border-gray-700 rounded-lg p-2 mb-3 bg-gray-800/50">
                        <p className="text-gray-400 font-medium mb-1">🔖 Notification Name</p>
                        <p className="text-gray-600 mb-2" style={{ fontSize: 10 }}>
                            Shown as the title on every notification, e.g. "{appNameDraft || 'SMK TV'}".
                        </p>
                        <div className="flex gap-1">
                            <input
                                type="text"
                                value={appNameDraft}
                                onChange={(e) => setAppNameDraft(e.target.value)}
                                onBlur={saveAppName}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                                maxLength={40}
                                placeholder="SMK TV"
                                className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-cyan-600"
                            />
                            <button
                                onClick={saveAppName}
                                className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-cyan-400"
                            >
                                Save
                            </button>
                        </div>
                    </div>

                    {/* Install prompt — an installed PWA gets a persistent background
                        service; a plain tab is what Android kills in the background */}
                    {installPrompt && (
                        <div className="border border-cyan-700/40 rounded-lg p-2 mb-3 bg-cyan-900/10 flex items-center justify-between gap-2">
                            <p className="text-gray-300" style={{ fontSize: 11 }}>
                                📲 Install this app so notifications keep working when the browser is closed.
                            </p>
                            <button
                                onClick={installApp}
                                className="shrink-0 px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-[10px] font-medium"
                            >
                                Install
                            </button>
                        </div>
                    )}

                    {/* Master enable toggle */}
                    <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={settings.enabled}
                            onChange={() => saveSettings({ enabled: !settings.enabled })}
                            className="accent-cyan-500"
                            disabled={notSupported}
                        />
                        <span className={settings.enabled ? 'text-gray-200' : 'text-gray-500'}>
                            Enable push notifications
                        </span>
                        {saving && <span className="text-gray-600 ml-auto">saving…</span>}
                    </label>

                    {/* Per-event toggles */}
                    {settings.enabled && !notSupported && (
                        <div className="mb-3 border-t border-gray-700 pt-2">
                            <p className="text-gray-500 mb-1 font-medium">Events</p>
                            <div className="flex flex-col gap-1">
                                {Object.entries(EVENT_LABELS).map(([key, label]) => (
                                    <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                                        <input
                                            type="checkbox"
                                            checked={!!settings.events?.[key]}
                                            onChange={() => toggleEvent(key)}
                                            className="accent-cyan-500"
                                        />
                                        <span className={settings.events?.[key] ? 'text-gray-300' : 'text-gray-600'}>
                                            {label}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Registered devices */}
                    <div className="border-t border-gray-700 pt-2">
                        <div className="flex justify-between items-center mb-1">
                            <p className="text-gray-500 font-medium">
                                Registered Devices
                                {devices.length > 0 && (
                                    <span className="ml-1 bg-gray-700 text-gray-400 rounded-full px-1">{devices.length}</span>
                                )}
                            </p>
                            <button
                                onClick={load}
                                disabled={refreshing}
                                title="Refresh devices and settings"
                                className={`text-xs ${refreshing ? 'text-cyan-500 animate-spin inline-block cursor-wait' : 'text-gray-600 hover:text-gray-400'}`}
                            >
                                ↻
                            </button>
                        </div>

                        {devices.length === 0 ? (
                            <p className="text-gray-600 italic">No devices registered yet</p>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                {devices.map(d => {
                                    const ts = testStatus[d.id] || 'idle'
                                    return (
                                        <div key={d.id} className="bg-gray-800 rounded p-1.5">
                                            <div className="flex items-center justify-between">
                                                <span className="text-gray-300 truncate max-w-[140px]">
                                                    {deviceIcon(d.userAgent)} {d.deviceName || 'Unknown device'}
                                                </span>
                                                <div className="flex items-center gap-1 shrink-0 ml-1">
                                                    <button
                                                        onClick={() => sendDeviceTest(d.id)}
                                                        disabled={ts === 'sending'}
                                                        title="Send test notification to this device"
                                                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-all ${
                                                            ts === 'sent'    ? 'bg-green-700 text-white' :
                                                            ts === 'error'   ? 'bg-red-700 text-white' :
                                                            ts === 'sending' ? 'bg-gray-600 text-gray-400 cursor-wait' :
                                                            'bg-gray-700 hover:bg-gray-600 text-gray-300'
                                                        }`}
                                                    >
                                                        {ts === 'sent' ? '✓' : ts === 'error' ? '✕' : ts === 'sending' ? '…' : '🔔'}
                                                    </button>
                                                    <button
                                                        onClick={() => removeDevice(d.id)}
                                                        disabled={!!removing[d.id]}
                                                        className={`px-1 text-xs ${removing[d.id] ? 'text-gray-600 cursor-wait' : 'text-red-500 hover:text-red-400'}`}
                                                        title="Remove this device"
                                                    >
                                                        {removing[d.id] ? '…' : '✕'}
                                                    </button>
                                                </div>
                                            </div>
                                            <p className={`mt-0.5 ${isStale(d.lastSeenAt) ? 'text-yellow-500' : 'text-gray-600'}`} style={{ fontSize: 10 }}>
                                                last seen {timeAgo(d.lastSeenAt)} · added {timeAgo(d.registeredAt)}
                                                {isStale(d.lastSeenAt) && (
                                                    <span title="This device hasn't checked in for over a day — its browser is likely closed or offline">
                                                        {' '}⚠ not checking in
                                                    </span>
                                                )}
                                            </p>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    {/* Global test button (this browser) */}
                    {!notSupported && fcmStatus.token && (
                        <button
                            onClick={sendGlobalTest}
                            disabled={globalTest === 'sending'}
                            className={`mt-2 w-full py-1 rounded text-xs font-medium transition-all ${
                                globalTest === 'sent'    ? 'bg-green-700 text-white' :
                                globalTest === 'error'   ? 'bg-red-700 text-white' :
                                globalTest === 'sending' ? 'bg-gray-600 text-gray-400 cursor-wait' :
                                'bg-gray-700 hover:bg-gray-600 text-gray-300'
                            }`}
                        >
                            {globalTest === 'sent'    ? '✓ Notification sent!' :
                             globalTest === 'error'   ? '✕ Send failed' :
                             globalTest === 'sending' ? 'Sending…' :
                             '🔔 Test this browser'}
                        </button>
                    )}

                    {!notSupported && !fcmStatus.token && !permDenied && (
                        <button
                            onClick={enableNotifications}
                            disabled={enabling}
                            className={`mt-2 w-full py-1.5 rounded text-xs font-medium transition-all ${
                                enabling ? 'bg-gray-600 text-gray-400 cursor-wait' : 'bg-cyan-700 hover:bg-cyan-600 text-white'
                            }`}
                        >
                            {enabling ? 'Requesting permission…' : '🔔 Enable notifications on this device'}
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
