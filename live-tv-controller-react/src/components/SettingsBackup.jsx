import React, { useRef, useState } from 'react';

export default function SettingsBackup() {
    const fileInputRef = useRef(null);
    const [status, setStatus] = useState(null); // { type: 'success'|'error', msg }
    const [importing, setImporting] = useState(false);

    function flash(type, msg) {
        setStatus({ type, msg });
        setTimeout(() => setStatus(null), 4000);
    }

    async function handleExport() {
        try {
            const res = await fetch('/api/settings/export');
            if (!res.ok) throw new Error(`Server error ${res.status}`);
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="(.+?)"/);
            const filename = match ? match[1] : 'live-tv-settings.json';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            flash('success', 'Exported');
        } catch (e) {
            flash('error', e.message);
        }
    }

    async function handleImport(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        setImporting(true);
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            const res = await fetch('/api/settings/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(json),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Import failed');
            flash('success', `Imported ${data.stateKeys} settings + ${data.schedulesCount} schedules`);
            setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
            flash('error', e.message);
        } finally {
            setImporting(false);
        }
    }

    return (
        <div className="flex flex-col gap-1 items-end">
            <span className="text-xs text-cyan-400 font-semibold mb-1">Settings</span>
            <div className="flex gap-1">
                <button
                    onClick={handleExport}
                    title="Export all settings to JSON file"
                    className="px-2 py-1 rounded text-xs font-medium transition-all bg-blue-700 hover:bg-blue-600 text-white"
                >
                    ⬇ Export
                </button>
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                    title="Import settings from JSON file"
                    className={`px-2 py-1 rounded text-xs font-medium transition-all text-white ${importing ? 'bg-gray-600 cursor-wait' : 'bg-green-700 hover:bg-green-600'}`}
                >
                    {importing ? '...' : '⬆ Import'}
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={handleImport}
                />
            </div>
            {status && (
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${status.type === 'success' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
                    {status.type === 'success' ? '✓' : '✗'} {status.msg}
                </span>
            )}
        </div>
    );
}
