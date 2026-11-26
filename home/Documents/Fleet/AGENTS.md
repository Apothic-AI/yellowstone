> **RETIRED 2026-11-26** -- the self-improvement space (Herdr w1K) was retired and its roles merged into `yellowstone-leader`. This file is history, not a live space. `~/Documents/Fleet` remains the operator Obsidian vault.

# Fleet workspace

cwd for fleet-level configuration and documentation. The fleet itself runs from `~/` and
`~/Code/*`; this directory holds the **record** of how it is configured, not the running
system. This `AGENTS.md` is loaded by every lane whose cwd is here. Anything that belongs to
one role is not in it: that lived in `.pi/modes/` (deleted with the space 2026-11-26), which was cwd-scoped, and a lane received
only the definitions it was launched with.

| Lane | Launch | Gets |
|---|---|---|
| leader | `PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `leader` contract **composed with** `.pi/modes/leader.json` (deleted 2026-11-26) |
| worker | `PI_MODE=worker PI_PROFILE=worker PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `worker` contract **composed with** `.pi/modes/worker.json` (deleted 2026-11-26) |

A file in `.pi/modes/` whose key matches a fleet mode and whose `promptStrategy` is `append`
**composes** with it: the fleet text first, then the space text, resolved as one definition. A
`replace` shadows deliberately, which is the wrong tool here. The project half is used only once
confirmed, so the confirmation flag is part of the launch, not an option — and startup
acceptance records nothing, so it is per process and per content. An unconfirmed project mode
blocks the whole composition and falls back to the **native** prompt: the lane does not run on
the fleet half alone, it loses its entire role contract. Editing a mode file is drift — but **not** because the file is not re-read. `pi-modes`
re-reads mode files from disk on every turn (`currentModes()` calls the loader; nothing is cached).
`/reload` is simply not the mechanism: it reloads keybindings, extensions, skills, prompts, themes
and **context files** (this `AGENTS.md`), and never touches mode definitions. What gates an edited
mode file is the **fingerprint recorded in the session**: a definition whose digest changed is
*drift*, and under the default `driftPolicy: block` the whole composition is blocked and the lane
falls back to the **native** prompt — losing the role contract entirely — until it re-approves with
`/mode-reapprove --confirm-project` or is relaunched carrying the flag. Under `warn` or `allow` the
new text simply takes effect on the next turn.

## Degraded start

The space half of a lane's prompt comes from `.pi/modes/`, and until retirement it opened with these exact
sentences:

> You are the self-improvement leader of this space — the lane that owns the harness this fleet runs on: `pi`, `herdr`, the launcher and profiles, the modes, skills, hooks, and the fleet's configuration record in `pi-fleet-model/`.  *(retired 2026-11-26; the role now belongs to `yellowstone-leader`)*
>
> You are a worker in the fleet workspace, spawned by `self-improvement-leader` for one harness job.  *(retired 2026-11-26)*

If your prompt lacks the sentence for your role, the space half was dropped: you are running on
the **native** prompt with no role contract at all, not on the fleet half alone. The footer is not
evidence — it still reads `profile: leader` when the composition was dropped, and a rejected
Confirm from artifacts, not from the screen. The check that works is
`~/.overlord/tools/reconcile-mode.py --inspect`, which prints a per-lane verdict: `match` means
the composition is current; `drift` means it will be **dropped** under `driftPolicy: block`, and the
lane then runs the **native** prompt with no role contract at all while its footer still reads
`profile: leader`. For a single lane, compare the digest its session recorded
(`pi-mode-state.v3` custom records, `fingerprints.<key>.digest`) against
`REAL_AGENT_DIR=~/.pi/agent node --experimental-strip-types ~/.overlord/tools/mode-composed-digest.mjs <cwd> <key>`.

Three traps this check has already sprung (2026-11-18, FT-91): **do not grep the session for the role
sentence** - it appears verbatim in this document, so a grep reports a hit even when the composition was
dropped; `sections` does not carry a `replace_base` mode's prompt, so its absence there proves nothing
either way; and `pi-modes state` is not available here (no binary on PATH). The remedy is a re-approval
inside the lane (`~/.overlord/tools/defer-mode-reapprove.py --pane <pane>`, deferred to idle) or a relaunch
carrying `PI_MODE_CONFIRM_PROJECT=1`. Then say so in your first turn and ask for one.
your first turn and ask for a relaunch carrying `PI_MODE_CONFIRM_PROJECT=1`.

## What is here

`pi-fleet-model/` — the fleet configuration record.

