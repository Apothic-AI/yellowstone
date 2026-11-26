# Continuation brief

**Updated**: 2026-11-01 07:10Z. Supersedes every earlier version of this file; the pre-migration version described work that is now finished.
**Read [`README.md`](Fleet/pi-fleet-model/README.md) first** for how to run a lane. This file is only the state of the migration and what remains.

---

## Herdr/Pi session pin-drift — RESOLVED 2026-11-06

**Closed. Do not reopen from the older continuation docs.** A Pi lane pinned to a stale session could not
recover and sat at `agent_status: working` indefinitely. Three stacked defects: stale `hook_authority` after
a validated replacement; reason-less lifecycle reports arming a synthetic process-exit gate; and — the one
that made it survive repeated repair — `persist/snapshot.rs` preferring `hook_authority` over
`persisted_agent_session` on save, so **every handoff rewrote the accepted session back to the stale one**.

- Fixed on the merge branch **`apothic-main`** at `Apothic-AI/herdr`, head `6dca9a29` (8 commits, pushed).
- Live server runs that build: PID 2518273, exe sha256 `0555c1f5…747d`, panes 67→67, log `0600`.
- Recovery was a genuine same-session `/resume` by the operator, verified from the server trace.
- 35–37 `cargo test` failures are **pre-existing and environmental** — identical names on pristine
  `origin/master`. Not a regression; do not scope them into this work.
- Known limitation: Pi provenance is lost on every handoff, so recovery after a restart needs a real
  `/resume` or `/new`. No upstream PR.

**Full detail: [`CURRENT-STATE-herdr-pin-drift.md`](CURRENT-STATE-herdr-pin-drift.md).** The older
`CONTINUATION-herdr-*.md` files are annotated as superseded.

## pi 1.5.0 fleet-wide, and `restart-fleet` (2026-11-06)

**Every pi lane now runs 1.5.0.** 37 of 38 restarted and verified; the 38th is the lane that
performed the rollout and restarts last. `npm install -g @earendil-works/pi-coding-agent@1.5.0`
into the mise node 22.23.3 prefix; 1.4.0 is the rollback.

**`/reload` cannot do this, and that is the load-bearing fact.** The bundle has 0 dynamic
imports and 78 static chunks, so the whole graph is resolved at exec. Reload re-reads
keybindings, extensions, skills, prompts, themes and context files and never re-execs the
bundle — every lane live during an install keeps the old code indefinitely.

- **New tool: `~/.overlord/tools/restart-fleet{,.py}`.** Restarts stale lanes; skips working
  ones unless `--interrupt-working`; defers its own lane via a detached helper; holds the
  overlord watchdog's flock so the watchdog cannot race `wE:p1`; verifies by bundle mtime vs
  process start time plus the pane footer. Reap-only by default — a lane already current is
  left alone. Detail: `EXECUTION-RECORD.md` §26.
- **`pi update --extensions` reverted the `pi-nested-skills` symlinked-root patch** (§24), as
  §24 itself predicted. Re-applied; the 12 lanes that had restarted before the re-apply were
  sent `/reload` instead of a second restart. **Order matters: update extensions → re-apply
  local patches → restart the fleet.**
- Extension deltas were tiny and were read, not inferred: `@narumitw/pi-btw` 0.63.4→0.63.5
  (static imports made lazy; no new network/subprocess/credential path) and
  `@narumitw/pi-tui-kit` 0.69.0→0.69.1 (one regex fix).
- **FT-29 is closed as stale process state, not a pi or herdr defect.** ESC swallows into
  autocomplete in a long-lived process; the branch is byte-identical across 1.4.0/1.5.0, and a
  fresh lane aborts correctly. Detail: `EXECUTION-RECORD.md` §27.

## Current verified operational work (2026-11-05)

