# FT-21 field ledger — every operator field, its state in this tranche, and its remaining gate

**Ledger revision V11 · code under test `behold 0.1.0-p1p2` (tree status V5).**

**V11 is the reporter's lifecycle correction.** It changes *when* the reporter writes,
not the field contract:

* the reporter publishes on a pi event **and** on a bounded **lifecycle timer** (60 s by
  default, `BEHOLD_STATE_INTERVAL_MS`, floor 1 s). An idle lane has no event, so
  event-only publishing meant it never reported at all, and a map that expired (300 s)
  was never noticed until the next event. The timer re-reads the map and **samples the
  session again** — pi resolves the context's values at call time — so the record is
  stamped with the sampling instant (`observed_at` and `observed_at_epoch` come from the
  same value). The identity handles the lane was launched with are constants, and the
  placement stays the map's;
* the **sequence is seeded per (lane, incarnation)**, not per tab, so a pane that moved
  and a module reload continue the sequence instead of restarting it at 1 (a sequence
  number that does not move forward is refused, and the observation would freeze);
* the first roster's behaviour is documented: it publishes the map, the lanes pick it up
  on their next tick, and the observation reaches the **next** roster run.

**V10 is the containment and concurrency correction.** The field contract does not move
(the per-lane id count stays **57**, 58 unique with `M-4`); what changes is the
**boundary** and the **transport**:

* the **test suite** runs against a **disposable tree** with the fail-closed Python guard,
  ordinary temporary paths and a fake capture. The guard's limits are named in the README
  (a node child, a SQLite C-level open, a shell, the unwrapped `os` calls, the rename
  destination, a child with a replaced environment) rather than implied away;
* the **spool** writes **one file per observation**, and the file's name carries the
  incarnation and the sequence number. A name is never reused, so two reporters for the
  same pane cannot race for one file, and the reader may remove a file it has read
  without the risk of destroying a newer record. The **reader** decides the owner: the
  newest incarnation owns the pane, the highest sequence number wins within one
  incarnation, and an order that cannot be established is refused;
* the **reporter** writes by default against the admission map's placement. The map's
  reserved tab, reserved pane and held workspace are still refused, and the **reader**
  still refuses a moved or reserved lane's record **before** the open, per run. The
  placement is the topology *as of the last capture*: a pane that moves into a reserved
  tab after the capture is a **bounded staleness**, not a guarantee, and is documented
  as one;
* the **growth** of the spool is bounded: the writer stops at 256 files for one lane
  (the last observation stays, and the lane goes quiet), and the reader keeps one file
  per pane.

**V9 is the admission and isolation correction.** The field contract does not move (the
per-lane id count stays **57**, 58 unique with `M-4`); what changes is the **boundary**:

* the **admission map** is validated strictly, on both sides: the deny lists must be
  present and hold safe handles, the two pane mappings must cover exactly the same
  panes, the capture time must be finite and not in the future, and a **missing** deny
  list is a broken map rather than an empty one. A broken map refuses everything;
* the **ingester** now refuses a spool file **before** it opens it when the file's name
  carries no tab (the current tab cannot be established before the read), when the map
  does not know the pane, when the pane **moved** since the map was published, or when
  the pane, its tab or its workspace is held or reserved. There is no read-then-discard
  for a reserved tab;
* the **reporter** refuses to write when its **inherited** tab identity no longer matches
  the map (the pane moved) — the same rule, from the other side;
* the **spool file** is protected against a stale writer: whoever writes last does not
  automatically win; an incarnation that started earlier may not replace a newer one's
  record before the first ingest;
* the **test suite** runs in a disposable tree with a fail-closed guard that refuses the
  real home, a live capture and a live roster run — in this process and in every child.

**V8 is the cache correction tranche.** It changes the *cache*, not the field contract:
the per-lane id count stays **57** (58 unique with `M-4`), and the coverage tally is
unchanged. What changed:

* the reporter now writes a **record version 2** that names the **incarnation** that wrote
  it (boot id, pid, start ticks) and carries a **per-incarnation sequence number** that
  counts up from 1. The cache's ownership rule is a total order on incarnations, so a
  restart, a resumed session, a concurrent reporter and a backwards clock step are all
  decidable — and a record whose order cannot be established is **refused**;
* the cache schema is **version 2**: one current row per **pane** (not per pane+session),
  a bounded **history** of retired rows (8 per pane, 5000 in total), and an explicit
  **migration** from version 1. The summary counts current rows and reports the history
  separately;
* the roster publishes an **admission map** (`denied-lanes.json`, version 2) carrying the
  deny ids **and** the topology's pane→tab / pane→workspace mapping. Both the reporter and
  the ingester use it, and both **fail closed**: a missing, malformed, wrong-version or
  stale map means "no admission", not "admit". A lane inside a reserved **tab** is now
  refused **before** its record is opened — there is no read-then-discard;
* a cached read can now be `clock_disputed`: the observation's timestamp cannot be
  trusted because the clock moved, so its age is unknown;
* the roster reports the **topology's provenance**: a live capture carries the capture's
  own clock, a snapshot file carries only its mtime (weak provenance), and a stale file is
  reported as stale.

This revision aligns the ledger with the code that actually ships and with `README.md`:

* the `--git`, `--jj` and `--stash-count` opt-ins that earlier revisions described **no
  longer exist** — the git/jj/herdr adapters were removed in V3 and **no flag re-enables
  them**; `argparse` rejects those names with exit code 2;
* the coverage tally is re-derived from `behold/lane.py::_ALL_FIELD_KEYS` and
  `behold/render.py::field_order()` instead of a hand-kept count;
