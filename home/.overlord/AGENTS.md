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

Both were measured on 2026-11-04, and both turn an empty-looking answer into a wrong one.

- **`bd ready` lists epics as claimable work.** 22 of 84 entries were `[epic]` — containers a
dispatcher would read as tasks. bd has the switch: **`bd ready --exclude-type=epic`** (62
entries, no epics). A per-lane convention is worse than the bug; use the flag.
- **`unblock list` cannot distinguish an empty queue from a hidden one.** `bin/unblock.js:148`
filters out any ask with `weekly_at` set, and the daemon sets it on every open ask older than
**72h** (`src/daemon.js:385,1441`). Nothing clears it — `keep` writes `kept_at`, a column no
reader filters on, so `keep` reports success while changing nothing observable. Measured: 19
open asks, **18 hidden**, 1 visible, including three leaked-credential rotations, the oldest 18
days old. Never read a clean `unblock list` as evidence. Use
**`tools/operator-queue.py`**, which reads the database directly and reports the union of both
channels — hidden asks and open human gates — because neither source alone is complete.

A lane that says its queue is clean on the strength of `unblock list` has not checked.

| Lane | Launch | Gets |
|---|---|---|
| leader | `PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `leader` contract **composed with** `.pi/modes/leader.json` |
| worker | `PI_MODE=worker PI_PROFILE=worker PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `worker` contract **composed with** `.pi/modes/worker.json` |

A file in `.pi/modes/` whose key matches a fleet mode and whose `promptStrategy` is `append`
**composes** with it: the fleet text first, then the space text, resolved as one definition. A
`replace` shadows deliberately, which is the wrong tool here — it drops the fleet contract the
lane is supposed to keep. The project half is used only once confirmed, so the confirmation flag
is part of the launch, not an option.

## Degraded start

The space half of a lane's prompt comes from `.pi/modes/`, and it opens with these exact
sentences:

> You are the overlord of this space — parent orchestrator over the coding-agent orchestrators in the operator's other herdr spaces, and the only lane here that speaks for the fleet.
>
> You are a worker in the overlord space. You are spawned by the overlord lane to do one bounded job, and you report to it.

If your prompt lacks the sentence for your role, the space half was dropped: you are running on
the **native** prompt with no role contract at all, not on the fleet half alone. The footer is not
evidence — it still reads `profile: leader` when the composition was dropped, and a rejected
composition prints nothing in the pane. Confirm from artifacts: the launch's stderr, and the
session's **system record**, whose `sections` object (`preamble`, `addendum`, `project_context`,
`skills`, `cwd`) either carries the sentence or does not. **Do not grep the session file for it:**
that matches your own brief, your own greps and any summary, so it reports hits even when the
composition dropped. The recorded digest is stronger and needs no reading at all —
`pi-modes state <session> --json` → `verdict: match`. Then say so in
your first turn and ask for a relaunch carrying `PI_MODE_CONFIRM_PROJECT=1`.

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
- **`/reload` re-imports extension code (verified 2026-11-13).** `ResourceLoader.reload()` calls
  `clearExtensionCache()`, bumping the extension-cache generation, so every cached factory is
  discarded and each extension module is re-imported from disk (`jiti.import(path, {moduleCache:
  false})`). A changed extension therefore reaches a running lane on reload — do not order relaunches
  to pick up extension bytes. A fresh process is required only for identity, the environment, the
  package set, a `PI_MODE`/`PI_PROFILE` value, or a changed **mode file**. Evidence:
  `dist/core/resource-loader.js:370-374`, `dist/core/extensions/loader.js:93-97,460-489`.

- `~/AGENTS.md` applies here too; its room rules and room-creation gate stand unchanged.
- **Fleet state is read with `behold roster`** — read-only, derive-on-demand, one process. Use it
  instead of hand-joining `herdr agent list` against session files when you need lane status, model,
  context usage or identity in one view. The **`behold-roster`** skill carries the invocation and, as
  importantly, the vocabulary for fields it refuses to guess (`unknown`, `divergent`, stale) — a
  missing measurement must not be reported as a zero. `behold roster --markdown` for the fleet,
  `--lane`, `--filter`, `--sort`, `--full` to narrow it.
