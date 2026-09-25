// Clipboard write that also works where navigator.clipboard does not exist.
//
// The controller is routinely opened over plain http:// — on the LAN by IP, or from
// another machine on the network. That is not a "secure context", so the browser does
// not expose navigator.clipboard at all and a copy button written against it throws
// TypeError and silently does nothing. The legacy execCommand path has no such
// restriction, so it is the fallback rather than the other way round.
export async function copyToClipboard(text) {
    const value = String(text ?? '');
    if (!value) return false;

    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch {
            // Permission denied or insecure context — fall through to execCommand.
        }
    }

    try {
        const ta = document.createElement('textarea');
        ta.value = value;
        // Keep it off-screen and non-focusable-looking so the page doesn't visibly jump.
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.left = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

export default copyToClipboard;