* the remaining gates name the gates the **shipped CLI** implies — the CLI **captures** a
  live snapshot itself (`herdr api snapshot`), and `--snapshot FILE` remains the
  deterministic offline override;
* **V7 adds `P-11`**: the reporter's runtime observation, joined from the cache on
  `(pane id, session id)`. The per-lane id count moves from 56 to **57**, and the unique
  id count from 57 to **58**;
* every "state here" cell below was read off a real run of the shipped code over the
  shipped **synthetic** fixture fleet. That is offline, synthetic evidence. **Nothing here
  has been measured against a live fleet**, and no live measurement is claimed.

**V5 (code).** Adds the **cache**, the **direct capture** and the **join**:

* `behold/cache.py` — a Behold-owned SQLite cache (default
  `~/.local/state/behold/behold.db`, overridable with `BEHOLD_CACHE_DB` or `--cache-db`),
  with an explicit schema version, WAL, `busy_timeout=5000`, `synchronous=NORMAL`, atomic
  upserts, identity-checked reads and a freshness vocabulary;
* `behold/sources/herdr_capture.py` — the direct capture of `herdr api snapshot`: one
  exact argv, no shell, a bounded timeout, sanitized stderr, typed failures. The captured
  document is normalized against the **installed herdr's own API schema** and a missing
  `protocol` is **refused**, never defaulted;
* `behold/guard.py` — two narrow seams on the fail-closed default: a **one-shot spawn
  permit** for exactly one argv, and a **cache write scope** for exactly one path family;
* `pi-extension/behold-state.ts` — the pi extension that reports runtime state into a
  spool the cache ingests. **Not installed, not propagated.** It needs no setup: it
  resolves the same state directory the reader does.

## The join: what `P-11` is, and what it is not

| | |
|---|---|
| Source | the cache's `pi_state_current`, joined on `(pane id, session id)` |
| Class | `last_observed` — a past observation that cannot be confirmed current |
| Privacy | 0 (the allowlisted scalars are counts, ids and paths) |
| Never | a replacement for the disk-derived fields; a value from another session; a stale value presented as current; **a liveness claim** |
| The `incarnation` in the value | the boot id, pid and start ticks of the process that wrote the record: **who** wrote it, never that it is still running |

| Situation | State | Value |
|---|---|---|
| a fresh observation for this lane's session | `present` | `{freshness: "fresh", observed_at, age_s, seq, incarnation, clock_skew_s, session_match: "matched", observed, unavailable}` |
| an observation older than the freshness window (120 s) | `stale` | the same shape with `freshness: "stale"` and the age |
| a cached observation belonging to another session | `unknown` | **none**; the reason is `identity_mismatch: ...` |
| an observation whose timestamp cannot be trusted (the clock moved) | `unknown` | **none**; the reason is `clock_disputed: ...` |
| no observation for this lane | `absent` | none |
| the cache is not enabled for this run | `absent` | none; the reason says so |
| the cache cannot be read | `error` | none |
| the lane is held or reserved | `held` | none — and **no cache read happens for it** |

The `unavailable` list names every observation field the reporter could not provide, with
the reason, so a partial observation is never presented as a complete one:

| Field | Kind | Why |
|---|---|---|
| `agent_status` | `not_available` | pi exposes only `isIdle()`; herdr's working/blocked status is not visible to an extension |
| `ttft_ms` | `not_available` | pi does not expose time-to-first-token |
| `herdr_socket_path` | `not_available` | environment value; not stored under the counts-and-paths rule |
| `herdr_env` | `not_available` | environment value; not stored under the counts-and-paths rule |
| `room_presence` | `not_available` | rooms presence is not exposed by the extension API |
| `bead_counts` | `not_available` | the beads export is not exposed to an extension |
| an expected field the record did not carry | `not_observed` | the reporter did not observe it this time |

**V11 (code).** The reporter's lifecycle correction: the **lifecycle timer** (60 s by
default) so an idle lane reports and a renewed admission map is picked up, the
**sequence seeded per lane** (not per tab) so a move plus a reload continues it, and the
first roster's behaviour and the idle lane's freshness documented honestly. The field
contract does not move: `P-11` is still a last-observed supplement, and the per-lane id
count is still 57.

**V10 (code).** The concurrency correction: the per-write spool records with the
reader-owned ordering, and the reporter's functional default. The field contract does not
move: `P-11` is still a last-observed supplement, and the per-lane id count is still 57.
The reporter writes by default against the admission map's placement; the map's reserved
tab, reserved pane and held workspace are still refused, and the placement is documented
as a **bounded staleness** (the map is as of the last capture) rather than as a
guarantee.

**V9 (code).** The admission and isolation correction: the strict admission map, the
pre-read refusals, the inherited-identity write refusal, the spool overwrite rule, and
the disposable test tree. The field contract does not move: `P-11` is still a
last-observed supplement, and the per-lane id count is still 57.

**V8 (code).** The cache correction: the **incarnation** and the ownership rule, the
bounded history and the version 1 migration, the **admission map** (fail closed on both
sides, and no read-then-discard for a reserved tab), the `clock_disputed` state, and the
topology's provenance. The field contract does not move: `P-11` is still a supplement,
and the per-lane id count is still 57.

**V4 (code).** Repairs the reopened binding residual: the global `M-4` reader no longer
lists the instances root or opens a held/foreign instance's state file — allowed handles
are derived from admitted+verified lanes first (see `V4` in `README.md` and the mutant
probe receipt).

**V3 (code).** The git/jj/herdr adapters are **removed** (typed
`repo-adapter-not-isolated`), externals are not opt-in-able, held/reserved **tab**
topology is denied before any read, an ownership disagreement blocks every preload/join,
the leaf is labelled `DISK_RECONSTRUCTED`, and a composed mode definition is
`unverifiable` rather than false drift.

