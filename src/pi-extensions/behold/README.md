# behold

> **A read-only, derive-on-demand fleet roster.**
> One command reads the stores that already exist and prints what it found, with every value
> carrying its state, its source, when it was observed and why it is missing.

`behold` answers the question *"what is this fleet actually doing right now, and how do I
know?"* without becoming part of the fleet. It is a single process with no daemon, no
service, no socket and no network access. It derives the roster on demand, prints it to
stdout, and exits.

The one thing it writes is its **own cache**: a SQLite database in Behold's own directory,
holding sanitized runtime state and the topology it captured. It is derived state — delete
it and the roster re-derives everything from the stores on disk.

```sh
behold roster --root /path/to/fixture-tree --markdown
```

---

## Contents

| Section | What is in it |
|---|---|
| [What behold is](#what-behold-is) | The one idea, and the long list of things it deliberately is not |
| [Install](#install) | Clone, optional venv, a PATH-friendly symlink, and why `pip install` is not an option |
| [Quick start](#quick-start) | Fixture mode, captured-snapshot mode, live mode with a direct herdr capture, and the exact CLI |
| [The cache](#the-cache) | Where the cache lives, what it holds, and the freshness vocabulary |
| [Reading the output](#reading-the-output) | The JSON document, the lane envelope, field anatomy, states and classes |
| [The field ledger](#the-field-ledger) | Every family and every field code the tool returns |
| [Filtering and sorting](#filtering-and-sorting) | Flattened keys, operators, worked examples |
| [Safety boundaries](#safety-boundaries) | The two real mechanisms, and what they do not cover |
| [Known limitations](#known-limitations) | The honest list, including what will never be available from disk |
| [Troubleshooting](#troubleshooting) | Every error message the tool can print, and what to do |
| [Tests](#tests) | The offline suite and the measured numbers |
| [Layout](#layout) | What each file does |

---

## What behold is

`behold` derives a **roster** of fleet lanes (a terminal pane running an agent) from stores
that already exist on disk:

* a **herdr snapshot** (the workspace / pane / agent topology),
* the **pi session JSONL** of each lane,
* per-instance **profile, TODO and settings** stores,
* the **rooms** pin registry and room files,
* the **cron** task file,
* the **dagr** run index,
* the **beads** issue export.

Three properties hold for every value it prints.

**1. Every value is typed.** A field is never just a value. It is a record with a `state`,
a `class`, a `source`, an `observed_at`, a `method` (for derived numbers), a `reason` (for
every non-present state) and a `privacy` class. "No value" is never written as `0` or `-`;
it is `unknown` or `absent` with a stated reason.

**2. Every value is traceable.** `source` names the file or the record the value came from.
`method` carries the exact expression for anything computed, so you can recompute it by
hand. If two authoritative sources disagree, both are shown and the state is `divergent` or
`conflict` rather than a silent pick.

**3. Nothing is invented.** Where the data does not exist, the tool says so and says why.
Time-to-first-token is not persisted by pi, so `T-8` is `unknown` forever in this tranche.
The runtime-selected session branch is not persisted either, so `P-4` labels the leaf
`DISK_RECONSTRUCTED` rather than calling it current.

### Privacy and read-only design

The design is **counts and paths only**. Free text is never exported, and there is no flag
that turns it on:

| Never exported | Why |
|---|---|
| goal text | class 2 |
| TODO subjects | class 2 |
| cron prompt bodies | class 2 |
| room bodies and receipts | class 2 |
| bead descriptions and notes | class 2 |
| bead titles, dagr run titles | class 1 free text, withheld under the "counts and paths only" rule |
| session message content, tool arguments | class 2 |
| skill bodies, prompt bodies | class 2 |
| environment values other than the single allowlisted `PI_PROFILE` key | class 2 |

Read-only is enforced, not promised. Two independent mechanisms are active for the whole
run, and both are covered by tests:

1. **Deny before read.** Held workspaces and reserved tabs/panes are refused *before* any
   session, state or process path for that lane is opened. Denied path markers
   (`/secrets/`, `/.ssh/`, `/auth.json`, `/.credentials/`, `/keyring`) are refused at the
   single read funnel every adapter must use.
2. **Fail-closed read-only and network guard.** A CPython audit hook raises on any
   write-intent `open`, any filesystem mutation, any socket or urllib operation, and any
   spawn event (`subprocess.Popen`, `os.posix_spawn`, `os.exec*`, `os.system`). There is no
   write exception for output. A write attempt inside the process crashes the run rather
   than succeeding.

V5 adds exactly **two narrow seams** to that fail-closed default, and both are tested:

* a **one-shot spawn permit** for one exact argv — `herdr api snapshot` — consumed by the
  spawn event itself. Every other argv, every other purpose and every second spawn is
  still refused;
* a **cache write scope** for one configured cache path family, open only for the
  duration of one block.

`behold` writes **no file other than its own cache**. There is no `--output` flag, so a
symlink planted at a would-be output path has no surface to exploit. Redirect stdout if
you want a file.

### What it is not

* No daemon, no service, no socket, no port. The one database is Behold's own cache, in
  Behold's own directory, holding derived state that can be deleted at any time.
* No write to any fleet store. No herdr or pi reporter. Nothing is pushed back.
* **No general external execution.** The git, jj and herdr *adapters* were removed in V3:
  a child process is not confined by an in-process audit hook, and repository config can
  make even a read-only `git` argv run a helper writer. Repo fields are typed
  `unknown(repo-adapter-not-isolated)`. What V5 adds is one exact argv — herdr's own
  read-only `api snapshot` — behind a one-shot permit, with no shell and no allowlist.
* No live fleet *discovery*. A run needs a snapshot: captured from herdr, read from
  `--snapshot FILE`, or read from a fixture tree. "Scan every session directory and pick
  the newest" is deliberately absent.
* No message bodies, prompts, secrets, TODO subjects, bead notes or room receipts — in
  the roster **or in the cache**.
* No exact proof of which extensions were loaded. An inert extension registers no tool, so
  the tool list cannot prove the inventory. `E-1` is `inferred` and says so.
* No claim that the roster knows whether a lane is making progress. `H-5` is the status
  string herdr reported, verbatim.

---

## Install

### Requirements

| Item | Requirement |
|---|---|
| Python | **CPython 3.10 or newer** |
| Dependencies | **none**. Standard library only |
| Shell | a POSIX shell and `coreutils` for the test suite only |
| Network | never used, at install time or at run time |

Verified by running the CLI and the full suite on CPython 3.10, 3.11, 3.12, 3.13 and 3.14.

### There is no `pip install`

This tree ships **no packaging metadata**: no `pyproject.toml`, no `setup.py`, no
`setup.cfg`, no entry points. `pip install .` and `pip install git+...` therefore do not
work, and pretending otherwise would send you down a dead end.

What ships instead is a **script plus a package**:

```
bin/behold      the entry point (executable, shebang python3)
behold/         the importable package
```

`bin/behold` puts the repository root on `sys.path` itself, so it works from any working
directory and through a symlink. Pick whichever of the following fits.

### Step 1: clone the published repository

```sh
git clone https://github.com/Apothic-AI/behold.git
cd behold
```

### Step 2 (optional): a virtual environment

There is nothing to install, so a venv is optional. It is still the tidiest way to pin an
interpreter for a fleet tool.

```sh
python3.10 -m venv ~/.venvs/behold
source ~/.venvs/behold/bin/activate
behold --version          # -> behold 0.1.0-p1p2
```

Deactivate with `deactivate`. The venv holds no packages; it only pins the interpreter.

### Step 3 (optional): put it on your PATH

**Symlink** (recommended). The target must be the `bin/behold` script, not the package
directory. `bin/behold` resolves its own realpath, so the symlink resolves the package
correctly from anywhere:

```sh
mkdir -p ~/.local/bin
ln -s "$HOME/Code/behold/bin/behold" ~/.local/bin/behold
hash -r
behold --version          # -> behold 0.1.0-p1p2
```

Make sure `~/.local/bin` is on your `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

**Shell alias or function**, if you would rather not touch `PATH`:

```sh
# bash / zsh
alias behold="$HOME/Code/behold/bin/behold"
```

### No install needed at all

Three other invocations that work as-is:

```sh
./bin/behold roster --root /path/to/tree      # from the repository root
python3 -m behold roster --root /path/to/tree # from the repository root
python3 /any/where/behold/bin/behold roster --root /path/to/tree
```

---

## Quick start

### Mode 1: a synthetic fixture fleet (fully offline)

The repository ships a fixture generator that builds a synthetic fleet with sentinels: a
held lane, a reserved tab, a lane with no session, a stale session pin, a TODO conflict, a
virtual model, a jj workspace, a partial session tail and more. It touches nothing real.

```sh
# 1. build a synthetic fleet (default 61 lanes; the generator never emits fewer than 16)
python3 fixtures/make_fixtures.py /tmp/behold-fix --lanes 61

# 2. derive the roster as JSON
./bin/behold roster --root /tmp/behold-fix --as-of 2026-11-11T03:00:00Z > out.json

# 3. derive the roster as Markdown
./bin/behold roster --root /tmp/behold-fix --markdown

# 4. one lane, every field
./bin/behold roster --root /tmp/behold-fix --markdown --lane w1A:p1

# 5. filter and sort
./bin/behold roster --root /tmp/behold-fix --filter 'H-5.value.status=working' \
                                        --sort 'T-3.value:desc'

# 6. bounded watch: re-derive when an input changes
./bin/behold roster --root /tmp/behold-fix --watch --watch-iterations 3 --watch-interval 0.5
```

`--as-of` freezes the clock so ages and staleness are reproducible. It is a single-run
override and is refused together with `--watch`.

### Mode 2: a captured snapshot

`--snapshot FILE` reads **one** file and nothing else. With no `--root` and no `--live`,
the host `/proc`, the pil records and the agent directory are never opened.

```sh
behold roster --snapshot /path/to/snapshot.json
```

The snapshot must be a herdr snapshot document with an integer `protocol` field. Protocol
`22` is the only supported one; an unknown protocol is a loud error, never a silent
mis-parse. Unknown *keys* inside a known protocol are tolerated, because herdr adds them.

### Mode 3: the real store paths (`--live`)

`--live` points the adapters at the real stores under your home directory:

```
~/.local/state/pil/sessions        ~/.pi-profile-switch/instances
~/.pi-profile-switch/profiles      ~/.pi/agent
~/.pi/modes                        ~/.local/state/pi-bg
```

```sh
behold roster --live --snapshot /path/to/captured/snapshot.json
```

The live path reads real private stores, so use it knowingly. This tranche has not been
exercised against a live fleet.

Two stores are not reachable in live mode. The **beads export** is unset there, because
reading it live means running `bd` as a subprocess, which this tranche does not do. The
**models catalogue** path is unset at the top level and is resolved per instance instead.
Both are listed as remaining gates in `FIELD-LEDGER.md`.

### Mode 4: the live run (the default)

A **bare** `behold roster` is the live run. It does two things:

1. it captures the topology by running herdr's own read-only API — `herdr api snapshot` —
   with an explicit argv, no shell and a bounded timeout;
2. it reads the real stores (the `--live` paths) and derives the roster from them.

```sh
behold roster                 # capture the topology, read the real stores
behold roster --markdown      # the same, as Markdown
behold roster --herdr         # the same, with the capture stated explicitly
```

The capture is a child process, so it goes through the one-shot spawn permit in the
read-only guard: the argv is exactly `herdr api snapshot`, the permit is consumed by that
one spawn, and every other spawn is refused. A failure is typed and loud:

| Code | Meaning |
|---|---|
| `herdr-not-found` | the herdr binary is not on `PATH` |
| `herdr-timeout` | the capture did not finish inside the timeout (10 s) |
| `herdr-exit-N` | herdr exited non-zero |
| `herdr-invalid-json` | the output was not a JSON object |
| `herdr-unreadable-snapshot` | the document is not a topology this build can read |

herdr's stderr is **sanitized** before it is shown: ANSI escapes and control characters
are removed, the home directory becomes `~`, and the result is truncated.

The captured document is normalized into the flat shape the roster reads. Two shapes are
accepted: the flat one (`agents` / `panes` / `workspaces` / `tabs`) and the live API's
nested `workspaces[].tabs[].panes[]` tree. A document in neither shape is an error, never
an empty roster. **This normalization has not been checked against a live capture** — the
lane that wrote it was not allowed to read the live fleet. See
[Known limitations](#known-limitations).

### CLI reference

```
usage: behold [-h] [--version] {roster} ...

usage: behold roster [-h] [--snapshot SNAPSHOT] [--herdr] [--root ROOT]
                     [--live] [--cache {auto,on,off}] [--cache-db CACHE_DB]
                     [--markdown] [--full] [--lane LANE] [--filter KEY=OP]
                     [--sort KEY[:desc]] [--proc-root PROC_ROOT]
                     [--as-of AS_OF] [--watch]
                     [--watch-iterations WATCH_ITERATIONS]
                     [--watch-interval WATCH_INTERVAL]
                     [--watch-max-seconds WATCH_MAX_SECONDS]
                     [--events-file EVENTS_FILE] [--verbose]
                     [--deny-workspace DENY_WORKSPACE] [--deny-pane DENY_PANE]
```

The first line is `behold --help`, the second is `behold roster --help`, both verbatim.

| Option | Meaning |
|---|---|
| `--snapshot FILE` | herdr snapshot JSON (fixture or captured). Reads **one** file and nothing else |
| `--herdr` | capture the live topology with `herdr api snapshot`. This is what a bare run does; the flag states it explicitly. Mutually exclusive with `--snapshot` |
| `--root DIR` | data root containing `herdr/`, `proc/`, `pil/`, `instances/`, `state/` |
| `--live` | use the real store paths. This is what a bare run does |
| `--cache MODE` | `auto` (default: the cache is used by a live run only), `on` (always), `off` (never) |
| `--cache-db PATH` | the cache database. Defaults to `$BEHOLD_CACHE_DB`, else `~/.local/state/behold/behold.db` |
| `--markdown` | render Markdown instead of JSON |
| `--full` | with `--markdown`: emit every field for every lane, not just the summary table |
| `--lane PANE_ID` | restrict to one lane, by pane id such as `w1A:p1` |
| `--filter KEY=OP` | repeatable. Keeps lanes whose flattened `KEY` satisfies the operator |
| `--sort KEY[:desc]` | repeatable. Defaults to `key` (the pane id) |
| `--proc-root DIR` | an explicit `/proc` tree to read. The host `/proc` is never read unless you name it |
| `--as-of ISO8601` | evaluate ages at this timestamp instead of now. Single-run only |
| `--watch` | re-derive on input change, bounded by iterations and by wall clock. The **topology** is not re-observed: herdr is asked once per run, and the admission map keeps the moment the topology was seen |
| `--watch-iterations N` | maximum number of rendered documents (default 2) |
| `--watch-interval S` | seconds between polls (default 0.5). Below 0.05 s is refused as a spin loop |
| `--watch-max-seconds S` | hard wall-clock bound for the whole loop (default 30) |
| `--events-file FILE` | a herdr events file to watch. Changes to it do not refresh session fields |
| `--verbose` | per-source timings and watch steps on **stderr** |
| `--deny-workspace ID` | add a held workspace. Defaults are never removed |
| `--deny-pane ID` | add a reserved pane. Defaults are never removed |

`behold --version` prints `behold 0.1.0-p1p2`.

### Exit codes

| Code | Meaning | Example message |
|---|---|---|
| `0` | the roster rendered | (no message) |
| `2` | usage error | `behold: filter 'H-5.value.status' needs one of = != ~ !~` |
| `3` | source error | `behold: snapshot not found: /tmp/nope.json` |
| `3` | capture failure | `behold: herdr-exit-1: herdr api snapshot exited 1 (server not running)` |
| `4` | guard violation | `behold: read-only guard refused an action: ...` |

An unknown flag is a usage error (`argparse` prints the usage line and exits 2), so
`--include-todo-subjects` and friends fail loudly instead of appearing to work.

---

## The cache

Behold keeps one SQLite database of **derived** state. It is not a source of truth: every
row carries the moment it was observed, the **incarnation** that wrote it, a sequence
number and a sha256 of the payload, and every read says how old the value is. Delete the
file and nothing is lost — the roster re-derives everything from the stores on disk.

| | |
|---|---|
| Default path | `~/.local/state/behold/behold.db` |
| Override | `BEHOLD_CACHE_DB=/path/to/db.db`, or `--cache-db PATH` |
| Spool inbox | `<the cache directory>/inbox/` |
| Schema version | `2`, in `cache_meta.schema_version` and in SQLite's `user_version` |
| Pragmas | `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL` |

A **version 1** database (the shape that keyed rows by pane *and* session, with no
incarnation) is **migrated in place**: the newest row per pane becomes the current row,
the rest are retired into the history table, and the migration is recorded in
`cache_meta.migrated_from`. Any other version is **refused**, not guessed at.

### When it is written

| Run | Cache |
|---|---|
| a live run (bare, or `--live`) | **on**: the topology is stored, and the inbox is ingested |
| `--root DIR` (a fixture tree) | **off**, unless `--cache on` |
| `--snapshot FILE` (one file) | **off**, unless `--cache on` |
| any run with `--cache off` | **off**, and the file is never opened |

An offline run does not touch the operator's cache unless it is asked to. The cache block
in the document always says which of these applied.

When the cache is on, the run also **publishes the admission map** beside it
(`denied-lanes.json`) for the reporter, and **ingests the inbox**: every spool record is
checked against that map before it is opened, and only then before it is stored.

### What it holds

| Table | Holds |
|---|---|
| `pi_state_current` | **one row per pane**: the observation that owns the pane, with the incarnation (boot id, pid, start ticks), the per-incarnation `seq`, `observed_at`, the state JSON and its sha256 |
| `pi_state_history` | the retired rows: bounded to **8 per pane** and **5000 in total**, so a lane that restarts a hundred times leaves eight rows behind, not a hundred |
| `herdr_snapshot_current` | one row: the topology this run used, with its protocol, `seq`, `observed_at`, the **admission-filtered** payload and its sha256 |
| `cache_meta` | the schema version, the creation time, and the version this file was migrated from |

The state is an **allowlist**: `model_id`, `model_provider`, `thinking_level`, `idle`,
`pending_messages`, `context_tokens`, `context_window`, `context_percent`,
`session_file`, `leaf_entry_id`, `cwd`, `herdr_pane_id`, `herdr_workspace_id`,
`herdr_tab_id`, `system_prompt_length`, `system_prompt_sha256`. Anything else a writer
sends is dropped before it reaches the database — a prompt, a message, a tool argument, a
credential, a skill body, a room body or a bead note cannot enter the cache even if a
writer hands one over. The topology is allowlisted the same way.

The topology is also **filtered by the policy and the admission map before it is
written**. A held workspace's, a reserved tab's or a reserved pane's metadata never
reaches the cache, and neither does a pane the map places in a reserved tab — including a
pane that names an admitted workspace but sits in a reserved tab. Without both the policy
and the map there is nothing to filter with, so the filter **fails closed**: the row keeps
the protocol number and nothing else. The roster's own output is derived from the *full*
document, not from the filtered one, so the cache is a cache and not the roster.

A record that cannot be **identified** is dropped as well. A workspace record without a
canonical workspace id, a tab record without a canonical tab id or workspace id, and a
pane record without a canonical pane id cannot be checked against the holds — a label
with no id is exactly the shape of metadata whose provenance is unknown — so it is not
persisted. A record that contradicts itself (a tab id that names a different workspace
than the record does) is dropped for the same reason.

The herdr entries are **identity handles** — the pane, workspace and tab ids the lane was
launched with, which the roster already publishes as `H-2`/`H-3`. The herdr *socket path*
and the env flag are environment values and are **not** stored.

The record's **envelope** (the pane, the tab, the session, the incarnation and the
sequence number) is metadata *about the write*, not an observation, and it is kept apart
from the allowlisted state block. The boot id is the machine's boot identity — not an
environment value — and it is what makes an incarnation orderable across reboots.

### The incarnation: who wrote this, and who owns the pane

Every record names the incarnation that wrote it: the machine's boot id, the reporting
process's pid and its start time (from `/proc`), plus a sequence number that **counts up
from 1 within that incarnation**. The ownership rule is a total order on incarnations,
not on timestamps:

| Situation | Outcome |
|---|---|
| the pane has no owner yet | the record takes it |
| the **same** incarnation, a greater `seq` | the record moves the pane forward |
| the same incarnation, the same or a smaller `seq` | refused: `stale_rejected` |
| a **later** incarnation (same boot, later start ticks) | the record takes the pane over, even with a reset sequence number |
| an **earlier** incarnation (the late reporter) | refused: `stale_incarnation` — it may not take the pane back |
| another boot, ordered by the boot epoch | the later boot takes the pane; the earlier one is refused |
| another boot, too close to order | refused: `ambiguous_incarnation` — **not guessed** |
| a migrated version 1 row (no incarnation) | it carries no ordering information, so it cannot refuse anything: the first real observation takes the pane |

The sequence number is **not** derived from the wall clock, so a backwards clock step
cannot freeze a lane's observation. The record also carries the reporter's monotone
estimate of the moment (`mono_epoch`), so the reader can see that the clock moved and
**dispute** the observation's age instead of calling it fresh.

**What cannot be proven.** The incarnation says *who* wrote a record. It is not a liveness
proof: nothing in the record shows that the process is still running, that the lane is
still the same lane, or that the observation describes the fleet now. Freshness is a
window, not a heartbeat: the reporter's lifecycle timer re-samples the session, so the
observation is current *as a sample*, but it still says nothing about the lane's life.
That is why `P-11` stays a last-observed supplement and never feeds
`P-1`/`P-2`/`P-3`/`T-1`.

### The join: `P-11`, the reporter's runtime observation

The roster joins the cached observation back to the lane it describes, on
`(pane id, session id)`:

| Situation | `P-11` |
|---|---|
| a fresh observation for this lane's session | `present`, class `last_observed`, value `{freshness: "fresh", observed_at, age_s, seq, incarnation, clock_skew_s, session_match, observed, unavailable}` |
| an observation older than the freshness window | `stale` — **never** `present`, and the age travels with the value |
| a cached observation that belongs to **another session** | `unknown`, reason `identity_mismatch: ...`, **no value** |
| an observation whose timestamp cannot be trusted (the clock moved) | `unknown`, reason `clock_disputed: ...`, **no value** |
| no observation for this lane | `absent` |
| the cache is not enabled for this run | `absent`, reason `the cache is not enabled for this run` |
| the cache cannot be read | `error` |

`P-11` never replaces the disk-derived fields: `P-1`..`P-10` still say what the session
file says, and `P-11` says what the reporter last observed.

### The gaps, reported as gaps

The reporter cannot see everything, and the roster says so instead of implying
completeness. Every observation carries an `unavailable` list:

| Field | Kind | Why |
|---|---|---|
| `agent_status` | `not_available` | pi exposes only `isIdle()`; herdr's working/blocked status is not visible to an extension |
| `ttft_ms` | `not_available` | pi does not expose time-to-first-token |
| `herdr_socket_path` | `not_available` | environment value; not stored under the counts-and-paths rule |
| `herdr_env` | `not_available` | environment value; not stored under the counts-and-paths rule |
| `room_presence` | `not_available` | rooms presence is not exposed by the extension API |
| `bead_counts` | `not_available` | the beads export is not exposed to an extension |
| any expected field the record did not carry | `not_observed` | the reporter did not observe it this time |

### The spool transport, honestly

The reporter writes **one file per observation** and the reader ingests whatever is there
when it runs. That is the whole transport:

```
<state dir>/inbox/pane-<pane id>.tab-<tab id>.inc-<incarnation>.s<sequence>.json
```

Each file is published atomically (write to a temp file, then rename), so the reader never
sees a half-written record. The consequences are real ones and are not papered over:

* a record is at most one rename old — there is no streaming, and the reader sees the last
  complete record rather than a sequence of them;
* the spool holds **one file per observation** until the reader ingests it, so it grows
  with the lane's event rate between two roster runs. The bound is a refusal: the writer
  stops at 256 files for one lane (`SPOOL_FILE_CAP`), the last observation stays where it
  is, and the lane goes quiet until the reader has cleared the backlog;
* the reader's view of a lane is as fresh as the last ingest, not as fresh as the lane.

**Why the name carries the incarnation and the sequence number.** An earlier version kept
**one file per lane** and replaced it. That is a read-modify-write with no compare-and-swap:
two writers could interleave — read, decide, rename — and the **older** one could win the
file before the first ingest, so the reader would never see the newer observation at all.
Now every write has its own name and **a name is never reused**. Two reporters for the
same pane never touch the same pathname, there is no window to interleave in, and the
reader may unlink a file it has read without the risk of destroying a newer record for the
same lane.

The **reader** owns the ordering, not the writer: it groups a pane's records by
incarnation, and the newest incarnation owns the pane — the same boot, the later start
time; another boot, the boot epoch, refused when two epochs are too close to order. Within
one incarnation the highest sequence number is the observation. An order that cannot be
decided is refused, not guessed at. The result does not depend on the order the files
happen to be listed in.

A socket or a daemon would remove the latency and cost a background process on every
lane. The file does neither.

### The lifecycle: when the reporter writes

The reporter writes on a pi event, and on a **bounded lifecycle timer** — 60 s by
default, `BEHOLD_STATE_INTERVAL_MS` (floor 1 s). The timer is what makes two cases
work, and both were defects before it:

* an **idle** lane produces no event, so without the timer it would never report at
  all, and the roster would have nothing to receive for it;
* the admission map **expires** after 300 s, and a reporter that is only woken by an
  event never notices the renewal, so it stays silent until the next event.

Each tick re-reads the map (the publish path does that anyway) and **samples the session
again**. Pi's own extension contract says the context is a live view: "Context values are
resolved at call time, so changes via bindCore/bindUI are reflected". So the model, the
thinking level, the streaming and queue state, the context usage and the system prompt
are the ones of *now*, and the record is stamped with the **sampling instant** —
`observed_at` (ISO) and `observed_at_epoch` come from the same value, so they cannot
disagree, and the reader computes the freshness from it.

What is **not** re-sampled is the identity handles the lane was **launched** with (the
pane, workspace and tab ids in the environment): they are launch-time constants and do
not follow a pane that moves. The file is named under the tab the *map* gives; the
record's `herdr_tab_id` is the inherited one.

The timer never blocks (one small file read and one small file write), it is `unref`ed
so it cannot keep the process alive, and it is cleared when the session shuts down.

**The first roster, honestly.** A roster run publishes the admission map. The lanes
learn about it on their next tick — up to one interval later — and the observation
reaches the **next** roster run, not the one that published the map. That is the
bootstrap: the map makes the lanes admissible, the lanes make the next run's roster
interesting.

**The sequence belongs to the lane, not to the tab.** The sequence number is per
(lane, incarnation), and it is seeded from the lane's own records *whichever tab they
were written under*. A pane that moved (so its record is written under the map's tab,
not the tab the lane was launched with) and a module reload therefore continue the
sequence instead of restarting it at 1 — a sequence number that does not move forward
is refused by the cache, and the lane's observation would freeze.

### The defaults, on both sides

| | |
|---|---|
| the cache database | `~/.local/state/behold/behold.db`, or `$BEHOLD_CACHE_DB`, or `--cache-db` |
| the spool inbox | `<the cache database's directory>/inbox/` |
| the reporter's state directory | `$BEHOLD_STATE_DIR`, else the directory of `$BEHOLD_CACHE_DB`, else `~/.local/state/behold` |
| turning the reporter off | `BEHOLD_STATE_ENABLED=0` |
| the reporter's lifecycle interval | `BEHOLD_STATE_INTERVAL_MS` (default 60 000, floor 1 000) |

**No setup is required**: the reporter and the reader resolve the same directory by
default, and both follow `BEHOLD_CACHE_DB` when it is set.

**The reporter writes by default**, against the admission map's placement. Its tab id is
*inherited* (it is the tab the lane was launched with, and it does not follow a pane that
moves), so the map — the topology *as of the last capture* — is the authority for where
the pane is. That is a **bounded staleness, not a guarantee**: a pane that moves into a
reserved tab after the capture is not visible to the map until the next roster run. The
reader refuses a moved or reserved lane's record **before** it opens the file, on every
run, so such a record is never stored and never surfaced — but the reporter is not
silent across the move itself. See "The reporter writes nothing it may not write" below.

### The admission map: why a lane may not be written, and why a record may not be read

The roster's deny list is a set of ids — a held workspace (`w2`), a reserved pane and a
reserved tab (`wE:t19`). That is enough for the roster to refuse a lane, but not enough
for the two other consumers of the decision: the **ingester** sees a file named for a
pane, and the **reporter** knows its own pane from the environment the lane was launched
with. So the roster publishes what it decided, in a form both can use without reading
anything they are not allowed to read:

```
<state dir>/denied-lanes.json
```

```jsonc
{
  "version": 2,
  "captured_at": "2026-11-12T03:14:15Z",
  "captured_at_epoch": 1794460455.0,
  "topology_revision": "8f2c1d0a4b6e7c93",
  "denied_workspaces": ["w2"],
  "reserved_panes": ["wE:t19"],
  "reserved_tabs": ["wE:t19"],
  "pane_tab": {"w1A:p1": "w1A:t1"},
  "pane_workspace": {"w1A:p1": "w1A"}
}
```

The `pane_tab` / `pane_workspace` mapping is the part that matters: it is the topology
the roster just read, so the **tab** of a pane is known *before* the lane's record is
opened.

It carries the placement of the lanes that **may report**. A lane the holds refuse is
not in it, so the published file does not name the panes and the tabs of a held
workspace: the refusal does not need that placement (the deny lists are enough for the
reporter to stay silent and for the ingester to refuse before the open), and publishing
it would publish handles of a lane the roster holds. The **deny lists themselves are
published** — that is unavoidable and deliberate: both sides need the ids to refuse, and
the ids are the holds.

**Both sides fail closed, and a broken map is not an empty one.** The reporter consults
the map before every write, and the ingester consults it before every open:

| The map is | Both sides |
|---|---|
| present, complete and fresh | proceed, unless the lane is refused |
| **missing** | **nothing**: admission could not be established |
| **unreadable or malformed JSON** | **nothing** |
| a **different version** | **nothing** |
| **stale** (older than 300 s) | **nothing**: the deny list may have changed since it was written |
| a **missing deny list** (absent, or not a list) | **nothing**: a broken map is not an empty deny list |
| a deny list entry that is **not a safe handle** | **nothing**: a handle that can name a file is a handle that can be made to name one |
| **partial** pane mappings (the two do not cover the same panes) | **nothing**: the roster does not know where half of them live |
| a capture time that is **not finite**, or lies in the **future** | **nothing**: a future date is not clamped to "age 0" |

"I could not check" is not "admitted", and "the list is missing" is not "the list is
empty". The Python and the TypeScript validators enforce the same rules.

**The reporter writes nothing it may not write.** The map is applied to the pane's
**current** placement, and the reporter's own inherited handles are checked against the
deny lists as well. The **deny lists are checked first**, on both sides: they name the
lanes that may never report and do not depend on the placement, so a held lane is
refused *as held* rather than as an unknown pane.

| | |
|---|---|
| the pane is a reserved pane | **no write** |
| the reporter's **inherited** tab is a reserved tab | **no write**: a lane launched in a reserved tab stays silent even if the map has moved it out |
| the reporter's **inherited** workspace is held | **no write** |
| the map's tab for the pane is a reserved tab | **no write** |
| the map's workspace is held | **no write** |
| the map does not know the pane | **no write** |

The record is written under **the map's** tab, not the inherited one: the map is the
current topology, and the inherited tab does not follow a pane that moves. A pane that
moved to another *admitted* tab therefore keeps reporting.

**What this does not buy, stated rather than hidden.** The map is the topology *as of the
capture*. A pane that moves into a reserved tab **after** that capture is not visible to
the map until the next roster run, so in that window the reporter can write one record
for it. The reader refuses that record **before** the open — the map's tab and the file's
name disagree — so it is never stored and never surfaced. The exposure is bounded by the
map's age (300 s) and the roster's cadence, and closing the writer side entirely would
need a live topology: a read-only herdr query narrows the window but cannot guarantee the
placement across a later write, and neither a second writer nor a change to herdr is in
scope.

**And the freshness of an idle lane's observation is its sample's age.** The lifecycle timer
re-samples the session, so an idle lane's observation is **current** — the model, the
thinking level, the idle flag and the usage are the ones of now — and it is stamped with
that sampling instant. It is not a heartbeat of the *process*: nothing in the record
shows that the lane is alive, and the roster still calls `P-11` a last-observed
supplement.

**The ingester opens nothing it may not read.** The map is applied to the spool file's
**name** — which carries the pane id **and** the tab id — so:

| The file is for | Outcome |
|---|---|
| a lane in a held workspace | refused **before the open** |
| a reserved pane | refused **before the open** |
| a lane inside a **reserved tab** | refused **before the open** — the tab comes from the map, not from the record, so there is **no read-then-discard** |
| a pane the map does not know | refused **before the open** |
| a **moved** pane (the name's tab ≠ the map's tab) | refused **before the open** |
| a name with **no tab** in it | refused **before the open**: the current tab cannot be established before the file is read, and the reserved-tab refusal depends on it |
| a file whose name and record disagree | refused, and not stored (defence in depth — this is *after* the open, and it is not called a pre-read check) |
| a record whose tab contradicts its own file name | refused, and not stored (defence in depth) |

**Two writers can no longer race for one file.** The writer does not read the file it is
about to replace, because there is no file it replaces: every observation has its own
name, and the name carries the incarnation and the sequence number. The reader decides
the owner (the newest incarnation; the highest sequence number within one incarnation;
refused when two boots are too close to order), so the result does not depend on which
file arrives first. A record whose name and whose own incarnation disagree is refused —
that is a collision, and it is not stored.

**What is still open, stated rather than hidden.** The map is the roster's topology *as
of the capture*, so a pane that moves **after** that capture is not visible to it until
the next run. The reader refuses that pane's file **before** the open — but between the
move and the next run, a record written under the *old* tab may sit in the inbox. It is
never stored and never surfaced: the next run's map refuses it before the open, and the
cache is not read for a refused lane at all. **The reporter is not guaranteed to be
silent across a move**: its inherited tab is stale by construction, and the map is as of
the capture, so a lane that moves into a reserved tab after a capture can still write
one record before the next run sees the move. That is a **bounded staleness**, not a
guarantee, and it is not described as one. The reader-side window is bounded by the
map's age (300 s); closing the writer side entirely would need a live topology — a
read-only herdr query narrows the window but cannot guarantee the placement across a
later write — and the roster does not have one.

### The freshness vocabulary

Every cached read carries one of six states. This is the vocabulary, and it means
exactly what it says:

| State | Meaning |
|---|---|
| `fresh` | observed within the freshness window (120 s by default) |
| `stale` | observed **older** than the window. The value is a last observation, not a current one. "Stale" never means "wrong" |
| `absent` | there is no cached row for that pane or session |
| `identity_mismatch` | there is a row, but it belongs to **another session**. The value is not returned |
| `unreadable` | the row exists but cannot be decoded, or the cache file cannot be opened |
| `clock_disputed` | the observation's timestamp cannot be trusted: the clock moved. Its age is unknown, so it is neither fresh nor stale |

A stale value is still shown with its age. It is never quietly dropped and never presented
as current.

### The topology's provenance

The roster says where the topology came from, because "current" is a claim:

| Source | Provenance | Stale? |
|---|---|---|
| a live capture (`herdr api snapshot`) | the **capture's own clock**: this process made the call, so the moment is known and cannot be forged | `stale` when the capture is older than 300 s — a capture reused by a long watch was not made in that iteration |
| a snapshot **file** | the file's **mtime**: weak provenance, because an mtime can be set by anyone | `stale` when the file is older than 300 s |
| a fixture tree | the tree's mtime, marked as a fixture | as above |

The herdr snapshot document carries no timestamp of its own, so the moment the roster
asked is the only moment it can name. The provenance is in `behold.topology`.

**A reused topology keeps its provenance.** A watch iteration reuses the run's capture:
herdr is asked once per run, not once per iteration. The reused snapshot keeps the moment
it was observed, so the roster reports that capture's kind, that capture's moment, and an
**age that grows** — the topology was not seen again, and saying otherwise would be the
same lie the map's freshness bound exists to prevent.

**The admission map is stamped with the observation, not with the publication.** The map
says "this placement was observed then", so a watch that re-publishes it must not re-stamp
it: a map re-stamped on every iteration would make an old topology look fresh forever, and
the map's 300-second bound would never apply. The published map therefore ages from the
capture, and once it is older than the bound the readers refuse it — which is the bound
this document promises. A watch that runs longer than the bound publishes a map that is
correctly stale, and the roster says so in `behold.admission.stale`.

### The pi extension

`pi-extension/behold-state.ts` is a pi extension that reports the runtime facts a session
knows and the disk does not. It writes one small JSON document per observation into the
inbox, and the roster's cache ingests it.

**It writes by default**, against the admission map's placement, and the map's reserved
tab, reserved pane and held workspace are refused. The map is as of the last capture, so
that placement is a **bounded staleness, not a guarantee** — see "The reporter writes
nothing it may not write" above.

**It is not installed.** It ships in this repository; nothing on this machine loads it, and
no lane writes a spool record yet. Installing it fleet-wide is a separate, reviewed step —
see `pi-extension/README.md` for the exact status.

## Reading the output

### The JSON document: top-level keys

```jsonc
{
  "behold": { /* run metadata, privacy rules, counts, timings */ },
  "global": { /* M-4 plus three machine-level summaries */ },
  "lanes":  [ /* one envelope per lane */ ],
  "diagnostics": [ /* per-lane notices about damaged or disagreed data */ ]
}
```

#### The `behold` block

| Key | What it holds |
|---|---|
| `version` | the tool version, here `0.1.0-p1p2` |
| `generated_at` | when this document was produced |
| `as_of` | the clock the ages were evaluated against (`--as-of`, or now) |
| `mode` | always `derive-on-demand-read-only` |
| `snapshot` | `{protocol, agents, panes, workspaces, tabs, source, bytes, duration_ms}` |
| `capture` | present only when the topology was captured: the argv, the duration, the byte count, the sanitized stderr, the normalizer's notes, and **when** the capture was made (`captured_at`) |
| `topology` | the topology's **provenance**: where it came from (`live_capture`, `snapshot_file`, `fixture_tree`), the age of it, and whether it can be called current (see [The topology's provenance](#the-topologys-provenance)) |
| `admission` | the admission map this run published: the deny ids, the topology revision, **the map's own age and whether it is already stale**, and the ingest's own counters (`written`, `stale_rejected`, `stale_incarnation`, `ambiguous_incarnation`, `skipped_denied`, `skipped_mismatch`, …) |
| `paths` | every directory the run was allowed to read, and the ones it was given |
| `guard` | the safety receipt: spawn counts, deny lists, denial counts, `open_attempts`, `events` |
| `privacy` | the effective rules (`held_workspaces`, `reserved_panes`, `denied_path_markers`, `counts_and_paths_only`, `no_private_exports`) plus the denial tally |
| `runtime_only_pending` | the six things that can only come from a live runtime (see [Runtime-only pending](#runtime-only-pending)) |
| `budget_targets` | the performance targets. **Targets, not a measured whole-fleet proof** |
| `cache` | the cache's own state: mode, path, schema version, row counts (current rows and retired history rows), the topology row's freshness and the pi-state tally (see [The cache](#the-cache)) |
| `lanes` | `{total, by_field_state}`: the lane count and a tally of every field state |
| `timings_ms` | per-source `{count, p50, max}` timings |
| `wall_ms` | total wall time of the derivation |
| `filters`, `sort` | the filters and sorts that were applied, echoed back |
| `watch` | present only under `--watch`: `{iteration, changed_sources, refreshed_lanes, stale_lanes, rotated, process_exits, elapsed_s}` |

#### The `global` block

| Key | What it holds |
|---|---|
| `M-4` | the machine-wide active profile. **Global only.** It is never a lane field, and it is read only when an admitted, verified lane attributes it |
| `goal_config` | the goal *config* file: its path, its top-level key names, and whether it carries goal text. It carries no goal text and no queue |
| `beads_export` | `{path, issues}`: where the beads export was read from and how many issues it holds |
| `dagr_index` | `{runs}`: how many dagr runs the index points at |

#### `diagnostics`

A flat array of notices about data that was damaged, disagreed or was skipped:

```json
[
  {"lane": "w1B:p1", "code": "identity_untrusted", "state": "session_pin_stale_used_pil_record",
   "disagreements": ["pin_session=... != record_session=..."]},
  {"lane": "w1D:p2", "code": "session", "detail": "partial_final_line_ignored",
   "session": "/path/to/session.jsonl"}
]
```

Codes you will see: `identity_untrusted` (the witnesses disagreed, so no join was performed)
and `session` (the session file had a partial final line, a duplicate id, a malformed line
or a chain problem).

### The lane envelope

```jsonc
{
  "key": "w1A:p1",                  // the pane id, and the lane's sort key
  "handles": { ... },               // ids and names only, never content
  "admission": { "admitted": true, "reason": null },
  "identity": { ... },              // how "this session belongs to this lane" was proven
  "fields": { "H-1": { ... }, ... } // every field, keyed by its code
}
```

`handles` holds `pane_id`, `workspace_id`, `tab_id`, `workspace_label`, `name`,
`name_layer` and `agent_status`.

`identity` is the trust record, and it is the part worth reading before you trust anything
else in the lane:

| Key | What it holds |
|---|---|
| `state` | the resolution outcome (see the table below) |
| `trusted` | `true` only when every witness agrees |
| `session_id` | the validated session UUID |
| `session_source` | where the session came from (the pin, the pil record, ...) |
| `pin_path`, `pin_reporter_pid` | the herdr reporter's pin and the pid that wrote it |
| `pil_record` | the pane-matched lane record, including how it was looked up |
| `proc` | the `/proc` observation: pid, comm, state, starttime, boot_id, the pid triple |
| `process_tuple` | `verified`, `unrecorded` or `mismatch` |
| `checks` | the named checks that were run, each with `ok` and `detail` |
| `disagreements` | the specific disagreements, when there are any |
| `untrusted_because` | why the lane is untrusted, in one phrase |
| `note` | free-form note, when there is one |

Identity states:

| State | Meaning |
|---|---|
| `verified` | the pin, the pane-matched lane record and the `/proc` pid triple all agree |
| `session_pin_stale_used_pil_record` | the herdr pin was stale (it lags after `/new` and `/resume`); the lane record was used instead |
| `session_pin_stale_no_fallback` | the pin was stale and no lane record could stand in |
| `reporter_pin_missing_used_pil_record` | no pin at all; the lane record was used |
| `pin_only_unverified` | a pin existed and nothing else did. **Not trusted.** A pin alone proves nothing |
| `no_session_source` | no session file could be located for this lane |
| `pid_disagreement` | the reporter pid and the lane record pid differ |
| `pane_disagreement` | the recorded pane id differs from the snapshot pane id |
| `process_tuple_disagreement` | the recorded boot id / starttime do not match the observed process |
| `envpane_disagreement` | the process's own `HERDR_PANE_ID` is not this pane |

Only `verified` is **trusted**. An untrusted lane is still shown, with every witness
visible, but no explicit join (beads) and no profile or instance resolution happen on it.

### Field anatomy

Every field is the same shape. This is a real `P-7` record from the fixture fleet:

```json
{
  "state": "present",
  "class": "derived",
  "value": 3600.0,
  "source": "session header + last entry",
  "observed_at": "2026-11-11T02:11:00Z",
  "age_s": 2940.0,
  "method": "observed_now - header.timestamp (lane process present)",
  "reason": null,
  "note": null,
  "unit": "s",
  "privacy": 0
}
```

| Key | Meaning |
|---|---|
| `state` | one of the eleven states below |
| `class` | `authoritative`, `derived`, `inferred` or `last_observed` |
| `value` | the value itself, or `null` when the state carries no value |
| `source` | the file or record the value came from. Paths only, never content |
| `observed_at` | when the value was observed (ISO 8601, UTC) |
| `age_s` | seconds between `observed_at` and the `as_of` clock |
| `method` | the exact expression for a derived value. **Required** for every derived value, enforced in code |
| `reason` | why there is no value. Required for every non-value state |
| `note` | a limitation, a caveat, or extra detail that does not fit in `reason` |
| `unit` | `s`, `tokens` or `%` where it applies |
| `privacy` | `0` public metadata, `1` operator-sensitive, `2` never emitted |

### Field states

| State | Meaning | Has a value? |
|---|---|---|
| `present` | read or computed, with its source | yes |
| `divergent` | two authoritative sources disagree; both values are shown | yes |
| `conflict` | two stores disagree (for example the session TODOs and the instance TODO mirror) | yes |
| `inferred` | a heuristic, labelled with its limitation | yes |
| `stale` / `last_observed` | a past observation that cannot be confirmed current; the age is shown | yes |
| `expired` | a TTL-bounded value whose deadline passed | yes |
| `unknown` | the data does not exist here; `reason` says why | no |
| `absent` | the source is legitimately missing. Expected, not an error | no |
| `error` | a source failed; the roster still renders | no |
| `held` | refused before any path was opened (held workspace, reserved tab, reserved pane) | no |
| `withheld` | class-2 content exists and is deliberately not exported | no |

A field is never silently dropped. Every one of the 56 per-lane codes is always present in
`fields`, either with a value or with a state and a reason.

### Field classes

| Class | Meaning |
|---|---|
| `authoritative` | read verbatim from a store |
| `derived` | computed, and carrying the exact `method` that produced it |
| `inferred` | a heuristic that may be wrong, labelled with its limitation |
| `last_observed` | a past observation that cannot be confirmed current |

### Privacy classes

| Class | Meaning |
|---|---|
| `0` | public fleet metadata |
| `1` | operator-sensitive: counts, paths and handles only |
| `2` | never emitted. The field appears with `withheld` and no value |

### JSON example

A trimmed but real lane, from the fixture fleet:

```json
{
  "behold": {
    "version": "0.1.0-p1p2",
    "generated_at": "2026-11-12T04:03:05Z",
    "as_of": "2026-11-11T03:00:00Z",
    "mode": "derive-on-demand-read-only",
    "lanes": { "total": 1, "by_field_state": { "absent": 2, "inferred": 1, "present": 38, "stale": 2, "unknown": 8, "withheld": 5 } }
  },
  "global": {
    "M-4": {
      "key": "M-4",
      "state": "present",
      "class": "authoritative",
      "scope": "global_file",
      "value": { "activeProfile": "worker", "state": "present" },
      "privacy": 1
    }
  },
  "lanes": [
    {
      "key": "w1A:p1",
      "handles": {
        "pane_id": "w1A:p1",
        "workspace_id": "w1A",
        "tab_id": "w1A:t1",
        "workspace_label": "alpha-workspace",
        "name": "alpha-leader",
        "name_layer": "tabs[].label",
        "agent_status": "working"
      },
      "admission": { "admitted": true, "reason": null },
      "identity": {
        "state": "verified",
        "trusted": true,
        "session_id": "aaaaaaaa-0000-4000-8000-000000000001",
        "session_source": "herdr agent_session pin (validated, agrees with the lane record)",
        "process_tuple": "verified",
        "disagreements": [],
        "untrusted_because": null
      },
      "fields": {
        "H-5": {
          "state": "present",
          "class": "authoritative",
          "value": {
            "status": "working",
            "state_change_seq": 7,
            "completion_seq": null,
            "interactive_ready": null,
            "restore_error": null
          },
          "source": "panes[].agent_status",
          "observed_at": "2026-11-11T03:00:00Z",
          "age_s": null,
          "method": null,
          "reason": null,
          "note": "herdr-observed status value, not a conclusion about progress; not reported by herdr for this lane: completion_seq, interactive_ready, restore_error",
          "unit": null,
          "privacy": 0
        },
        "T-3": {
          "state": "present",
          "class": "derived",
          "value": 15.75,
          "source": "T-1 + T-2",
          "observed_at": "2026-11-11T02:07:00Z",
          "age_s": 3180.0,
          "method": "T-1 / T-2 * 100",
          "reason": null,
          "note": null,
          "unit": "%",
          "privacy": 0
        },
        "R-1": {
          "state": "unknown",
          "class": "authoritative",
          "value": null,
          "source": "git branch + oid: adapter removed in V3",
          "observed_at": null,
          "age_s": null,
          "method": null,
          "reason": "repo-adapter-not-isolated",
          "note": "requires a separately reviewed isolated execution boundary",
          "unit": null,
          "privacy": 0
        }
      }
    }
  ],
  "diagnostics": []
}
```

### Markdown example

`--markdown` renders a summary table, the pending runtime-only metrics, the budget targets
and, with `--full` or `--lane`, a per-field section for every lane:

```markdown
# behold roster

derived on demand · read-only · 16 lanes · generated 2026-11-12T04:03:48Z · as-of 2026-11-11T03:00:00Z

snapshot: protocol 22 · agents 16 · panes 16 · workspaces 11
privacy: counts and paths only · held workspaces w2 · reserved panes wE:t19 · denials {"held_workspace:w2": 1, "reserved_pane:wE:t19": 1, "reserved_tab:wE:t19": 1}
cache: disabled (cache disabled for this run)

| lane | workspace | pane | status | model | ctx% | branch | dirty | todos | beads | identity |
|---|---|---|---|---|---|---|---|---|---|---|
| alpha-leader | alpha-workspace | w1A:p1 | working | acme-large-1 | 15.75 | unknown: repo-adapter-not-isolated | unknown: repo-adapter-not-isolated | 3 | 2 | verified · aaaaaaaa-0000-4000… |
| alpha-worker | alpha-workspace | w1A:p2 | idle | acme-fast-1 | 1.52 | unknown: repo-adapter-not-isolated | unknown: repo-adapter-not-isolated | absent: no todo state in session or instance store | 0 | verified · aaaaaaaa-0000-4000… |

## pending runtime-only metrics

- T-8 ttft_ms: pi does not persist time-to-first-token
- J-1 background job live exit state: only log files and last tool calls exist
- J-2 monitor exit state: runtime-only
- J-3 bizzy monitor registry: no persistable state
- E-1 exact loaded extension list: tools alone cannot prove it (inert extensions register nothing); needs loader/registration evidence, not the tool list
- M-7 rooms presence/inbox depth: deferred to P3
```

And the per-lane detail section (`--full` or `--lane`):

```markdown
## w1A:p1 — alpha-leader

- **H-5** `present`/authoritative: {"completion_seq":null,"interactive_ready":null,"restore_error":null,"state_change_seq":7,"status":"working"}
  - source `panes[].agent_status` · note herdr-observed status value, not a conclusion about progress; not reported by herdr for this lane: completion_seq, interactive_ready, restore_error
- **T-3** `present`/derived: 15.75
  - source `T-1 + T-2` · method `T-1 / T-2 * 100` · age 3180.0s
- **D-2** `withheld`/authoritative: withheld (class 2)
- **J-1** `stale`/last_observed: stale: {"log_count":2,"log_files":[{"job_id":"bg-0001",…}]}
  - source `pi-bg/*.log stats + session bash_bg calls`
```

---

## The field ledger

**58 unique field ids**: 57 per lane, plus `M-4`, which is global only and is never a lane
field. The tables below cover every one of them.

### Coverage at a glance

| Family | Lane ids | Emitted with a value | Always `unknown` | Always `withheld` (class 2) | Runtime-only / deferred |
|---|---|---|---|---|---|
| H herdr topology | 6 | 6 | none | none | none |
| P pi session and model | 11 | 11 | none | none | none |
| T tokens, context, performance | 8 | 7 | `T-8` | none | `T-8` |
| R repository | 7 | 2 (`R-5`, `R-7`) | `R-1` `R-2` `R-3` `R-4` `R-6` | none | none |
| M mode, profile, rooms | 6 | 5 | `M-7` | none | `M-7` |
| G goals and dagr | 4 | 4 | none | none | none |
| D TODOs | 2 | 1 (`D-1`) | none | `D-2` | none |
| C crons | 2 | 1 (`C-1`) | none | `C-2` | none |
| E extensions | 2 | 2 | none | none | `E-1` (exact list) |
| S skills and prompts | 4 | 2 (`S-1`, `S-3`) | none | `S-2` `S-4` | none |
| J monitors and jobs | 3 | 2, last-observed only | `J-3` | none | `J-1` `J-2` `J-3` |
| B beads | 2 | 1 (`B-1`) | none | `B-2` | none |
| **Total** | **57 lane ids + `M-4` = 58** | **46** | **8** | **5** | **6 items** |

"Always unknown" means the field can never carry a value in this tranche. "Emitted" means
the field carries a value under normal conditions; every field can also be `absent`,
`conflict`, `divergent`, `stale` or `error` depending on what the stores actually hold.
No field is silently dropped.

`FIELD-LEDGER.md` in this repository tracks each field's source, its state in the tranche
and the gate that still has to be closed before the value is true of a live fleet. Its
repository rows still describe the `--git` and `--jj` opt-ins that V3 removed; the tables
below describe what the code returns today.

### H: herdr topology

All six come from the one snapshot read the whole roster is built on.

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `H-1` | workspace label | The human name of the workspace the pane lives in | `snapshot workspaces[].label` | `present`, `absent` |
| `H-2` | workspace id | The workspace handle, for example `w1A` | `snapshot workspaces[].workspace_id` | `present`, `absent` |
| `H-3` | pane id | The pane handle, for example `w1A:p1` | `snapshot agents[].pane_id` | `present`, `absent` |
| `H-4` | pane name + winning layer | The name of the lane, and which snapshot layer produced it | `tabs[].label` → `agents[].name` → `agents[].display_agent` → `panes[].label` → `agents[].terminal_title_stripped` | `present`, `absent` |
| `H-5` | status + sequence numbers | The status string herdr reported, verbatim, plus `state_change_seq`, `completion_seq`, `interactive_ready` and `restore_error` | `panes[].agent_status` then `agents[].agent_status` | `present`, `unknown` |
| `H-6` | cwd vs foreground cwd | The lane's working directory and the shell's foreground directory | `snapshot agents[].cwd`, `foreground_cwd` | `present`, `divergent`, `absent` |

`H-4` names its winner: the `source` is the layer that answered and the `note` repeats it
as `winning layer: <layer>`. `H-5` keeps `done` as a legitimate herdr value rather than
reading it as a claim that the work finished, and its `note` lists the sub-values herdr did
not report. `H-6` is `divergent` when the two realpaths differ.

### P: pi session and model

| Code | Field | What it means | Source / method | States |
|---|---|---|---|---|
| `P-1` | provider | The selected provider and the physical provider behind it | `model_change.provider` vs the last assistant `provider` | `present`, `divergent`, `absent` |
| `P-2` | model | The selected model and the physical model behind it | `model_change.modelId` vs the last assistant `model` | `present`, `divergent`, `absent` |
| `P-3` | reasoning effort | The thinking level in force | `thinking_level_change`, else the assistant `thinkingLevel` | `present`, `absent` |
| `P-4` | session id + leaf + chain | The validated session UUID, the leaf, the chain state and the entry counts | session header + the `id`/`parentId` tree, read from disk | `present` |
| `P-5` | session path | The session file, realpath-normalized, with the reported spelling and how many spellings exist | the pin or the pane-matched lane record | `present` |
| `P-6` | session start | When the session opened | session header `timestamp` | `present`, `absent` |
| `P-7` | session duration | How long the session has been open | `observed_now - header.timestamp` when the lane process is present, else `last_entry_timestamp - header.timestamp`. The `method` says which | `present`, `unknown` |
| `P-8` | last observed turn span | The span of the last user to assistant turn seen on disk | `last_assistant_or_user_ts - last_user_ts` | `present`, `absent` |
| `P-9` | session name | The session's own name. Privacy 1 | the latest `session_info.name` | `present`, `absent` |
| `P-10` | fork lineage | The parent session path. Privacy 1 | session header `parentSession` | `present`, `absent` |
| `P-11` | runtime observation | What the lane's reporter last observed in memory: the model, the thinking level, the streaming and queue state, the context usage and the lane's identity handles. Class `last_observed` | the cache's `pi_state_current`, joined on `(pane id, session id)` | `present`, `stale`, `unknown` (identity mismatch), `absent`, `error`, `held` |

`P-1` and `P-2` are `divergent` when the selected model differs from the physical one,
which is the normal case for a virtual-model lane. `P-4` carries
`leaf_authority: "DISK_RECONSTRUCTED"` and `runtime_leaf: null`: pi keeps the selected leaf
in memory only, so the file can show the last entry but cannot prove which branch is
current. `P-8` is explicitly the last observed span, never a live "still running" timer.

### T: tokens, context and performance

| Code | Field | What it means | Method | States |
|---|---|---|---|---|
| `T-1` | context used | Tokens used by the last assistant message | the message's `usage.totalTokens`, else `usage.input + output + cacheRead + cacheWrite` | `present`, `absent` |
| `T-2` | context max | The context window of the **physical** model | `models-store.json` `contextWindow` | `present`, `unknown` |
| `T-3` | context % | How full the context window is | `T-1 / T-2 * 100` | `present`, `unknown` |
| `T-4` | session tokens | Tokens used by the session on the active branch, broken down into `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `cost`, `cost_estimated`, `usage_kinds`, `usage_entries`, `cache_warm_entries` and `compaction_usage_entries` | the sum over assistant usage, `usage` entries and compaction / branch-summary usage | `present`, `unknown` |
| `T-5` | cache counts + hit rate | Cache reads, cache writes, input tokens, and the hit rate as a ratio and a percentage | `ΣcacheRead / (ΣcacheRead + Σinput)` | `present`, `absent` |
| `T-6` | cost (estimated flag) | Accumulated cost, flagged `estimated` when any total was not provider-reported. Privacy 1 | `Σ usage.cost{...}` | `present`, `absent` |
| `T-7` | TPS | Output tokens per second, from persisted timings | `Σ output tokens / Σ durationMs` over the last 20 assistant messages that carry a duration | `present`, `unknown` |
| `T-8` | TTFT | Time to first token | none | **`unknown`, always** |

`T-2` never assumes a default window. If the catalogue has no `contextWindow` for the
physical model, `T-2` and `T-3` are `unknown` with the reason
`no contextWindow: <detail>` and `T-1 or T-2 unknown; refusing to assume a context size`.

`T-4` sums **on the active branch only**, so abandoned branches are excluded by design. When
that differs from a branch-blind file sum, the difference is reported in the `note`, with
both numbers.

`T-8` is `unknown` in every lane, forever, in this tranche: pi persists total `durationMs`
but not time-to-first-token. It is listed under
[Runtime-only pending](#runtime-only-pending) and needs a separately reviewed live
extension.

**Honesty note.** `T-1`, `T-3`, `T-4` and `T-5` are *derived*. They are not proven to equal
what pi's own footer prints: pi may add estimates or compaction adjustments that a raw
usage sum does not reproduce. Each field carries its `method` string so the comparison is
mechanical, and footer equivalence remains an open gate.

### R: repository state

The git and jj adapters were **removed** in V3. A child process is not constrained by an
in-process audit hook, and repository configuration can make even a read-only git argv run
a helper writer, so the capability was removed rather than shipped behind an opt-in flag.
Detection by `stat` is pure and stays.

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `R-1` | git branch + oid | The branch and commit the lane is on | *(adapter removed)* | **`unknown`, always** |
| `R-2` | worktree identity | The repository the workspace is bound to | herdr's `workspaces[].worktree` only; the git cross-check is disabled | **`unknown`, always** |
| `R-3` | dirty counts | Modified, staged, untracked and conflicted counts | *(adapter removed)* | **`unknown`, always** |
| `R-4` | ahead / behind / stash | How far the branch has diverged, and the stash count | *(adapter removed)* | **`unknown`, always** |
| `R-5` | jj detected | Whether the lane sits in a jj workspace, and its bookmark token | `.jj` presence by `stat`, plus the snapshot's `tokens.jj_bookmark` | `present`, `absent`, `expired` |
| `R-6` | jj bookmark, change, status | The jj working-copy state | *(adapter removed)* | **`unknown`, always** |
| `R-7` | non-repo lane | Whether the lane is in a repository at all | `.git` / `.jj` presence by `stat` | `present` |

The reason string is the same for all five removed fields:
`repo-adapter-not-isolated`. `R-5` needs no jj binary, and its bookmark token is
TTL-aware: a token whose expiry has passed yields `expired`. `R-7` reads `NO_REPO`, `git`
or `jj`, and the absence of a repository is an expected state, not an error.

### M: mode, profile and rooms

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `M-1` | active mode + metadata | The mode key in force, the overlay keys, the drift policy, when it was activated, and the definition paths, digests, scopes and labels. Privacy 1, no prompt body | the session's `custom pi-mode-state.v3` entry, plus the definition files for their label only | `present`, `absent` |
| `M-2` | mode drift | Whether the recorded digest still matches the file on disk | the digest recomputed with pi-modes' own fingerprint algorithm | `present`, `unknown` |
| `M-3` | profile with provenance | The declared profile, the selected profile, the resolved skills and tools, the instance and the catalogue label. Privacy 1 | the process env key `PI_PROFILE`, plus `instances/<instance>/pi-profile.json` | `present`, `unknown` |
| `M-4` | global active profile | The machine-wide active profile. **Global only, in `global`, never a lane field** | `pi-profile-state.json`, read only for instances attributed by an admitted, verified lane | `present`, `conflict`, `unknown` |
| `M-5` | rooms lane name | The rooms name pinned to this pane | `rooms/names.json` `pins["pane:<id>"]` | `present`, `absent` |
| `M-6` | rooms membership | Which rooms the lane is listed in, and the registry count. Privacy 1, names only | `rooms/registry/` plus the `rooms/rooms/` files | `present`, `unknown` |
| `M-7` | presence / inbox depth | How present the lane is and how deep its inbox is. Privacy 1 | *(deferred to P3)* | **`unknown`, always** |

`M-2` recomputes the digest byte-for-byte the way pi-modes does. A **composed** definition
(any overlay, or a project scope) is reported as `unverifiable`, not as drift: the accepted
digest covers the composed result, so hashing the wrong object would be a false alarm.

`M-3` keeps three profiles apart and never conflates them:

* **declared**: the single allowlisted environment key `PI_PROFILE`, read at process start.
  It can be stale after a `/profile` switch, and the field says so.
* **selected**: the per-instance `pi-profile.json`. The instance comes **only** from the
  verified process's own `PI_CODING_AGENT_DIR`, never from path containment of the session
  file.
* **resolved**: the saved skill and tool references, plus the catalogue label.

No other environment variable value is ever emitted.

`M-4` is the one global file on the machine. The instances root is never listed: the reader
is handed the instance names already established from admitted and verified lanes and
constructs one path per name. A held or foreign instance's copy is therefore never opened,
and with no admitted and verified lane the answer is `unknown(noaccess)`.

### G: goals and dagr

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `G-1` | goals count + statuses | How many goals the lane has and their status breakdown. Privacy 1, counts only | the per-session goal `custom` entry | `present`, `absent`, `unknown` |
| `G-2` | goals queue depth | How deep the goal queue is. Privacy 1 | the same entry | `present`, `absent`, `unknown` |
| `G-3` | dagr runs for the lane | The dagr runs that name this pane, with task state counts and owner counts. Privacy 1, **title withheld** | the `recent` index, then each `run.json` | `present`, `absent`, `unknown` |
| `G-4` | dagr staleness | How old the run snapshot is, and whether the run's own events are newer than it | `observed_at - run.generated_at` compared with `run.events` | `present`, `absent`, `unknown` |

`G-1` and `G-2` are `unknown` when the goal store is text-only: the count is withheld
because the goal text is class 2. `G-3` maps a run to a pane by the orchestrator pane or by
any task attempt's locator pane. That is a **mapping, not progress**: task `state` values
are reported exactly as recorded.

### D: TODOs

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `D-1` | TODO counts + conflict | Open, completed and total counts, with the by-status breakdown. Privacy 1 | the session's `pi-core-todo-state` on the active branch, cross-checked against the instance's `pi-todo-state.json` for the same session UUID | `present`, `conflict`, `absent` |
| `D-2` | TODO subjects | The text of the TODOs | *(never exported)* | **`withheld`, always** |

`D-1` is `conflict` when the session store and the instance mirror disagree about the
total. Both numbers are in the value and the `reason` spells the conflict out.

### C: crons

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `C-1` | crons for the lane | The cron tasks whose `projectDir` is this lane's cwd: `id`, `name`, `schedule`, `cron`, `kind`, `projectDir`. Privacy 1 | the cron `tasks.json` | `present`, `unknown` |
| `C-2` | cron prompt | The prompt body of a cron task | *(never read into output)* | **`withheld`, always** |

A task that carries a `prompt` field increments a `prompt_field_skipped` counter. The
prompt is skipped, not read and then redacted.

### E: extensions

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `E-1` | extensions loaded | Which extensions the session appears to have loaded | the session system-message replay: `toolsAdded` / `toolsRemoved` and the skills section | **`inferred`, always** |
| `E-2` | installed package pins | The packages configured for this lane: name and ref only | the instance `settings.json` package entries | `present`, `absent` |

`E-1` is the weakest field in the ledger and says so in its own `reason`: an **inert
extension registers no tool**, so the tool list cannot prove the extension inventory. The
field is a lower bound on what was loaded, never a proof. Exact attribution needs loader or
registration evidence from a live runtime, which is listed under
[Runtime-only pending](#runtime-only-pending). `E-2` is what is *configured*, which is not
the same thing as what is loaded.

### S: skills and prompts

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `S-1` | skills loaded | The skills named in the session, with their paths, plus the names the profile resolved | the session skills section, cross-checked against `pi-profile.json` `resolved.skills` | `present`, `conflict`, `absent` |
| `S-2` | skill text | The body of a skill | *(never emitted)* | **`withheld`, always** |
| `S-3` | prompts (configured vs loaded) | The configured prompt paths and the names of the sections that were loaded | `settings.json` prompt sources plus the session system-message section names | `present` |
| `S-4` | prompt text | The body of a prompt | *(never emitted)* | **`withheld`, always** |

`S-1` is `conflict` when the session's skills section and the profile's resolved skills
disagree. `S-3` carries `loaded_is_not_proof_of_bodies: true`: a section name proves the
section was present, not what was in it.

### J: monitors and background jobs

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `J-1` | background tasks | The `bash_bg` calls seen in the session and the `pi-bg/*.log` files with their sizes and mtimes. Privacy 1 | session tool calls plus log file stats | `stale` (last observed) |
| `J-2` | monitors set | The `monitor` tool calls seen in the session. Privacy 1 | session tool calls | `stale` (last observed) |
| `J-3` | bizzy monitors | The bizzy monitor registry. Privacy 1 | `bizzy.json` | **`unknown`, always** |

`J-1` and `J-2` are **not** running states. A log file's size and mtime are evidence that
something was logged, not that a process is alive, and a later monitor exit cannot be seen
in session data at all. Their `reason` says this. `J-3` is `unknown` because `bizzy.json`
holds only `disabledTools`: there is no monitor registry to read.

### B: beads

| Code | Field | What it means | Source | States |
|---|---|---|---|---|
| `B-1` | beads for the lane | The issues attributed to this lane: ids, statuses, priorities and types, with a by-status breakdown. Privacy 1, **title withheld** | the beads export, joined on `metadata.agent_pane` **and** `metadata.agent_session` | `present`, `unknown` |
| `B-2` | bead description and notes | The body of a bead | *(never emitted)* | **`withheld`, always** |

The join is deliberately strict, and the field says how strict it was:

* `metadata.agent_pane` must equal the pane, and `metadata.agent_session` must equal the
  **validated** session id **exactly**. A suffix match is forgeable and a path-shaped value
  must equal the realpath, not merely contain it.
* A matching `owner`, a `project:<workspace>` label, or a bead id quoted in prompt text is
  **not** a join. Those are counted in `rejected` as `owner_only`, `label_only` and
  `incomplete_metadata`. A label scopes the project, nothing more.
* Without a validated session identity the join refuses outright, with
  `identity_untrusted:<reason>` or `session_identity_not_validated`. An unvalidated
  attribution is worse than a count of zero with a reason.

### Runtime-only pending

These six items appear verbatim in `behold.runtime_only_pending` and in the Markdown
footer. They are not bugs and they are not failures: the data simply does not exist on
disk.

| Field | What is missing | Why |
|---|---|---|
| `T-8` | TTFT | pi persists total `durationMs`, not time-to-first-token |
| `J-1` | live exit state of a background job | only log files and last tool calls exist |
| `J-2` | monitor exit state | runtime-only |
| `J-3` | bizzy monitor registry | no persistable state |
| `E-1` | the exact loaded extension list | tools alone cannot prove it. An inert extension registers nothing; it needs loader or registration evidence |
| `M-7` | rooms presence and inbox depth | deferred to a separately approved P3 phase |

Closing any of these needs a new extension, its own approval gate, and a rollout. It is
not a flag flip.

---

## Filtering and sorting

Filtering and sorting operate on **flattened field paths**, so any property the JSON exposes
is reachable without a second schema. There is no query language and no expression parser:
four operators, and the key is a dotted path.

### Flattened keys

| Pattern | Example | Meaning |
|---|---|---|
| `key` | `key` | the pane id |
| `admitted` | `admitted` | `true` or `false` |
| `handles` | `handles` | the whole handle map |
| `<CODE>` | `T-3` | the whole field record |
| `<CODE>.state` | `T-3.state` | the field's state, for example `present` |
| `<CODE>.value` | `T-3.value` | the value itself |
| `<CODE>.value.<path>` | `H-5.value.status` | a path inside the value |
| `identity.state` | `identity.state` | the identity resolution state |
| `identity.session_id` | `identity.session_id` | the validated session UUID |

Two things are **not** flattened: `identity.trusted` (only `identity.state` and
`identity.session_id` are reachable), and anything nested deeper than the JSON actually
goes. Lists are indexed as `key[0]`, `key[1]`, and so on.

### Operators

| Operator | Syntax | Meaning |
|---|---|---|
| `=` | `KEY=VALUE` | exact string equality |
| `!=` | `KEY!=VALUE` | not equal |
| `~` | `KEY~GLOB` | shell glob match (`*`, `?`, `[seq]`), case-sensitive |
| `!~` | `KEY!~GLOB` | not a glob match |

There is no `>` or `<`. Numbers compare as strings, so `T-3.value=15.75` works but
`T-3.value>10` does not exist. For a numeric range, sort instead.

Note the glob operator takes **no `=`**: it is `KEY~GLOB`, not `KEY=~GLOB`. The parser
splits on the operator it finds first, so `KEY=~GLOB` parses the key as `KEY=`, which
matches nothing.

### Examples

```sh
# only lanes herdr reports as working
behold roster --root /tmp/behold-fix --filter 'H-5.value.status=working'

# every lane that is not working (glob negation, no '=' sign)
behold roster --root /tmp/behold-fix --filter 'H-5.value.status!~w*'

# lanes whose context percentage string starts with a 1
behold roster --root /tmp/behold-fix --filter 'T-3.value~1*'

# only lanes with a verified identity
behold roster --root /tmp/behold-fix --filter 'identity.state=verified'

# repeat the flag to AND the conditions together
behold roster --root /tmp/behold-fix --filter 'H-5.value.status=working' \
                              --filter 'admitted=true'

# sort by context usage, highest first, then by lane key
behold roster --root /tmp/behold-fix --sort 'T-3.value:desc' --sort 'key'
```

A filter that matches nothing is **not** an error. The result is an empty lane list, which
is visible as `lanes.total: 0` in the JSON and as `_no lanes matched_` in the Markdown.

Sorting is a stable multi-key sort. Numbers sort numerically, text sorts case-insensitively,
and **missing or unknown values always sort last, in both directions**: the unknown
partition is never reversed. The default sort key is `key` (the pane id).

---

## Safety boundaries

Both mechanisms are real and both are tested.

### 1. Deny before read (`behold/guard.py`, `Policy`)

* Held workspace `w2` and reserved tab / pane `wE:t19` are refused **before** that lane's
  process, session or state path is touched. The refusal reason is a stable code:
  `held_workspace:w2`, `reserved_tab:wE:t19`, `reserved_pane:wE:t19`.
* Denied path markers (`/secrets/`, `/.ssh/`, `/auth.json`, `/.credentials/`, `/keyring`)
  are refused at the single read funnel every adapter must use.
* A held lane produces **no value at all**, not even its snapshot label or status. The
  handles that name the refusal are what remain.
* The lane-record directory is the one pre-admission listing, and it is opened one candidate
  file at a time, by pane-matched lookup only. Denied records are discarded on sight and
  their session paths are never opened.

The audit hook, not an mtime comparison, is the boundary.

### 2. Fail-closed read-only and network guard (`guard.enforce()`)

A CPython audit hook refuses:

* any `open` with write intent (`w`, `a`, `x`, `+`, or `O_WRONLY` / `O_RDWR` / `O_CREAT` /
  `O_TRUNC` / `O_APPEND`),
* any filesystem mutation (`os.remove`, `os.rename`, `os.mkdir`, `os.symlink`,
  `shutil.rmtree`, ...),
* any network operation (`socket.connect`, `urllib.Request`, `http.client.connect`, ...),
* any spawn event (`subprocess.Popen`, `os.posix_spawn`, `os.exec*`, `os.system`).

There is **no write exception** for output, and **no argv allowlist**.

V5 adds two seams, both narrow, both tested, and both *opt-in per call* rather than
standing permissions:

* **One-shot spawn permit** (`guard.permit_spawn`). A permit names one exact argv and one
  purpose. The audit hook compares the argv the OS was asked to run — not a basename, not
  a prefix — and consumes the permit at the spawn event. A second spawn with the same
  permit is refused. An unknown purpose is refused before a process can exist. The only
  purpose in the build is `herdr-snapshot-capture`, and the only argv is
  `herdr api snapshot`.
* **Cache write scope** (`guard.cache_write_scope`). One cache path family (the database
  and the sidecars SQLite creates beside it) plus its parent directory, for the duration
  of one block. Every other path is refused, and the scope ends with the block.

### 3. Ownership is witness agreement

A validated pin *alone* is `pin_only_unverified` and not trusted. Trust requires the pin,
the pane-matched lane record and the `/proc` pid triple to agree, with no disagreement, and
the process tuple either verified or explicitly unrecorded. A disagreement is untrusted: no
beads join, no profile resolution, no instance resolution.

### 4. Global state is read by handle, not by scanning

`global.M-4` is given the instance names already established from admitted and verified
lanes and constructs one path per name. It never lists the instances root, so a held or
foreign instance's `pi-profile-state.json` is never opened. A full-roster negative test
plants such files and asserts the attempted-open list is empty, with a trusted positive
control, so "nothing opened" cannot mean "the reader never ran".

### What the guard does not cover

The audit hook covers the audit events CPython itself emits. It is **not** an OS-level
sandbox, and it cannot constrain a program that was started before the hook was installed.

Two limits are worth stating plainly:

* **The SQLite writes are invisible to the hook.** CPython raises audit events for
  `open` and the filesystem mutations it performs in Python; the `sqlite3` module opens
  and writes the database in C, so those operations raise no event. The cache write scope
  therefore governs the *Python-level* operations (creating the cache directory, and
  anything the caller writes itself), and the confinement of the database file itself is
  the **path policy**: one configured cache path, in Behold's own directory, never a fleet
  store path. A test asserts that `behold/cache.py` is the only module in the package that
  imports `sqlite3` at all.
* **A child process is not contained.** The capture's argv is exact and the permit is
  one-shot, but herdr is a separate program and the hook cannot constrain what it does.
  `herdr api snapshot` is herdr's own read-only API; that is the whole of the child's
  job.

---

## Known limitations

These are limits of the design, stated so nobody has to discover them the hard way.

**Content that will never be in the output.**

* No message bodies, prompt bodies, skill bodies, TODO subjects, cron prompts, bead
  descriptions or notes, room bodies or receipts.
* Bead **titles** and dagr run **titles** are withheld even though the plan placed them at
  privacy 1, because this tranche is restricted to counts and paths only. Re-enabling them
  is a separate, reviewed decision, not a flag flip.
* No tool arguments, no environment values other than the single allowlisted `PI_PROFILE`
  key.

**Proof that does not exist.**

* `E-1` cannot prove which extensions were loaded. An inert extension registers no tool, so
  the tool list is a lower bound, not an inventory.
* `T-8` (TTFT) is `unknown` in every lane, forever, in this tranche.
* `J-1` and `J-2` are last-observed, not running states. `J-3` has no registry to read.
* `M-7` (rooms presence and inbox depth) is deferred to P3.
* `P-4`'s leaf is `DISK_RECONSTRUCTED`. pi does not persist the selected leaf, so the
  runtime branch cannot be proven from disk.
* `M-2` cannot re-check a composed mode definition; it reports `unverifiable` rather than
  a false drift.

**Repository fields.**

* `R-1`, `R-2`, `R-3`, `R-4` and `R-6` are `unknown(repo-adapter-not-isolated)` in every
  lane. The `--git` and `--jj` opt-ins that an earlier draft described **no longer
  exist**: the adapters were removed because a child process is not contained by an
  in-process audit hook and repository config can make a read-only git argv run a helper
  writer. The herdr **capture** is the one exception, and it is a different thing: a
  read-only API call with an exact argv, behind a one-shot permit.
* `R-5` detects a jj workspace by `stat` and reads the snapshot's bookmark token. It never
  runs jj, and it says so in its `note`.

**The capture and the cache.**

* **The live capture has not been run.** The lane that wrote the capture was not allowed
  to read the live fleet, so `herdr api snapshot`'s real output has not been observed
  against the live binary. What *is* verified is the **installed herdr's own schema**:
  `herdr api schema --json` (protocol 22, schema_version 1) defines the response as a
  `SessionSnapshot` with `version`, `protocol`, `workspaces`, `tabs`, `panes`, `layouts`
  and `agents`, and a representative fixture built to that schema is checked in
  (`fixtures/herdr_session_snapshot.json`) and checked against the installed schema by
  the test suite. The normalizer accepts that flat shape and the API's success envelope
  (`{"id", "result"}`), and a document in neither shape is a typed error rather than an
  empty roster. **The first live run may still need a normalizer fix.**
* A captured document with **no integer `protocol` is refused**, not defaulted: the
  protocol is never filled in on the document's behalf. The roster's own parser then
  refuses an unsupported protocol with a loud error.
* A session published by the live API as an **id** is not turned into a session path pin:
  a pin that cannot be opened is worse than no pin, and the lane falls back to the
  pane-matched lane record.
* The SQLite writes are not visible to the in-process audit hook (they happen in C). The
  confinement of the cache file is the **path policy** — one configured path in Behold's
  own directory — plus the narrow write scope, not the hook. See
  [Safety boundaries](#safety-boundaries).
* The cache's freshness is a **wall-clock age**, not proof that a value is still current.
  A `stale` row is a last observation.
* The cache is **derived** state. It is never a source of truth about a lane, and the
  disk-derived fields (`P-1`..`P-10`) are never replaced by it.
* A cached observation that belongs to **another session** is never returned: `P-11` says
  `identity_mismatch` and carries no value.
* An old observation is `stale`, never `present`, and carries its age.
* A lane the roster refuses (held workspace `w2`, reserved pane/tab `wE:t19`) is excluded
  **before** the cache is consulted: no cache read happens for it, and its spool record is
  refused before the file is opened.
* The reporter cannot see herdr's agent status (pi exposes only `isIdle()`), the time to
  first token, the rooms presence or the beads counts. Those are reported as **unavailable**
  on every observation, not omitted.
* The reporter's view is as fresh as the last ingest, not as fresh as the lane.

**Target versus measured.**

* `behold.budget_targets` is a set of **targets**, and the document says so in its own
  `note` field: `"targets, not measured whole-fleet proof"`. They are measured on
  synthetic fixtures only (see [Tests](#tests)). Nothing here has been validated against a
  live 61-lane fleet.
* `T-1`, `T-3`, `T-4` and `T-5` are derived. Equivalence with pi's own footer is an open
  gate, not a proven fact.

**Trust and attribution.**

* The active branch is `DISK_RECONSTRUCTED`, so per-branch sums exclude abandoned
  branches by design.
* The beads join requires exact metadata. A lane whose beads lack
  `metadata.agent_pane` and `metadata.agent_session` will show zero, with the rejections
  counted.
* A lane whose identity is untrusted gets no profile, no instance and no beads join. That
  is the intended behaviour, not a bug.

**Operational.**

* A bare `behold roster` is a **live** run: it captures the topology from herdr and reads
  the real private stores. Use `--snapshot FILE` for one file and nothing else, or
  `--root DIR` for a fixture tree.
* `--live` points at the real stores and reads private data. It has not been exercised
  against a live fleet.
* `--as-of` cannot be combined with `--watch`: a watched document has to age.
* The host `/proc` is never read unless `--root` or `--proc-root` names a tree.
* `--filter` and `--sort` compare as strings. There is no numeric comparison operator.
* Only `identity.state` and `identity.session_id` are reachable from the flattened key
  space. `identity.trusted` is not.
* For a lane with no validated session, every path-derived field is `unknown` with the
  reason `no validated session: <identity state>`, except the always-withheld class-2
  fields `C-2` and `B-2`.
* The pi extension in `pi-extension/` is **not installed**. No lane writes a spool
  record yet, so the cache's `pi_state_current` table stays empty in practice.

---

## Troubleshooting

Every error the tool can print, and what to do about it.

| Message | Exit | Cause and fix |
|---|---|---|
| `behold: snapshot not found: /path` | 3 | The path does not exist. Check the path, or use `--root DIR`, where the snapshot is expected at `DIR/herdr/snapshot.json` |
| `behold: snapshot unreadable: JSONDecodeError` | 3 | The file is not JSON. It is probably a log or a truncated capture |
| `behold: snapshot has no integer protocol field; refusing to guess` | 3 | Not a herdr snapshot document. `behold` will not guess the format |
| `behold: unsupported herdr protocol 21; supported: [22]` | 3 | The snapshot is from another herdr protocol version. Capture a protocol-22 snapshot |
| `behold: herdr-not-found: the herdr binary is not on PATH; ...` | 3 | herdr is not installed or not on `PATH`. Capture a snapshot out of band and pass `--snapshot FILE` |
| `behold: herdr-timeout: herdr api snapshot did not finish within 10s` | 3 | herdr did not answer in time. Check that the herdr server is up, or use `--snapshot FILE` |
| `behold: herdr-exit-1: herdr api snapshot exited 1 (server not running)` | 3 | herdr ran and failed. The parenthesised text is herdr's sanitized stderr |
| `behold: herdr-invalid-json: herdr api snapshot did not return a JSON object` | 3 | Something other than herdr answered on that PATH entry |
| `behold: herdr-unreadable-snapshot: the captured document is not a herdr topology` | 3 | The capture produced a document this build cannot read. Capture it out of band and pass `--snapshot FILE` |
| `behold: cache schema mismatch: database is v2, this build expects v1; ...` | 3 | The cache file was written by another build. Delete it or point `BEHOLD_CACHE_DB` elsewhere |
| `behold: --herdr captures the live topology and --snapshot reads a file; they are mutually exclusive` | 2 | Drop one of the two flags |
| `behold: filter 'H-5.value.status' needs one of = != ~ !~` | 2 | The filter expression has no operator. Use `H-5.value.status=working` |
| `behold: --as-of is a single-run override and cannot be combined with --watch (a watched document must age)` | 2 | Drop one of the two flags |
| `behold: error: unrecognized arguments: --include-todo-subjects` | 2 | Unknown flag. There is no private-export flag, by design |
| `behold: read-only guard refused an action: ...` | 4 | Something tried to write or spawn inside the process. This is the guard working; it is a defect in an adapter, not in your command |
| `behold: network guard refused an action: ...` | 4 | A socket or URL fetch was attempted. Same as above |
| `behold: denied read: ...` | 4 | A denied path marker was reached. The read was refused before it happened |

**Common non-errors.**

* *Everything is `unknown`.* The lane has no validated session. Look at
  `identity.state` and `identity.untrusted_because` first: the usual causes are a stale
  herdr pin after a `/new` or `/resume`, a pid that no longer matches, or a lane whose
  process has exited.
* *Every field is `held`.* The lane is in a held workspace or a reserved tab or pane. That
  is the deny policy working. `--deny-workspace` and `--deny-pane` only ever add to the
  list, never remove from it.
* *`T-3` is `unknown`.* Either `T-1` (no assistant usage on the active branch) or `T-2`
  (no `contextWindow` for the physical model in the catalogue) is unknown. The reason
  field says which. `behold` will not assume a default window.
* *`B-1` is `unknown` with `identity_untrusted:...`.* The identity witnesses disagreed, so
  the join refused. Check `identity.disagreements`.
* *The Markdown table shows long `unknown: ...` strings.* The summary columns show the
  reason when there is no value. Use `--full` or `--lane` for the per-field section.
* *A filter returns nothing.* The expression may be parsing differently from what you
  meant. In particular the glob operator takes no `=`: `KEY~GLOB`, not `KEY=~GLOB`. A filter
  that matches nothing is not an error; it is an empty lane list.
* *`watch` prints one document and stops.* That is correct. `behold` re-renders only when an
  input actually changed or a process exited, up to `--watch-iterations` renders or
  `--watch-max-seconds`.

---

## Tests

The suite is offline, standard library only, and needs no network, no git, no jj and no
herdr. It needs a POSIX shell, `coreutils` and `python3`.

```sh
tests/run-tests.sh                 # fixtures + 436 tests, about 30 s
tests/run-tests.sh --lanes 8       # a smaller synthetic fleet (the generator never
                                   # emits fewer than 16 lanes)
tests/run-tests.sh --keep          # keep the disposable tree for inspection
```

### The suite runs against a disposable tree

An earlier tranche of this repository ran two capture tests in the **live** mode by
accident: they created a real cache database under `~/.local/state/behold` and read the
machine's derived stores. The suite now runs against a **disposable tree** with a
fail-closed guard, and every path it uses is explicit:

| | |
|---|---|
| the tree | `$HOME` and the XDG directories point into a disposable directory under the run's temporary directory; the fixtures, the fake `herdr` and every cache path live there |
| the guard | in this process **and in every Python child** (through a `sitecustomize` on `PYTHONPATH`), any `open`, `makedirs`, `remove` or `rename` of a path under the **real** home — the repository and the sandbox excepted — raises `IsolationError` |
| the live capture | a spawn of the real `herdr` is refused unless it is the **bundled-schema read** (`herdr api schema`), which prints a file the binary ships with; the fake `herdr` lives in the sandbox and is the only other one allowed |
| the live roster | a `roster` invocation without `--root`/`--snapshot`, or without an explicit `--cache` decision, is refused before it runs |
| the proof | `tests/test_isolation.py` **plants negative tests**: each of those refusals is attempted and asserted to fail |

**What the guard does not cover, named rather than hidden.** The independent review of
`2b0675d` found the gaps: a **node** child is not confined by a Python guard; a
**SQLite** database is opened inside the `sqlite3` module, in C; `os.replace` and
`os.link`/`os.symlink`/`shutil`/`os.system` are not wrapped; the **destination** of a
rename is never checked; a **shell** can run the real `herdr` because the spawn rule keys
on the executable's basename; and a child spawned with a replaced environment loses the
guard silently. None of those paths is exercised by this suite today, and the suite's
commands and paths are checked — but the limit is real, and it is the reason the suite
keeps to ordinary temporary paths and a fake capture rather than growing a containment
tier.

The only real-machine reads the suite still makes are **static reads of installed
programs**: the herdr binary's bundled schema, and the installed pi package's own source
(the extension's API compatibility is checked against it). Both are read-only, and both
are refused if anything tries to write them.

Suites and their sizes:

| Suite | Tests | Covers |
|---|---|---|
| `test_acceptance` | 51 | fields, identity, active branch, honesty, privacy |
| `test_v3_residuals` | 28 | the independent review's remaining expectations, including the global-handle probe |
| `test_units` | 25 | leaf semantics, damaged JSONL, rotation, mode digest |
| `test_guard` | 28 | read-only / network / deny / no-service scans, the spawn permit, the cache write scope, fixture-tree immutability |
| `test_si_regressions` | 22 | the defects the fleet lead found, and the watch that re-stamped the admission map |
| `test_isolation` | 20 | the fail-closed guard: real-home paths, the live capture, the live roster run, the child's own refusals |
| `test_cache` | 50 | cache schema, the ownership rule, migration, retention, freshness, identity, privacy |
| `test_capture` | 42 | the direct herdr capture: argv, timeouts, typed errors, sanitized stderr, the CLI paths, the schema fixture |
| `test_extension` | 44 | the pi extension's static contract, its behaviour under node, the admission map's fail-closed cases, the per-write spool names, the lifecycle timer, the growth bound |
| `test_spool_concurrency` | 19 | the spool's concurrency contract: both arrival orders, the late writer, the crash points, the replay, the cleanup and its races, the growth bound |
| `test_reporter_join` | 17 | the cache-to-roster join: distinct values, freshness, identity mismatch, and the held/reserved exclusions |
| `test_reporter_lifecycle` | 3 | the reporter's lifecycle end to end: timer → spool → SQLite → `P-11`, with a changed state, consistent timestamps, stale and clock-disputed |
| `test_topology_privacy` | 6 | what the shared cache may hold about the topology: planted held and reserved metadata, the reserved-tab attribution, the unidentifiable and malformed records, the malformed and missing topologies, and the admitted control |
| `test_admission` | 33 | the admission map's validator: complete deny lists, complete pane mappings, finite non-future capture times, safe handles, the hard-coded holds, and the published placement |
| `test_schema_conformance` | 11 | the capture against the installed herdr schema, and the fixture against both |
| `test_render` | 17 | JSON and Markdown, filter and sort, no progress claims |
| `test_watch` | 8 | bounded invalidation, rotation, process exit, events-only semantics |
| `test_incarnation` | 6 | the disposable pi session fixture, the process race on one inbox, the late reporter end to end |
| `test_bench` | 6 | measured p50/p95 against the budget targets |
| **Total** | **436** | |

Four rules the suite keeps:

* **No test ever reaches the live fleet.** The capture tests inject a runner or put a
  fake `herdr` on `PATH` inside the sandbox, and the fake records the argv it was called
  with, so the exact argv is asserted rather than assumed. The real binary is consulted
  only for `herdr api schema --json`, which prints the **bundled schema** and no live
  state — and inside the namespace even a live capture cannot reach the daemon.
* **No test reads the live fleet's stores.** The CLI tests run against the fixture tree;
  the live store paths are not mounted, and the guard would refuse them if a test tried.
* **No test writes a real cache.** Every cache path in the suite is inside the sandbox,
  and the kernel refuses a write outside it.
* **No test touches the operator's machine.** That one is enforced by the kernel now,
  not by the suite's own promises: the planted negatives prove it from the inside.

The bench suite prints real numbers. Measured here on a synthetic 61-lane fixture fleet:

| Measurement | p50 | p95 | Target |
|---|---|---|---|
| snapshot load | 0.16 ms | 0.18 ms | ≤ 40 ms |
| single lane | 1.97 ms | 2.29 ms | ≤ 80 ms |
| multi-MB session parse (4.43 MB) | 29.88 ms | 34.85 ms | ≤ 120 ms |
| warm roster, 61 lanes (no child) | 108.28 ms | 121.04 ms | ≤ 250 ms |
| full roster (no child) | 113.64 ms | 117.72 ms | ≤ 1500 ms |

These are synthetic-fixture numbers. They are **not** a measured whole-fleet proof, and
the document says the same thing in `budget_targets.note`.

---

## Layout

```
bin/behold                  entry point (stdlib only)
behold/cli.py               argument parsing, the run, exit codes
behold/cache.py             the SQLite cache: schema, atomic upserts, freshness, ingest
behold/field.py             the Field type: state / class / source / method / age / reason
behold/guard.py             pre-read deny policy + the audit-hook read-only and network guard
                            + the one-shot spawn permit + the cache write scope
behold/identity.py          pin + pane-matched lane record + the /proc cross-check
behold/session.py           JSONL tree, active-branch chain, derived aggregates
behold/procfs.py            pid triple, allowlisted environment read
behold/lane.py              one lane record: every operator field id
behold/render.py            JSON and Markdown, filter and sort, budget targets
behold/watch.py             bounded re-derive on input change (no daemon)
behold/util.py              time, JSONL and path helpers
behold/sources/__init__.py  the Paths object and the source-error type
behold/sources/herdr.py     the snapshot adapter
behold/sources/herdr_capture.py  the direct `herdr api snapshot` capture + normalizer
behold/sources/pi_state.py  profile, mode, settings, model catalogue, todo mirror
behold/sources/fleet_state.py rooms, crons, dagr, beads, background-job logs
behold/sources/repo.py      repository detection by stat (no child process)
fixtures/make_fixtures.py   the synthetic fleet generator
fixtures/herdr_session_snapshot.json  a representative herdr SessionSnapshot, built to
                            the installed herdr's own API schema
pi-extension/behold-state.ts  the pi extension that reports runtime state to the spool
pi-extension/README.md         the extension's contract and its propagation status
tests/                      the eighteen suites above
tests/isolation.py          the Python fail-closed guard
tests/run-tests.sh          the runner: the disposable tree, the fake capture
FIELD-LEDGER.md             per-field source, state and remaining gate
```

---

## Status

**V4.** This is the FT-21 P1+P2 foundation: a single-process, no-daemon, no-database CLI
that derives a fleet roster from stores that already exist, on demand, with every value
carrying its class, source, observation time and reason.

**V5.** This is the cache-and-capture tranche. It adds three things to the V4 foundation
and changes the CLI's default:

* **A cache.** `behold/cache.py` is a Behold-owned SQLite database (default
  `~/.local/state/behold/behold.db`, overridable with `BEHOLD_CACHE_DB` or `--cache-db`)
  holding sanitized runtime state and the sanitized topology, with an explicit schema
  version, WAL, `busy_timeout`, `synchronous=NORMAL`, atomic upserts and a freshness
  vocabulary. It is derived state, and it is the only file behold writes.
* **A direct capture.** A bare `behold roster` now captures the topology with
  `herdr api snapshot` — one exact argv, no shell, a bounded timeout, sanitized stderr —
  behind a one-shot spawn permit in the read-only guard. `--snapshot FILE` and
  `--root DIR` remain deterministic offline overrides, and an offline run does not touch
  the cache unless `--cache on` says so.
* **A pi extension.** `pi-extension/behold-state.ts` reports the runtime facts a session
  knows and the disk does not, into a spool the cache ingests. It needs **no setup**: it
  resolves the same state directory the reader uses (and follows `BEHOLD_CACHE_DB`).
  **It is not installed** and not propagated.

**V11.** The reporter's lifecycle correction, on top of the concurrency tranche:

* **The reporter has a lifecycle.** It publishes on a pi event *and* on a bounded timer
  (60 s by default), so an idle lane reports and a renewed admission map is picked up
  without waiting for an event. The timer **samples the session again** — pi resolves the
  context's values at call time — and stamps the record with the sampling instant, so the
  ISO string and the epoch can never disagree.
* **The sequence belongs to the lane.** It is seeded per (lane, incarnation), not per
  tab, so a pane that moved and a module reload continue it instead of restarting at 1.

**V10.** The concurrency correction, on top of the cache-and-capture tranche:

* **The spool is race-free.** Every observation has its own file, and the file's name
  carries the incarnation and the sequence number, so a name is never reused: two
  reporters for one pane cannot race for one file, and the reader — not the writer —
  decides the owner (the newest incarnation owns the pane; the highest sequence number
  wins within one incarnation; an order that cannot be established is refused). The
  reader removes only strictly superseded records, never the current observation, and the
  spool's growth is bounded by refusal.
* **The observer is functional by default.** The reporter writes against the admission
  map's placement, and the map's reserved tab, reserved pane and held workspace are still
  refused. The placement is the topology *as of the last capture*: a pane that moves into
  a reserved tab after the capture is a **bounded staleness**, not a guarantee, and the
  reader refuses such a record **before** it opens the file on every run.
* **A join.** `P-11` brings the reporter's observation into the roster, joined on
  `(pane id, session id)`, with a freshness verdict, an identity-mismatch state that
  returns no value, and an explicit list of the fields the reporter cannot see. The
  held and reserved lanes are excluded before the cache is consulted, and the deny policy
  is published for the reporter so it does not even write for them.

The V4 change repaired the one binding residual the V3 review reopened: the global `M-4`
reader now derives its handles from admitted and verified lanes instead of listing the
instances root, so a held or foreign instance's `pi-profile-state.json` is never opened. A
full-roster negative test plants such files and asserts the attempted-open list is empty,
with a trusted positive control, so "nothing opened" cannot mean "the reader never ran".

V3 removed capability rather than disclosing it: there is **no general external
execution**, repo-derived fields are typed `unknown(repo-adapter-not-isolated)`, held
workspace and reserved tab and pane are denied before any read, an ownership
disagreement blocks every preload and join, the active branch is labelled
`DISK_RECONSTRUCTED` rather than "current", and a composed mode definition is
`unverifiable` instead of false drift.

**Not installed, not published, not propagated, not bootstrapped, no live read.** The
`--live` path and the live capture have not been exercised against a real fleet, the pi
extension is not installed anywhere, and the remaining gates are listed in
`FIELD-LEDGER.md`: the live capture's document shape, the live-fleet read, the live beads
join, footer equivalence for the derived token fields, the per-lane consumption of the
cache, the P3 runtime assist for the six runtime-only items, the publication of a
packaged install artifact and the fleet skill propagation.
