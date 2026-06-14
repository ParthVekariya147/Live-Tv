import { useState, useEffect, useRef } from 'react';

const ITEM_H  = 36;                                    // px — height of one option row
const HOURS   = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const PERIODS = ['AM', 'PM'];

// Parse a 24-hour "HH:MM" string into { hh (1-12), mm (0-59), ampm }
function parse24(value) {
    if (!value) return { hh: 12, mm: 0, ampm: 'AM' };
    const [h, m] = value.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return { hh: 12, mm: 0, ampm: 'AM' };
    if (h === 0)        return { hh: 12, mm: m, ampm: 'AM' };
    if (h < 12)         return { hh: h,  mm: m, ampm: 'AM' };
    if (h === 12)       return { hh: 12, mm: m, ampm: 'PM' };
    return              { hh: h - 12, mm: m, ampm: 'PM' };
}

// Convert 12-hour components → 24-hour "HH:MM" string
function to24(hh, mm, ampm) {
    let h24 = hh % 12;
    if (ampm === 'PM') h24 += 12;
    return `${String(h24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export default function TimePickerAMPM({ value, onChange, label, disabled = false }) {
    const parsed          = parse24(value);
    const [hh,   setHh]   = useState(parsed.hh);
    const [mm,   setMm]   = useState(parsed.mm);
    const [ampm, setAmpm] = useState(parsed.ampm);
    const [open, setOpen] = useState(false);

    const rootRef = useRef(null);
    const hourRef = useRef(null);
    const minRef  = useRef(null);

    // Sync internal state when the controlled `value` prop changes
    useEffect(() => {
        const p = parse24(value);
        setHh(p.hh);
        setMm(p.mm);
        setAmpm(p.ampm);
    }, [value]);

    // Emit a new 24h string — only if it actually differs to avoid infinite loops
    const emit = (newHh, newMm, newAmpm) => {
        const next = to24(newHh, newMm, newAmpm);
        if (next !== value) onChange(next);
    };

    // Close dropdown on outside click
    useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
            if (!rootRef.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    // Scroll each column so the selected item appears at the top when dropdown opens
    useEffect(() => {
        if (!open) return;
        const t = setTimeout(() => {
            if (hourRef.current) {
                const idx = HOURS.indexOf(hh);
                hourRef.current.scrollTop = idx * ITEM_H;
            }
            if (minRef.current) {
                minRef.current.scrollTop = mm * ITEM_H;
            }
        }, 0);
        return () => clearTimeout(t);
    }, [open]); // intentionally omit hh/mm — only scroll on open, not on every pick

    const pickHour   = (h) => { setHh(h);   emit(h,  mm,  ampm); };
    const pickMinute = (m) => { setMm(m);   emit(hh, m,   ampm); };
    const pickPeriod = (p) => { setAmpm(p); emit(hh, mm,  p);    };

    const displayStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${ampm}`;

    return (
        <div ref={rootRef} className="timepicker-root">
            {label && <span className="timepicker-label">{label}</span>}

            {/* Trigger button */}
            <button
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setOpen((o) => !o)}
                className={[
                    'timepicker-trigger',
                    open     ? 'timepicker-trigger--open'     : '',
                    disabled ? 'timepicker-trigger--disabled' : '',
                ].join(' ')}
            >
                <span className="timepicker-trigger-text">{displayStr}</span>
                <span
                    className="timepicker-chevron"
                    aria-hidden="true"
                    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                    ▾
                </span>
            </button>

            {/* Floating dropdown */}
            {open && (
                <div className="timepicker-dropdown" role="dialog" aria-label="Time picker">

                    {/* Hour column */}
                    <div ref={hourRef} className="tp-col" role="listbox" aria-label="Hour">
                        {HOURS.map((h) => (
                            <div
                                key={h}
                                role="option"
                                aria-selected={h === hh}
                                className={`tp-item${h === hh ? ' tp-item--selected' : ''}`}
                                onClick={() => pickHour(h)}
                            >
                                {String(h).padStart(2, '0')}
                            </div>
                        ))}
                    </div>

                    {/* Minute column */}
                    <div ref={minRef} className="tp-col" role="listbox" aria-label="Minute">
                        {MINUTES.map((m) => (
                            <div
                                key={m}
                                role="option"
                                aria-selected={m === mm}
                                className={`tp-item${m === mm ? ' tp-item--selected' : ''}`}
                                onClick={() => pickMinute(m)}
                            >
                                {String(m).padStart(2, '0')}
                            </div>
                        ))}
                    </div>

                    {/* AM / PM column */}
                    <div className="tp-col tp-col--period" role="listbox" aria-label="AM or PM">
                        {PERIODS.map((p) => (
                            <div
                                key={p}
                                role="option"
                                aria-selected={p === ampm}
                                className={`tp-item${p === ampm ? ' tp-item--selected' : ''}`}
                                onClick={() => pickPeriod(p)}
                            >
                                {p}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
