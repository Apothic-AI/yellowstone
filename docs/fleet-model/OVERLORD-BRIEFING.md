# Overlord briefing

**Updated**: 2026-11-05 — current operational additions are in the section below; older migration details remain historical snapshots.

## Current operational additions

**2026-11-06 — Herdr/Pi session pin-drift RESOLVED.** A Pi lane pinned to a stale session could not recover
and sat at `agent_status: working` indefinitely while screen detection was suppressed. Three stacked defects,
the decisive one being `persist/snapshot.rs` preferring `hook_authority` over `persisted_agent_session` on
save, so every handoff rewrote the accepted session back to the stale one and undid each repair.

- Merge branch **`apothic-main`** (`Apothic-AI/herdr`, head `6dca9a29`, 8 commits, pushed); live server runs it
  (PID 2518273, exe sha256 `0555c1f5…747d`, panes 67→67, log `0600`). Rollback chain documented.
- Recovery was a genuine `/resume` by the operator, verified from the server trace — not by a lane report.
- **35–37 `cargo test` failures are pre-existing and environmental** (identical names on pristine
  `origin/master`). Do not treat them as a regression and do not scope them into this work.
- Known limitation: **Pi provenance is lost on every handoff**, so recovery after any restart needs a real
  `/resume` or `/new`, not an ordinary turn. Observed in this lane's own traces, not theoretical.
- No upstream PR.

Detail: `CURRENT-STATE-herdr-pin-drift.md`. The `CONTINUATION-herdr-*.md` files are annotated superseded.

Fleet support target: Linux only. Windows and macOS compatibility are explicitly out of scope.

- Herdr's verified Pi reporter is deployed at commit `e204bdec`; Linux ownership is fail-closed. Linux is the fleet's only support target. `/new` and `/resume` were proven on a disposable managed lane to synchronize Herdr's live pin and the durable `pil` record after the duplicate canonical-path network reporter was retired. Do not restore that companion as a network writer.
- Modes and profiles have different session semantics: `pi-modes` replays the mode stored in the selected session branch on `session_start` and only uses `PI_MODE` at startup; `pi-profile` reapplies its existing launch plan but does not re-resolve `PI_PROFILE` on `/new` or `/resume`. Drift or unapproved project modes fail closed.
- `~/.overlord/tools/reload-fleet` now includes the initiating lane. Its self reload is automatically deferred to a detached helper that waits up to 24 hours for idle, reloads, writes durable `confirmed`/`waking`/`woken` or failure state under `~/.local/state/pil/reload-results/`, and sends one provenance-labeled wake prompt after confirmed reload. A disposable-pane test verified confirmed reload with the Pi pane still alive and idle. Other working lanes remain skipped unless `--interrupt-working` is used; that mode sends Esc, waits for idle, rechecks before reload, and nudges successfully reloaded lanes to inspect state without repeating completed actions. `--working-only` limits it to working lanes; `--dry-run` is recommended first. Six focused tests pass.
- The durable evidence is in `pi-fleet-model/EXECUTION-RECORD.md` §33-34 and `HANDOFF-fleet-migration.md`.

**Read next**: [`README.md`](Fleet/pi-fleet-model/README.md) for how to run a lane, then [`fleet-configuration-model.v5.md`](fleet-configuration-model.v5.md) for the design, [`EXECUTION-RECORD.md`](EXECUTION-RECORD.md) for evidence and mistakes, [`HANDOFF-fleet-migration.md`](HANDOFF-fleet-migration.md) for state.

---

## Status: the migration is complete. Nothing is pending.

The last wait closed itself. Both queued lanes were restarted at their own stop boundaries and verified from `/proc`, and the rollout now stands at **22 of 22 named leader lanes** carrying `PI_MODE=leader` — read from each lane's own environment, not from its self-report. Counting the role rather than the name, it is **23**: the `Assistant` space's `w1Z:p1` carries the mode and a rooms registration but no herdr agent name.

| Lane | Pane | Closed |
|---|---|---|
| `starla-leader` | `w6:pD` | restarted 06:10Z, carries `PI_MODE=leader` |
| `herdr-voice-leader` | `w1J:pE` | restarted 06:51Z, carries `PI_MODE=leader` |

Everything else is closed too: T6 (real cron firing), T7 (goal survives a switch), the fork gate, the instruction decomposition, and roles as artifacts.

## Roles are artifacts. This is the change that matters to you.

`~/AGENTS.md` is now **role-neutral — 78 lines, zero leader-only prose**. A lane started without a role mode gets resources but **no role duties**. That is deliberate.

| Role | Spawn | Prompt from | Resources |
|---|---|---|---|
| Leader | `PI_MODE=leader PI_PROFILE=leader pil` | `leader` mode (`replace_base`) | `leader` profile (renamed from `fleet` — FT-36) |
| Worker | `PI_MODE=worker PI_PROFILE=worker pil` | `worker` mode | `worker` |
| You (overlord) | bare `pil` | `~/.overlord/AGENTS.md` | `leader` |