## Cache and source semantics (V5)

### What the cache is

A derived, disposable store of **sanitized** state. Three writers, one reader contract:

| Writer | Writes | Row |
|---|---|---|
| the pi extension (`pi-extension/behold-state.ts`) | the runtime facts a session knows and the disk does not | `pi_state_current`, one row per `(pane_id, session_id)` |
| the CLI | the topology the run used | `herdr_snapshot_current`, one row (`id = 1`) |
| the roster | reads both back and reports their **freshness** (`P-11`) | — |

| Table | Columns | Identity |
|---|---|---|
| `pi_state_current` | `pane_id`, `session_id`, `seq`, `observed_at`, `observed_at_epoch`, `state_json`, `sha256`, `writer` | `(pane_id, session_id)` |
| `herdr_snapshot_current` | `id`, `protocol`, `seq`, `observed_at`, `observed_at_epoch`, `payload_json`, `sha256`, `source` | `id = 1` |
| `cache_meta` | `key`, `value` — `schema_version`, `created_at` | `key` |

Beside the database the CLI publishes `denied-lanes.json` (the effective deny policy) so
the reporter never writes a record for a lane the roster would refuse.

### The cache's own states (separate from the field states)

The field states in this ledger (`present`, `stale`, `absent`, `unknown`, …) describe a
**lane field**. The cache has its own, smaller vocabulary, and it describes a **cached
value's age**, never its truth:

| State | Meaning |
|---|---|
| `fresh` | observed within the freshness window (120 s by default) |
| `stale` | observed **older** than the window. A last observation, not a current one. Never "wrong" |
| `absent` | no cached row for that pane or session |
| `identity_mismatch` | a row exists but belongs to **another session**. The value is not returned |
| `unreadable` | the row or the file cannot be decoded or opened |

A stale cached value is still reported, with its age. It is never dropped and never
presented as current.

### The allowlist

The cache stores an **allowlist** of scalar fields, and drops everything else *before* it
reaches the database:

`model_id`, `model_provider`, `thinking_level`, `idle`, `pending_messages`,
`context_tokens`, `context_window`, `context_percent`, `session_file`, `leaf_entry_id`,
`cwd`, `herdr_pane_id`, `herdr_workspace_id`, `herdr_tab_id`, `system_prompt_length`,
`system_prompt_sha256`.

The herdr entries are **identity handles** (the roster already publishes them as `H-2` /
`H-3`); the herdr socket path and the env flag are environment values and are **not**
stored. The captured topology is allowlisted the same way (the handles, labels, status
values and paths the roster already prints). A prompt, a message body, a tool argument, a
credential, a skill body, a room body or a bead note cannot enter the cache even if a
writer hands one over: `behold/cache.py::sanitize_state` and `sanitize_topology` are the
single funnels, and a test writes a payload full of sentinels and asserts that none of
them reaches the database file.

The topology funnel also **filters by the policy and the admission map**: a held
workspace's, a reserved tab's or a reserved pane's record is not persisted, and neither
is a pane the map places in a reserved tab. Without the policy and the map the funnel
fails closed and keeps only the protocol number, so "we could not tell what is admitted"
never means "everything is admitted". The roster's own output is derived from the full
document, not from the filtered one.

The funnel also requires the record to be **identifiable**: a workspace record without a
canonical workspace id, a tab record without a canonical tab id or workspace id, and a
pane record without a canonical pane id are dropped, because a record whose identity is
missing or malformed cannot be checked against the holds. A record that contradicts
itself — a tab id that names a different workspace than the record does — is dropped for
the same reason.

The published **admission map** carries the placement of the lanes that may report, and
not the placement of the lanes the holds refuse: the refusal does not need it (the deny
lists are published, and both sides refuse on those lists alone — the reporter before it
writes, the ingester before it opens a file), and publishing it would publish the panes
and tabs of a held workspace. The deny lists are published on purpose: both sides need
those ids to refuse, and those ids are the holds. The deny lists are checked *before*
the placement on both sides, so a refused lane is refused as held or reserved, and not
as an unknown pane.

### The capture's source semantics

| Run | Topology source | Cache |
|---|---|---|
| bare `behold roster` (live) | `herdr api snapshot`, captured live | **on** |
| `--herdr` | the same capture, stated explicitly | **on** |
| `--live --snapshot FILE` | the file | **on** |
| `--snapshot FILE` (alone) | the file | **off** unless `--cache on` |
| `--root DIR` (a fixture tree) | `DIR/herdr/snapshot.json` | **off** unless `--cache on` |

The captured document is normalized into the shape the roster reads. The authoritative
shape is the installed herdr's own `SessionSnapshot` (`herdr api schema --json`, protocol
22): `version`, `protocol`, `workspaces`, `tabs`, `panes`, `layouts`, `agents`. The API's
success envelope (`{"id", "result"}`) is unwrapped. A document with **no integer
`protocol` is refused** — the protocol is never defaulted — and a document in neither
shape is a typed error (`herdr-unreadable-snapshot`), never an empty roster. A
representative fixture built to that schema is checked in
(`fixtures/herdr_session_snapshot.json`) and checked against the installed schema by the
suite. **The live capture itself has not been run from this lane** — the fleet read is
still a gate.

### The observation: when the topology was seen, and what the map may claim

The herdr snapshot document carries no timestamp of its own, so the roster records its own
**observation**: the kind of source (`live_capture`, `snapshot_file`, `fixture_tree`), the
moment it observed the topology, and how that moment is known — the capture's own clock
(cannot be forged) or a file's mtime (weak provenance, anyone can set it). The
observation travels with the snapshot.