- Herdr Pi session reporter ownership and live deployment: verified at `e204bdecd12549cd3849ee8a8e15ec5090613456`; full Linux nextest passed 4,135 with 17 skipped. Fleet support is Linux-only by design; Windows/macOS are outside compatibility scope. Details: `EXECUTION-RECORD.md` §33.
- `/new` and `/resume` synchronization: proven in a disposable managed lane. Both Herdr's live verified session pin and `session-tracker.ts` durable lane record followed the selected session. The duplicate `pi-session-ref-canonical.ts` network reporter is intentionally inert.
- Mode/profile behavior: `pi-modes` applies process `PI_MODE` on startup and fresh `/new` sessions, whose branches are empty; `/resume`, `/reload`, and `/fork` restore session-branch mode state. `pi-profile` reapplies the process's existing launch plan on session start; it does not re-resolve `PI_PROFILE` during session switches.
- Fleet reload: `reload-fleet` includes self and defers that reload until a detached helper observes idle. The helper waits up to 24 hours; its atomic result file at `~/.local/state/pil/reload-results/` records waiting/reloading/confirmed/waking/woken/wake_failed/failed, and sends one provenance-labeled wake prompt after confirmed reload. Live disposable-pane test reached confirmed and left Pi alive/idle; six focused tests pass. `--interrupt-working` waits for verified idle before reloading other working lanes; `--working-only` targets only those lanes.

## What is done and verified

| Area | State |
|---|---|
| Instruction layer | `~/AGENTS.md` 201 → **78 lines, role-neutral**. `~/.overlord/AGENTS.md` 356 → 123. **−13.8k tokens/request** |
| Skills | Seven created: `context-economy`, `lane-identity`, `pi-goal-contracts`, `pi-rooms-protocol`, `pi-hermes-memory-usage`, `pi-persist-usage`, `overlord-operations` |
| Roles | **New.** `leader` mode (`replace_base`); `worker` mode; overlord uses its space file. Shared core carries no role duties |
| Spawn convention | `PI_MODE=<role>` for the contract, `PI_PROFILE=<profile>` for resources. Workers: `PI_MODE=worker PI_PROFILE=worker pil` |
| Launcher | Installed globally **from the fork**, five commits. `npm:pi-profile-switch` removed from `packages` |
| Profiles | `leader` (13 skills, tools `*`), `worker` (2 skills, 13 tools), `ask`. None declares `extensions` — see gotchas |
| Modes | `worker`, `leader` + presets `planning`, `deep-review`, `overlord`. Copied per instance (ADR-0019) |
| Fleet hooks | `github.com/Apothic-AI/pi-fleet-hooks` — `nonblock` + `transient-error-retry`, registered in `settings.json` |
| Fork gate | `npm run check` passes. The one `npm test` failure reproduces at base `5d378fa` — pre-existing |
| T6 | **Closed** — a real cron task fired on the timer tick and wrote its artifact |
| T7 | **Closed** — goal survives a profile switch in both directions. `goal_id` is re-minted, so the first `goal_complete` is rejected once |
| Realized saving | **~22,832 tokens/request per lane** (11,266 chars of fixed overhead vs ~25,649 before) |
| Rollout | **22 of 22 named leader lanes** carry `PI_MODE=leader`, verified from `/proc/<pid>/environ` at 2026-11-01T07:06Z. Both queued lanes restarted at their own stop boundaries: `starla-leader` 06:10Z, `herdr-voice-leader` 06:51Z. Amended 10:14Z: **23 leader-role panes** — the `Assistant` space's `w1Z:p1` carries the mode and a rooms registration but no herdr agent name |

## What remains

1. ~~**`starla-leader` (w6:pD) and `herdr-voice-leader` (w1J:pE)**~~ — **closed.** Both restarted at their own stop boundaries and verified from `/proc`. The overlord's watcher then caught `comms-leader`, a leader lane created *after* the count was written, and brought it into spec at 07:03Z — so this is an invariant now, not a queue.
2. ~~**This lane's own role**~~ — **closed.** This lane was relaunched as `PI_MODE=leader pil`; it carries `PI_MODE=leader`, `PI_ROOMS_NAME=self-improvement-leader`, instance `launch-K1OaC6`, and was the 22nd lane counted above.
3. **Per-space `AGENTS.md`** — analysed in [`PER-SPACE-DECOMPOSITION.md`](PER-SPACE-DECOMPOSITION.md). Decompose a space **when it is activated**, not in bulk: only 1 of 65 spaces has a live agent, and six of the large files are one template.
4. **Optional**: pin a profile per space if a space needs more than `leader`. Project profiles go in `<project>/.pi/profiles/<space>.json` under a **distinct** name.

## The role model, in one table

