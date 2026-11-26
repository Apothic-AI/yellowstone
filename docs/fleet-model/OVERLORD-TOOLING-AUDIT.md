# Overlord tooling audit — one pass over `~/.overlord/tools/`

Scope: every file in `~/.overlord/tools/` and its mirror at
`~/Code/yellowstone/home/.overlord/tools/`. Method: inventory each file (language, size, whether it
carries any help surface, its one-line purpose), read the ones involved in the 2026-11-14
profile-extension relaunch tranche, and compare the two trees.

Inventory: **58 files** — 53 tools, 2 unit tests (`test_broadcast_to_fleet.py`,
`test_mode_propagation_safety.py`), 2 PATH shims (`pane-signal`, `proc-find`), 1 data file
(`rooms-names.json`, which is state and correctly absent from the mirror). Live and mirror were
identical apart from that data file.

**33 of the 58 carried no help surface at all** (no `--help`, no `usage:`, no argparse). Two are
fixed below; the remainder is **26 operator-facing tools** once you set aside the data file, the two
tests and the two shims — already-shimmed targets (`proc-find.py`, `pane-signal.sh`) do have help.

## Finding 1 — the tranche re-implemented a tool that already existed, and the tool's own gate is why

The five-lane brief's method section spelled out: read `herdr agent get`, capture session and env,
double ctrl+c, `herdr pane run <pane> "env PI_MODE=… pil --session …"`, then check the footer. That
is `relaunch-lane.sh`, step for step — and that script's own header already said the explicit env was
unnecessary because pil restores the role itself.

The reason it was bypassed is one line at the end:

```sh
case "$footer" in
  *"profile: leader"*) echo "OK: $lane relaunched on profile fleet" ;;
  *) echo "WARN: $lane relaunched but profile is not fleet"; exit 1 ;;
esac
```

A gate that only accepts **leader** writes a WARN and exit 1 on every **worker** lane. The tranche
included `pi-auto-translate-dev` (worker), so the tool could not be used for the job it was built
for, and the alternative was bespoke shell. **Fixed:** the expected profile now comes from
`--expect-profile`, else the lane's own `~/.local/state/pil/roles/<lane>.env`, else the footer it
had before we stopped it, else any token. Added `--verify-only` (audit a lane without touching it),
`--json`, and `--help`.

Verified read-only against three lanes: `sysops-leader` PASS, `ft55-parameter-plan` PASS (worker —
the case the old gate refused), and `comms-leader` FAIL on the two gates that are genuinely open for
it (no `profile:` token, recorded session file absent), which matches the known state recorded in
EXECUTION-RECORD.

## Finding 2 — the inline `env PI_…` prefix is almost entirely redundant

Every launch and relaunch in this fleet writes:

```sh
env PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 PI_ROOMS_NAME=<lane> pil …
```

All four variables are already recoverable:

| variable | where it actually comes from |
|---|---|
| `PI_MODE`, `PI_PROFILE`, `PI_MODE_CONFIRM_PROJECT` | `~/.local/state/pil/roles/<lane>.env` (208 role files), restored by pil's `restore_role` |
| `PI_ROOMS_NAME` | derived by pil from the pane's **tab label** |

So the prefix is not configuration, it is a chance to get the role wrong. It has already gone wrong:
on 2026-11-13 a repair script sourced a space's `.pi/launch.env` and promoted a worker lane
(`ft55-parameter-plan`) to leader, because a space's launch.env describes its leader, not whatever
lane you are relaunching.

**Done:** `pil --role leader|worker` sets `PI_MODE`/`PI_PROFILE`/`PI_MODE_CONFIRM_PROJECT` from one
word and records them through the existing `record_role` path, so a launch is `pil --role worker`
with no env at all. An explicit role beats a recorded one and is then persisted — which is also the
supported way to fix a lane whose role record is wrong.

Proven hermetically, with no lane launched and no real state touched: a stub `pi`/`pi-profile` on
`PATH` dumping the five contract variables, `XDG_STATE_HOME` pointed at a temp dir, `PI_LANE_NAME`
to bypass tab-label derivation. Four cases — `--role worker` with no record, bare `pil` restoring
that record, `--role leader` overriding a worker record (the ft55 repair case), and the
`--role=worker` form — all correct in both the launched env and the written record. `pil --selftest`
passes all seven role tests.

`--role` is position-independent: pil strips it wherever it appears among its own arguments, so
`pil --session X --role worker`, `pil --role worker --session X` and a mixed
`pil --session X --role leader --session-dir /tmp/sd -p hello` all resolve to the same role. Measured,
not inferred — an earlier version of this file claimed "first argument only", and a DM repeated it;
the parse loop scans every argument. The one consequence is that a pi argument literally named
`--role` cannot be forwarded through pil. An unknown role refuses with exit 2 from any position.
Launch.env files can now drop their three lines; that migration is not done.

## Finding 3 — the missing reader, now added: `lane`

The most repeated idiom in the fleet is field extraction by inline python:

```sh
herdr agent get <lane> | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["agent"]["agent_status"])'
herdr pane read <pane> --source recent-unwrapped --lines 40 | grep -E 'mode:' | tail -1
herdr pane process-info --pane <pane> | python3 -c '...foreground_processes...'
tr '\0' '\n' < /proc/<pid>/environ | grep '^PI_'
```

The tranche used the first form six times, the second twice, and a 60-iteration `sleep 1` poll loop
three times. **New: `lane`** (`~/.overlord/tools/lane`, symlinked into `~/.local/bin`):