That matters for the watch. A watch iteration reuses the run's topology: herdr is asked
once per run, not once per iteration. Reusing a capture is **not** observing it again, so
the reused snapshot keeps its observation, and the roster reports that capture's kind,
that capture's moment, and an age that grows. The fresh runner of a watch iteration used
to have no capture receipt of its own, and reported the topology as `unknown` (or as a
file) — which is a false claim about where the topology came from.

The **admission map** is stamped with the observation, not with the moment of the
publication. The map says "this placement was observed then"; a map re-stamped on every
iteration would make an old topology look fresh forever, and the map's own 300-second
bound — the bound the reporter's fail-closed reader enforces — would never apply. The
published map therefore ages from the capture: it is fresh when it is written, it is
refused once it is older than the bound, and a watch that runs longer than the bound
publishes a map that is correctly stale (`behold.admission.stale`). The roster says so
rather than calling an old topology current.

## Evidence base for the "state here" cells

| Item | Value |
|---|---|
| Fixture fleet | `python3 fixtures/make_fixtures.py /tmp/behold-ledger-fix --lanes 61` → "fixtures at /tmp/behold-ledger-fix with 61 lanes" (exit 0) |
| Derivation | `./bin/behold roster --root /tmp/behold-ledger-fix --as-of 2026-11-11T03:00:00Z` (exit 0, 61 lanes) |
| Field coverage | every one of the 61 lanes carries **exactly the same 57 field ids**; one id-set, 57 ids, no lane missing a field |
| Denied lanes | 3 lanes are `held` before any read (held workspace `w2`, reserved tab / pane `wE:t19`), so 58 lanes are admitted; `behold.privacy.denials` = `held_workspace:w2 1, reserved_pane:wE:t19 1, reserved_tab:wE:t19 1` |
| External execution | `behold.guard.spawns` = `{}` — no child process was spawned during the run; `behold.guard.open_attempts` = 489 admitted reads. (A **live** run does spawn one child: the `herdr api snapshot` capture, recorded as `herdr-snapshot-capture: 1`.) |
| Per-field states | `behold.lanes.by_field_state` = `absent 652, conflict 1, divergent 2, held 171, inferred 57, present 1492, stale 114, unknown 701, withheld 287` — the delta against V4 is exactly `P-11`: `absent` for the 58 admitted lanes (the cache is off for an offline run) and `held` for the 3 refused ones |
| Suite | `tests/run-tests.sh` → `Ran 296 tests` / `OK` / `PASSED` (exit 0) — 178 carried over from V4 plus 118 new (cache, capture, extension, reporter join) |

"State here" therefore means **what the committed code emits for the synthetic fixture
fleet**. It is not a statement about a live fleet. A live fleet can produce different
states per lane (`absent`, `conflict`, `divergent`, `stale`, `error`, `held`); the only
counts that are stable across runs are the **id counts** and the per-state tallies printed
in `behold.lanes.by_field_state`.

## Identity count (re-derived, not hand-kept)

There are **58 unique field ids** in this ledger: **57 per-lane** ids plus `M-4`, which is
global-only and never a lane field. The two code-side lists agree exactly and are the
source of truth:

* `behold/lane.py::_ALL_FIELD_KEYS` — the 57 ids a lane must carry;
* `behold/render.py::field_order()` — the same 57 ids, in render order;
* `behold/cli.py` `Runner.document()` — emits `global["M-4"]` **once**, outside the lane
  list.

