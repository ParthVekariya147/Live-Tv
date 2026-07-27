import React, { useEffect, useState } from 'react';

const LOCAL_API_BASE = import.meta.env.VITE_LOCAL_API_BASE || "http://localhost:3000";

export const CHANNELS_UPDATED_EVENT = 'channelsUpdated';

function makeLocalId() {
    return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const ChannelManager = () => {
    const [open, setOpen] = useState(false);
    const [rows, setRows] = useState([]);
    const [status, setStatus] = useState('');
    const [saving, setSaving] = useState(false);

    const loadChannels = async () => {
        try {
            const res = await fetch(`${LOCAL_API_BASE}/api/channels`, { cache: 'no-store' });
            const data = await res.json();
            if (data.success) {
                setRows(data.channels.map((c) => ({ ...c })));
            }
        } catch (err) {
            setStatus(`Failed to load channels: ${err.message}`);
        }
    };

    useEffect(() => {
        if (open) loadChannels();
    }, [open]);

    const addRow = () => {
        setRows((prev) => [...prev, { id: makeLocalId(), name: '', channelId: '' }]);
    };

    const updateRow = (id, patch) => {
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    };

    const deleteRow = (id) => {
        setRows((prev) => prev.filter((r) => r.id !== id));
    };

    const handleSave = async () => {
        setSaving(true);
        setStatus('Saving...');
        try {
            const res = await fetch(`${LOCAL_API_BASE}/api/channels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channels: rows }),
            });
            const data = await res.json();
            if (!data.success) {
                setStatus(`Error: ${data.error}`);
                return;
            }
            setRows(data.channels.map((c) => ({ ...c })));
            setStatus(`Saved ${data.channels.length} channel(s).`);
            window.dispatchEvent(new CustomEvent(CHANNELS_UPDATED_EVENT));
        } catch (err) {
            setStatus(`Failed to save: ${err.message}`);
        } finally {
            setSaving(false);
        }
    };

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                className="px-2 py-1 rounded text-xs font-medium transition-all bg-gray-700 hover:bg-gray-600 text-amber-400 border border-amber-800/40 flex items-center gap-1"
                title="Manage the YouTube channel IDs used by Live Event Monitor 1/2 and Katha Monitor"
            >
                ⚙ Channels
            </button>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center overflow-y-auto py-6 px-3">
            <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-3xl text-sm text-gray-200">
                <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-4 py-3 flex justify-between items-center rounded-t-lg z-10">
                    <div>
                        <h2 className="text-lg font-bold text-amber-400">Channel Manager</h2>
                        <p className="text-xs text-gray-400">{status || 'Add YouTube channel IDs to monitor — used by Live Event Monitor 1, Monitor 2, and Katha Monitor.'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={addRow} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-xs font-medium">+ Add Channel</button>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="bg-green-700 hover:bg-green-600 text-white px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50"
                        >
                            {saving ? 'Saving...' : 'Save'}
                        </button>
                        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white text-xl leading-none px-2">×</button>
                    </div>
                </div>

                <div className="p-4 space-y-2">
                    {rows.length === 0 && (
                        <div className="text-center py-10 text-gray-500">
                            <p>No channels configured yet.</p>
                            <p className="text-xs mt-1">Click "+ Add Channel" and paste a YouTube channel ID (starts with UC...).</p>
                        </div>
                    )}

                    {rows.map((row) => (
                        <div key={row.id} className="flex gap-2 items-center bg-gray-800 border border-gray-700 rounded p-2">
                            <input
                                type="text"
                                className="input-field flex-1"
                                placeholder="Channel name (e.g. My Channel)"
                                value={row.name}
                                onChange={(e) => updateRow(row.id, { name: e.target.value })}
                            />
                            <input
                                type="text"
                                className="input-field flex-1 font-mono"
                                placeholder="Channel ID (UCxxxxxxxxxxxxxxxxxxxxxx)"
                                value={row.channelId}
                                onChange={(e) => updateRow(row.id, { channelId: e.target.value.trim() })}
                            />
                            <button
                                onClick={() => deleteRow(row.id)}
                                className="bg-red-700 hover:bg-red-600 text-white px-2 py-1.5 rounded text-xs font-medium"
                                title="Remove this channel"
                            >
                                Delete
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default ChannelManager;