| Role | Spawn | Prompt from | Resources from |
|---|---|---|---|
| Leader | `PI_MODE=leader pil` | `leader` mode | `leader` |
| Worker | `PI_MODE=worker PI_PROFILE=worker pil` | `worker` mode | `worker` |
| Overlord | `pil` in `~/.overlord` | that space's `AGENTS.md` | `leader` |

A lane started with bare `pil` gets resources but **no role duties** — the shared core is deliberately role-neutral.

## Gotchas paid for — do not rediscover these

- **`pi-profile` is mandatory.** Without the launcher, `PI_CODING_AGENT_DIR` is unset, the extension returns at `index.ts:134`, and `/profile` is never registered. As a pi package it is inert.
- **Do not install both ways.** Launcher `-e` plus a `packages` entry double-registers `/profile`.
- **A launcher started inside a lane used to inherit that lane's instance as its agent dir** — fixed in `08d9a89`. Before that, a worker spawned by a leader mirrored the leader's stale snapshot.
- **Declaring `extensions` in a profile drops every loose script extension** (`no-mirror`). `herdr-agent-state.ts` and the fleet hooks vanish. Both profiles leave it undeclared.
- **Builtins cannot be referenced** in `extensions`; they load by default and need no entry.
- **Never run `pil` from inside a lane.** It claims the pane's tab-label name, then deregisters it on exit — deleting the real lane's rooms entry. Test from a laneless pane or set `PI_LANE_NAME`.
- **A footer name is not registration.** `rooms_who` is. Renaming via `pil --rename` can leave a lane unregistered; re-pin with `rooms_pins`.
- **`pi-modes` fails closed on symlinked mode paths** — keep the copy step; never re-link `modes/`.
- **A profile switch re-mints the goal id.** The goal survives; the first `goal_complete` is rejected once. Re-read, don't re-send the objective.
- **`reload-fleet` under `timeout` + a pipe loses its output** — Python block-buffers stdout and SIGTERM discards it. Use `PYTHONUNBUFFERED=1` and redirect to a file.
- **`~/.overlord` is not in `trust.json`**, so project-scope skills there are invisible; overlord procedure is the global `overlord-operations` skill.
- **pi state is shared by symlink**, not selectively seeded. `SEEDED_STATE_FILES` only pre-creates paths Pi makes at runtime.

## Known cosmetic defects — do not chase

| Symptom | Reality |
|---|---|
| `[skills] … skill root is not a directory` after a profile switch | `pi-nested-skills` refusing a symlinked root; all 13 skills still load |
| `/profile` does not exist | Started with bare `pi` |
| `agents-cron list` empty | No tasks scheduled — the normal state |
| One `npm test` failure in pi-profile-switch | Pre-existing at base `5d378fa` |

## Backups

```
~/AGENTS.md.bak-prefase2-20261031
~/.overlord/AGENTS.md.bak-prefase2-20261031
~/.pi/agent/settings.json.bak-phase3-20261031
~/.pi/agent/extensions.bak-fleet-hooks/
```
---

## Update 2026-11-02 22:48 — workspace-prompt rollout complete

**State.** All 69 spaces (10 live lanes + 59 dormant top-level `~/Code` dirs) carry `.pi/launch.env` = `PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1`, and every one passes `~/.overlord/tools/verify-space-split.py`. Four have real role deltas (`Documents/Comms`, `Code/sibyl-work`, `Code/apothic-monorepo-worktrees`, `Code/pi-profile-switch`); the rest are shared-only and carry a `## Role deltas` pointer. Full evidence and the mistakes made on the way: `EXECUTION-RECORD.md` §22.

**The gate nobody can skip.** A project mode is only loaded when the project is *trusted*. The launcher writes each instance `settings.json` with `defaultProjectTrust: "never"`; `trust.json` is the record that overrides it. Any space with `.agents/skills` in its ancestry (all of `~/Code`, via `~/Code/.agents/skills`) or trust-requiring entries under `.pi/` needs an exact-path entry. Without it the composition is dropped **silently** — base contract only, footer unchanged. 69 exact-path entries were added (backup `trust.json.bak-comms-20261102T0309`). Verify a lane with `verify-mode-composition.sh <pane> <base-marker> <overlay-marker>`, never from its report.