| subcommand | replaces |
|---|---|
| `lane status <lane>` | the `agent get \| python3 -c` status idiom |
| `lane footer <lane>` | the `pane read \| grep \| tail -1` idiom, parsed and with UNKNOWN |
| `lane argv <lane>` | the process-info argv chain (inspection only, labelled as non-gate) |
| `lane env <lane> [--keys …]` | `/proc/<pid>/environ` parsing, contract vars by default |
| `lane session <lane>` | session path, existence, pil-pin agreement |
| `lane check <lane>` | all five standard gates as a pass/fail table |
| `lane wait <lane> --status idle` | hand-rolled poll loops |

`--json` and `-f FIELD` on every subcommand, `--help` on the program and each subcommand.

## Finding 4 — the two invalid gates came from inline scripting, and now have safe primitives

* **Scrollback footer read.** Reading the footer with `tail -c 3000` matched a stale frame and made a
  healthy lane look drift-degraded (`wE:p1`). `lane footer` reads `--source recent-unwrapped` full
  lines only, takes the **last** line carrying a status segment, and reports `UNKNOWN` when it finds
  none — absence is never reported as clean.
* **argv as a profile gate.** The tranche's required gate was "node argv contains `-e` and a path
  ending `pi-profile/index.ts`". That shape is identical before and after a repair, because the
  extension arrives via the launcher's parent process; the gate would have failed correctly repaired
  lanes. `lane argv` prints the argv and states on its own line that it is **not** a validity gate;
  `lane check` does not include it.

## Finding 5 — `--help` coverage

Fixed in this pass: `reload-fleet` and `restart-fleet`. Both now print their own contract (what they
do, what they explicitly cannot do, the failure modes behind each rule) and then delegate to the
Python implementation for the full flag list.

**Now swept:** 29 shell tools and 5 Python ones gained a `-h|--help` handler that prints their own
header block, so the documentation that already existed in those files stopped being invisible. The
Python pass also fixed a real defect: `verify-space-split.py --help` used to **run the audit** and
report FAIL, because it never looked for the flag.

Every operator-facing tool now answers `--help`. What still does not: the two unit tests, the two
PATH shims (`pane-signal`, `proc-find`, which exec targets that do), and `rooms-names.json`, which
is data.

## Finding 6 — ten entry points for "replace a process", none distinguishable by name

`relaunch-lane.sh`, `relaunch-lane-monorepo.sh`, `migrate-lane.sh`, `migrate-unnamed-lane.sh`,
`rollout-profiles.sh`, `rollout-modes.sh`, `seed-role-records.sh`, `self-restart.sh`, `new-self.py`,
`reset-self.sh`, plus `restart-fleet`.

Each carries a distinct guard, but nothing in the name tells an agent which one to use, which is how
a bespoke twelfth variant gets written. **Addressed by documentation rather than deletion:** eight of
them now carry a `Canonical:` line in their header pointing at the tool to reach for first —
`relaunch-lane.sh` (one lane), `restart-fleet` (many), `new-self.py` (this lane) — and saying what
the survivor's own guard is for. `migrate-lane.sh` and `relaunch-lane.sh` differ only by "writes a
continuation first", and the header now says so.

## Finding 7 — small cleanups

* `rooms-names.json` sits in the tool directory but is state, not a tool. **Left in place
  deliberately:** two live consumers read it by that path (`swarm-topology`, `mirror-provenance.sh`),
  so moving it is a code change in both for a cosmetic win. It is the one file `verify-mirror-live.sh`
  treats as live-only by design.
* The four stray `*.bak-*` files (three tools plus a `.mjs`) were moved out of the tool directory to
  `~/.local/state/overlord-tool-backups/`. They had already polluted one mechanical sweep in this
  pass by matching a shell glob.
* `test_broadcast_to_fleet.py` and `test_mode_propagation_safety.py` live among the tools; they belong
  in a `tests/` subdirectory.
* `relaunch-lane.sh` used `herdr agent read | grep -aoE 'rooms: … profile: …' | tail -1`, which can
  stitch tokens from two different lines. The rewrite takes the last full line and extracts from it.

## What this pass changed

| file | change |
|---|---|
| `tools/lane` | **new** — status/footer/argv/env/session/check/wait, `--json`, `-f`, `--help` |
| `tools/relaunch-lane.sh` | profile gate reads the lane's real expectation; `--verify-only`, `--expect-profile`, `--json`, `--help`; full-line footer parse |
| `tools/reload-fleet` | `--help` documenting reload vs restart |
| `tools/restart-fleet` | `--help` documenting the deferred self-restart and the bare-`pil` relaunch |
| `~/.local/bin/{lane,relaunch-lane.sh,restart-fleet,spawn-lane}` | symlinks, matching the existing `reload-fleet` convention |
| `bin/pil` | **new flag** `--role leader|worker` — one word instead of a four-variable env prefix |
| `tools/spawn-lane` | **new** — tab create + `pil --role` + wait-for-idle + first prompt, with guards |
| 29 shell + 5 Python tools | `-h|--help` printing their own header block |
| 8 duplicate relaunch tools | `Canonical:` header line naming the one to reach for |

Published: yellowstone `e22f9fd12` on `ft-01/herdr`, both pre-push gates green
(`verify-revert-detection`, `verify-mirror-live`: 66 identical, 0 differing, 0 live-only).

All four files are mirrored byte-identically into `~/Code/yellowstone/home/.overlord/tools/`.
