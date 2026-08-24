import React, { useState, useEffect, useCallback } from 'react'

/**
 * What was actually sent, newest first.
 *
 * This answers the question the panel otherwise can't: a notification that never
 * arrived might have been switched off, might have had no registered device, or
 * might have been rejected by FCM — and those look identical from the phone.
 * Each row records the rendered text, what triggered it, and how many devices
 * took it.
 */

const PAGE_SIZE = 20

function timeAgo(iso) {
    if (!iso) return '—'
    try {
        const diff = Date.now() - new Date(iso).getTime()
        const mins = Math.floor(diff / 60000)
        if (mins < 1) return 'just now'
        if (mins < 60) return `${mins}m ago`
        const hrs = Math.floor(mins / 60)
        if (hrs < 24) return `${hrs}h ago`
        return `${Math.floor(hrs / 24)}d ago`
    } catch (_) { return iso }
}

export default function NotificationHistory({ labels = {} }) {
    const [entries, setEntries] = useState([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [clearing, setClearing] = useState(false)
    const [shown, setShown] = useState(PAGE_SIZE)

    const load = useCallback(async (limit) => {
        setLoading(true)
        try {
            const res = await fetch(`/api/notifications/history?limit=${limit}`)
            if (res.ok) {
                const data = await res.json()
                setEntries(data.entries || [])
                setTotal(data.total || 0)
            }
        } catch (_) { /* leave whatever is on screen */ } finally { setLoading(false) }
    }, [])

    useEffect(() => { load(shown) }, [load, shown])

    async function clearHistory() {
        setClearing(true)
        try {
            await fetch('/api/notifications/history', { method: 'DELETE' })
            await load(shown)
        } catch (_) {} finally { setClearing(false) }
    }

    return (
        <div>
            <div className="flex justify-between items-center mb-1.5">
                <p className="text-gray-500 font-medium">
                    Sent messages
                    {total > 0 && <span className="ml-1 bg-gray-700 text-gray-400 rounded-full px-1">{total}</span>}
                </p>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => load(shown)}
                        disabled={loading}
                        title="Refresh"
                        className={`${loading ? 'text-cyan-500 animate-spin inline-block cursor-wait' : 'text-gray-600 hover:text-gray-400'}`}
                    >
                        ↻
                    </button>
                    {total > 0 && (
                        <button
                            onClick={clearHistory}
                            disabled={clearing}
                            className="text-gray-600 hover:text-red-400"
                            style={{ fontSize: 10 }}
                        >
                            {clearing ? 'clearing…' : 'clear'}
                        </button>
                    )}
                </div>
            </div>

            {entries.length === 0 ? (
                <p className="text-gray-600 italic">
                    {loading ? 'Loading…' : 'Nothing sent yet. Notifications you send from here will be listed with what triggered them.'}
                </p>
            ) : (
                <div className="flex flex-col gap-1">
                    {entries.map(e => (
                        <div key={e.id} className="bg-gray-800/70 rounded p-1.5">
                            <div className="flex items-start justify-between gap-1">
                                <span className="text-gray-300 break-words" style={{ fontSize: 11 }}>
                                    {e.title}
                                </span>
                                <span
                                    className={`shrink-0 ${e.ok === false ? 'text-red-400' : 'text-green-600'}`}
                                    title={e.error || (e.ok === false ? 'Not delivered' : 'Delivered')}
                                    style={{ fontSize: 10 }}
                                >
                                    {e.ok === false ? '✕' : '✓'} {e.tokensSucceeded}/{e.tokensAttempted}
                                </span>
                            </div>
                            <p className="text-gray-500 whitespace-pre-line break-words" style={{ fontSize: 10 }}>
                                {e.body}
                            </p>
                            <p className="text-gray-700 mt-0.5" style={{ fontSize: 9 }}>
                                {labels[e.event] || e.event}
                                {e.trigger && <span className="text-cyan-800"> · {e.trigger}</span>}
                                <span> · {timeAgo(e.sentAt)}</span>
                            </p>
                            {e.ok === false && e.error && (
                                <p className="text-red-500 mt-0.5 break-words" style={{ fontSize: 9 }}>{e.error}</p>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {entries.length > 0 && total > entries.length && (
                <button
                    onClick={() => setShown(s => Math.min(s + PAGE_SIZE, 100))}
                    className="mt-1.5 w-full py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
                    style={{ fontSize: 10 }}
                >
                    Show more ({total - entries.length} older)
                </button>
            )}
        </div>
    )
}