**bdi's bead↔pane join is a mechanism now** (bead `swarm-8bk`, closed): `~/.overlord/tools/bdi-reconcile.py` on a 25s systemd user timer (metadata only, `flock`, rotating log), plus a `bd` shim installed **as the stock path** (`~/.local/bin/bd` → `~/.overlord/bin/bd`, stock binary at `bd-real`) because pi tool calls run `bash -c` and read no rc file, so a PATH prepend cannot win. Proven on scratch bead `swarm-3m6`: claim → join, stop → cleared, re-claim → join, a planted dead pane → cleared by the timer. Fleet read: `conflicts: []`, `orphan-claim: 0`, `pane-in-another-project: 0`. The rule and the evidence are `EXECUTION-RECORD.md` §23.

**Its root cause had to be corrected once.** The 8 `pane-in-another-project` conflicts were the **config shape**, not a stale snapshot: 21 path-scoped `[[projects]]` blocks (one per checkout) made every space epic resolve to tree `overlord` while its pane resolved to another path, and `src/model/join.rs:419` refuses that. One tracker (`swarm` at `/home/bitnom`) makes both sides agree. Re-running the per-checkout generator reintroduces all eight. Config decides whether a cross-space claim is *legal*; the reconciler decides whether the metadata is *current*. Both stay.

**Follow-ups logged, not done:** `.pi/` is gitignored in `Code/sub2api` and `Code/synomone`, so their launch env **and any mode files are untracked** and vanish for a fresh clone (bead `swarm-vwr`); 9 of 33 ephemeral `pi -p` workers exited 0 having written nothing (bead `swarm-6ji`, still open — the cause was never isolated).

**The `pi-nested-skills` notice is solved**, not deferred (bead `swarm-nwv`, closed): a one-hunk patch in `scanRoot` makes a symlink-to-directory root return silently while still skipping it before scanning, so the scan set is unchanged. Patched locally in `~/.pi/agent/npm/node_modules/pi-nested-skills`; patch kept at `patches/pi-nested-skills-0.5.0-symlinked-root-notice.patch` and **lost on any reinstall or `pi update --extensions`** — re-apply it there. Evidence: §24.

**Leader contract changed (2026-11-02):** subagents are spawned **only through herdr**, never by `bash`/`pi -p`. It is written into the global leader mode (`~/.pi/agent/modes/leader.json`), so it reaches **new** lanes; existing lanes keep the copy their instance took at launch until they are relaunched — **not** because a mode file cannot be re-read (`pi-modes` re-reads it from disk every turn; `/reload` simply does not govern mode definitions at all) but because a changed definition is *drift* against the recorded digest, and the default `block` policy drops the composition until it is re-approved. See §25, and §26 for the correction landing in this space's file.

## Update 2026-11-02 11:20 EST — the `/reload` sentence is fixed in this space's mode file