| Document | For |
|---|---|
| `pi-fleet-model/README.md` | **start here** — how to start a lane, roles, profiles, modes, how to check one, known cosmetic issues |
| `pi-fleet-model/fleet-configuration-model.v5.md` | the design: decisions, architecture, verification status, rejected alternatives |
| `pi-fleet-model/EXECUTION-RECORD.md` | what was actually done, with evidence and the mistakes made on the way |
| `pi-fleet-model/HANDOFF-fleet-migration.md` | current state and what remains, one page |
| `pi-fleet-model/OVERLORD-BRIEFING.md` | what the overlord must know after a restart |
| `pi-fleet-model/PER-SPACE-DECOMPOSITION.md` | per-space `AGENTS.md` analysis and the on-activation recipe |
| `pi-fleet-model/FT-01-LEAD-DECISIONS.md` | FT-01 (yellowstone as a git-subrepo monorepo): every decision with its evidence, the acceptance criteria and what falsified them, and the reversals |

## Conventions that apply in this directory

- **A lane's identity is its herdr tab label.** `pil` derives it at spawn, so name the tab before starting. This space's lanes were `self-improvement-leader` and the workers it spawned (retired 2026-11-26).
- **Read the fleet's state; do not reconstruct it.** `behold roster` joins herdr topology, pi session state and extension data per lane in one read-only pass — the skill is **`behold-roster`** and it explains the `unknown` / `divergent` / stale vocabulary, so a missing measurement is never reported as a zero. `--markdown` for the whole fleet, `--lane`, `--filter`, `--sort`, `--full` to narrow. Hand-joining `herdr agent list` against session files is the failure mode this replaces.
- **`/reload` re-imports extension code; a mode file is the exception.** `ResourceLoader.reload()`
  clears the extension factory cache (bumping its generation), so each extension module is re-imported
  from disk — verified in the installed package 2026-11-13 (`dist/core/resource-loader.js:370-374`,
  `dist/core/extensions/loader.js:93-97,460-489`). So a changed extension reaches a running lane on
  reload; a relaunch is needed only for identity, environment, the package set, `PI_MODE`/`PI_PROFILE`,
  or a changed mode file. Do not measure extension currency by process start time alone.
