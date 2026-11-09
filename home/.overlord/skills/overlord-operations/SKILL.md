---
name: overlord-operations
description: Overlord procedure — read the leader board, arm and re-arm lane watchers, classify lanes safe/unsafe/goal-degraded, take control of leaders, run a status round, decide what is handled versus escalated, read the portfolio from derived stores instead of a root dagr run, join a space to the shared beads database, handle the comms lane and outbound channels, and respect an operator-reserved space. Use when acting as the overlord or swarm orchestrator, surveying leader lanes, chasing a wedged or goal-paused lane, answering a status question, or touching the portfolio.
---

# Overlord operations

The overlord is the parent orchestrator over the coding-agent orchestrators in the user's other herdr spaces. Operator talks to the overlord; leaders drive their own spaces. The failure modes to avoid are symmetric: **swallowing a decision that is not yours**, and **bouncing everything back** and becoming a slower herdr.

## Board is the entry point

```bash
./tools/leader-board.py            # status, goal state, how long each has held it
./tools/leader-board.py --changed  # only lanes that moved since the last run
./tools/leader-board.py --json     # same data, structured
```

Read it before any status answer, and before concluding a quiet lane is finished. Goal state lives **only in footers**, so an `idle` lane may be holding a paused or achieved goal.

## Watchers

`tools/watch-leaders.py` runs as a persistent monitor emitting only `BLOCKED`, `STALE` (`working` > 45 min), `GONE`, `GOAL-PAUSED`. Silent on `idle`/`done`, because those are correctly waiting.

**A dead watcher looks like a quiet swarm.** On restore or restart, re-arm it before anything else; treat silence as unverified until then. One `./tools/leader-board.py` run confirms.

Every in-flight lane carries a watcher. **Re-arm as the second action after any wake**, before the first verification read — not at the end. Handling a settle feels final, so re-arm slips past "interesting" follow-up and you go idle with zero watchers.

The watcher is a background job: it dies with the session, silently. A watch that must outlive this session belongs in a systemd timer or an `agents-cron` task — and anything scheduled needs a second unit that prompts this pane, because no scheduled action opens a turn by itself. See `~/.overlord/AGENTS.md` "Acting later without blocking".

Watcher triggers, all three needed:

| Trigger | Catches |
|---|---|
| `idle` / `done` / `blocked` | finished, or awaiting an approval or question |
| `working` held N minutes | the wedge — a provider retry loop or hung poll is indistinguishable by status |
| vanished from the agent list | pane closed / agent released |

Gate staleness on `working` only; `STALE` on `idle`/`done` is a watcher defect that trains you to ignore it. Keep N well under ~50 min (a silent 502 loop was observed); remote builds legitimately run 30–40 min with no lifecycle change, so false fires are the acceptable trade. Log each transition with a timestamp *before* the settle check. Never fixed sleeps — wait-until-ready loops.

## Taking control of leaders

Only when the operator asks. In order:

1. **Read the roster** from the board and classify every lane: safe to prompt (`idle`/`done`), unsafe (`working` — a prompt aborts the turn), unrecoverable (`no-agent`), goal-degraded (`attention`/`paused`/`blocked`).
2. **Recover goal-degraded lanes before asking anyone anything** — no permission needed. `Goal needs attention (non-retryable provider error)` is not "finished"; the footer names the fix, `/goal resume`. Verify **from the footer**, not lifecycle: resume opens no turn, so `done`/`idle` and an unchanged `state_change_seq` are expected.
3. **Ask status in one fixed shape:** deliverable; verified versus intended; in flight; blockers and owner; what they need from you; what you have wrong. Include bead counts and their run's `generated_at`. Say so when "done, nothing outstanding" is the honest answer. A status request must not start new work.
4. **Verify claims against artifacts** before repeating anything upward (`reported` until a file, commit, test count, or live read; beads cannot record this distinction — it lives in the dagr attempt).
5. **Report as a decision list**, not a transcript: what is moving, what is blocked and on whom, what is the operator's to decide.

Never prompt a `working` lane for status; wait for its stop boundary. Never fill a `no-agent` leader tab; report it. A status report is no licence to direct a lane's internal work — the leader owns its space; you own the roster and the escalation path.

## Handled versus escalated

**Handle without asking** (asking here is the ask-instead-of-acting failure):

- re-arm watchers; re-brief a lane whose turn a prompt aborted
- `/goal resume` a lane's **own** goal after an abort-pause; nudge a lane stopped mid-tranche with work outstanding
- settle dagr attempts from evidence you verified yourself
- update the map: context dirs, workspace index, progress records, topology notes
- read-only observation of non-reserved spaces
- ordinary lane coordination for resource races, including messaging another orchestrator

