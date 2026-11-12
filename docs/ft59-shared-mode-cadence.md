# FT59 — the shared communication cadence: candidate and adoption

**What this is.** The fleet's pi-rooms communication cadence lived only in the Fleet
workspace's project overlay, so a lane in any other space never saw it. This change puts it
in the **shared** role contracts — `home/.pi/agent/modes/leader.json` and
`home/.pi/agent/modes/worker.json` — which every space composes onto.

**Status.** Candidate. The canonical copies are in this tree; the live files
(`~/.pi/agent/modes/`) are untouched until the adoption below is run and reviewed.

## The candidate, in one diff

Both files are the live files with one addition. Nothing else moved — the same keys, the
same `promptStrategy` (`replace_base`), the same contract text.

`home/.pi/agent/modes/leader.json` — appended to `systemPrompt`:

```md

## Communication cadence

Use pi-rooms for coordination, not narration. Do not send incremental progress updates merely to report
that work is continuing. Send a room post or DM when you are blocked and need another agent or the operator,
when another agent is blocked or waiting for your response, or at a real inflection point such as a completed
deliverable, a material scope/status change, a handoff, an authorization boundary, or a final/milestone report.
Preserve communication needed for coordination, handoffs, genuine blockers, authorization, and final or
milestone reporting. A quiet lane is preferred to a stream of granular progress messages.
```

`home/.pi/agent/modes/worker.json` — appended to `systemPrompt`:

```
Use pi-rooms for coordination, not narration. Do not send incremental progress updates merely to report that work is continuing. Send a room post or DM when you are blocked and need another agent or the operator, when another agent is blocked or waiting for your response, or at a real inflection point such as a completed deliverable, a material scope/status change, a handoff, an authorization boundary, or a final/milestone report. Preserve communication needed for coordination, handoffs, genuine blockers, authorization, and final or milestone reporting. A quiet lane is preferred to a stream of granular progress messages.
```

The wording is **the fleet's own**: it is byte-for-byte the section the Fleet workspace's
leader overlay already carries and the bullet its worker overlay already carries. One rule,
one wording, now in the place every space reads.

The worker's existing contract still says *"Never create rooms"*. There is no conflict: the
cadence is about **posting** and **DM**-ing, never about creating a room.

## Why the shared contracts, and why a copy in the tree

The shared contracts are what every space composes onto, so a rule for every lane belongs
there — the same ownership rule the Fleet workspace's own overlay states: *both roles need
it → the shared half; one role needs it → that role's file only.*

Until now those two files had **no canonical source**: they existed only as hand-edited
files under `~/.pi/agent/modes/`, with backups beside them. That is drift — the fleet's own
word for a thing the tree does not carry. `home/.pi/agent/` is the tree's mirror of the
agent directory, and the installer copies every file under it ("a new per-feature file needs
no code here — only a path under `home/.pi/agent/`"). Adding the two files gives the shared
contracts a source, and the next edit is a diff in this tree rather than an edit on the
machine.

## The check

`test/verify-shared-mode-cadence.sh`, wired into `test/run.sh` (the gate list is derived
from the directory, so an unwired control fails the run). It holds **both** shared contracts
to the cadence's parts — the channel (`pi-rooms`), the triggers (a blocker, another agent
waiting, a handoff, an authorization boundary, a material scope/status change, a completed
deliverable, a final/milestone report), the prohibition (no incremental narration), the
preservation clause and the preference for a quiet lane. A rule that is half-present is a
rule a lane can obey the wrong side of.

It reads the **canonical copies in this tree**, not the live ones: until the adoption lands,
the live files are the operator's, and a gate that read them would be red for the whole
window between the candidate and the adoption.

## The adoption, on one lane

**The lane: `w17:p1` — `yellowstone-leader`.**

| | |
|---|---|
| idle | yes — `herdr pane list` reports `agent_status: idle` |
| under a hold | no — the holds are the held workspace `w2` and the reserved tab/pane `wE:t19` |
| project-mode composition | yes — its cwd is the yellowstone tree, whose `.pi/modes/leader.json` is a project `append` onto the global `leader` contract |
| disruptive | no — it is not interrupted, not restarted, and its selected session is not replaced |

**The steps, in order.**

1. **Land the candidate** (this commit). The live files are still the operator's.
2. **Copy the two shared files to the live agent dir**, with a backup, and only those two
   files:

   ```bash
   cp ~/.pi/agent/modes/leader.json ~/.pi/agent/modes/leader.json.bak-ft59-$(date -u +%Y%m%dT%H%M%SZ)
   cp ~/.pi/agent/modes/worker.json ~/.pi/agent/modes/worker.json.bak-ft59-$(date -u +%Y%m%dT%H%M%SZ)
   cp <repo>/home/.pi/agent/modes/leader.json ~/.pi/agent/modes/leader.json
   cp <repo>/home/.pi/agent/modes/worker.json ~/.pi/agent/modes/worker.json
   ```

   The backup is the rollback, and it is the same convention the live directory already uses.
3. **Re-approve the one lane**, and let the fleet's own tool do the mutation:

   ```bash
   python3 ~/.overlord/tools/propagate-mode-change.py --only w17:p1 --key leader
   ```

   It hashes the composed definition with pi-modes' own fingerprint function, sends
   `/mode reapprove --expect <that digest>` (the project half needs `--confirm-project`),
   and **reads back the digest the lane recorded**. `reconcile-mode.py` owns the mutation
   because it owns the two consent dialogs.
4. **Verify from the artifact, not the pane.** The evidence is the digest the lane's session
   **recorded** — read from its `pi-mode-state.v3` entry — equal to the composed digest
   computed from the live files. A footer line, a status line or a sent command is not
   evidence; see `docs/INCIDENT-fleet-rollout-verification-2026-11-06.md`, which records the
   two times the fleet believed a rollout it had not achieved.
5. **Then, and only then, the rest of the fleet** — with
   `propagate-mode-change.py --key leader` and `--key worker`, one key at a time, reading the
   per-lane receipts. The dry run is the plan:

   ```bash
   python3 ~/.overlord/tools/propagate-mode-change.py --dry-run --key leader
   python3 ~/.overlord/tools/propagate-mode-change.py --dry-run --key worker
   ```

   Working lanes are skipped by default. Held workspaces are excluded. No broadcast.

6. **De-duplicate the Fleet workspace overlay** — separately, and afterwards. Once the shared
   contract carries the cadence, the copy in the Fleet workspace's overlay is the same rule
   twice, which the Fleet overlay's own rule forbids (*"Never duplicate a rule across the
   halves"*). Removing it touches a live project mode, so it is its own reviewed change: the
   mirror under `home/Documents/Fleet/.pi/modes/` and the live file together, then a
   re-approval of the Fleet lanes. Until then the fleet says the same thing in two places,
   which is redundant but not contradictory.

**What this plan does not do:** no fleet-wide reload, no interrupt of a working lane, no
held workspace, no replaced session, no `/new`, no provider call, and no paid resource. It
does not report a rollout as done on the strength of the commands it sent.

## The rollback

Restore the two backups. The lanes that were re-approved keep the digest they recorded; a
restored definition is a change again, so a lane that must go back to the old text is
re-approved once more — the same one-lane motion, in the other direction.
