# `pi-extension/behold-state.ts` — the Behold state reporter

**Status: shipped in this repository, NOT installed, NOT propagated.**
There is no `~/.pi/agent/extensions/behold-state.ts` on this machine, nothing in the fleet
loads it, and no lane writes a spool record yet. Installing it fleet-wide is a separate,
reviewed step (see "Propagation status" below).

## What it is

A pi extension that reports the runtime facts a session knows and the disk does not, into
Behold's own cache spool:

| Field | Source in the ExtensionContext | Class |
|---|---|---|
| `model_id`, `model_provider` | `ctx.model` | 0 |
| `thinking_level` | `ctx.thinkingLevel` | 0 |
| `idle` | `ctx.isIdle()` | 0 |
| `pending_messages` | `ctx.hasPendingMessages()` | 0 |
| `context_tokens`, `context_window`, `context_percent` | `ctx.getContextUsage()` | 0 |
| `session_file`, `leaf_entry_id` | `ctx.sessionManager` | 1 (paths) |
| `cwd` | `ctx.cwd` | 1 (path) |
| `herdr_pane_id`, `herdr_workspace_id`, `herdr_tab_id` | the lane's herdr identity handles | 0 |
| `system_prompt_length`, `system_prompt_sha256` | `ctx.getSystemPrompt()`, reduced to metadata | 0 |

It never sends a prompt, a message, a tool argument, a credential, a skill body, a room
body or a bead note. The allowlist is `ALLOWED_STATE_KEYS` in the source, and the cache
applies the same list again before anything reaches the database.

It does not store **environment values**: the herdr socket path and the env flag are
environment values and are not read. The pane, workspace and tab ids are identity handles
(the roster already publishes them) and are stored, because the join needs them.

It does not open a session, does not parse the session JSONL and does not re-open a
session over `pi --mode rpc --session`. It reads the context it is handed, in memory.

## What pi does not expose (reported as unavailable, never as a value)

