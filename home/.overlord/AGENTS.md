# Overlord space

cwd of the **overlord** herdr space — parent orchestrator over the coding-agent orchestrators
in the operator's other spaces. One tab, one agent (`wE:t1` / `wE:p1`), plus a `bdi`
dashboard pane, which is not an agent slot.

The dashboard is not pinned to a fixed pane id — the one this file used to name (`wE:p1V`) no
longer exists, and a hard-coded id drifts silently. Find it by process, because `herdr pane
list` does **not** carry a foreground command: loop the workspace's panes through `herdr pane
process-info --pane <id>` and take the one whose `foreground_processes[].name` is `bdi`. It
runs the Rust binary `~/Code/beady-eye/target/debug/bdi` (there is no release build and it is
not on `PATH`), with `--all`, because the default view **hides a tree whose beads have no live
agent** — an epic with no agent working it is invisible unless `--all` is passed.

What is in this file is true for **every** lane in this directory. Role instructions live in
`.pi/modes/`, which is cwd-scoped, and a lane receives only the definitions it was launched
with.

## Two reads that lie, and what to use instead

- `bd ready` lists epics as claimable — use `--exclude-type=epic` (see the `beads` skill).
- Never read a clean `unblock list` as evidence — use `tools/operator-queue.py` (see the `unblock` skill).

| Lane | Launch | Gets |
|---|---|---|
| leader | `PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `leader` contract **composed with** `.pi/modes/leader.json` |
| worker | `PI_MODE=worker PI_PROFILE=worker PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `worker` contract **composed with** `.pi/modes/worker.json` |

A file in `.pi/modes/` whose key matches a fleet mode and whose `promptStrategy` is `append`
**composes** with it: the fleet text first, then the space text, resolved as one definition. A
`replace` shadows deliberately, which is the wrong tool here — it drops the fleet contract the
lane is supposed to keep. The project half is used only once confirmed, so the confirmation flag
is part of the launch, not an option.

## Absolutes

These stand even when the space half is missing.

- **Never write a project repo, run infrastructure, or act on a paid resource by hand.** No
  lane here performs that work itself; it goes to the space that owns it or to a worker of
  this space.
- **Never report unverified success.** A lane's report is `reported`; only a file, a commit, a
  test count or a live read makes it `verified`.
- **Never fill a `no-agent` tab, and never touch a reserved space.**

- **Name yourself in every `herdr agent prompt` you send.** Open with who is sending it and
  why — `overlord → assistant-leader: …`. The recipient sees it as `role: "user"` with no
  attribution, so composer input is indistinguishable from the operator speaking. A prompt
  that forbids verification is the one shape no operator message takes; say why you are asking.

## Where things live
- **`/reload` re-imports extension code** — see the `overlord-operations` skill.

- `~/AGENTS.md` applies here too; its room rules and room-creation gate stand unchanged.
- **Fleet state is read with `behold roster`** — read-only, derive-on-demand, one process. Use it
  instead of hand-joining `herdr agent list` against session files when you need lane status, model,
  context usage or identity in one view. The **`behold-roster`** skill carries the invocation and, as
  importantly, the vocabulary for fields it refuses to guess (`unknown`, `divergent`, stale) — a
  missing measurement must not be reported as a zero. `behold roster --markdown` for the fleet,
  `--lane`, `--filter`, `--sort`, `--full` to narrow it.
- **Keeping lanes up is a timer, not a job of this lane** — see the `overlord-operations` skill.
- Procedure is in the **`overlord-operations`** skill: leader board, watchers and re-arming,
  taking control of leaders, handled-versus-escalated, the portfolio and derived stores,
  joining a space to the beads database, comms and outbound channels, topology, directing
  agents, and propagating contract changes. `pi-rooms-protocol`, `pi-goal-contracts`,
  `lane-identity`, `pi-persist-usage` and `context-economy` hold the rest.
- **Comms is its own space** since 2026-11-01: workspace `w1T`, lane `comms-leader`, cwd
  `~/Documents/Comms`. It is no longer a tab in this workspace.
- **The fleet record is not here.** It lives at `~/Documents/Fleet/pi-fleet-model/`.
  **`~/Documents/Fleet` is no longer any workspace's cwd** — the `self-improvement` workspace
  `w1K` was retired and removed 2026-11-26 when its role merged into `yellowstone-leader`
  (plan: `Code/yellowstone/research/si-into-yellowstone-merge-plan.md` — it moved into the yellowstone repo on 2026-11-26). The directory itself is
  **retained** as the operator's Obsidian vault (129 files) and its `AGENTS.md` still exists,
  but that contract now governs **no running lane** — read it as history, not as a live space.
  The absorbed copy lives in the yellowstone repo at `docs/fleet-model/`.
- **Assistant space** `w1Z`, lane `assistant-leader`, cwd `~/Documents/Assistant`. It holds
  the operator's intent and preferences; this space holds the fleet's state.
- Live workspace index: [README.md](README.md) in this directory.

## Session continuity and reloads

Herdr's managed Pi reporter and `session-tracker.ts` keep the live pane pin and durable lane record synchronized across Pi `/new` and `/resume`. Do not restore or add a second canonical-path network reporter: the retired `~/.pi/agent/extensions/pi-session-ref-canonical.ts` compatibility file is intentionally inert because duplicate reporters can leave Herdr's live pin stale after a session switch.

Pi role state has two layers. `pi-modes` applies the process `PI_MODE` selector on startup and fresh `/new` sessions, whose branches are empty; `/resume`, `/reload`, and `/fork` replay the mode stored in the selected session branch. `pi-profile` reapplies the already-materialized process launch plan on session start; `PI_PROFILE` is not re-resolved on every session switch. Mode drift or unapproved project modes fail closed to native composition.

Reload procedure: see the `overlord-operations` skill. Interrupting a working lane is fine, because a relaunch or reload resumes its session and the lane picks up where it left off. The only reason not to interrupt one is if what it is working on is time-sensitive and can’t bear the delay.

Fleet support is Linux-only by design; Windows and macOS are outside compatibility scope.