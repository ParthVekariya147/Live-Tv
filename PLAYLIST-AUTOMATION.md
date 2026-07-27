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
| **Resume At** (formerly "Start Index") | Which video in the list to begin at (1-based). **Auto-advances as the list plays** — see below. |
| **Play Count** | How many videos to play starting from Resume At before handing off. |
| **Then** | What happens once Play Count is reached (see below). |

**Resume At auto-advances — videos don't repeat.** Every time a video from this List actually plays, Resume At is immediately updated to point past it (wrapping back to 1 once the last video in the List has played). So if a List has 10 videos and Play Count is 1, activating it five times in a row (e.g. via "Loop this Group") plays videos 1, 2, 3, 4, 5 — not video 1 five times. This is what makes "Loop this Group" behave like a rotating playlist instead of replaying the same video(s) forever. You can still type a number into Resume At yourself at any time to manually jump or force a replay from a specific position — the field is just also kept up to date automatically.

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

---

## Fixed 2026-07-20: video timer showing 00:00/00:00

**Symptom:** while a playlist was running, the current-time/remaining-time display on the Loop Player card stayed at `00:00 / 00:00` instead of updating.

**Root cause:** `LoopPlayer.html` (and `LivePlayer.html`, same copy-pasted code) fires `loadVideo`, `play`, and `unmute` as three separate commands with no gap between them. When the very first video of a session loads, `loadVideo` creates a brand-new YouTube `IFrame` player object — but that object's control methods (`playVideo`, `unMute`, etc.) aren't actually attached until its internal `onReady` callback fires a moment later. The `play`/`unmute` commands that arrived in that gap threw `TypeError: player.playVideo is not a function` / `... unMute is not a function`, which was caught and silently swallowed. The video could then get stuck never reaching YouTube's `PLAYING` state — and since the time-report loop only broadcasts a time update when `state === PLAYING`, the display never received anything to show and sat at its hardcoded default forever.

**Fix:** both files now queue any command that arrives before the freshly-created player is actually ready, and replay the queue once `onReady` fires — instead of dropping it. Verified end-to-end: after the fix, a fresh session's first video reaches `PLAYING`, ends up correctly unmuted, and the controller's timer ticks in real time.

**Not fixed (same-shaped risk, lower confidence it's hit in practice):** `DelayLive.html` has a related but not identical pattern — it already checks `typeof player.loadVideoById === 'function'` before deciding whether to reuse or recreate the player, which is more defensive, but its `play` case still calls `player.playVideo()` unconditionally. Worth the same treatment if the same symptom ever shows up on Delay Live Player specifically.

---

## Fixed 2026-07-20: "all the players are getting errors" — server.cjs was crashing entirely

**Symptom:** every player showed errors; the browser console was flooded with `SyntaxError: Unexpected end of JSON input` from `state-api.js`, `scheduler-api.js`, and `logger.js`, plus WebSocket errors from the Scheduler and Katha Monitor.

**This had nothing to do with the Loop/Live Player timer fix above** — it was a separate, pre-existing, much more severe bug: `server.cjs`'s background HTTPS server (port 3443, used for the phone push-notification setup page) calls `httpsServer.listen(HTTPS_PORT, ...)` with no `.on('error', ...)` handler attached. If port 3443 is already in use — e.g. by another already-running instance of the app (the packaged exe, a previous session that wasn't fully closed) — that failure surfaces as an unhandled `EADDRINUSE` **`error` event**, and Node's default behavior for an unhandled `error` event on an `EventEmitter` is to throw. With nothing catching it, this **crashed the entire Node process** — not just the HTTPS server. That takes the main API server (port 3005) down with it, which is why literally everything depending on `/api/*` broke at once: every player's state stopped saving, the scheduler and Katha Monitor's WebSocket connections dropped, and nothing could recover on its own because the process was simply gone.

Confirmed directly: after this happened, `curl http://localhost:3005/api/state` failed to connect at all (not a 500 — no server there), while port 3004 (Vite) stayed up and kept returning its own generic 500 for every proxied API call it couldn't reach — which is what produced the `Unexpected end of JSON input` errors client-side (a body-less proxy error response isn't valid JSON).

**Fix (`server.cjs`):**
1. Added the missing `.on('error', ...)` handler on the HTTPS server before `.listen()`, matching the graceful-degradation behavior already documented for HTTPS/cert failures elsewhere in this file — a bind failure now just logs a warning and the app continues running HTTP-only, exactly as the existing docs already claimed it should.
2. Added a process-wide `process.on('uncaughtException', ...)` / `process.on('unhandledRejection', ...)` safety net at the top of `server.cjs`, matching the pattern `live-tv-api/server.js` already uses. This is defense-in-depth on top of fix #1 — it doesn't replace fixing the specific root cause, but it means *any* single future unhandled error elsewhere in this ~2000-line file logs and keeps the server alive instead of taking every player down with it.

Verified end-to-end: recreated the exact port-3443-already-in-use condition, confirmed the server logged `[HTTPS] Failed to listen on port 3443: ... — continuing without HTTPS` and stayed up, confirmed `/api/state/*` requests that previously failed with a bodyless `500` now return a clean `200`, and confirmed the console error flood was gone on reload (only the normal, self-resolving initial OBS-WebSocket-reconnect messages remained).
- **Config is saved to both `localStorage` and the server**, but the server save can silently fail (see below) — `localStorage` is what actually keeps your setup safe across reloads/crashes in that case.

---

## Known environment issue (not specific to this feature)

In this OneDrive-synced copy of the repo, server-side state saves (`PUT /api/state/:key`) can intermittently fail with a `500` because OneDrive briefly locks `data/app-state.json` during the app's atomic write-and-rename. This affects *all* player state, not just Playlist Automation. When it happens, your Groups/Lists config is still safe — it's written to `localStorage` first and independently of the server call — but it means the server copy can lag behind. If you see stale automation config after switching machines/browsers, that's why.
