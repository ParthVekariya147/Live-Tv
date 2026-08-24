import React, { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Notification Panel — edit the wording of every notification the app sends.
 *
 * The event list, each event's default wording and its available {placeholders}
 * all come from GET /api/notifications/catalog, so this component holds no copy
 * of them: an event added to notification-catalog.cjs appears here, editable,
 * with no change to this file.
 *
 * The live preview is rendered by the server (POST /api/notifications/render)
 * rather than by string-replacing here, so what the preview shows is produced by
 * the very same code path that builds a real push — including emoji handling and
 * the code-point-safe length limits.
 */

// A small, relevant palette rather than a full emoji keyboard. Text inputs
// accept any emoji the OS keyboard produces (Win+. on Windows), so this is a
// shortcut for the ones that actually suit broadcast notifications.
const EMOJI_PALETTE = [
    '🔴', '🟢', '🟡', '⚪', '▶️', '⏸️', '⏹️', '⏭️', '⏺️',
    '📺', '🎬', '🎥', '📡', '🔔', '🔕', '⚠️', '✅', '❌',
    '⏰', '📅', '🔀', '🔁', '📱', '💻', '🎧', '🕉️', '🙏', '🎉',
]

function fieldCharCount(str) {
    // Code points, not UTF-16 units — an emoji counts as 1 here, matching how the
    // server measures and truncates it.
    return Array.from(str || '').length
}

export default function NotificationPanel({ settings, onPatch, appName }) {
    const [catalog, setCatalog] = useState(null)
    const [loadError, setLoadError] = useState(false)
    const [expanded, setExpanded] = useState(null)
    // "Manual changes" open by default — it's the group that didn't exist before
    // and the reason most people will open this tab.
    const [openGroups, setOpenGroups] = useState({ manual: true })
    // Unsaved edits, keyed by event: { title, body, useAppNameAsTitle }
    const [drafts, setDrafts] = useState({})
    const [previews, setPreviews] = useState({})
    const [testing, setTesting] = useState({})
    const [savedFlash, setSavedFlash] = useState({})
    // Which field a palette insert should land in — set on focus so the emoji and
    // placeholder buttons know whether the operator was last editing title or body.
    const focusedFieldRef = useRef({ key: null, field: null, el: null })

    const loadCatalog = useCallback(async () => {
        try {
            const res = await fetch('/api/notifications/catalog')
            if (!res.ok) { setLoadError(true); return }
            const data = await res.json()
            setCatalog(data)
            setLoadError(false)
        } catch (_) { setLoadError(true) }
    }, [])

    // Fetch-on-mount. The rule can't see that loadCatalog's setState calls all sit
    // behind an await, so it reads this as a synchronous setState in an effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { loadCatalog() }, [loadCatalog])

    const eventsByGroup = useCallback((groupId) => {
        if (!catalog) return []
        return catalog.events.filter(e => e.group === groupId)
    }, [catalog])

    function draftFor(event) {
        return drafts[event.key] || {
            title: event.effective.title,
            body: event.effective.body,
            useAppNameAsTitle: event.effective.useAppNameAsTitle,
        }
    }

    function isDirty(event) {
        const d = drafts[event.key]
        if (!d) return false
        return d.title !== event.effective.title
            || d.body !== event.effective.body
            || d.useAppNameAsTitle !== event.effective.useAppNameAsTitle
    }

    // Debounced server-side render of whatever is in the editor right now.
    const previewTimers = useRef({})
    const requestPreview = useCallback((eventKey, draft) => {
        clearTimeout(previewTimers.current[eventKey])
        previewTimers.current[eventKey] = setTimeout(async () => {
            try {
                const res = await fetch('/api/notifications/render', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        event: eventKey,
                        title: draft.title,
                        body: draft.body,
                        useAppNameAsTitle: draft.useAppNameAsTitle,
                    }),
                })
                if (!res.ok) return
                const rendered = await res.json()
                setPreviews(p => ({ ...p, [eventKey]: rendered }))
            } catch (_) { /* preview is a nicety — never block editing on it */ }
        }, 250)
    }, [])

    useEffect(() => () => {
        Object.values(previewTimers.current).forEach(clearTimeout)
    }, [])

    function patchDraft(event, patch) {
        const next = { ...draftFor(event), ...patch }
        setDrafts(d => ({ ...d, [event.key]: next }))
        requestPreview(event.key, next)
    }

    // Open an editor: seed its draft and fetch the first preview so the box shows
    // the current wording rendered, not an empty frame.
    function toggleExpanded(event) {
        const opening = expanded !== event.key
        setExpanded(opening ? event.key : null)
        if (opening) {
            const draft = draftFor(event)
            setDrafts(d => ({ ...d, [event.key]: draft }))
            requestPreview(event.key, draft)
        }
    }

    async function saveTemplate(event) {
        const draft = draftFor(event)
        await onPatch({
            templates: {
                ...(settings.templates || {}),
                [event.key]: {
                    title: draft.title,
                    body: draft.body,
                    useAppNameAsTitle: draft.useAppNameAsTitle,
                },
            },
        })
        setDrafts(d => { const next = { ...d }; delete next[event.key]; return next })
        setSavedFlash(f => ({ ...f, [event.key]: true }))
        setTimeout(() => setSavedFlash(f => ({ ...f, [event.key]: false })), 2000)
        // Re-read so `effective` reflects what the server actually stored (it
        // truncates and trims), rather than assuming the draft went in verbatim.
        loadCatalog()
    }

    async function resetTemplate(event) {
        // null is the wire form of "forget my override" — the catalog default
        // takes over again on the server side.
        await onPatch({ templates: { ...(settings.templates || {}), [event.key]: null } })
        setDrafts(d => { const next = { ...d }; delete next[event.key]; return next })
        const fresh = await fetch('/api/notifications/catalog').then(r => r.ok ? r.json() : null).catch(() => null)
        if (fresh) {
            setCatalog(fresh)
            const ev = fresh.events.find(e => e.key === event.key)
            if (ev) requestPreview(event.key, {
                title: ev.effective.title, body: ev.effective.body, useAppNameAsTitle: ev.effective.useAppNameAsTitle,
            })
        }
    }

    async function sendTemplateTest(event) {
        const draft = draftFor(event)
        setTesting(t => ({ ...t, [event.key]: 'sending' }))
        try {
            const res = await fetch('/api/notifications/test-template', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: event.key,
                    title: draft.title,
                    body: draft.body,
                    useAppNameAsTitle: draft.useAppNameAsTitle,
                }),
            })
            setTesting(t => ({ ...t, [event.key]: res.ok ? 'sent' : 'error' }))
        } catch (_) {
            setTesting(t => ({ ...t, [event.key]: 'error' }))
        }
        setTimeout(() => setTesting(t => ({ ...t, [event.key]: 'idle' })), 3000)
    }

    function toggleEventEnabled(event) {
        onPatch({ events: { ...(settings.events || {}), [event.key]: !event.enabled } })
        setCatalog(c => c && {
            ...c,
            events: c.events.map(e => e.key === event.key ? { ...e, enabled: !e.enabled } : e),
        })
    }

    /**
     * Insert text at the caret of the field the operator was last in, so an emoji
     * or a {placeholder} lands where they were typing instead of being appended.
     */
    function insertAtCaret(event, text) {
        const focus = focusedFieldRef.current
        const field = (focus.key === event.key && focus.field) ? focus.field : 'body'
        const el = (focus.key === event.key) ? focus.el : null
        const draft = draftFor(event)
        const current = draft[field] || ''

        if (el && typeof el.selectionStart === 'number') {
            const start = el.selectionStart
            const end = el.selectionEnd
            const next = current.slice(0, start) + text + current.slice(end)
            patchDraft(event, { [field]: next })
            // Restore the caret after React re-renders with the new value.
            requestAnimationFrame(() => {
                try {
                    el.focus()
                    el.setSelectionRange(start + text.length, start + text.length)
                } catch (_) { /* element may have unmounted */ }
            })
            return
        }
        patchDraft(event, { [field]: current + text })
    }

    if (loadError) {
        return (
            <div className="text-center py-3">
                <p className="text-red-400">Couldn't load the notification list.</p>
                <button onClick={loadCatalog} className="mt-1 px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-cyan-400">
                    Retry
                </button>
            </div>
        )
    }

    if (!catalog) {
        return <p className="text-gray-600 italic text-center py-3">Loading messages…</p>
    }

    const customCount = catalog.events.filter(e => e.effective.isCustom).length

    return (
        <div>
            <p className="text-gray-500 mb-2" style={{ fontSize: 10 }}>
                Every message the app can send, and the exact words it uses. Edit any of them,
                emojis included — they are used for both automatic and by-hand changes.
                {customCount > 0 && <span className="text-cyan-600"> {customCount} customised.</span>}
            </p>

            {catalog.groups.map(group => {
                const events = eventsByGroup(group.id)
                if (events.length === 0) return null
                const isOpen = !!openGroups[group.id]
                const onCount = events.filter(e => e.enabled).length

                return (
                    <div key={group.id} className="mb-2 border border-gray-700 rounded-lg overflow-hidden">
                        <button
                            onClick={() => setOpenGroups(g => ({ ...g, [group.id]: !g[group.id] }))}
                            className="w-full flex items-center justify-between px-2 py-1.5 bg-gray-800/70 hover:bg-gray-800 text-left"
                        >
                            <span className="text-gray-300 font-medium">
                                {isOpen ? '▾' : '▸'} {group.label}
                            </span>
                            <span className="text-gray-600" style={{ fontSize: 10 }}>
                                {onCount}/{events.length} on
                            </span>
                        </button>

                        {isOpen && (
                            <div className="px-1.5 py-1 bg-gray-900">
                                <p className="text-gray-600 mb-1" style={{ fontSize: 10 }}>{group.hint}</p>

                                {events.map(event => {
                                    const open = expanded === event.key
                                    const draft = draftFor(event)
                                    const preview = previews[event.key]
                                    const ts = testing[event.key] || 'idle'
                                    const titleCount = fieldCharCount(draft.title)
                                    const bodyCount = fieldCharCount(draft.body)

                                    return (
                                        <div key={event.key} className="mb-1 rounded bg-gray-800/60">
                                            <div className="flex items-center gap-1.5 px-1.5 py-1">
                                                <input
                                                    type="checkbox"
                                                    checked={event.enabled}
                                                    onChange={() => toggleEventEnabled(event)}
                                                    className="accent-cyan-500 shrink-0"
                                                    title={event.enabled ? 'This message is being sent' : 'This message is switched off'}
                                                />
                                                <button
                                                    onClick={() => toggleExpanded(event)}
                                                    className="flex-1 min-w-0 text-left"
                                                    title={event.hint}
                                                >
                                                    <span className={event.enabled ? 'text-gray-300' : 'text-gray-600'}>
                                                        {event.label}
                                                    </span>
                                                    {event.effective.isCustom && (
                                                        <span className="ml-1 text-cyan-600" style={{ fontSize: 9 }} title="You have edited this message">✎</span>
                                                    )}
                                                </button>
                                                <button
                                                    onClick={() => toggleExpanded(event)}
                                                    className="shrink-0 text-gray-500 hover:text-cyan-400 px-1"
                                                    title="Edit the wording"
                                                >
                                                    {open ? '▾' : '✎'}
                                                </button>
                                            </div>

                                            {open && (
                                                <div className="px-1.5 pb-2 pt-0.5 border-t border-gray-700/60">
                                                    <p className="text-gray-600 mb-1.5" style={{ fontSize: 10 }}>{event.hint}</p>

                                                    {/* Title */}
                                                    <div className="mb-1.5">
                                                        <div className="flex justify-between items-baseline">
                                                            <label className="text-gray-500" style={{ fontSize: 10 }}>Title</label>
                                                            <span className={titleCount > catalog.limits.title ? 'text-red-400' : 'text-gray-700'} style={{ fontSize: 9 }}>
                                                                {titleCount}/{catalog.limits.title}
                                                            </span>
                                                        </div>
                                                        <input
                                                            type="text"
                                                            value={draft.title}
                                                            onChange={(e) => patchDraft(event, { title: e.target.value })}
                                                            onFocus={(e) => { focusedFieldRef.current = { key: event.key, field: 'title', el: e.target } }}
                                                            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-cyan-600"
                                                        />
                                                    </div>

                                                    {/* Body */}
                                                    <div className="mb-1.5">
                                                        <div className="flex justify-between items-baseline">
                                                            <label className="text-gray-500" style={{ fontSize: 10 }}>Message</label>
                                                            <span className={bodyCount > catalog.limits.body ? 'text-red-400' : 'text-gray-700'} style={{ fontSize: 9 }}>
                                                                {bodyCount}/{catalog.limits.body}
                                                            </span>
                                                        </div>
                                                        <textarea
                                                            value={draft.body}
                                                            onChange={(e) => patchDraft(event, { body: e.target.value })}
                                                            onFocus={(e) => { focusedFieldRef.current = { key: event.key, field: 'body', el: e.target } }}
                                                            rows={2}
                                                            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-cyan-600 resize-y"
                                                        />
                                                    </div>

                                                    {/* Placeholders this event can fill in */}
                                                    {(event.vars.length > 0 || catalog.globalVars.length > 0) && (
                                                        <div className="mb-1.5">
                                                            <p className="text-gray-500 mb-0.5" style={{ fontSize: 10 }}>
                                                                Tap to insert — replaced with the real value when sent:
                                                            </p>
                                                            <div className="flex flex-wrap gap-1">
                                                                {[...event.vars, ...catalog.globalVars].map(v => (
                                                                    <button
                                                                        key={v.name}
                                                                        onClick={() => insertAtCaret(event, `{${v.name}}`)}
                                                                        title={`${v.hint || v.name} — e.g. "${v.sample}"`}
                                                                        className="px-1 py-0.5 rounded bg-gray-700 hover:bg-cyan-800 text-cyan-400 font-mono"
                                                                        style={{ fontSize: 9 }}
                                                                    >
                                                                        {`{${v.name}}`}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Emoji palette */}
                                                    <div className="mb-1.5">
                                                        <p className="text-gray-500 mb-0.5" style={{ fontSize: 10 }}>
                                                            Emojis (or use your keyboard's — Windows key + <b>.</b>):
                                                        </p>
                                                        <div className="flex flex-wrap gap-0.5">
                                                            {EMOJI_PALETTE.map(emoji => (
                                                                <button
                                                                    key={emoji}
                                                                    onClick={() => insertAtCaret(event, emoji)}
                                                                    className="px-1 rounded hover:bg-gray-700"
                                                                    style={{ fontSize: 14, lineHeight: '18px' }}
                                                                >
                                                                    {emoji}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>

                                                    {/* Where the title goes */}
                                                    <label className="flex items-start gap-1.5 mb-1.5 cursor-pointer select-none">
                                                        <input
                                                            type="checkbox"
                                                            checked={draft.useAppNameAsTitle}
                                                            onChange={() => patchDraft(event, { useAppNameAsTitle: !draft.useAppNameAsTitle })}
                                                            className="accent-cyan-500 mt-0.5"
                                                        />
                                                        <span className="text-gray-400" style={{ fontSize: 10 }}>
                                                            Head the notification with "{appName || 'SMK TV'}" and put your title on the
                                                            first line of the message. Untick to make your own title the headline —
                                                            that's where a title emoji shows up biggest on a phone.
                                                        </span>
                                                    </label>

                                                    {/* Preview — rendered by the server, so this is literally what gets sent */}
                                                    <div className="rounded border border-gray-700 bg-black/40 p-1.5 mb-1.5">
                                                        <p className="text-gray-600 mb-1" style={{ fontSize: 9 }}>ON YOUR PHONE</p>
                                                        {preview ? (
                                                            <>
                                                                <p className="text-gray-100 font-semibold break-words" style={{ fontSize: 11 }}>
                                                                    {preview.title}
                                                                </p>
                                                                <p className="text-gray-400 whitespace-pre-line break-words" style={{ fontSize: 10 }}>
                                                                    {preview.body}
                                                                </p>
                                                            </>
                                                        ) : (
                                                            <p className="text-gray-700 italic" style={{ fontSize: 10 }}>rendering…</p>
                                                        )}
                                                    </div>

                                                    <div className="flex items-center gap-1">
                                                        <button
                                                            onClick={() => saveTemplate(event)}
                                                            disabled={!isDirty(event)}
                                                            className={`px-2 py-1 rounded font-medium ${
                                                                savedFlash[event.key] ? 'bg-green-700 text-white'
                                                                : isDirty(event) ? 'bg-cyan-700 hover:bg-cyan-600 text-white'
                                                                : 'bg-gray-700 text-gray-500 cursor-default'
                                                            }`}
                                                            style={{ fontSize: 10 }}
                                                        >
                                                            {savedFlash[event.key] ? '✓ Saved' : isDirty(event) ? 'Save' : 'Saved'}
                                                        </button>
                                                        <button
                                                            onClick={() => sendTemplateTest(event)}
                                                            disabled={ts === 'sending'}
                                                            title="Send this exact message to every registered device now"
                                                            className={`px-2 py-1 rounded font-medium ${
                                                                ts === 'sent'    ? 'bg-green-700 text-white' :
                                                                ts === 'error'   ? 'bg-red-700 text-white' :
                                                                ts === 'sending' ? 'bg-gray-600 text-gray-400 cursor-wait' :
                                                                'bg-gray-700 hover:bg-gray-600 text-gray-300'
                                                            }`}
                                                            style={{ fontSize: 10 }}
                                                        >
                                                            {ts === 'sent' ? '✓ Sent' : ts === 'error' ? '✕ Failed' : ts === 'sending' ? 'Sending…' : '🔔 Test'}
                                                        </button>
                                                        {event.effective.isCustom && (
                                                            <button
                                                                onClick={() => resetTemplate(event)}
                                                                title="Go back to the built-in wording"
                                                                className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 ml-auto"
                                                                style={{ fontSize: 10 }}
                                                            >
                                                                Reset
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
