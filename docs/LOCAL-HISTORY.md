# Local watch ledger (milestone 1)

Local history is the source of truth for observed viewing. Tracker accounts are optional
downstream integrations. The ledger does not resolve media, send requests, schedule sync,
or change any tracker adapter's decisions.

## Flow

`SessionManager.ensureHistory()` attaches `HistoryRecorder` as soon as local media and a
video are available. It does not create, start or stop a `ScrobbleController`. The normal
`reconcile()` flow finishes resolution and badge preflight before `ensurePlaying()`
attaches the tracker controller. Pending, failed or disconnected tracker resolution
does not stop local observation. Repeated reconcile/play/discovery calls cannot bypass
a pending preflight, and stale replies cannot unlock a newer publication. Player iframes
retain upstream's existing published-media path, which has no per-frame resolver preflight.

`PlaybackEvents` owns one listener set per video with separate, abortable subscriptions
for history and scrobbling. Attaching the tracker later retains the local viewing period.
Replacing media or a player closes the old local period immediately, while the outgoing
tracker stays on its original lifecycle until normal tracker attachment/teardown.
Full teardown closes both and removes their listeners and pending discovery timers.
Play, pause, ended, pagehide and teardown produce local events.
Timeupdate observations reuse the five-second persistence cadence. Crossing the recipe's
watched threshold emits a stop, while later playback continues to produce checkpoints.
The existing controller and tracker messages retain their original behavior.

`recordHistory` messages write IndexedDB on the extension origin in the background. Each
operation opens the database, commits its transaction, and closes the connection. No
ledger state depends on service-worker memory or browser storage. Tab removal appends a
best-effort stop from the last checkpoint and removes its ownership records. It runs in
an independent tab-removal listener so IndexedDB latency cannot hold up tracker recovery.

## Database version 1

Database: `tmsync-watch-history`.

| Store | Primary key | Indexes / purpose |
| --- | --- | --- |
| sessions | id | mediaKey, startedAt; WatchSession summaries and checkpoint sequence |
| events | id | sessionId, occurredAt; append-only start/progress/pause/stop observations |
| syncRecords | [sessionId, tracker] | Reserved SyncRecord model for future explicit synchronization |
| owners | key | tabId; atomic frame arbitration per tab and media |

Session timestamps are Unix milliseconds; progress is 0–100; duration and watched time
are seconds. `finishedAt` is the first observed completion time. A partial stop leaves it
unset. Completion follows the recipe threshold independently of a tracker's outcome.
`syncRecords` is intentionally empty: a successful start/pause is not proof that remote
history has synced, and this milestone does not introduce a retry queue.

Schema upgrades belong in ascending `oldVersion` blocks in `history/db.ts`. Events and
summary updates share a transaction. Sequence numbers reject duplicate/stale messages.
Ownership is retained after threshold stops to prevent other frames recording credits as
another watch; a silent owner can be replaced after 30 seconds. Same-frame player
replacement creates a new viewing period immediately.

## Viewing periods and time

One attached player has a random 128-bit id. Pausing and resuming retain that session and all its
events, including across service-worker restarts. A reload, player replacement, new visit
or replay after ended gets a new id. Thus watching tomorrow never overwrites today's
partial period. Media keys use the shared engine's strongest scraped identifier, type
and episode coordinates; title-only keys also include year and source host. Tracker ids
from existing native/derived resolution enrich the session without rewriting its key.
Numbering remains the page's coordinates; derived cour ids do not change them.

Watched time means observed wall time, not media position. Small timeupdate samples
accumulate only when the position advances at a plausible playback rate. Seeks and rate
changes reset the sampling baseline. Stalls, duplicate events, paused intervals and gaps
over ten seconds add no time. Cumulative totals and atomic frame ownership prevent
duplicate checkpoints from adding viewing time twice. This deliberately undercounts
ambiguous intervals instead of treating seeks or suspension as watching.

## Limits and privacy

No new external requests, telemetry, UI or permissions. Only the source hostname is
stored; full URLs (which may contain tokens) are omitted. A crash can lose the most recent
uncommitted checkpoint (normally up to five seconds); a crash needs no final event for
the partial session to survive. Browser eviction, private-mode policies or clearing
extension data can remove IndexedDB. Writes fail independently of tracker scrobbling.

Automatic identity merging between title-only and later id-based periods, cross-device
merging, exports/backups, sync retries and the History/statistics UI remain later work.
Concurrent independent tabs intentionally retain independent viewing periods.
