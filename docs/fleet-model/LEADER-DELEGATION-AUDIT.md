# Leader delegation default — bounded audit

**Audit date:** Tue 2026-11-10, `date -u` = **10:53:52 UTC**.
**Requester:** overlord DM `12e3b602` (operator's renewed delegation directive, 2026-11-07 original).
**Owner:** self-improvement-leader. Performed by lane `ft-todos-triage`.
**Status:** read-only. Nothing was edited, reloaded, re-approved, restarted, spawned or messaged.
The single transient write was `/tmp/err.$$`, a scratch stderr capture, removed in the same
command — no config, mode or instance file was touched.

---

## 1. The contract as it stands

`~/.pi/agent/modes/leader.json` — `promptStrategy: replace_base`, `schemaVersion: 2`,
`systemPrompt` 9,014 chars, file 9,426 bytes, md5 `0b1f12f5b5f8`.

The delegation default occupies byte offsets **1586–2163** of `systemPrompt`:

> ## Default to spawning a worker
>
> Before you touch a piece of the space's work, ask whether a worker should do it. A task is
> delegatable when it is a bounded, verifiable deliverable and the leader's own access is not
> required to complete it. If those hold, spawn a worker. The only kind of brief to explain "how"
> is one that has already done the work twice.
>
> The tell that you are about to do it yourself: you are reaching for a command, a file open, or a
> research pass for a piece of the space's work that is not your own brief. Stop there. That is the
> moment to hand it off.

**The directive and the contract already contradict each other, and that is the defect to fix.**
`## Do not`, first bullet, requires: *"Verify from the artifact — a file, a commit, a test count, a
live read. A lane's report is reported, not verified, until you have checked it yourself."* The
third bullet then forbids the exact act verification requires: *"if you catch yourself typing a
command for a piece of the space's work, stop — that is the moment to hand it off."* A leader that
obeys the second cannot perform the first.

So the required change is **not a relaxation of the default**. It is the missing sentence that says
which leader-owned acts are not delegatable, so the two bullets stop contradicting. Framing it as a
relaxation is what would damage the contract; framed as reconciliation, the addition is small and
closed.

---

## 2. Question 1 — the exact addition

**Placement:** append to the end of `## Default to spawning a worker`, after the "The tell that you
are about to do it yourself…" paragraph and before `## Spawn through herdr only`. Placing it *inside*
the default — rather than as a new section or an amendment to `## Do not` — is what keeps it read as
the boundary of the default instead of a competing rule.

**Proposed text, verbatim, to be inserted as two further paragraphs of that section:**

```
Three things are yours, and none of them is a brief: a decision only you can make — the space's
remit, a trade-off between two of its own implementations, what to keep, consolidate or retire;
verification of a delegate's artifact against a file, a commit, a test count or a live read; and a
reversible change to this space's own configuration that costs less to make than to describe. Do
them in the turn, report the evidence, and stop there: the exception covers the check, never the
work the check implies.

Bounded and verifiable still means a worker, and an existing lane whose brief and access already fit
is better than a new one. Do not open a lane whose only deliverable is a read you are about to make
anyway, and do not manufacture a worker to be seen delegating.
```

**Why this is minimal rather than merely short.** It adds no authority that does not already exist
elsewhere in the contract, and it closes three specific gaps, one per clause:

| Clause | Closes | Existing text it defers to |
|---|---|---|
| "a decision only you can make" | the `## When you already know the resolution, act` section, which currently has nothing to say about delegation | that section's list of what is genuinely blocked |
| "verification of a delegate's artifact" | the bullet-1 / bullet-3 contradiction above | `## Do not` bullet 1, unchanged |
| "a reversible change to this space's own configuration that costs less to make than to describe" | small config work with no meaningful brief | "The only kind of brief to explain *how* is one that has already done the work twice" |

**What it deliberately does not do.** It does not touch "Never write this space's code or run its
infrastructure by hand" — only configuration, only reversible, only this space. It does not create a
project-code exception. It does not lower the bar for what counts as delegatable; the second
paragraph restates that bar rather than softening it. And the clause "the exception covers the check,
never the work the check implies" is the load-bearing one: without it, "verify the artifact" expands
into "do the work in order to have something to verify", which is the failure mode the whole section
exists to prevent.

**One forward constraint, so a later edit does not collide.** FT-07 in `Fleet TODOS.md` asks for a
self-improvement-leader review gate on fleet-affecting changes; that gate creates *required*
leader-owned review work. FT-07 is currently absent from the global contract (0 occurrences of
"review" and of "self-improvement-leader" in this file). If both land, FT-07 should be written to
name itself as one of the leader-owned exceptions, or the two will read as contradictory in exactly
the way this audit is fixing.

---

## 3. Question 2 — live fingerprints

**Method.** `pi-modes state <session.jsonl> --json` per lane — the package's own read-only reader,
which "never writes to a session and never attaches to one"
(`pi-modes/docs/project/2026-11-07-out-of-band-mode-reapproval.md:85`). Verdicts read from
`verdict` / `keys[].verdict`, not from the `recorded` boolean
(that field is a boolean, `:100-104`; the first external consumer to misread it concluded every lane
needed work). No session text was grepped for a prompt marker.

**Scope:** all **22** leader-like lanes in `herdr agent list` (20 × `*-leader`, plus `overlord`) out
of 33 total agents; 26 live workspaces.

**Result: no pre-existing drift anywhere that could be read.**

| Verdict | Lanes |
|---|---|
| `match` | **20** |
| unreadable — `session file not found`, exit 2 | **2** |

The two unreadable lanes are **`comms-leader` (`w1T:p1`) and `subtoken-leader` (`w9:p1Q`)**. This is
not drift and not a mode problem: the session path `herdr agent list` reports for those panes does
not exist on disk, while the directory it would live in does (newest file in
`--home-bitnom-Documents-Comms--` is `2026-11-02T06-00-03-075Z…`, against the pane's claimed
`2026-11-09T02-34-48-506Z…`; likewise `sub2api`'s newest is `2026-11-04T04-06-40-059Z…` against
`2026-11-09T07-12-51-410Z…`). A stale pane→session pin, **not verified either way** — exactly the
`unknown` the CLI's exit 4 exists to keep distinct, and not a fault signal for this audit.

**Two recorded-path shapes, both currently coherent:**

- **Project-delta lanes** (`recordedScope: project`) record at `<space>/.pi/modes/leader.json`:
  Fleet, Assistant, overlord, yellowstone, sibyl-work, billion-context-bleeding, lfm3. Their digest
  is the **composed** result (global text + project `append`), so a global edit drifts them too.
- **Instance-copy lanes** record at `~/.pi-profile-switch/instances/launch-XXXX/modes/leader.json`.
  `path` is part of the fingerprint, so the same text at an instance path hashes differently from the
  real agent dir — the trap `reconcile-mode.py` documents with its own measurement (`3fef5517` vs
  `7fd1f88c`).

**Materialisation is clean and uniform:** **32 of 32** instance `modes/leader.json` copies are
byte-identical to the canonical file (md5 `0b1f12f5b5f8`, 9,426 bytes, `same=32 diff=0`). Nothing
needs repair before the edit; everything needs re-materialising after it.

All seven project deltas are `promptStrategy: append` — Fleet 12,246 chars, Assistant 11,413,
overlord 22,250, yellowstone 2,623, Comms 1,548, sysops 2,285, Personal 2,111.

**Genuine mismatches found: none in mode state.** One out-of-scope observation, named so it is not
mistaken for mode state: `herdr workspace list` returns **two** workspaces labelled `sibyl`.

### 3a. A blocker in the sanctioned tooling — report it before scheduling a rollout

**The read-only observability path does not run as shipped on this machine.** Both
`~/.overlord/tools/mode-composed-digest.mjs` and `~/.overlord/tools/reconcile-mode.py` resolve the
package to `/home/bitnom/Code/yellowstone/src/pi-extensions/pi-modes`, which has **no
`node_modules`**, and `node --experimental-strip-types …/scripts/mode-cli.ts` fails there with
`ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-coding-agent'` (imported from
`src/prompt-composition.ts`). `bin/pi-modes.mjs` fails earlier still, on `jiti`.

Both tools also carry a **stale fallback** to
`src/pi-extensions/tryinget/packages/pi-modes`, which **does not exist** — a FT-01 migration
leftover. They only work today because the first candidate (`settings.json`'s absolute
`/pi-modes` source) happens to resolve to the same dependency-less checkout; if the package list
changes shape, they fail with "pi-modes package not found" instead.

The audit worked around this **without writing anything**, by running the CLI from the pi package
directory with jiti's runtime alias:

```bash
PI=$HOME/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent
PI_MODES_CLI_SECRET_FILE=$HOME/.overlord/pi-modes-cli.secret \
  node --input-type=module -e '
    const {createJiti} = await import("jiti");
    const j = createJiti(process.cwd()+"/", {alias:{"@earendil-works/pi-coding-agent":process.cwd()+"/dist/index.js"}});
    process.argv=[process.argv[0],"mode-cli","state",process.argv[1],"--json"];
    await j.import("/home/bitnom/Code/yellowstone/src/pi-extensions/pi-modes/scripts/mode-cli.ts");
  ' "$SESSION"
```

**Consequence for Question 3:** `reconcile-mode.py --dry-run` and every `--only` invocation will fail
until this is fixed (a `node_modules` for the package, or an `alias`/`PI_MODES_PKG` that resolves the
SDK). Fix that *first*; it is a prerequisite of the rollout, not a nice-to-have.

---

## 4. Question 3 — propagation plan (not executed)

The edit is a **global base** change: it alters the digest of every composed leader selection. Expect
**all 22** leader-like lanes to drift the moment the file is written, including the seven project-delta
lanes, whose recorded digest covers the composed result.

1. **Write only the canonical file** `~/.pi/agent/modes/leader.json`. No instance file is ever edited
   by hand; `pi-modes` fails closed on a symlinked mode root and `pi-profile` copies rather than
   symlinks (`reconcile-mode.py` docstring).
2. **Fix the tooling blocker** in §3a, or the rest of this plan cannot run.
3. **Prove on one lane, idle, that is not carrying work.** Prefer a lane whose space is quiet in the
   beads board. Then: `/profile reload` (re-materialises the instance copy — `/reload` does **not**),
   `/mode-reapprove --expect <digest>` where `<digest>` comes from `pi-modes expected <session>` for
   **the path that lane reads**, and verify with `pi-modes state <session> --json` →
   `verdict: match` plus a footer reading `mode:leader` with no diagnostic marker. Two counts, base
   and overlay, via `~/.overlord/tools/verify-mode-composition.sh <pane> <base-marker> <overlay-marker>`.
4. **Roll out idle lanes** with `~/.overlord/tools/reconcile-mode.py --only <pane>` (reload + pinned
   `--expect` + attestation in one motion) or `propagate-mode-change.py` for the inventory pass.
   `PI_MODES_CLI_SECRET_FILE` as needed.
5. **Queue working lanes — never prompt them.** No Esc, no `--interrupt-working`. Use
   `defer-mode-reapprove.py` (it waits for the lane's own stop boundary and records a durable result)
   or let the lane re-approve at its next natural idle. `reload-fleet` skips working lanes by default;
   keep it that way.
6. **Judge by artefact, not by the pane.** Which lanes are done is `pi-modes state` reading `match`
   for every lane, not a status field. Record the count before and after, as §31 of
   `EXECUTION-RECORD.md` does.

**Ordering constraint:** because the edit is a base change, any lane left unreconciled composes
`native` under the default `block` policy and silently loses its whole role contract. The queue is
therefore a correctness debt with a visible cost per lane, not a cosmetic lag — reconcile the
*working* lanes at their boundaries rather than deferring them indefinitely.

---

## 5. Question 4 — what is feasible to delegate right now

**Roster** (`herdr agent list`, 22 leader-like lanes of 33 agents; `beads-board.py` read-only,
26 labelled spaces / 316 beads; `--ready` queue):

| Class | Finding |
|---|---|
| **Active execution** | `self-improvement-leader` (`w1K:p1`) — working, 1 bead `wip` in epic `swarm-c0l`. The only leader with work in flight at audit time. |
| **Status moved while observing** | `overlord` (`wE:p1`) read `working` then `done` between two calls minutes apart. The brief's rule holds literally: a `working` field is not progress, and a `done` field is not completion. |
| **Idle with a live lane and ready work** | 19 leaders. Ready queue carries concrete P0/P1 items for several: `gemini-accts-leader` (`w2`) holds `swarm-2cy.1` **P0** and `swarm-2cy.2` P1; `synomone-leader` (`w1E`) holds `swarm-3fc.10` and `.14` P1; `dxdb-leader` (`w1C`) `swarm-bd0.2` P1; `vpn2proxy-leader` (`wB`) `swarm-14q.2` P1; `sibyl-leader` (`w7`) `swarm-c0z.2` P1. These are delegatable — bounded and verifiable — the moment the leader briefs them. |
| **No bounded work possible — no lane exists** | **6 spaces hold beads with no live herdr workspace at all**: `w1J` 8 open, `w21` 9 open, `w11` 4 open, `w1P` 5 open (and no epic), `w0` 1 open + 2 blocked, `w27` 0 open. **27 of 120 open beads (22.5%) sit behind a space that has no lane.** They are not idle and not blocked-on-operator; they are unstaffed. |
| **Unknown — cannot be read** | `comms-leader` (`w1T`), `subtoken-leader` (`w9`): pane→session pin names a session file that does not exist (§3). Excluded from any progress claim in either direction. |
| **Needs the operator** | `overlord`'s `swarm-7p5.2` P2 ("decide the 9 leaderless context dirs") is a decision, not a deliverable — not delegatable by a worker. |

**The highest-impact single finding for delegation feasibility:** the ready queue's second-highest item,
**`swarm-i9f.1` P0 "Operator retest: a local spoken reply must play to the end on Linux"**, is assigned
to `herdr-voice-leader` — **`w1J`, a workspace that no longer exists and a lane absent from the agent
roster**. A P0 sits in a space that cannot act on it. `swarm-i9f` also holds 8 open beads. That is a
roster/reassignment question for overlord, not a delegation question, and I have not touched it.

**Board hygiene, named but not actioned:** `beads-board.py` reports `self-improvement: beads but no
epic` and `w1P: beads but no epic`, and four closed beads with no `project:<space>` label
(`swarm-5mr`, `swarm-brl`, `swarm-3m6`, `swarm-nwv`). The `self-improvement` row (2 beads, both closed)
is a labelling subset distinct from `w1K` (13 beads, epic `swarm-c0l`) — label/space drift, worth a
separate look rather than a conclusion here.

**This is a feasibility report.** No task was handed out, no lane was spawned, no hold or objective was
altered, and no epic other than this lane's own was claimed.

---

## 6. Limits

- **Read-only by construction, not by promise.** The only writes this lane performed were
  `FLEET-TODOS-TRIAGE.md` (previous task), this file, and a `/tmp` stderr scratch file removed in the
  same command.
- **Two of 22 lanes are `unknown`, not healthy.** No statement in §3 covers them.
- **`state` proves the record matches the file at the recorded path.** It does not prove the lane
  *loaded* that text into a live prompt; that needs a turn, a footer read, or a scrollback check with
  the lane's own consent — which is where FT-31's lesson applies: compare `[Context]`, not `[Prompts]`.
- **Feasibility is from beads + roster + workspace list only.** I did not open individual lanes'
  transcripts to judge whether a leader is thinking about something not yet in beads; the `unknown`
  column is real, not a placeholder.
- **`beads-board.py` aggregates labels, not liveness.** A `project:<space>` label can outlive its
  workspace — which is precisely the 27-bead finding in §5, and also why that finding needed the
  independent `herdr workspace list` check to be trustworthy.