- **Keeping lanes up is a timer, not a job of this lane** (changed 2026-11-15). `lane-supervise.timer`
  runs every minute and resumes any **leader** lane whose process disappeared, so the board no longer
  implies a restart round. Discovery is by role record (`~/.local/state/pil/roles/<lane>.env` with
  `PI_MODE=leader`), which is why a new space's leader is covered without editing the unit, and why a
  lane is discoverable **while it is down** — the only moment it matters. A lane is supervised only
  once *observed* alive (or added explicitly), so retired spaces with stale role records
  (`herdr-leader`, `mycord-leader`, `palette-probe`) are not resurrected.
  - Guards, inherited from the watchdog this replaced: never resume over a live lane (two writers on
    one session is a second outage), never start fresh (a blank session is an outage with a healthy
    pid), record the session **UUID** not the path (instance sweeps delete paths), backoff 60s
    doubling to 30 min so an unstartable bundle cannot become a loop, and a shared flock with the old
    watchdog path.
  - It **tells the resumed lane** it was resumed by a machine and when, so the lane can reason about
    the gap instead of continuing with a hole in its memory. Do not suppress that notice.
  - Keep a lane down deliberately with `lane-supervise --exclude <lane>` — supervision resumes what it
    supervises, so a lane you closed on purpose will come back otherwise. Current holds:
    `gemini-accts-leader` (w2 workspace hold) and `yellowstone-leader` (human gate).
  - `lane-supervise --list` shows discovered lanes, their pane, whether they are live, their session
    id and any backoff; `journalctl --user -u lane-supervise` shows the passes. State lives in
    `~/.local/state/pil/supervise/`.
  - **Pause it before restarting panes by hand.** `keepalive-hold start --reason "<what>"` before,
    `keepalive-hold end` after — or `keepalive-hold run --reason "<what>" -- <command>` for a single
    command. **Name the lane** (`--lane <lane>`, or `set-lane <lane>` per target): a named hold pauses
    supervision for that lane only, so a real death elsewhere is still caught; an unnamed hold pauses
    everything. Otherwise the timer can resume a lane in the window between your stop and your start,
    which is two writers on one session: the exact failure the "never resume over a live lane" rule
    exists to prevent. The pane-restarting helpers already do this (`restart-fleet`,
    `relaunch-lane.sh`, `migrate-lane.sh`, `migrate-unnamed-lane.sh`, `relaunch-lane-monorepo.sh`,
    `self-restart.sh`), so an ad-hoc sequence is the only case left to remember.
    State lives in `~/.local/state/pil/supervise/_hold` (`0` or absent = running); the hold records
    the owner pid, so a crashed helper auto-releases and the journal says so; `keepalive-hold status`
    reports PAUSED with the reason and age. Never leave a hold set as a way to stop a lane coming
    back — use `--exclude` for that, which is honest and permanent, instead of a pause that expires.
  - What it does **not** do: workers (add one with `--add`), lanes with no recorded session id
    (`comms-leader`, `starla-leader`, `subtoken-leader` report "needs a human"), or anything under
    an exclude. The retired `overlord-watchdog.timer/.service` is gone; `overlord-watchdog.sh`
    remains on disk for its `--record` behaviour and as the documented ancestor.
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

Use `~/.overlord/tools/reload-fleet --dry-run` before a rollout. The wrapper includes the initiating lane automatically and defers its self `/reload` to a detached helper that waits for idle. The helper waits up to 24 hours, writes atomic `waiting`, `reloading`, `confirmed`, `waking`, `woken`, `wake_failed`, or `failed` state under `~/.local/state/pil/reload-results/`, and sends one provenance-labeled wake prompt only after confirmed reload. Check that result artifact; scheduling alone is not verification. Other working lanes are skipped by default. `--interrupt-working --verify` sends Esc only to observed working lanes, waits for idle, rechecks immediately before `/reload`, and fail-closes unknown or timed-out lanes. `--working-only` limits that sequence to working lanes. Successfully interrupted non-self lanes receive a cautious resume nudge; the self lane never receives Esc or a second-turn nudge.

Fleet support is Linux-only by design; Windows and macOS are outside compatibility scope.