| Field | Why |
|---|---|
| `agent_status` (herdr's working / blocked / done) | pi exposes only `isIdle()` |
| `ttft_ms` | pi does not expose time-to-first-token |
| `herdr_socket_path`, `herdr_env` | environment values; not stored by policy |
| `room_presence` | rooms presence is not exposed by the extension API |
| `bead_counts` | the beads export is not exposed to an extension |

The roster lists these on every observation, with the reason, so a partial observation is
never presented as a complete one.

## The defaults: no setup is required

The state directory is resolved, in order:

1. `$BEHOLD_STATE_DIR`
2. the directory of `$BEHOLD_CACHE_DB`
3. `~/.local/state/behold`

The reader (`behold roster`) resolves the same directory — the cache database is
`~/.local/state/behold/behold.db`, or `$BEHOLD_CACHE_DB`, or `--cache-db` — so **the
reporter and the reader agree by default**, and both follow `BEHOLD_CACHE_DB`.

`BEHOLD_STATE_ENABLED=0` turns the reporter off entirely.

`BEHOLD_STATE_INTERVAL_MS` sets the lifecycle interval (default 60 000 ms, floor
1 000 ms). See "The lifecycle" below.

## The spool protocol

One JSON document per observation, written atomically (temp file + rename):

```
<state dir>/inbox/pane-<pane id>.tab-<tab id>.inc-<incarnation>.s<sequence>.json
```

```jsonc
{
  "behold_state": 2,                    // record version; the cache refuses anything else
  "pane_id": "w1A:p1",
  "tab_id": "w1A:t1",
  "session_id": "aaaaaaaa-0000-4000-8000-000000000001",
  "incarnation": "<boot id>:<pid>:<start ticks>",   // who wrote this
  "boot_id": "<the machine's boot id>",
  "incarnation_start_ticks": 900001,    // this process's start time, in ticks since boot
  "incarnation_boot_epoch": 1794450000.0,  // the wall clock at boot, captured once
  "seq": 7,                             // per incarnation, counted up from 1
  "observed_at": "2026-11-12T05:00:00.000Z",
  "observed_at_epoch": 1762300000.001,
  "mono_epoch": 1762300000.004,         // the reporter's monotone estimate of the moment
  "state": { /* the allowlisted scalars */ },
  "writer": "pi-extension"
}
```

The file name carries the pane id **and** the tab id in a reversible, filesystem-safe
form (`w1A:p1` in `w1A:t1` → `pane-w1A_p1.tab-w1A_t1.json`). That is deliberate: the
roster applies its **admission map** to the **name** first, so a held workspace's, a
reserved pane's and a lane inside a reserved **tab**'s record are refused **without the
file being opened**. There is no read-then-discard for a reserved tab.

### The incarnation, and why the sequence number is not a timestamp

The record names the process that wrote it: the machine's boot id, the pid and the
process's start time in ticks since boot. That is what makes a restart decidable. The
cache's rule is a total order on incarnations:

* the same incarnation may only move forward (its sequence number must grow);
* an incarnation that started **later** takes the pane over — even with a reset counter;
* an incarnation that started **earlier** (the late reporter) may **not** take it back;
* a record from another boot is ordered by the boot epoch, and two boot epochs too close
  to order are **refused**, not guessed at.

The sequence number counts up from 1 **within an incarnation** and is **not** derived from
the wall clock, so a backwards clock step cannot freeze a lane's observation. It is
seeded from the lane's own spool files, so a `/reload` inside the same process continues
the sequence instead of going back to 1.

The incarnation says **who** wrote a record. It is not a liveness proof: nothing here
shows that the process is still running.

The transport is a **file, not a socket**, and the consequences are honest ones: a record
is at most one rename old, the reader sees the last complete record rather than a stream,
and the spool holds one file per observation until the reader ingests it. A socket or a
daemon would remove the latency and cost a background process on every lane.

### One file per observation, and why the name carries the incarnation

The file's name is `pane-…tab-….inc-<incarnation>.s<sequence>.json`, and **a name is
never reused**. An earlier version kept one file per lane and replaced it, which is a
read-modify-write with no compare-and-swap: two writers could interleave and the older
one could win the file before the first ingest, so the reader would never see the newer
observation at all.

Now the two writers of one pane never touch the same pathname, there is no window to
interleave in, and the reader may remove a file it has read without the risk of
destroying a newer record for the same lane. The **reader** decides the owner: the newest
incarnation owns the pane, the highest sequence number wins within one incarnation, and
an order that cannot be established is refused rather than guessed at.

The cost is growth: the spool holds one file per observation until the reader ingests
it. The bound is a **refusal** — at 256 files for one lane the writer stops, the last
observation stays where it is, and the lane goes quiet until the reader has cleared the
backlog. The reader keeps one file per pane.

## How it becomes a cache row

`behold roster` in a live run ingests the inbox into `pi_state_current`:

```sh
behold roster                     # live: captures the topology, ingests the spool
behold roster --cache on          # offline run: ingest the spool into the cache too
```

The ingest is idempotent: a record that is not newer than the stored row is refused as
`stale_rejected` and the stored row is left alone; a late write from an older
incarnation is refused as `stale_incarnation`, and an unorderable one as
`ambiguous_incarnation`. The roster then joins the observation back to the lane on
`(pane id, session id)` and reports it as `P-11`, with its freshness, its age and the
incarnation that wrote it.

## The admission map

The reporter cannot know Behold's deny list, so the roster publishes it beside the cache
(`<state dir>/denied-lanes.json`):

```jsonc
{
  "version": 2,
  "captured_at": "2026-11-12T03:14:15Z",
  "captured_at_epoch": 1794460455.0,
  "topology_revision": "8f2c1d0a4b6e7c93",
  "denied_workspaces": ["w2"],
  "reserved_panes": ["wE:t19"],
  "reserved_tabs": ["wE:t19"],
  "pane_tab": { "w1A:p1": "w1A:t1" },
  "pane_workspace": { "w1A:p1": "w1A" }
}
```

The `pane_tab` / `pane_workspace` mapping is what lets the reporter (and the ingester)
refuse a lane inside a reserved tab **before** the record is opened. It carries the
placement of the lanes that **may report**: a lane the holds refuse is not in it, so
the published file does not name the panes and tabs of a held workspace. The holds
themselves are in the deny lists, which both sides need in order to refuse.

The reporter checks the deny lists **before** the placement, so a held lane is refused
as *held* and not as an unknown pane.

The reporter consults the map before every write and **fails closed**:

| The map is | The reporter |
|---|---|
| present, complete and fresh | writes, unless its own lane is refused |
| **missing**, **unreadable**, **malformed**, a **different version**, or **stale** (older than 300 s) | writes **nothing** |
| a **missing deny list**, a deny list entry that is not a safe handle, **partial** pane mappings, or a capture time that is not finite / lies in the future | writes **nothing**: a broken map is not an empty map |

"I could not check" is not "admitted", and "the list is missing" is not "the list is
empty". The map is a **courtesy, not the boundary**: the ingest refuses a refused lane's
record anyway, before opening it.

### The lifecycle: when it writes

The reporter writes on a pi event and on a **bounded lifecycle timer** (60 s by default,
`BEHOLD_STATE_INTERVAL_MS`, floor 1 s). The timer exists because of two cases that
event-only publishing got wrong:

* an **idle** lane has no event, so it would never report at all — and the roster's
  first map would have nothing to receive for it;
* the admission map **expires** after 300 s, and a reporter only woken by an event
  never notices the renewal, so it stays silent until the next event.

A roster **watch** does not renew the map: it reuses the run's capture, so the topology
is not observed again, and the map it re-publishes still ages from that capture. A watch
that runs longer than the map's lifetime publishes a map that is correctly stale, and the
reporter then writes nothing — which is the bound working, not a failure. A new roster run
captures again and publishes a fresh map.

Each tick re-reads the map and **samples the session again**. Pi's own extension
contract says the context is a live view — "Context values are resolved at call time, so
changes via bindCore/bindUI are reflected" — so the model, the thinking level, the
streaming and queue state, the context usage and the system prompt are the ones of
*now*. The record is stamped with the **sampling instant**: `observed_at` (ISO) and
`observed_at_epoch` come from the same value, so they cannot disagree, and the reader
computes the freshness from it.

What is **not** re-sampled is the identity handles the lane was launched with (the
pane, workspace and tab ids in the environment): they are launch-time constants and do
not follow a pane that moves. The file is named under the tab the *map* gives; the
record's `herdr_tab_id` is the inherited one.

The first roster publishes the map; the lanes pick it up on their next tick; the
observation reaches the **next** roster run. The timer is bounded (one interval, no
retry storm), never blocks (one small read and one small write), is `unref`ed so it
cannot keep the process alive, and is cleared when the session shuts down.

The tick is not a heartbeat of the process: nothing in the record shows that the lane is
alive, which is why the roster still calls the observation a last-observed supplement.

### The sequence belongs to the lane

The sequence number is per **(lane, incarnation)**, not per tab, and it is seeded from
the lane's own records *whichever tab they were written under*. A pane that moved (so
its record goes under the map's tab, not the tab the lane was launched with) and a
module reload therefore continue the sequence instead of restarting it at 1 — a sequence
number that does not move forward is refused by the cache, and the lane's observation
would freeze.

### The placement, and what it does not guarantee

The reporter's tab id is **inherited**: it is the tab the lane was launched with, and it
does not follow a pane that moves. The map says where the pane was **as of the last
capture**, so the record is written under the **map's** tab: a pane that moved to another
admitted tab keeps reporting, and a lane launched in a reserved tab stays silent even if
the map has moved it out.

| | |
|---|---|
| the pane is a reserved pane | **no write** |
| the reporter's **inherited** tab is a reserved tab | **no write** |
| the reporter's **inherited** workspace is held | **no write** |
| the map's tab for the pane is a reserved tab | **no write** |
| the map's workspace is held | **no write** |
| the map does not know the pane | **no write** |

The deny lists are checked **first**, so a held or reserved lane is refused *as held or
reserved* and not as an unknown pane — and a lane the map does not carry (a lane that
moved into a reserved tab after the capture, for instance) is still refused.

**What this does not guarantee.** The map is the topology *as of the capture*. A pane
that moves into a reserved tab **after** that capture is not visible to the map until the
next roster run, so in that window the reporter can write one record for it. The reader
refuses that record **before** it opens the file — the map's tab and the file's name
disagree — so it is never stored and never surfaced. The exposure is a **bounded
staleness**, not a guarantee: it is bounded by the map's age (300 s) and the roster's
cadence. Closing the writer side entirely would need a live topology — a read-only herdr
query narrows the window but cannot guarantee the placement across a later write — and
neither a second writer nor a change to herdr is in scope.

### The stale writer

There is no file for a stale writer to take back: every observation has its own name, so
two reporters for the same pane cannot race for one file, and the reader decides the
owner by the incarnation order (the same order the cache's ownership rule uses):

| the two records | the reader |
|---|---|
| the same incarnation | the higher sequence number wins |
| an incarnation that started **later** | it owns the pane |
| an incarnation that started **earlier** (the late reporter) | **refused**: it may not take the pane back |
| another boot, ordered by the boot epoch | the newer boot owns the pane |
| two boots too close to order | **refused**, not guessed at |
| written in another boot, too close to order | **does not write**: refused, not guessed at |
| not a readable record | writes (there is nothing to protect)

## Propagation status

| Step | Status |
|---|---|
| Source in this repository | done (`pi-extension/behold-state.ts`) |
| Static and contract tests | done (`tests/test_extension.py`, `tests/test_incarnation.py`) |
| Installed under `~/.pi/agent/extensions/` | **not done** — no install from this lane |
| Enabled fleet-wide | **not done** — once installed, the reporter writes against the admission map's placement; the rollout is a review decision |
| Verified against a live lane | **not done** — no live fleet read from this lane |
| Published / propagated | **not done** — SI owns the rollout and the review |

The extension is written to the fleet's extension conventions (best-effort, atomic
writes, swallowed failures), but *shipping* it is a separate decision: it makes every lane
write a file, and that needs the SI review this tranche explicitly leaves open.

## Uninstalling

Delete the file and set `BEHOLD_STATE_ENABLED=0`. The spool files and the cache database
can be deleted at any time: they are derived state, and the roster re-derives everything it
needs from the stores on disk.