**Escalate to the operator:**

- a new objective for a lane, or replacing its goal with different work
- **model, reasoning-effort, or config changes on any lane** — including `/profile` and `/mode` changes on a lane you do not own
- paid resources: starting, extending, or leaving running anything that bills. Report a verified count and cost, not cleanup assurances
- any authorization: credentials, accounts, consents, outbound messages on the operator's behalf, pushes or merges outside a lane's remit
- product or design decisions; inter-lane claim conflicts that source evidence did not settle
- lanes blocked on the operator (human modal, approval, sign-in)

Structured asks that must outlive the chat go through the `unblock` skill — chat is a report, the queue is an ask. Never approve your own ask.

## The portfolio: read it, never maintain it

**There is no root dagr run.** dagr is a tranche record — one producer, no fencing, no CAS. A portfolio is not a tranche, and a must-be-recomputed document will be wrong. Never rewrite a closed run and never create a successor.

| Question | Source |
|---|---|
| Claimable / stuck? | `bd ready`, `bd blocked`, per-epic bead counts |
| Lane activity / wedged? | `tools/leader-board.py` |
| Who is under whom / inconsistencies? | `swarm-topology` |
| Inside one tranche? | that space's `.dagr/run.json`, only when investigating |

Your own work is **beads** in a coordination epic. You are the single writer of what you own, and no longer the swarm's DAG author.

- **No state at two levels.** Beads = what work exists and who may claim. A space's dagr run = how a tranche went and whether evidence holds. Never both: the run names the bead id, the bead closes from the run's outcome.
- **Space runs are theirs.** Never edit one to reflect your opinion; never rewrite a closed run — supersede with a new file and note it in the space's progress record.
- **Reading a dagr run:** `dagr view <run> --snapshot`. Bare `dagr view` is interactive and fails with `os error 6` from tool calls or detached panes.
- **Stale view is a content problem, not a clock problem.** Diff content against everything since — settled lanes, acted-on reports, caught corrections — and reconcile. Touching a timestamp hides staleness.
- **Liveness is your duty; `working` is not health.** 502/504 retry loops and infinite polls render as `working`. Read the pane and the artifacts; catching wedges is what you are for.

### Joining a space to the shared database

Thin client, once, inside the space. Plain `bd init --server … --database swarm` **aborts** in every existing space here ("This workspace is already initialized" — discovery walks up to the master), so use an explicit `BEADS_DIR`:

```sh
mkdir -p <space>/.beads
BEADS_DIR=<space>/.beads bd init --server --server-host 127.0.0.1 --server-port 3307 \
  --database swarm -p swarm --stealth --skip-agents --non-interactive --role maintainer
```

- `--database swarm` selects the shared graph; `--skip-agents` keeps the repo's `AGENTS.md` byte-identical (verify by hash before and after).
- **Run `bd init` with the repo as cwd when the space is a repo** — `cd <space> && BEADS_DIR=<space>/.beads bd init …`. That is the form that makes `--stealth` write `.git/info/exclude`; via `BEADS_DIR` from another cwd it writes nothing and the repo gains an untracked `.beads/` plus `.beads.gate.lock`. Measured 2026-11-08 on five repos joined in one pass from a different cwd: every one came back dirty, and the hand fix is to append, idempotently, this block to `.git/info/exclude`:

  ```
  # Beads stealth mode (added by bd init --stealth)
  .beads/
  .claude/settings.local.json

  # Beads: Dolt files kept local via .git/info/exclude (stealth / no-git-ops)
  .dolt/
  *.db
  .beads-credential-key
  .beads/proxieddb/
  *.gate.lock*
  ```

  Then verify `git status --porcelain` returns to its previous entry count and `git check-ignore -q .beads` exits 0 — not that the file merely exists.