- **Roles are artifacts, not prose.** `PI_MODE=leader|worker` carries a role's contract; `PI_PROFILE` scopes its resources. A lane started with bare `pil` gets resources but no role duties, because `~/AGENTS.md` is deliberately role-neutral.
- **Pause supervision before you restart panes by hand.** A helper that stops a lane and starts it again creates a window where `lane-supervise.timer` sees the lane down and resumes it — two processes on one session, which is the failure its own rules exist to prevent. Wrap the work: `keepalive-hold start --reason "<what>"` … `keepalive-hold end`, or one-shot `keepalive-hold run --reason "<what>" -- <command>`. **Name the lane you are replacing** (`--lane <lane>`, or `keepalive-hold set-lane <lane>` as you move through targets): a hold that names a lane pauses supervision for *that lane only*, and the timer keeps watching everything else; a hold with no lane is a blanket pause. The hold file is `~/.local/state/pil/supervise/_hold`; content `0` (or absent) means supervision runs, and `keepalive-hold status` reports `PAUSED [lane <name>]` or `PAUSED [all lanes]`. Every pane-restarting tool in `~/.overlord/tools` already does this (`restart-fleet`, `relaunch-lane.sh`, `migrate-lane.sh`, `migrate-unnamed-lane.sh`, `relaunch-lane-monorepo.sh`, `self-restart.sh`). A hold carries the owner pid, so a helper that crashes cannot pause supervision forever — the timer releases it and says so in the journal. Check with `keepalive-hold status`.
- **Leader lanes stay up on their own — do not restart a dead one by hand.** `lane-supervise.timer` runs every minute, finds leader lanes whose process disappeared, and relaunches each into its previous session with `pil --role leader --session <uuid>`; the resumed lane is told it was resumed by a machine, with the timestamp, so it can reason about the gap. Discovery is by role record (`~/.local/state/pil/roles/<lane>.env`, `PI_MODE=leader`), so a new space is covered without editing any unit — but a lane is only supervised once it has been *observed* alive, which keeps retired spaces from being resurrected. It refuses to start a lane with no recorded session (that is an outage with a healthy pid), never resumes over a live lane, and backs off 60s→30min. Read it with `lane-supervise --list`; keep a lane **down** with `lane-supervise --exclude <lane>` (current holds: `gemini-accts-leader`, `yellowstone-leader`). Worker lanes are not supervised unless added with `--add` — resuming every worker would resurrect finished work (measured 2026-11-17: 39 leader role records, 189 worker, 168 inactive) — and `--add` seeds the lane's pane, session and role from `~/.local/state/pil/sessions/<lane>.json` + its role record, so it still works after the lane is already down. `lane-supervise --list` names the live lanes it does not cover; read that, not the length of the supervised list (FT-78: a worker named `experiment` was Ctrl-C'd and silently never came back).
- **Compose before you author.** `pi-modes` separates three layers: a **mode** (`<cwd>/.pi/modes/<key>.json`) carries prompt text and is drift-gated; a **preset** (`<cwd>/.pi/mode-presets/<key>.json`) is a saved *selection* — one base plus up to 64 ordered overlays, carrying no text at all; and `AGENTS.md` carries what every lane in a directory needs. `/mode presets` lists them, `/mode use <key>` applies one, `/mode save <key>` captures the current selection. Reach for a preset before writing a new mode, and `AGENTS.md` before either. Full write-up: `pi-fleet-model/MODE-PRESETS.md`.
- **Cross-space work is delegated leader-to-leader as intent and requirements** — never a method, and never a worker of this space seated in another space's panes. Verify a handoff by the receiver's receipt and its own disposition, never by reading its screen. The fleet-progress lane may reach into any space to repair fleet machinery, not to take a leadership or worker role in that space's work. Protocol, routing cases, bead rule and the receipt ladder: `pi-fleet-model/DELEGATION-PROTOCOL.md`.
- **Keep these docs current.** They are the record the next lane inherits; a stale claim here costs someone a session.
- **A change is not finished until it is reloaded.** After editing an `AGENTS.md`, a harness config, a hook, a profile, a mode or a skill, reload every lane the change touches — `~/.overlord/tools/reload-fleet --only <pane>`, `--include-self` for the lane that made it — in the same turn. Do not hand the reload back to the operator as a note. Reload is silent (no turn, unchanged `state_change_seq`), so judge it by the tool's accepted/failed counts. A change to the **package set, identity, the environment, or `PI_MODE`/`PI_PROFILE`** needs a restart rather than a reload; a changed **mode file** needs re-approval or a relaunch carrying `PI_MODE_CONFIRM_PROJECT=1`.
- **Never signal a process by command-line pattern.** `pkill -f 'pi$'` matches every pi lane on the machine, because `pi` *is* their command line — enough to take out the whole fleet, and `pkill -f '<target>'` matches the shell running the command too, so it kills the caller as well as the target. A `proc-find` helper already exists for this (`~/.overlord/tools/proc-find.py`): match an explicit *field* (`--argv0`, `--exe`, `--env KEY=VALUE`) with the caller's process and ancestors excluded, and require `--expect N` for signals. For a lane/pane target, use `~/.overlord/tools/pane-signal.sh <pane> --signal <SIG>`, which reads the pane's foreground pid and refuses if it is this shell or an ancestor. Measured: `pgrep -f proc-find` returned 3 processes; `proc-find --argv-contains proc-find` returned none. So: signal a pid you read from `ps`/`proc-find`/`pane-signal`, never a string you just composed; bound test children with `timeout` instead of hunting them by name.

## Reading fleet state: backchannels before TUI scraping

**Prefer a backchannel over scraping a pane.** Fleet state should be read from what already exists
on disk or in an API, in this order:

1. **A durable artifact** — a JSON/JSONL record a tool already writes.
2. **The pi session file** — every turn, tool call, model, thinking level and goal transition is
   already recorded there; parse the record instead of the screen.
3. **`behold`** — `behold roster` derives the fleet view from herdr topology, pi session state and
   extension data, and is the fleet's read-only join of those sources (skill: `behold-roster`).
4. **A new behold feature** — extend behold's pi or herdr integration rather than teaching another
   script to scrape. Behold exists to make this unnecessary.
5. **Inter-extension / inter-plugin messaging** — room or socket messages that push state, rather
   than polling a screen for it.

**Why this is a rule and not a taste.** A TUI read is not a read-only operation. `herdr agent read
`and` herdr pane read` default to `recent`, and a `recent*` read harvests scrollback by injecting SGR
mouse-wheel events into the pane's pty (`src/server/alt_screen_read.rs`: `send_wheel`,
SettleInitial -> Harvest -> Restore). The lane visibly scrolls up and snaps back. That was FT-27:
`watch-leaders.py` ran `leader-board.py` every 90 s, the board read every lane with a bare
`agent read`, and **every lane on the machine** jumped roughly every 100 s. The probe gate requires
more `--lines` than the pane's viewport rows, so `--lines 3/8/20/30` cannot probe while
`--lines 40+` can — a safe-by-size accident, never a design.

