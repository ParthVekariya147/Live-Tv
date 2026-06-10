import React, { useRef, useState } from 'react';

export default function SettingsBackup() {
    const fileInputRef = useRef(null);
    const [status, setStatus] = useState(null); // { type: 'success'|'error', msg }

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
            setStatus({ type: 'success', msg: `Exported: ${filename}` });
        } catch (e) {
            setStatus({ type: 'error', msg: `Export failed: ${e.message}` });
        }
        setTimeout(() => setStatus(null), 4000);
    }

    async function handleImport(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
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
            setStatus({ type: 'success', msg: `Imported ${data.stateKeys} settings + ${data.schedulesCount} schedules. Reloading...` });
            setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
            setStatus({ type: 'error', msg: `Import failed: ${e.message}` });
            setTimeout(() => setStatus(null), 5000);
        }
    }

    return (
        <div className="settings-backup-bar">
            <span className="settings-backup-label">Settings</span>

            <button className="settings-backup-btn export" onClick={handleExport} title="Download all settings as JSON">
                ⬇ Export
            </button>

            <button className="settings-backup-btn import" onClick={() => fileInputRef.current?.click()} title="Restore settings from JSON file">
                ⬆ Import
            </button>

            <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={handleImport}
            />

            {status && (
                <span className={`settings-backup-status ${status.type}`}>
                    {status.type === 'success' ? '✓' : '✗'} {status.msg}
                </span>
            )}
        </div>
    );
}