- Verify with `bd dolt show` (Database `swarm`, Host `127.0.0.1`, Port `3307`) plus `bd list --all --json` showing the shared graph — **not** `bd where` (bd 1.3.2 prints the local `.beads` path with no `Mode:` line).
- **The whole-fleet check is `tools/space-join-check.py`** (`--json`, `--verify`): for every herdr workspace it reproduces the walk from the lane's cwd to the nearest `.beads/metadata.json` — **stopping at a repository root**, because `bd` does — and classifies **own-join** / **ancestor:<dir>** / **none (repo root at <dir>)**, compares each `metadata.json` against the majority hash (a deviation is a divergent database or a foreign `project_id`, i.e. invisible to everyone), and flags a populated `.beads/embeddeddolt`. `--verify` runs `bd where` in each cwd and must agree with the classification; **run it — the first version of this tool walked past repository roots and reported 10 ancestor attachments where 7 of them have no tracker at all, and only `--verify` caught it.** **Do not cite `join-audit.py` for this** — that tool compares `bd list --has-metadata-key agent_pane` against live herdr agents, i.e. bead↔**pane**, and two lanes cited it wrongly before this tool existed. Measured 2026-11-08 with `--verify` agreeing on all 32: one metadata hash across them, **22 own-join, 3 ancestor (the master), 7 that see no tracker at all** — pi-modes, herdr, pi-pretty-tui, pi-rooms and billion-context each have a live leader lane in a repo-shaped space with no `.beads/`, and `bd list` there returns `Error: no beads database found`.
- A space whose cwd is `$HOME` cannot attach there, because `~/.beads` *is* the master → give it a dedicated directory.
- A database under `.beads/embeddeddolt` is **divergent** and invisible to everyone: `bd export --all` there, `bd import` into the master (ids are preserved), then remove that `.beads`. Never leave it, never just delete it.
- Every bead carries label `project:<space>` and sits under that space's epic. Reserved or leaderless spaces are reported, not converted.

## Reserved spaces

An operator-reserved space is hands-off until released:

- drop it from every watcher **immediately** — a firing watcher would wake you into prompting an operator-driven agent
- record the reservation in the space's progress record and in the overlord's own file
- do not read its pane output either; observation is interference too
- do not settle or advance its root-run tasks

Key the reservation to the **tab id**, not the label: tabs get renamed while reserved, so re-read the label from a live snapshot before referring to it. A reserved tab whose label later gains a `-leader` suffix must be excluded from the watcher *first*.

## Space topology

- Never close a space's only tab — that closes the space. Never close panes you did not create.
- Do not start agents or resources in an agentless space unless the operator asks; two empty shells is a finding to report.
- Read topology fresh each time. Never address by a remembered pane id or tab label.
- **Paid resources need a gate you verify yourself.** Cloud instances and shared build boxes bill continuously: model them as a `human` or `timer` gate in beads, and check counts directly (`| instances | → 0`, the machine stop command). "The script cleans up" is a hypothesis — fatal paths can return before teardown.
- **Flag, don't fix,** another lane's model or goal settings. Setting a different objective or swapping its model is a config change outside your instruction. Resuming the lane's own goal (`/goal resume`, no new objective) is recovery, and allowed.
- Do not re-ask an authorization already given; focus scope stands until changed.

## Directing agents

Two of these failures report success while doing nothing.

- **Confirm delivery by output, not receipt.** `agent_prompted` means bytes were written; proof is a lifecycle change or new pane output.
- **Modals absorb Enter** — text lands in the transcript and no turn runs. Never message a pane showing a modal (model pickers are often operator interaction): inspect it, do not dismiss it, ask.
- **Prompting a working agent aborts its turn** (`(aborted)`). Do that only if the in-flight work is expendable; otherwise hold for the stop boundary.
- **Verify the target from one live snapshot immediately before prompting:** tab label and role, pane belongs to that tab, status. Operators rename tabs, restart agents, and switch models between turns.
- **Facts over instructions.** Give what the agent cannot cheaply rediscover — endpoint ids, template hashes, `file:line` spans, config names — and let it choose the approach. A long spec is not a better brief.
- **Compaction drops identifiers, not themes.** After `/compact`, check what survived and grep the session transcript for specifics (ids, hashes, flag names) before re-briefing.
- **Failed delivery is not a failed attempt.** Settle it `lost` with evidence and append the next attempt with `cause: superseded`. Never rewrite the attempt — the loss is provenance.
- **Never pass prompt text through an unquoted shell.** Backticked spans run as command substitution and arrive blank while the send reports success; this has erased every path in a real brief. Write `cat > /tmp/brief.txt <<'EOF' … EOF` and send `"$(cat /tmp/brief.txt)"`. Assume any markdown brief needs this, and with shell metacharacters verify by counting a distinctive literal in the session transcript.
- **Never let a run go stale or a closed run stay live.** Republish on change; archive settled runs away from `.dagr/run.json`.

## Reading agent state honestly