Your own lane is correctly configured with bare `pil` — your contract is this space's file, not a mode.

Two env inputs, two jobs: `PI_MODE` is pi-modes' own selector carrying the role contract; `PI_PROFILE` is ours and scopes resources. Assembly is cwd-scoped, which is why a worker needs the profile explicitly — it shares its leader's directory.

## What changed since you last read this

> **The counts in this briefing are a 2026-11-05 snapshot.** "22 of 22 named leader lanes" and "~69
> lanes still run bare `pi`" describe that day, not today — re-derive them (`herdr agent list`, and
> each lane's `/proc` env) before repeating them. It is kept for the shape of the argument, not the
> numbers.

1. **`leader` mode exists.** ~1.5k contract: one space, drive it through lanes, spawn workers with `PI_PROFILE=worker pil`, don't research what a delegate can, verify from artifacts, stay in your space.
2. **The shared core lost all delegation prose.** Invariant 3's "delegate; spawn a lane" clause, the whole Orchestration section, and the `overlord-operations` routing row were removed. If you see a lane behaving as if it has no duties, this is why — it was started without a mode.
3. **A launcher started inside a lane inherited that lane's instance as its agent dir** — fixed (`08d9a89`). Before, a worker spawned by a leader mirrored the leader's stale settings and held state links into a directory the sweep reclaims.
4. **T7 closed.** The goal survives a profile switch in both directions, but `goal_id` is **re-minted**, so the first `goal_complete` after a switch is rejected once. Re-read the id; never re-send the objective (that wipes the queue).
5. **Your rollout:** **22 of 22 named leader lanes** carry `PI_MODE=leader`, verified from each lane's `/proc` env at 07:06Z; **23 leader-role panes** counting the unnamed `w1Z:p1`. Your tooling (`migrate-lane.sh`, `relaunch-lane.sh`) emits it, and your watcher proved it also catches *new* lanes: `comms-leader` appeared after the count was written and was in spec eight minutes later, without anyone queueing it.

## What only you can do

**Scope, stated once so it is not re-litigated: workspace ops are yours, space *design* is not.**
You hold the scope for *managing* workspaces across the fleet — creating them, joining their beads,
launching and keeping their leader lanes healthy, the watcher/board/bdi side, restarts. The
**scaffolding** — a space's `AGENTS.md` skeleton, its `.pi/modes/{leader,worker}.json` role halves, and
any profile/skill wiring — is **self-improvement-leader's**, because one lane holding the shape is what
stops the template drifting space by space. Request it; do not hand-author it. The current end-to-end
procedure, with that split written into it, is the `new-space` skill
(`/home/bitnom/Documents/Fleet/.agents/skills/new-space/SKILL.md`, symlinked to
`~/.overlord/.agents/skills/new-space`).

1. **Keep the rollout invariant armed, not the queue.** The two-lane queue is empty and should stay that way. The useful check is the standing one — a `*-leader` tab with no `PI_MODE` gets restarted at its next stop boundary — and your watcher already does it unaided. Re-tune it only downward-safe: `working` under 45 minutes is not a stall.
2. **Keep the board honest.** ~69 lanes still run bare `pi` from before the launcher existed: they have the new `AGENTS.md` but no profile and no mode. They gain both on their next restart. Restarting another space's lane is the operator's call.
3. **Update your own space map.** `~/.overlord/AGENTS.md` still says "Two tabs, one pi agent each" against seven tabs. That is yours to correct.
4. **Per-space `AGENTS.md`** — see [`PER-SPACE-DECOMPOSITION.md`](PER-SPACE-DECOMPOSITION.md). Decompose on activation, not in bulk: only 1 of 65 spaces has a live agent, and six of the large files are one template.

## Findings in your space, reported not fixed

- The `overlord` tab has two panes: `wE:p1` (the agent) and `wE:p1V` (**bdi**, not an agent slot). Correct as-is.
- Seven tabs where the space file describes two.

## Known cosmetic defects — do not chase

| Symptom | Reality |
|---|---|
| `[skills] … skill root is not a directory` after a profile switch | `pi-nested-skills` refusing a symlinked root; all 13 skills still load |
| `/profile` does not exist | the lane started with bare `pi` |
| `agents-cron list` empty | no tasks scheduled |
| One `npm test` failure in pi-profile-switch | pre-existing at base `5d378fa` |

## Two verification lessons worth keeping

- **A footer name is not rooms registration.** `rooms_who` is. Running `pil` from inside a lane deregisters it.
- **Env proves a lane started with a selection; only a fresh session's transcript proves the text reached the model.** A resumed session keeps the prompt it started with, so a transcript check on a resumed lane looks like a miss when it is not.