import React, { useState, useEffect, useCallback } from 'react'
import { getFCMStatus, unregisterFCM } from '../services/fcm.js'

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

export default function NotificationSettings() {
    const [open, setOpen]           = useState(false)
    const [settings, setSettings]   = useState({ enabled: true, events: DEFAULT_EVENTS })
    const [devices, setDevices]     = useState([])
    const [testStatus, setTestStatus] = useState({}) // { [deviceId]: 'idle'|'sending'|'sent'|'error' }
    const [globalTest, setGlobalTest] = useState('idle')
    const [saving, setSaving]       = useState(false)
    const [setup, setSetup]         = useState(null)    // { primaryUrl, qrDataUrl }
    const [qrLoading, setQrLoading] = useState(false)
    const fcmStatus = getFCMStatus()

    const load = useCallback(async () => {
        try {
            const [sRes, dRes] = await Promise.all([
                fetch('/api/notifications/settings'),
                fetch('/api/notifications/devices'),
            ])
            if (sRes.ok) setSettings(await sRes.json())
            if (dRes.ok) {
                const d = await dRes.json()
                setDevices(d.devices || [])
            }
        } catch (_) {}
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
        const device = devices.find(d => d.id === deviceId)
        if (!device) return
        try {
            await fetch('/api/notifications/register', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: device.token }),
            })
            setDevices(prev => prev.filter(d => d.id !== deviceId))
        } catch (_) {}
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
                                    <p className="text-yellow-500 text-center bg-yellow-900/20 rounded p-1" style={{ fontSize: 10 }}>
                                        ⚠ Self-signed cert — Chrome may block service worker.<br />
                                        Run <code className="bg-gray-700 px-1 rounded">npx localtunnel --port 3004</code> then set <code className="bg-gray-700 px-1 rounded">TUNNEL_URL</code> in .env and restart.
                                    </p>
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
                            <button onClick={load} className="text-gray-600 hover:text-gray-400 text-xs">↻</button>
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
                                                        className="text-red-500 hover:text-red-400 px-1 text-xs"
                                                        title="Remove this device"
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            </div>
                                            <p className="text-gray-600 mt-0.5" style={{ fontSize: 10 }}>
                                                last seen {timeAgo(d.lastSeenAt)} · added {timeAgo(d.registeredAt)}
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
                        <p className="text-gray-600 mt-2 italic">
                            Grant notification permission to register this device.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