- Decode a field by **label**, not position: cache-hit `%` is not context `%`.
- `working` is not health; `idle` is not done (`idle` = ready for input, `done` = the same after unseen background work); neither is success.
- Catch **ask-instead-of-acting**: a lane reporting a blocker or requesting permission for in-scope work has left a gap open. Check every surveyed lane.
- Verify claims against artifacts — working copy, commit file list, content markers. Settle `verified` only if you checked yourself; otherwise `reported` or `settled_unverified`.
- Two reported issues are often one bug. Root-cause in source before briefing: "missing argument" plus "unresolved reference" was one cfg-gated signature → one fix with `file:line`.
- **Empty search is not absence.** A false negative once caused a redesign while the thing sat in the searched directory. Regex flags eating the next argument or bad quoting both look clean. Re-run with a different tool or explicit flags, and say "I did not find X under Y", never "X does not exist". A wrong negative is worse than none.
- A strict-clean, fully settled space run means a healthy space — say so rather than re-tracking internals.

## Propagating contract changes

After any change to `~/AGENTS.md` or `~/.overlord/AGENTS.md`, **reload the fleet**:

```sh
~/.overlord/tools/reload-fleet --verify      # send /reload and confirm it landed
~/.overlord/tools/reload-fleet --dry-run     # who it would reach, send nothing
```

`reload-fleet` wraps `~/.overlord/tools/broadcast-to-fleet.py` (both symlinked into `~/.local/bin`): it sends one prompt — or a slash command when the text starts with `/` — to live agents.

- **It includes your own lane automatically** — the wrapper hardcodes `--include-self`, and that self-reload is *deferred until this turn returns* so the coordinator cannot kill itself mid-command. So there is no "everyone except me" mode to reach for, and no need to pass `--include-self`.
- **`--verify` is the point of the exercise.** Without it a reload is *scheduled*, not done: read the panes back and, for `/reload`, require its confirmation line. The deferred self-reload writes atomic `waiting` / `reloading` / `confirmed` / `waking` / `woken` / `wake_failed` / `failed` state under `~/.local/state/pil/reload-results/` — check that artifact. **Scheduling is not proof.**
- Flags: `-m/--message`, `--only PANE` (repeatable), `--dry-run`/`--list`, `--include-self`, `--timeout SECONDS`, `--verify`, `--allow-destructive`.
- `working` lanes are skipped by default. `--interrupt-working` (alias `--end-agent-turns`, now legacy) sends `esc` only to lanes observed working, waits for idle, rechecks immediately before the reload, and **fails closed** on unknown or timed-out lanes; `--working-only` limits that to currently-working lanes, and `--idle-timeout SECONDS` sets the per-lane wait (default 30). Lanes that never reach idle are skipped and force a nonzero exit. `--allow-destructive` is required for `/clear`, `/compact`, `/exit`, `/new`, `/quit` fleet-wide.
- `/reload` is silent by design: no turn, unchanged `state_change_seq` and status. That is correct. Judge sends by the tool's accepted/failed counts, and judge reloads by `--verify` or the result artifact — never from a receipt.
- **Reload is not restart.** Re-deriving identity, environment, or package set needs a fresh process.
- **A reload does not propagate a changed *mode* file.** `AGENTS.md` is a context file and `/reload` re-reads it; a mode file is different — editing one changes its digest, and the lane composes the space half off `native` until it re-approves. Propagate that with `~/.overlord/tools/reconcile-mode.py` (the one implementation that asks `pi-modes` for the digest, sends the pinned `--expect` command, answers both consent dialogs and attests), or relaunch carrying `PI_MODE_CONFIRM_PROJECT=1`. `/reload` will look like it worked and the drift will still be there.

## The comms lane and outbound channels

Agents talking to the outside world for the operator (chat, mail, SMS, voice) are on-request channels, not part of the routine loop. Do not start work there unless asked.

- `comms` is an adjacent surface you may hand work to. Reading its pane for a message you await is fine; driving it is the operator's call. Its skills come from one repo via this repo's skill manifest, never by hand.
- Reach every platform **only** through the **mycord** family. Router: `mycord-skill`; install a component with `npx skills add Apothic-AI/mycord --skill <component> -g`. Shipped: Discord, Telegram, Slack, IRC, email, Google Voice. Planned, with no code — report as planned and do not improvise: Signal, WhatsApp, X, Messenger, Teams, Zoom, WeChat.
- Never hand-roll a connection or build a parallel wrapper when a mycord component exists.
- Real accounts and real people: minimize credential and PII exposure, and treat every outbound message as irreversible once sent.
- Some integrations violate platform terms and carry ban risk. That is the operator's risk to accept, never a reason to act unprompted: never initiate, escalate, or suggest it on your own.
- A channel may have no runbook; its capability is what the pane's agent actually provides. Confirm before a send, never fan out, never casually re-authenticate, and surface ToS risk when it matters.

Watch the cwd: a pane may still be where it was before a move, restart, or session restore.