import React, { useState, useEffect, useCallback } from 'react';

// Only needed if the server has RELAY_COOKIES_SECRET set (off by default) — see
// the auth gate on /api/relay/cookies in relay-service.cjs. Cached locally so
// it doesn't need re-entering every time the panel opens.
const SECRET_LS_KEY = 'relayCookiesAccessKey';

function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
}

function authHeaders(secret) {
    return secret ? { 'Authorization': `Bearer ${secret}` } : {};
}

export default function CookieSettings() {
    const [open, setOpen] = useState(false);
    const [info, setInfo] = useState(null); // { path, exists, active, updatedAt }
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState(null); // { type, msg }
    const [secretKey, setSecretKey] = useState(() => localStorage.getItem(SECRET_LS_KEY) || '');

    function flash(type, msg) {
        setStatus({ type, msg });
        setTimeout(() => setStatus(null), 5000);
    }

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/relay/cookies', { headers: authHeaders(secretKey) });
            if (res.status === 401) {
                flash('error', 'Unauthorized — check the access key below');
                return;
            }
            if (res.ok) {
                const data = await res.json();
                setInfo(data);
                setDraft(data.content || '');
            } else {
                const data = await res.json().catch(() => ({}));
                flash('error', data.error || `Failed to load (${res.status})`);
            }
        } catch (e) {
            flash('error', e.message);
        } finally {
            setLoading(false);
        }
    }, [secretKey]);

    useEffect(() => { if (open) load(); }, [open, load]);

    function saveSecretKey(v) {
        setSecretKey(v);
        if (v) localStorage.setItem(SECRET_LS_KEY, v);
        else localStorage.removeItem(SECRET_LS_KEY);
    }

    async function handleSave() {
        if (!draft.trim()) { flash('error', 'Paste cookie content before saving'); return; }
        setSaving(true);
        try {
            const res = await fetch('/api/relay/cookies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders(secretKey) },
                body: JSON.stringify({ content: draft }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                flash('success', 'Cookies saved — the relay will use them on the next load');
                load();
            } else if (res.status === 401) {
                flash('error', 'Unauthorized — check the access key below');
            } else {
                flash('error', data.error || 'Failed to save');
            }
        } catch (e) {
            flash('error', e.message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="relative flex flex-col items-end gap-1">
            <button
                onClick={() => setOpen(v => !v)}
                title="Manage the YouTube cookies.txt used by yt-dlp for the live relay"
                className={`px-2 py-1 rounded text-xs font-medium transition-all flex items-center gap-1 ${open ? 'bg-amber-700 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
            >
                🍪 Cookies
                <span className={`w-1.5 h-1.5 rounded-full ${info?.active ? 'bg-green-400' : 'bg-yellow-500'}`} />
            </button>

            {status && (
                <div className={`text-xs px-2 py-1 rounded ${status.type === 'success' ? 'bg-green-900/60 text-green-400' : 'bg-red-900/60 text-red-400'}`}>
                    {status.msg}
                </div>
            )}

            {open && (
                <div className="absolute right-0 top-full mt-1 z-20 bg-gray-900 border border-amber-700/50 rounded-lg p-3 w-96 text-xs shadow-xl">
                    <p className="text-amber-400 font-semibold mb-1">YouTube Cookies (cookies.txt)</p>
                    <p className="text-gray-500 mb-2">
                        {info?.exists
                            ? <>Loaded — updated {fmtDate(info.updatedAt)}</>
                            : 'No cookies file yet. Needed if yt-dlp starts hitting "Sign in to confirm you\'re not a bot".'}
                    </p>

                    <textarea
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        placeholder={'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t...'}
                        rows={8}
                        spellCheck={false}
                        className="w-full bg-gray-950 border border-gray-700 rounded p-2 font-mono text-[10px] leading-tight text-gray-300 resize-y"
                    />
                    <p className="text-gray-600 mt-1">
                        Export with a "cookies.txt" browser extension while logged into YouTube, then paste the full file contents above.
                    </p>

                    <div className="flex gap-1 mt-2 justify-end">
                        <button
                            onClick={load}
                            disabled={loading}
                            className="px-2 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300"
                        >
                            {loading ? '...' : '↻ Reload'}
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving || !draft.trim()}
                            className={`px-2 py-1 rounded text-xs font-medium text-white ${saving ? 'bg-gray-600 cursor-wait' : 'bg-amber-700 hover:bg-amber-600'}`}
                        >
                            {saving ? 'Saving...' : '💾 Save'}
                        </button>
                    </div>

                    {/* Only relevant if the server was started with RELAY_COOKIES_SECRET set —
                        harmless no-op otherwise. Kept collapsed-by-default via <details> since
                        most setups never need it. */}
                    <details className="mt-2">
                        <summary className="text-gray-600 cursor-pointer select-none">Access key (only if configured on the server)</summary>
                        <input
                            type="password"
                            value={secretKey}
                            onChange={e => saveSecretKey(e.target.value)}
                            placeholder="RELAY_COOKIES_SECRET value"
                            className="w-full mt-1 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
                        />
                    </details>
                </div>
            )}
        </div>
    );
}