The earlier "58 / 51 emitted / 5 unknown / 4 P3 / 6 withheld" figures were an overlapping
set of observations, not a partition, and are withdrawn. They are replaced by the
[coverage audit](#coverage-audit), whose partition is exact.

## What the shipped CLI accepts

Verified against the shipped parser (`./bin/behold roster --help`) and by running the
rejected names. This table is the CLI's real surface, not an aspiration.

| Option | Shipped behaviour | Verified |
|---|---|---|
| `--snapshot FILE` | reads **one** file; with no `--root` and no `--live` the host `/proc`, the pil records and the agent dir are never opened | exit 0 on a fixture snapshot |
| `--root DIR` | fixture/data root containing `herdr/`, `proc/`, `pil/`, `instances/`, `state/` | exit 0 |
| `--live` | real store paths. **A bare run is a live run**, so `--live` is the default | exit 0 (with a capture or a snapshot) |
| `--herdr` | **captures** the live topology with `herdr api snapshot`: one exact argv, no shell, a bounded timeout, sanitized stderr. Mutually exclusive with `--snapshot` (exit 2) | exit 0 with a fake herdr on `PATH`; exit 3 on a typed capture failure |
| `--cache {auto,on,off}` | `auto` (default) opens the cache for a **live** run only; `on` opens it always; `off` never opens it | exit 0 / cache block in the document |
| `--cache-db PATH` | the cache database path. Defaults to `$BEHOLD_CACHE_DB`, else `~/.local/state/behold/behold.db` | exit 0 |
| `--markdown`, `--full`, `--lane`, `--filter`, `--sort` | as documented in `README.md` | exit 0 |
| `--proc-root`, `--as-of`, `--watch`, `--watch-iterations`, `--watch-interval`, `--watch-max-seconds`, `--events-file`, `--verbose` | as documented in `README.md`; `--as-of` with `--watch` is refused (exit 2) | exit 0 / 2 |
| `--deny-workspace`, `--deny-pane` | only ever **add** to the fixed deny lists (`w2`, `wE:t19`) | exit 0 |
| `--git` | **does not exist** — `behold: error: unrecognized arguments: --git` | exit 2 |
| `--jj` | **does not exist** — `behold: error: unrecognized arguments: --jj` | exit 2 |
| `--stash-count` | **does not exist** — `behold: error: unrecognized arguments: --stash-count` | exit 2 |
| `--output` | **does not exist** — `behold: error: unrecognized arguments: --output` | exit 2 |

There is no `--include-todo-subjects` or any other private-export flag, by design: the
tool has no free-text export, and the only file it writes is its own cache.

**The live capture is never exercised by the suite.** The capture tests inject a runner
or put a **fake** `herdr` on `PATH`; the fake records the argv it was called with, so the
exact argv is asserted rather than assumed, and the live binary is never called.

Companion to `README.md` and to `/home/bitnom/.local/state/ft21-plan/result.md` §4.
Field ids are the plan's. "State here" is what the committed code actually emits for the
synthetic fixture fleet; "gate" is what is still needed before the value is true of a live
fleet or before the field may be published wider.

Legend — state: **A** authoritative read · **D** derived with a method · **I** inferred
(labelled) · **LO** last-observed · **U** explicitly unknown (reason given) · **W** withheld
(class 2) · **H** held before read · **P3** deferred to the runtime-assist phase.
`divergent`, `conflict`, `absent`, `stale` and `error` are also emitted states; they are
listed beside the letter where they are reachable.

Privacy: 0 public metadata · 1 operator-sensitive (counts/paths only) · 2 never emitted.

## herdr layer

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| H-1 | workspace name | `H-1` | 0 | A / absent | `snapshot workspaces[].label` | live snapshot read |
| H-2 | workspace id | `H-2` | 0 | A | `snapshot workspaces[].workspace_id` | — |
| H-3 | pane id | `H-3` | 0 | A | `snapshot agents[].pane_id` | — |
| H-4 | pane name + winning layer | `H-4` (`note` = `winning layer: <layer>`) | 0 | A / absent | `tabs[].label` → `agents[].name` → `display_agent` → `panes[].label` → `terminal_title_stripped` | live check of the precedence chain |
| H-5 | status + seq + failure states | `H-5` | 0 | A | `panes[].agent_status` else `agents[].agent_status`; `state_change_seq`, `completion_seq`, `interactive_ready`, `restore_error`; `done` kept verbatim | — |
| H-6 | cwd vs foreground_cwd | `H-6` | 0 | A / divergent | `snapshot agents[].cwd`, `foreground_cwd` | — |

All six come from the one snapshot read the whole roster is built on. A denied lane
carries none of them: a held lane emits **no** snapshot label, status or cwd.

## pi session / model

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| P-1 | provider (selected + physical) | `P-1` | 0 | A / divergent | `model_change.provider` vs last assistant `provider` | live virtual-model lanes |
| P-2 | model (selected + physical) | `P-2` | 0 | A / divergent | `model_change.modelId` vs last assistant `model` | — |
| P-3 | reasoning effort | `P-3` | 0 | A / absent | `thinking_level_change`, else assistant `thinkingLevel` | — |
| P-4 | session id + validated leaf/chain | `P-4` | 0 | A | header `id` vs filename UUID; leaf + `chain_state` + counts; `leaf_authority: DISK_RECONSTRUCTED`, `runtime_leaf: null` | — |
| P-5 | session path (realpath + spellings) | `P-5` | 0 | A | `agent_session` pin or pane-matched pil record, realpath-normalized | — |
| P-6 | session start | `P-6` | 0 | A / absent | header `timestamp` | — |
| P-7 | session duration | `P-7` | 0 | D | `observed_now - header.timestamp` (lane process present) or `last_entry_timestamp - header.timestamp` (frozen); the `method` states which | — |
| P-8 | last observed turn span | `P-8` | 0 | D / absent | last user → last assistant/user timestamp; labelled "last observed", never "running" | live cross-check against a real turn |
| P-9 | session name | `P-9` | 1 | A / absent | latest `session_info.name` | — |
| P-10 | fork lineage | `P-10` | 1 | A / absent | header `parentSession` (path only) | — |
| P-11 | runtime observation (reporter) | `P-11` | 0 | **LO** / absent / unknown (identity mismatch, clock disputed) | the cache's `pi_state_current`, joined on `(pane_id, session_id)`; class `last_observed`; `freshness`, `age_s` and the writing `incarnation` travel with the value; `unavailable` names every field the reporter cannot see | a live lane with the reporter installed |

`P-4`'s leaf is a **disk reconstruction**, not proof of the runtime-selected branch: pi
keeps the selected leaf in memory, so the field says `DISK_RECONSTRUCTED` and carries
`runtime_leaf: null` rather than calling the branch current.

`P-11` is a **supplement**, never a replacement: `P-1`..`P-10` still say what the session
file says. It is `stale` rather than `present` when the observation is older than the
freshness window, it carries no value at all when the cached observation belongs to
another session, and it is `held` for a refused lane — with no cache read performed for
that lane.

## tokens / context / performance

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| T-1 | context used | `T-1` | 0 | D | last assistant `usage.totalTokens`, else `input+output+cacheRead+cacheWrite` | exact footer equivalence (see note) |
| T-2 | context max | `T-2` | 0 | A / U | `models-store.json` `contextWindow` for the **physical** model; unknown if absent (never assume 200k) | live catalogue check |
| T-3 | context % | `T-3` | 0 | D / U | `T-1 / T-2 * 100`; unknown if either side unknown | exact footer equivalence |
| T-4 | session tokens | `T-4` | 0 | D | Σ assistant usage + `usage` entries + compaction/branch-summary usage **on the active branch**; `usage_kinds` shown; a branch-blind total is reported in `note` when it differs | compare with pi footer on a live lane |
| T-5 | cache counts + rate | `T-5` | 0 | D / absent | `ΣcacheRead`, `ΣcacheWrite`, hit rate as ratio and % | compare with footer |
| T-6 | cost (estimated flag) | `T-6` | 1 | D / absent | Σ `usage.cost`; `estimated: true` when any `totalFromProvider` is false | provider-reported totals |
| T-7 | TPS | `T-7` | 0 | D / U | Σ output / Σ `durationMs` over the last 20 assistant messages that carry a duration; unknown when none do (legacy session) | validate against stream timings |
| T-8 | TTFT | `T-8` | 0 | **U** | `unknown(reason: pi persists total durationMs, not time-to-first-token)` | **P3 only**, separately reviewed |

**Honesty note (binding correction #4).** T-1/T-3/T-4/T-5 are *derived* and the plan's
claim of exact footer equivalence is **not** proven by this tranche: pi may add estimates or
compaction adjustments that raw usage sums do not reproduce. The fields carry their method
string so the comparison is mechanical, and "footer equivalence" stays an open gate. P-8 is
the last observed span, not the current active turn duration. T-7 is derived from persisted
per-message durations, not a live stream rate.

## repo state

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| R-1 | git branch + oid | `R-1` | 0 | **U** (always) | `unknown(repo-adapter-not-isolated)`; source `git branch + oid: adapter removed in V3`; note: requires a separately reviewed isolated execution boundary | a reviewed isolated execution boundary — **there is no `--git` flag** |
| R-2 | worktree identity | `R-2` | 0 | **U** (always) | herdr's `workspaces[].worktree` half only; `unknown(repo-adapter-not-isolated)` when a worktree is reported, `unknown(no worktree record and no git adapter)` otherwise | same |
| R-3 | dirty counts | `R-3` | 0 | **U** (always) | `unknown(repo-adapter-not-isolated)`; source `git dirty counts: adapter removed in V3` | same |
| R-4 | ahead/behind/stash | `R-4` | 0 | **U** (always) | `unknown(repo-adapter-not-isolated)`; source `git ahead/behind/stash: adapter removed in V3` | same — **there is no `--stash-count` flag** |
| R-5 | jj detected | `R-5` | 0 | A / absent / expired | `.jj` presence by `stat` plus `tokens.jj_bookmark` (TTL-aware); **no jj binary is ever run**; note: detection only | — |
| R-6 | jj bookmark/change/status | `R-6` | 0 | **U** (always) | `unknown(repo-adapter-not-isolated)`; source `jj bookmark/change/status: adapter removed in V3` | same — **there is no `--jj` flag** |
| R-7 | non-repo lane | `R-7` | 0 | A | `.git`/`.jj` presence by `stat` → `NO_REPO` / `git` / `jj` / `git+jj`; note: absence of a repository is an expected state, not an error | — |

The git and jj adapters were **removed** in V3, not gated behind a flag: a child process is
not contained by the in-process audit hook, and repository config can make even a
read-only `git` argv run a helper writer. `R-1`, `R-2`, `R-3`, `R-4` and `R-6` are
therefore `unknown` in **every** lane, with the stable reason
`repo-adapter-not-isolated`. Re-enabling them is a capability decision with its own
review, **not** a flag flip — and today `argparse` rejects `--git`, `--jj` and
`--stash-count` outright (exit 2). Detection by `stat` (`R-5`, `R-7`) is pure and stays.

## mode / profile / rooms / goals / todos / crons

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| M-1 | active mode + metadata | `M-1` | 1 | A / absent | session `custom pi-mode-state.v3`; definition path/digest/scope/label only, no prompt body | — |
| M-2 | mode drift | `M-2` | 1 | A / U | digest recomputed with pi-modes' own `modeDefinitionFingerprint` (replicated byte-for-byte); a **project-scope** (composed) definition is `unverifiable` (`composed_definition_unsupported`), never false drift; `matched` / `drift` / `partial` / `unverifiable` are the reported sub-states | needs the pi-modes loader to recompose a project definition, or an owner-side digest comparison |
| M-3 | profile with provenance | `M-3` | 1 | A / U | **declared** = the single allowlisted env key `PI_PROFILE` (process-start, may be stale after `/profile`); **selected** = per-instance `pi-profile.json` `{profile, source}` where the instance comes **only** from the verified process's `PI_CODING_AGENT_DIR`; **resolved** = saved skills/tool references; catalog label. No env value other than that one profile name is emitted | never conflated; `/profile` staleness surfaced as a note |
| M-4 | global activeProfile | `global.M-4` (**not a lane field**) | 1 | A / conflict / unknown | `pi-profile-state.json` read **only** from instances already established by admitted+verified lanes; the instances root is never listed, and a held/foreign instance's copy is never opened. Disagreeing *allowed* copies ⇒ `conflict`; no admitted+verified instance ⇒ `unknown(noaccess)` | live read (never exercised); the deny lists cover only `w2`/`wE:t19` |
| M-5 | rooms lane name | `M-5` | 0 | A / absent | `rooms/names.json` `pins["pane:<id>"]` | — |
| M-6 | rooms membership | `M-6` | 1 | A / U | `registry/` count + `rooms/*` membership, **names only** | — |
| M-7 | presence / inbox depth | `M-7` | 1 | **U** (always) | deferred by the plan to P3 | P3 |
| G-1 | goals count + statuses | `G-1` | 1 | A / absent / U | per-session goal `custom` entry, structured counts only; a text-only store ⇒ `unknown(goal state is text-only; count withheld)` | confirm the live goal entry's shape |
| G-2 | goals queue depth | `G-2` | 1 | A / absent / U | same entry, depth only | same |
| D-1 | TODO counts + conflict | `D-1` | 1 | A / conflict / absent | session `pi-core-todo-state` (active branch) vs instance `pi-todo-state.json` for the same session UUID | — |
| D-2 | TODO subjects | `D-2` | 2 | **W** | never exported; no opt-in flag exists | — |
| C-1 | crons for the lane | `C-1` | 1 | A / U | `tasks.json` filtered by `projectDir`; `id`/`name`/`projectDir`/`schedule`/`cron`/`kind` only; a task's `prompt` field is counted as skipped, never read into output | live cron file |
| C-2 | cron prompt | `C-2` | 2 | **W** | never read into output | — |

## extensions / skills / prompts

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| E-1 | extensions loaded | `E-1` | 0 | **I** (always) | session system-message replay (`toolsAdded`/`toolsRemoved`, skills section); the field's own `reason` states that an inert extension registers no tool, so the tool list cannot prove the inventory | **P3 exact** via loader/registration evidence, not the tool list |
| E-2 | installed package pins | `E-2` | 0 | A / absent | `settings.json` package entries (name + ref, plus the settings path it came from); the agent dir's and the instance's `settings.json` are both candidates | — |
| S-1 | skills loaded | `S-1` | 0 | A / conflict / absent | skills section names+paths, cross-checked against `pi-profile.json resolved.skills` | — |
| S-2 | skill text | `S-2` | 2 | **W** | never emitted | — |
| S-3 | prompts (configured vs loaded) | `S-3` | 0 | A | configured prompt paths from settings + loaded section **names**; `loaded_is_not_proof_of_bodies: true` | — |
| S-4 | prompt text | `S-4` | 2 | **W** | never emitted | — |

`E-2` is what is *configured*, which is not the same thing as what is *loaded*. `E-1` is
the weakest field in the ledger and says so in its own `reason`.

## monitors / background jobs

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| J-1 | background tasks | `J-1` | 1 | **LO** | session `bash_bg` calls + `pi-bg/*.log` size/mtime; explicitly "not a running state" | P3 live |
| J-2 | monitors set | `J-2` | 1 | **LO** | session `monitor` tool calls; exit state unknowable | P3 live |
| J-3 | bizzy monitors | `J-3` | 1 | **U** (always) | `bizzy.json` holds only `disabledTools`; there is no persistable monitor registry | P3 live |

## dagr / beads

| # | Field | Output key | Priv | State here | Source / method | Gate |
|---|---|---|---|---|---|---|
| G-3 | dagr runs for the lane | `G-3` | 1 | A / absent / U | `recent` index → `run.json` matched on `orchestrator.pane` or any `attempts[].locator.pane`; task state counts by owner; run **title withheld**; task states are reported as recorded, never as progress | live dagr tree |
| G-4 | dagr staleness | `G-4` | 1 | A / absent / U | `observed_at - generated_at`, and `stale` when a run event is newer than `generated_at` | — |
| B-1 | beads for the lane | `B-1` | 1 | A / U | **explicit metadata join**: `metadata.agent_pane` + `metadata.agent_session`, where the session value must match the validated id **exactly** (no suffix, no path containment) and the identity must be *trusted* (a pid/reporter/pil disagreement refuses the join). `owner`, `project:` label and prompt-text bead ids are counted as **rejected**. Labels scope the project only | live `bd` export; requires the metadata keys to be set at task creation |
| B-2 | bead description/notes | `B-2` | 2 | **W** | never emitted; titles also withheld (see below) | — |

**Stricter-than-plan choices (documented, deliberate).** Bead *titles* and dagr *run
titles* are withheld (`title_withheld: class1_free_text`) although the plan put them at
privacy 1, because the binding correction restricts this tranche to "counts and paths only".
Monitor descriptions are likewise not emitted. Re-enabling any of them is a separate,
reviewed decision — not a flag flip.

## Coverage audit

The partition below is exact and re-derivable from the code, not hand-kept. "Lane ids" are
the ids a lane's `fields` map must contain (`behold/lane.py::_ALL_FIELD_KEYS`, 57 ids);
`M-4` is the single global id and is **not** a lane id, so the two id counts are stated
separately and never mixed.

| Family | Lane ids | Always `unknown` | Always `withheld` (class 2) | Runtime-only / deferred | Carries a value under normal conditions |
|---|---|---|---|---|---|
| H herdr | 6 | — | — | — | `H-1` `H-2` `H-3` `H-4` `H-5` `H-6` (6) |
| P pi session / model | 11 | — | — | — | `P-1` `P-2` `P-3` `P-4` `P-5` `P-6` `P-7` `P-8` `P-9` `P-10` `P-11` (11) |
| T tokens / context / perf | 8 | `T-8` | — | `T-8` | `T-1` `T-2` `T-3` `T-4` `T-5` `T-6` `T-7` (7) |
| R repository | 7 | `R-1` `R-2` `R-3` `R-4` `R-6` | — | — | `R-5` `R-7` (2) |
| M mode / profile / rooms | 6 | `M-7` | — | `M-7` | `M-1` `M-2` `M-3` `M-5` `M-6` (5) |
| G goals / dagr | 4 | — | — | — | `G-1` `G-2` `G-3` `G-4` (4) |
| D TODOs | 2 | — | `D-2` | — | `D-1` (1) |
| C crons | 2 | — | `C-2` | — | `C-1` (1) |
| E extensions | 2 | — | — | `E-1` (exact list) | `E-1` `E-2` (2) |
| S skills / prompts | 4 | — | `S-2` `S-4` | — | `S-1` `S-3` (2) |
| J monitors / jobs | 3 | `J-3` | — | `J-1` `J-2` `J-3` | `J-1` `J-2` (2, last-observed only) |
| B beads | 2 | — | `B-2` | — | `B-1` (1) |
| **Total (lane ids)** | **57** | **8** | **5** | **6 items** | **44** |

* **57 lane ids + 1 global-only id (`M-4`) = 58 unique ids.** `M-4` appears in the
  `global` block, never in a lane's `fields`.
* **44 + 8 + 5 = 57.** The three columns partition the lane ids with nothing left over.
* The **6 runtime-only items** are exactly `behold.runtime_only_pending`: `T-8`, `J-1`,
  `J-2`, `J-3`, `E-1` (exact list) and `M-7`.
* No operator field is absent from the output. Every one is either emitted with
  provenance, or present as a typed `unknown`/`absent`/`held`/`withheld`/`conflict`/
  `divergent`/`stale`/`error` with a reason.
* `P-11` carries a value only when the reporter has written an observation for that
  lane's session; in an offline fixture run with the cache off it is `absent` with a
  reason. It is **not** always-unknown: it is a real source, and its absence is stated,
  not assumed.

## Trust rules (V4)

- A lane is `trusted` only when the reporter pin, the pane-matched pil record and the
  `/proc` pid triple **agree**. A pid disagreement, a workspace/pane disagreement, a
  boot-id or starttime mismatch, or a pin/pil session disagreement makes it untrusted; the
  roster still shows each witness, but no explicit join (beads) and no instance or
  profile resolution happens on it. A pin alone is `pin_only_unverified` and is **not**
  trusted.
- Held workspace `w2` and reserved tab / pane `wE:t19` produce **no value at all** — not
  even the snapshot label or status. The reason is a stable code
  (`held_workspace:w2` / `reserved_tab:wE:t19` / `reserved_pane:wE:t19`). Only the
  handles that name the refusal are emitted.
- The pil record directory is the one pre-admission listing (lane/pane/pid/session-path
  metadata, never session or env content); denied records are discarded on sight and their
  session paths are never opened.
- `global.M-4` is derived from **admitted + verified** lanes only. The instances root is
  never listed, so a held or foreign instance's `pi-profile-state.json` is never opened.

## Remaining gates (each is a separate authorization)

1. **SI source review of this tree** — nothing here is installed, published or propagated.
2. **Live-fleet read and live capture** — the shipped CLI **captures** the topology itself
   (`herdr api snapshot`, one exact argv, no shell, a bounded timeout). The capture path
   has **never been run against the live herdr** from this lane, so two things are still
   open: (a) the shape of the captured document — the normalizer accepts the flat shape
   and the live API's nested `workspaces[].tabs[].panes[]` tree, and a document in
   neither shape is a typed error, so the first live run may still need a normalizer fix;
   (b) the budget targets must be measured on a real fleet — the numbers in `README.md`
   and in `behold.budget_targets` are **targets measured on synthetic fixtures only** and
   are explicitly "not a measured whole-fleet proof". `--live` reads real private stores
   and has never been exercised against a live fleet.
3. **Repository fields (R-1, R-2, R-3, R-4, R-6)** — these need a separately reviewed
   isolated execution boundary. There is no opt-in flag today (`--git`, `--jj` and
   `--stash-count` are rejected by `argparse`), so this gate is a capability decision, not
   a configuration one. The herdr capture is a different thing: a read-only API call with
   an exact argv, behind a one-shot permit.
4. **Beads live join** — `bd list --json` is a subprocess; this tranche reads a synthetic
   export (`Paths.for_live()` leaves the beads path unset). Live use needs an explicit
   isolated-execution decision and a decision on export scope.
5. **Footer equivalence** (T-1/T-3/T-4/T-5) — compare with pi's footer on lanes known to
   have compaction/branch summaries before claiming equivalence.
6. **P3 runtime assist** — TTFT, live job/monitor state, exact extension attribution,
   rooms presence depth: a *new* extension beside herdr's, never a duplicate reporter, and
   its own approval gate.
7. **The cache is consumed per lane, but only as a supplement.** `P-11` joins the
   reporter's observation on `(pane id, session id)` and reports its freshness. It never
   replaces a disk-derived field: `P-1`..`P-10` still say what the session file says.
   Whether the observation should ever *feed* `P-1`/`P-2`/`P-3`/`T-1` (as a
   last-observed supplement) is still open — it would change what those fields mean, so
   it needs its own review.
8. **The pi extension is not installed.** `pi-extension/behold-state.ts` ships in the
   repository. It is **not** under `~/.pi/agent/extensions/`, and no lane writes a spool
   record. It needs no setup when it is installed (it resolves the same state directory
   the reader does, and follows `BEHOLD_CACHE_DB`), but installing it makes every lane
   write a file, so it needs its own rollout and review.
9. **The reporter's observation is only as good as its fields.** The fields pi does not
   expose — herdr's agent status, time to first token, rooms presence, the beads counts
   — are reported as **unavailable** on every observation. Closing any of them needs a
   different integration, not a better reporter.
10. **Manifest re-stamping** — `MANIFEST.sha256` records the transferred bytes of the
    tracked files. This revision changes several of them, so their manifest lines do not
    verify until the manifest is re-stamped with the new bytes.
10. **Publication / install** — no npm publish and no PATH install; the tree ships no
    packaging metadata, so `pip install` is not an option (see `README.md` §Install). The
    `behold-roster` fleet skill and its `home/AGENTS.md` row are a separate, deferred
    propagation step that must document only the shipped CLI.
11. **jq / `--as-of` convenience** — still deferred; the cache exists now, but it was
    built for the runtime assist, not for a performance rescue.
