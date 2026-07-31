import { setStateValue } from './state-api';

// ============================================================================
// Stream-End Rules — matches an ended Live Player title against saved keyword
// rules to decide which Loop Playlist Automation Group (and optionally a
// specific Playlist inside it) to start. See LiveEndRulesManager.jsx for the
// editor UI that manages this data.
// ============================================================================

export const LIVE_END_RULES_LOCAL_KEY = 'liveEndRules';
export const LIVE_END_RULES_UPDATED_EVENT = 'liveEndRulesUpdated';
export const LIVE_END_RULES_SERVER_KEY = 'player.live.endRules';

export function generateRuleId() {
    return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newRule() {
    return { id: generateRuleId(), keywords: '', groupId: '', listId: '', isDefault: false };
}

export function loadLocalRules() {
    try {
        const saved = localStorage.getItem(LIVE_END_RULES_LOCAL_KEY);
        const parsed = saved ? JSON.parse(saved) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

// One-time migration: the old single "On Stream End, Start Group" dropdown (a bare groupId
// baked into livePlayerState) becomes the Default rule here, so setups configured before this
// feature existed keep handing off to Loop Player instead of silently losing that behavior.
export function migrateLegacyEndGroup(legacyGroupId) {
    if (!legacyGroupId || loadLocalRules().length > 0) return;
    const rules = [{ ...newRule(), groupId: legacyGroupId, isDefault: true }];
    localStorage.setItem(LIVE_END_RULES_LOCAL_KEY, JSON.stringify(rules));
    setStateValue(LIVE_END_RULES_SERVER_KEY, rules);
}

// Picks which rule applies to an ended live stream's title — keyword rules are tried first
// (case-insensitive substring match, comma-separated keywords per row, same convention as the
// Loop Player Group "Live event" trigger uses), the row marked Default is the fallback when
// nothing matches or the title is unknown. Returns null if nothing applies (do nothing, same
// as leaving the old dropdown on "None").
export function resolveLiveEndTarget(rules, title) {
    if (!Array.isArray(rules) || rules.length === 0) return null;
    const t = (title || '').toLowerCase().trim();
    if (t) {
        const match = rules.find(r => r.groupId && (r.keywords || '').trim() !== ''
            && r.keywords.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(k => t.includes(k)));
        if (match) return { groupId: match.groupId, listId: match.listId || null, matchedBy: 'keyword' };
    }
    const fallback = rules.find(r => r.isDefault && r.groupId);
    return fallback ? { groupId: fallback.groupId, listId: fallback.listId || null, matchedBy: 'default' } : null;
}
