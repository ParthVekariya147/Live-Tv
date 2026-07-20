# Loop Player — Playlist Automation

> How the "⚙ Playlists" feature on the Loop Player works, the rules it follows, and its current limits.
> Files: `live-tv-controller-react/src/components/LoopPlaylistAutomation.jsx` (editor UI + engine), `src/components/LoopPlayerCard.jsx` (playback), `src/components/common/ErrorBoundary.jsx` (crash guard).

---

## What it does

Normally the Loop Player plays one flat list of YouTube video IDs, in order, forever. Playlist Automation sits on top of that and lets you define **multiple playlists that take turns automatically** — e.g. one set of videos in the morning, a different set in the evening, or a special playlist that kicks in whenever a live event is detected.

You open it by clicking **⚙ Playlists** on the Loop Player card. It's a full-screen panel, but the automation engine itself (scheduler clock, live-event listener, chaining logic) keeps running in the background even when the panel is closed — closing it doesn't pause anything that's active.

---

## The two building blocks

### Group — a routine

A Group is "when does something start, and what happens when it's all done." Fields:

| Field | Meaning |
|---|---|
| Serial / Name | Just labels — used so other Groups can target this one when chaining. |
| **Trigger** | How this Group starts (see table below). |
| **When Group ends** | What happens after every List inside it has finished (see table below). |

**Trigger types:**

| Trigger | Behavior |
|---|---|
| `Default (chained from another Group)` | Never starts on its own — only reachable when another Group's end-behavior points at it. |
| `On Scheduler Time` | Fires once per day at the HH:MM you set. A clock check runs every 20 seconds; each Group fires **at most once per calendar day**. |
| `On Live Event Match` | Fires when the app detects a live-event match (the same detection your Live Player monitor already uses). Leave the keyword box empty to fire on *any* detected live event, or type comma-separated keywords to only fire when the matched video's title contains one of them. |

**"When Group ends" types** (checked once every List in the Group has been exhausted):

| Option | Behavior |
|---|---|
| `Loop this Group` | Restart the Group from its first playable List. |
| `Go to Group by Serial` | Jump to another Group, matched by its Serial number. |
| `Go to Group by Name` | Jump to another Group, matched by its Name. |

### List — a playlist

A List is "which videos, how many, and what happens after them." Fields:

| Field | Meaning |
|---|---|
| Serial / Name | Labels — used so other Lists in the same Group can target this one. |
| Video IDs box | Paste video IDs or full YouTube URLs, comma or newline separated, then click **Import**. |
| **Start Index** | Which video in the list to begin at (1-based). |
| **Play Count** | How many videos to play starting from Start Index before handing off. |
| **Then** | What happens once Play Count is reached (see below). |

**"Then" types:**

| Option | Behavior |
|---|---|
| `Go to Next List` | Hand off to another List you pick from a dropdown (must be in the same Group). |
| `End Group` | This was the last List in the routine — falls through to the parent Group's "When Group ends" rule. |

---

## How playback actually connects to the Loop Player

1. Activating a List (via the ▶ Play/Activate buttons, a scheduled trigger, a live-event match, or automatic chaining) fires a `loopPlayerLoadPlaylist` browser event.
2. `LoopPlayerCard` picks that up, loads the video into the real player the same way its own manual **Load** button does, and marks itself as "automation-driven."
3. When a video ends, both the Playlist Automation engine and the Loop Player card see the same `videoEnded` signal. While automation is driving, the card defers to the engine's decision (next video in this List → next List → Group end-behavior) instead of just wrapping to the next index itself.
4. **Any manual control on the Loop Player card — Load, Next, Previous, Jump, Reset — immediately takes control back from automation.** This is deliberate: touching the card's own controls always means "I'm driving now."
5. If a chain genuinely dead-ends (Play Count reached, `Go to Next List` with nothing selected, or `Go to Group by Serial/Name` pointing at nothing), automation stops cleanly and hands control back — it does not freeze the player.

---

## Rules & restrictions

- **A List with zero videos is skipped automatically** when the engine is resolving a chain (e.g. "Loop this Group" walks forward past any empty Lists to find the first one with videos). If you manually hit Play on an empty List, it just tells you to add videos first — nothing happens.
- **Chains are capped at 20 hops.** If your Groups/Lists reference each other in a way that can't resolve within 20 steps (e.g. a genuine configuration cycle with no playable List anywhere in it), the engine gives up rather than looping forever.
- **Scheduler triggers fire at most once per calendar day**, even if the app is left running past midnight and the same HH:MM comes around on a new day (it fires again then).
- **Live-event keyword matching is best-effort.** It depends on your existing Live Player monitor detecting a live match first, and on a YouTube oEmbed title lookup succeeding — if that lookup fails or times out, keyworded Groups simply won't match that occurrence (Groups with no keyword still fire, since they don't need the title).
- **Only the Loop Player has this feature.** Live Player, Delay Player, and Local Player are untouched.
- **Serial/Name uniqueness isn't enforced strictly** — the editor doesn't block you from using duplicate Group/List serials or names, but "Go to Group/List by Serial/Name" targeting will only ever resolve to whichever match `Array.find` hits first, so duplicates make chaining ambiguous. Keep them unique.
- **Config is saved to both `localStorage` and the server**, but the server save can silently fail (see below) — `localStorage` is what actually keeps your setup safe across reloads/crashes in that case.

---

## Known environment issue (not specific to this feature)

In this OneDrive-synced copy of the repo, server-side state saves (`PUT /api/state/:key`) can intermittently fail with a `500` because OneDrive briefly locks `data/app-state.json` during the app's atomic write-and-rename. This affects *all* player state, not just Playlist Automation. When it happens, your Groups/Lists config is still safe — it's written to `localStorage` first and independently of the server call — but it means the server copy can lag behind. If you see stale automation config after switching machines/browsers, that's why.
