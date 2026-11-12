# INCIDENT — a fleet rollout that reported success it had not achieved (2026-11-06)

**Status:** existing incident, recorded here so the next lane inherits the rule rather than the
lesson twice. Nothing in this file is new: it points at the original records, which stay where
they are and are not rewritten.

## The two failures, as they happened

**1. An unsafe broad reload whose verification was unsound.** A fleet-wide `/reload` was
broadcast through `broadcast-to-fleet.py --message /reload --include-self --verify`. The
command text was left **unsent** in a lane's composer when the palette check failed, and the
`--verify` step counted a **transient, scrolling** confirmation. The run reported
`verified 24/26` — and two of those lanes had never been reloaded at all. A count that reads
"24 of 26 confirmed" was, for two lanes, a count of a keystroke.

**2. A false self-success claim about a lane's own state.** `restart-fleet` read a lane's
identity from the pane **footer in scrollback** and matched `mode:… profile:…`. A pane keeps the
previous process's footer in its scroll history, so after a restart that read can describe the
lane that just died. Two fleet passes reported `mode=worker profile=fleet
rooms=yellowstone-worker` for a lane that had in fact come back **unnamed, on the global
profile**, with its role contract gone. The verification said OK. The lane was broken.

The records, in the fleet's own log, are not edited by this note:

* `~/Documents/Fleet/pi-fleet-model/EXECUTION-RECORD.md` §28 — *"A deleted worktree build cost
  two lanes their identity — and my verifier said OK"*, and the rule it ends on: **a footer is
  not evidence after a restart**.
* `~/Documents/Fleet/pi-fleet-model/HANDOFF-fleet-migration.md` — the `broadcast-to-fleet`
  defect, its three fixes, and the generalisable half: *emit on transitions only, and give
  every watcher its own failure line*.
* `~/Documents/Fleet/pi-fleet-model/INCIDENT-slash-command-as-prose-2026-11-07.md` — the
  neighbouring incident: a diagnostic typed into a running lane became a prompt and put the
  lane to work.

## Why this note lives in the repository

The original records live in the Fleet workspace's `pi-fleet-model/`, which is a space's own
directory and is mirrored, not versioned with the code. A rule about **fleet-wide** behaviour
belongs where the fleet's tooling is versioned, so that a clone carries it. This note carries
no new claim; it carries the pointer and the rule.

## The rule, in the fleet's own tools

The tools that exist to avoid a repeat say it in their own words:

* `~/.overlord/tools/propagate-mode-change.py` — *"It never claims delivery from a
  keystroke."* It reports, per lane, the fingerprint path the lane read, the mechanism chosen,
  and whether the lane's mode source now carries the current on-disk text.
* `~/.overlord/tools/propagate-mode-change.py` — the re-approval is **pinned**: the composed
  definition is hashed with the package's own function, `/mode reapprove --expect <digest>`
  is sent, and the digest the lane **recorded** is read back. Equality is the evidence;
  anything else is reported as `attestation_failed` and nothing is claimed.
* `~/.overlord/tools/reconcile-mode.py` owns the mutation, because it owns the two consent
  dialogs — the delegate exists precisely because the sending tool left a lane sitting on a
  modal while reporting drift.

## What a mode change does here, and what it does not do

* **One lane first.** A shared role contract is adopted on a single lane, chosen because it is
  **idle** and **not under an operator hold**. No fleet-wide broadcast, no interrupt of a
  working lane, no touched workspace under a hold, no replaced session.
* **The evidence is the lane's recorded fingerprint**, re-resolved from the live mode files —
  not a scrollback line, not a sent command, not a status line.
* **A scheduling result is not proof.** The reload helper's atomic result under
  `~/.local/state/pil/reload-results/` (`waiting`, `reloading`, `confirmed`, `waking`,
  `woken`, `failed`) says what happened to the helper; the lane's recorded digest says what
  the lane holds. Only the second is adoption evidence.
* **A drift is reported, not repaired by sending.** Under the default `block` policy a changed
  definition makes the next turn drop the space half (or, for a lane with no fallback, fall to
  the native prompt). The repair is a re-approval, and the re-approval is the operator's
  grant to the lane that owns the harness — not a side effect of a reload.

## The standing prohibition, restated

Do not run broad reloads for a shared mode change. Do not interrupt a working lane to
re-approve. Do not touch a held workspace. Do not replace a selected session. And do not
report a rollout as done on the strength of the commands that were sent.