If a read is genuinely unavoidable: use `--source visible`, keep `--lines` at or below the viewport,
never put such a read in a loop or a per-lane fan-out, and state in the tool why the history is
needed. A reader that changes the thing it reads is a defect.

Open work: **FT-70** (extend behold to cover what the FT-27 offenders need) and **FT-71** (sweep
all SI and overlord scripts for other TUI scraping worth replacing).

## Updating `pi`, `herdr`, or any extension: read the code first

**Never update or upgrade `pi`, `herdr`, or a pi extension/plugin without inspecting the
actual code changes first.** Not the changelog, not the release notes, not the version
bump — the diff. This fleet runs *on* these packages, and a single extension update is
code that executes inside every lane's session. Two consequences, both unacceptable:

- **Security.** An update can add telemetry, network calls, credential or key access,
  filesystem scope, or a postinstall script. A pinned `git:` package that is republished
  from `npm:` is a supply-chain change even when the version looks equivalent.
- **Stability.** `pi-rooms` (messaging identity), `pi-goal` (completion contracts),
  `pi-persist` (per-request context), `pi-modes` and `PI_PROFILE` (roles and resources),
  `pi-subdir-agents` (which `AGENTS.md` a lane loads), `pi-nested-skills` (skill roots) and
  the `pi-fleet-hooks` (`nonblock`, `transient-error-retry`) are load-bearing: a schema or
  behaviour change in any of them degrades lanes silently, not loudly. Hooks and anything
  that runs in-process (`pi-fleet-hooks`, `herdr-agent-state.ts`) get the most scrutiny —
  they execute on every event, in every lane.

### The gate, in order

1. **Identify the exact change.** Which ref moves — tag, branch, `git:` vs `npm:`, local
   path — and what the diff is. Compare against the pinned commit, not against `latest`.
2. **Read the diff.** Files touched, new dependencies, `postinstall`/build steps, network
   endpoints, env vars or credential paths it reads, subprocesses it spawns, anything that
   writes outside its own directory. Say out loud what it can now do that it could not
   before.
3. **Check the load-bearing surface it touches** against the list above. If it changes a
   tool schema, a prompt fragment, a skill root, a config key or a hook signature, treat it
   as a fleet migration, not an update — it needs its own rollout and verification.
4. **Prove it on one lane, then roll out.** A throwaway lane in a scratch cwd: start it,
   confirm it idles, its rooms name registers, its skills resolve, and (on a goal-capable
   lane) that `goal_complete` still works. Only then update the fleet.
5. **Record the decision** in `pi-fleet-model/EXECUTION-RECORD.md`: package, old → new ref,
   what the diff added, what you tested, and the result. Blocked or reverted updates are
   recorded too, with the reason — the next lane must not re-litigate them from scratch.

An automated "Package Updates Available — run `pi update --extensions`" notice is **not**
an instruction to update. It is a prompt to run the gate above. If the review is not done,
the answer is no.

When a fix is needed urgently and the upstream change is too large to review now, pin the
known-good ref and note why — never accept an unreviewed update to unblock yourself.

## Verification

Never report unverified success. A lane's report is `reported`; only a file, a commit, a test
count or a live read makes it `verified`.

## Incident response: ask the space owner before investigating

When a lane of this space exits unexpectedly, or the box shows a symptom that could be
infrastructure-wide, **DM `sysops-leader` first** and ask whether they already know the cause — then
investigate. On 2026-11-17 four mid-turn exits of the self-improvement lane cost four hours and
produced a confident wrong answer ("no userspace reaper") while sysops already knew the cause was
`earlyoom`. The cost of asking is one message; the cost of not asking was a wrong finding that had to
be corrected in three documents. Investigating first is only right when sysops cannot be reached, and
then say so in the record.

## Context pressure is a measurement, not a feeling

A lane's context usage comes from the record, not from the session file: `behold roster --lane <lane>
--json` field **`P-11`** (`observed.context_percent`, `context_tokens`, `context_window`), or
`~/.overlord/tools/lane-fields <lane> ctx-used ctx-max ctx`. **Session-file size is not a proxy for
it.** On 2026-11-17 this lane's session was 118.6 MB on disk while the measured window was 22.9% of
1,000,000 tokens; reasoning from the file size made the lane defer work it had ample room to do, and it
took the operator challenging the claim to surface it. A large session file means a long history on
disk — the window is what is in the request. Same rule as everywhere else here: a read from the wrong
record is not a measurement, and a proxy that moves in the same direction as the quantity is the most
dangerous kind, because it looks like evidence.
