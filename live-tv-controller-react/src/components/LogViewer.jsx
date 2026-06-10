import React, { useState, useEffect, useCallback } from 'react';
import { getLogs, getLogMonths, deleteLog, clearLogs, LogCategory, LogType } from '../utils/logger';

/**
 * LogViewer Component
 * Displays logs with filtering, search, and management capabilities
 * 
 * Props:
 * - mode: 'collapsed' | 'fullpage' (default: 'collapsed')
 * - maxHeight: Height when collapsed (default: '350px')
 * - defaultExpanded: Start expanded? (default: false)
 */
const LogViewer = ({ mode = 'collapsed', maxHeight = '350px', defaultExpanded = false }) => {
    const [logs, setLogs] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [autoRefresh, setAutoRefresh] = useState(false);

    // Filters
    const [months, setMonths] = useState([]);
    const [selectedMonth, setSelectedMonth] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('');
    const [selectedType, setSelectedType] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    // Pagination
    const [page, setPage] = useState(0);
    const [limit] = useState(50);

    // Selected logs for bulk actions
    const [selectedLogs, setSelectedLogs] = useState(new Set());

    // Expanded log detail
    const [expandedLogId, setExpandedLogId] = useState(null);

    // Fetch available months
    useEffect(() => {
        const fetchMonths = async () => {
            const result = await getLogMonths();
            if (result.success && result.months.length > 0) {
                setMonths(result.months);
                setSelectedMonth(result.months[0]); // Most recent month
            } else {
                // Default to current month
                const currentMonth = new Date().toISOString().slice(0, 7);
                setMonths([currentMonth]);
                setSelectedMonth(currentMonth);
            }
        };
        fetchMonths();
    }, []);

    // Fetch logs
    const fetchLogs = useCallback(async () => {
        if (!selectedMonth) return;

        setLoading(true);
        const result = await getLogs({
            month: selectedMonth,
            category: selectedCategory || undefined,
            type: selectedType || undefined,
            search: searchQuery || undefined,
            limit,
            offset: page * limit
        });

        if (result.success) {
            setLogs(result.logs);
            setTotal(result.total);
        }
        setLoading(false);
    }, [selectedMonth, selectedCategory, selectedType, searchQuery, page, limit]);

    // Fetch logs when filters change
    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    // Auto-refresh
    useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(fetchLogs, 5000);
        return () => clearInterval(interval);
    }, [autoRefresh, fetchLogs]);

    // Handle delete single log
    const handleDeleteLog = async (id) => {
        await deleteLog(id, selectedMonth);
        fetchLogs();
    };

    // Handle clear all logs for month
    const handleClearMonth = async () => {
        if (!confirm(`Clear all logs for ${selectedMonth}?`)) return;
        await clearLogs(selectedMonth);
        fetchLogs();
    };

    // Handle export
    const handleExport = (format = 'json') => {
        const dataToExport = logs.filter(log => selectedLogs.size === 0 || selectedLogs.has(log.id));

        if (format === 'json') {
            const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `logs-${selectedMonth}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } else if (format === 'csv') {
            const headers = ['Timestamp', 'Day', 'Level', 'Category', 'Type', 'Message'];
            const rows = dataToExport.map(log => [
                log.timestamp,
                log.dayName,
                log.level,
                log.category,
                log.type,
                `"${(log.message || '').replace(/"/g, '""')}"`
            ]);
            const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `logs-${selectedMonth}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        }
    };

    // Toggle log selection
    const toggleLogSelection = (id) => {
        const newSelected = new Set(selectedLogs);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedLogs(newSelected);
    };

    // Get level color
    const getLevelColor = (level) => {
        switch (level) {
            case 'error': return 'text-red-400';
            case 'warn': return 'text-yellow-400';
            case 'debug': return 'text-gray-400';
            default: return 'text-green-400';
        }
    };

    // Get category color
    const getCategoryBadge = (category) => {
        const colors = {
            video: 'bg-blue-600',
            source: 'bg-purple-600',
            scheduler: 'bg-orange-600',
            katha: 'bg-pink-600',
            monitor: 'bg-cyan-600',
            system: 'bg-gray-600'
        };
        return colors[category] || 'bg-gray-600';
    };

    // Format month for display
    const formatMonth = (monthStr) => {
        const [year, month] = monthStr.split('-');
        const date = new Date(year, parseInt(month) - 1);
        return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    };

    const totalPages = Math.ceil(total / limit);

    // Collapsed mode - show toggle button
    if (mode === 'collapsed' && !expanded) {
        return (
            <div className="w-full mt-4 border-t border-gray-700 pt-2">
                <button
                    onClick={() => setExpanded(true)}
                    className="w-full py-2 px-4 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300 flex items-center justify-center gap-2"
                >
                    <span>📋</span>
                    <span>Show System Logs</span>
                    <span className="text-xs text-gray-500">({total} entries)</span>
                    <span>▼</span>
                </button>
            </div>
        );
    }

    return (
        <div
            className={`w-full ${mode === 'collapsed' ? 'mt-4 border-t border-gray-700 pt-2' : ''}`}
            style={mode === 'collapsed' ? { maxHeight } : {}}
        >
            {/* Header */}
            <div className="flex items-center justify-between bg-gray-800 px-4 py-2 rounded-t-lg">
                <div className="flex items-center gap-2">
                    <span className="text-lg">📋</span>
                    <h3 className="text-white font-semibold">System Logs</h3>
                    <span className="text-xs text-gray-400">({total} entries)</span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        className={`px-2 py-1 text-xs rounded ${autoRefresh ? 'bg-green-600' : 'bg-gray-600'}`}
                        title="Auto-refresh every 5s"
                    >
                        ⟳ {autoRefresh ? 'ON' : 'OFF'}
                    </button>
                    {mode === 'collapsed' && (
                        <button
                            onClick={() => setExpanded(false)}
                            className="px-2 py-1 text-xs bg-gray-600 rounded hover:bg-gray-500"
                        >
                            ▲ Collapse
                        </button>
                    )}
                </div>
            </div>

            {/* Filters */}
            <div className="bg-gray-800/50 px-4 py-2 flex flex-wrap gap-2 items-center">
                {/* Month selector */}
                <select
                    value={selectedMonth}
                    onChange={(e) => { setSelectedMonth(e.target.value); setPage(0); }}
                    className="bg-gray-700 text-white text-xs px-2 py-1 rounded"
                >
                    {months.map(m => (
                        <option key={m} value={m}>{formatMonth(m)}</option>
                    ))}
                </select>

                {/* Category filter */}
                <select
                    value={selectedCategory}
                    onChange={(e) => { setSelectedCategory(e.target.value); setPage(0); }}
                    className="bg-gray-700 text-white text-xs px-2 py-1 rounded"
                >
                    <option value="">All Categories</option>
                    {Object.values(LogCategory).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                    ))}
                </select>

                {/* Type filter */}
                <select
                    value={selectedType}
                    onChange={(e) => { setSelectedType(e.target.value); setPage(0); }}
                    className="bg-gray-700 text-white text-xs px-2 py-1 rounded"
                >
                    <option value="">All Types</option>
                    {Object.values(LogType).map(type => (
                        <option key={type} value={type}>{type}</option>
                    ))}
                </select>

                {/* Search */}
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
                    placeholder="Search..."
                    className="bg-gray-700 text-white text-xs px-2 py-1 rounded flex-1 min-w-[120px]"
                />

                {/* Action buttons */}
                <button onClick={() => handleExport('json')} className="px-2 py-1 text-xs bg-blue-600 rounded hover:bg-blue-500">
                    Export JSON
                </button>
                <button onClick={() => handleExport('csv')} className="px-2 py-1 text-xs bg-green-600 rounded hover:bg-green-500">
                    Export CSV
                </button>
                <button onClick={handleClearMonth} className="px-2 py-1 text-xs bg-red-600 rounded hover:bg-red-500">
                    Clear Month
                </button>
            </div>

            {/* Logs table */}
            <div
                className="overflow-auto bg-gray-900"
                style={mode === 'collapsed' ? { maxHeight: `calc(${maxHeight} - 120px)` } : { maxHeight: '60vh' }}
            >
                {loading ? (
                    <div className="text-center py-4 text-gray-400">Loading logs...</div>
                ) : logs.length === 0 ? (
                    <div className="text-center py-4 text-gray-400">No logs found</div>
                ) : (
                    <table className="w-full text-xs">
                        <thead className="bg-gray-800 sticky top-0">
                            <tr>
                                <th className="px-2 py-1 text-left text-gray-400 w-8">
                                    <input
                                        type="checkbox"
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                setSelectedLogs(new Set(logs.map(l => l.id)));
                                            } else {
                                                setSelectedLogs(new Set());
                                            }
                                        }}
                                    />
                                </th>
                                <th className="px-2 py-1 text-left text-gray-400">Time</th>
                                <th className="px-2 py-1 text-left text-gray-400">Day</th>
                                <th className="px-2 py-1 text-left text-gray-400">Level</th>
                                <th className="px-2 py-1 text-left text-gray-400">Category</th>
                                <th className="px-2 py-1 text-left text-gray-400">Type</th>
                                <th className="px-2 py-1 text-left text-gray-400">Message</th>
                                <th className="px-2 py-1 text-gray-400 w-8"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map(log => (
                                <React.Fragment key={log.id}>
                                    <tr
                                        className="border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer"
                                        onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                                    >
                                        <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                                            <input
                                                type="checkbox"
                                                checked={selectedLogs.has(log.id)}
                                                onChange={() => toggleLogSelection(log.id)}
                                            />
                                        </td>
                                        <td className="px-2 py-1 text-gray-300 whitespace-nowrap">
                                            {log.time || log.timestamp?.split('T')[1]?.slice(0, 8)}
                                        </td>
                                        <td className="px-2 py-1 text-gray-400 whitespace-nowrap">
                                            {log.dayName?.slice(0, 3) || ''}
                                        </td>
                                        <td className={`px-2 py-1 ${getLevelColor(log.level)} uppercase`}>
                                            {log.level}
                                        </td>
                                        <td className="px-2 py-1">
                                            <span className={`px-1.5 py-0.5 rounded text-white text-[10px] ${getCategoryBadge(log.category)}`}>
                                                {log.category}
                                            </span>
                                        </td>
                                        <td className="px-2 py-1 text-cyan-400 whitespace-nowrap">
                                            {log.type}
                                        </td>
                                        <td className="px-2 py-1 text-gray-300 truncate max-w-[300px]" title={log.message}>
                                            {log.message}
                                        </td>
                                        <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                                            <button
                                                onClick={() => handleDeleteLog(log.id)}
                                                className="text-red-400 hover:text-red-300"
                                                title="Delete log"
                                            >
                                                ×
                                            </button>
                                        </td>
                                    </tr>
                                    {expandedLogId === log.id && (
                                        <tr className="bg-gray-800/30">
                                            <td colSpan={8} className="px-4 py-2">
                                                <pre className="text-xs text-gray-400 overflow-x-auto">
                                                    {JSON.stringify(log, null, 2)}
                                                </pre>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="bg-gray-800/50 px-4 py-2 flex items-center justify-between rounded-b-lg">
                    <span className="text-xs text-gray-400">
                        Showing {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total}
                    </span>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setPage(Math.max(0, page - 1))}
                            disabled={page === 0}
                            className="px-2 py-1 text-xs bg-gray-600 rounded disabled:opacity-50"
                        >
                            ◀ Prev
                        </button>
                        <span className="px-2 py-1 text-xs text-gray-400">
                            Page {page + 1} of {totalPages}
                        </span>
                        <button
                            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                            disabled={page >= totalPages - 1}
                            className="px-2 py-1 text-xs bg-gray-600 rounded disabled:opacity-50"
                        >
                            Next ▶
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default LogViewer;
