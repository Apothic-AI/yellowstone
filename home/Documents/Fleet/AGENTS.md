# Fleet workspace

cwd for fleet-level configuration and documentation. The fleet itself runs from `~/` and
`~/Code/*`; this directory holds the **record** of how it is configured, not the running
system. This `AGENTS.md` is loaded by every lane whose cwd is here. Anything that belongs to
one role is not in it: that lives in `.pi/modes/`, which is cwd-scoped, and a lane receives
only the definitions it was launched with.

| Lane | Launch | Gets |
|---|---|---|
| leader | `PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `leader` contract **composed with** `.pi/modes/leader.json` |
| worker | `PI_MODE=worker PI_PROFILE=worker PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `worker` contract **composed with** `.pi/modes/worker.json` |

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

The space half of a lane's prompt comes from `.pi/modes/`, and it opens with these exact
sentences:

> You are the self-improvement leader of this space — the lane that owns the harness this fleet runs on: `pi`, `herdr`, the launcher and profiles, the modes, skills, hooks, and the fleet's configuration record in `pi-fleet-model/`.
>
> You are a worker in the fleet workspace, spawned by `self-improvement-leader` for one harness job.

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

- **A lane's identity is its herdr tab label.** `pil` derives it at spawn, so name the tab before starting. This space's lanes are `self-improvement-leader` and the workers it spawns.
- **Roles are artifacts, not prose.** `PI_MODE=leader|worker` carries a role's contract; `PI_PROFILE` scopes its resources. A lane started with bare `pil` gets resources but no role duties, because `~/AGENTS.md` is deliberately role-neutral.
- **Keep these docs current.** They are the record the next lane inherits; a stale claim here costs someone a session.
- **A change is not finished until it is reloaded.** After editing an `AGENTS.md`, a harness config, a hook, a profile, a mode or a skill, reload every lane the change touches — `~/.overlord/tools/reload-fleet --only <pane>`, `--include-self` for the lane that made it — in the same turn. Do not hand the reload back to the operator as a note. Reload is silent (no turn, unchanged `state_change_seq`), so judge it by the tool's accepted/failed counts. A change to the **package set, identity, the environment, or `PI_MODE`/`PI_PROFILE`** needs a restart rather than a reload; a changed **mode file** needs re-approval or a relaunch carrying `PI_MODE_CONFIRM_PROJECT=1`.
- **Never signal a process by command-line pattern.** `pkill -f 'pi$'` matches every pi lane on the machine, because `pi` *is* their command line — enough to take out the whole fleet, and `pkill -f '<target>'` matches the shell running the command too, so it kills the caller as well as the target. A `proc-find` helper already exists for this (`~/.overlord/tools/proc-find.py`): match an explicit *field* (`--argv0`, `--exe`, `--env KEY=VALUE`) with the caller's process and ancestors excluded, and require `--expect N` for signals. For a lane/pane target, use `~/.overlord/tools/pane-signal.sh <pane> --signal <SIG>`, which reads the pane's foreground pid and refuses if it is this shell or an ancestor. Measured: `pgrep -f proc-find` returned 3 processes; `proc-find --argv-contains proc-find` returned none. So: signal a pid you read from `ps`/`proc-find`/`pane-signal`, never a string you just composed; bound test children with `timeout` instead of hunting them by name.

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