Landed at a relaunch boundary by `~/.overlord/tools/land-mode-fixes.sh`, and verified from the relaunched session's own transcript: `sections.preamble` is 12,143 chars = global leader mode 5,460 + this space's delta 6,681 + 2, i.e. the fleet contract **and** the space delta, with the native-fallback marker absent. Two false sentences still stand and are deliberately not in place: the `BEADS_DIR` runtime claim in **both** leader modes (this lane's, held for the operator's word), and the old `/reload` sentence in `~/.overlord/.pi/modes/leader.json` (the overlord's file). `verify-mode-composition.sh` was itself broken — it counted markers in the raw transcript, so a lane's own tool output could fake either verdict; it now counts in `sections.preamble` only and was checked against negative controls. Details and evidence: §26.

## Update 2026-11-02 23:52 EST — a fleet outage, a watchdog, and a NO-GO

The evening's state, in the order it happened. Everything below is verified unless it says otherwise.

**A fleet outage, and what came out of it.** `pkill -f 'pi$'` matched every pi agent's command line
and killed ~46 lanes including all leaders, while the operator was away. Nothing durable was lost
(commits, worktrees, beads, runs, notes all survived); the running coordination did not, and
restoring it was manual. `~/AGENTS.md` now carries **Never #7** against pattern kills, and the
operator's instruction was explicit: discipline cannot prevent that class, so build the recovery.

**The overlord watchdog — installed, and proven on a stand-in.** `overlord-watchdog.timer` runs every
minute; `~/.overlord/tools/overlord-watchdog.sh` asks one question (is there a `pi` process in
`wE:p1`, read from `herdr pane process-info`, not from a status field) and, if not, resumes the last
session with `pil --session <uuid>` and tells the lane what happened and when. Deliberately small per
the operator: no state inspection, no down-taxonomy, no goal-paused classification, no watchdog for
the watchdog. Kept only the two invariants it cannot work without — `flock` with a 300 s stale timeout
(never resume over a live lane) and `--session` (resume, never start fresh).

*Two defects found only by killing a real lane; a green timer would have hidden both.* An absolute
session path does not survive a resume — `pi-profile-switch` makes a new instance dir per launch and
sweeps old ones, so the recorded path pointed into an instance that no longer held the session; the
lane now records the session **UUID**, which `pi --session` resolves across instances. And the notify
call was malformed (`--timeout` requires `--wait`), so the first resume notified nobody.

**Still open, and it is the honest description:** the watchdog has **never been exercised on the real
overlord lane** — only on a probe pane. Installed-and-proven-on-a-stand-in is what it is. The
operator deferred the real test until all pi-rooms work is deployed fleet-wide, and said explicitly
not to close the item or test it opportunistically.

**billion-context: NO-GO, and the reason is measured.** Coexistence with `pi-auto-compact` is *not*
the problem — at the operator's own configuration the two never meet (auto-compact triggers at 78 %
of a 1M window = 780,000 tokens; bili holds the meter at ≤27k, a sawtooth rather than a ramp, ~1,843
turns from the trigger), and forcing a collision produced 3 compactions, 3 bili reconciliations, 0
errors, 0 lost turns. **Recall is the blocker:** over four confound-free folded passes (n=144),
**70.8 % exact, 29.2 % plausible-but-wrong, 0 % absent** — with a compression-off ceiling of 36/36, so
the loss is the compressor. It never abstains; it invents, and 34 of the 42 wrong answers were values
absent from the source entirely while matching the expected shape. Report:
`~/Documents/Assistant/reviews/billion-context-coexistence-report.md`. Evidence preserved at
`evidence/bili-coexistence/` (544 KB) with a README; the 215 MB scratch install was deleted only after
that copy was verified.

**Beads: the R2 review's surviving items landed** under the operator's authority grant — the `beads`
skill read path (`bd ready --label project:<w-id>`, the `bd create --labels` rule, and "an unlabelled
bead is an anomaly"), the destructive-verb guard in `~/.overlord/bin/bd` (independent whole-argv scan,
exact-token equality, adjacent pairs for `dolt clean-databases`/`admin compact`, refusal before the
passthrough, `bd backup sync` verified before any override), and identity assertions in
`~/.overlord/tools/bdi-reconcile.py` (22 spaces, all on `swarm`). The R2 review carries a dated
correction: the "no backup at all" premise was **false** — daily btrfs (`/.snapshots`) and `restic`
exist — so the framing is restore time and granularity, not absence.

**`BEADS_DIR` is corrected in both leader modes** (global 6,019 chars, this space 7,854). `bd` attaches
by walking up to `.beads/metadata.json`; the env-var form was migration-plan intent, never runtime
behaviour. This was the last false statement shipping to new lanes.

**A tool defect worth knowing about.** `broadcast-to-fleet` left typed command text **unsent** in a
lane's composer when the palette check failed, and its `--verify` counted a **transient, scrolling**
confirmation — so "verified 24/26" hid two lanes that were never reloaded. Three fixes: `ctrl+u` after
`esc` on any miss, the last-8-lines baseline instead of a 60-line window, and polling the palette to a
6 s deadline instead of one 0.25 s sleep (heavy lanes render it later). Recorded in
`EXECUTION-RECORD.md` §28 alongside two other checks that reported success: a guard that claimed a
backup against a 0-byte directory, and a skill that shipped `bd update --label` (no such flag).

**Also changed:** the `pi-rooms-protocol` skill no longer documents a `rooms_ack` tool that never
existed (two delivery states, and `delivered` is not an acknowledgement); `lane-identity` records that
a name with a `participants/<name>.json` is reserved; a queue-watch pattern was added to the `unblock`
skill and then **removed** on the operator's instruction (only the Assistant lane watches the operator's
queue — a shared skill would invite 47 lanes to). `EXECUTION-RECORD.md` §27 keeps the generalisable
half: emit on transitions only, and give every watcher its own failure line.
