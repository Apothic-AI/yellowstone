# Running a lane in this fleet

How to start, scope and check an agent lane. One page. Everything deeper is linked at the bottom.

---

## Start a lane

A lane's **role** is expressed by two artifacts chosen at spawn — a **mode** (its prompt and duties) and a **profile** (its resources). The shared `~/AGENTS.md` is role-neutral and contains no "if you are a leader" clauses.

| You want | Command |
|---|---|
| A **leader** lane (orchestrates one space) | `PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil` |
| A **worker** lane (executes one brief) | `PI_MODE=worker PI_PROFILE=worker pil` |
| The **overlord** | `pil` in `~/.overlord` — its contract is that space's `AGENTS.md` |
| Read-only Q&A | `pi-profile ask` |
| Plain pi | `pi` — debugging only; you lose `/profile`, `/mode`, and the narrowing |

`PI_MODE_CONFIRM_PROJECT=1` is in the leader line above because **the normal case is a space with a
project mode** (a `.pi/modes/leader.json` in that space). It is a no-op in a space that has none —
include it unless you have actually checked that there is no project mode file, because getting it
wrong is silent: an unconfirmed project mode blocks the **whole** composition and the lane falls back
to the **native** prompt, losing its role contract entirely, not just the space half. The flag is per
process and per content, so it belongs
in the launch line, not in an option. See `~/Documents/Fleet/AGENTS.md` for the worked example.

`pil` names the lane from the **herdr tab label**, so name the tab before you start. A tab still called `12` yields an unnamed lane.

**Never run `pil` from inside a lane.** It claims the name of the pane it runs in, then deregisters it on exit — which deletes the real lane's registry entry. Test from a pane with no lane, or set `PI_LANE_NAME`.

## The three profiles

| Profile | Skills | Tools | Use for |
|---|---|---|---|
| `leader` | 14 (control plane) | all | leaders, the overlord |
| `worker` | 3 | 13, incl. `bash_bg`/`jobs`/`monitor` | bounded tasks |
| `ask` | 1 | 13, read-only | questions, no writes |

The default for a new launch is whatever was last selected — currently `leader`.

```sh
/profile status          # what you resolved, and why
/profile use worker      # switch, and remember it for next launch
/profile reload          # re-read after editing a profile file
```

Profiles live in `~/.pi-profile-switch/profiles/<name>.json`. A space can add its own under `<project>/.pi/profiles/<space>.json` — use a **distinct name**, never an override.

**Why `PI_PROFILE=worker` and not bare `pil` for workers:** profile selection is cwd-based, and a worker shares its leader's directory (so it inherits that space's `AGENTS.md`). Without the prefix it silently gets the leader's `leader` profile — 14 skills instead of 3.

### How a skill reaches a lane

A profile's `skills` array is an **allow-list of names**, not paths. At launch `pi-profile` runs
pi's own discovery over the real agent dir and the cwd, then writes the instance's
`settings.json` with a `-<path>` exclusion for **every discovered skill the profile did not
name**. The exclusions are what a lane feels; the resolution is recorded in
`instances/launch-*/pi-profile.json` → `resolved.skills`.

| Route | Lanes that get the skill |
|---|---|
| Named in the lane's profile | that profile's lanes — the only route that works for a narrowed profile |
| Auto-discovered from `~/.agents/skills/` with no exclusion | default (unfiltered) launches, which have no profile and therefore no exclusion list |
| Project skills (`<space>/.agents/skills/`, ancestor `.agents/skills/`) | every lane whose cwd is in that space — pi discovers these natively; a profile neither adds nor removes them |
| A package's `skills:` or `pi-nested-skills` | lanes that load that package/extension |

The name must resolve at `~/.agents/skills/<name>/SKILL.md`; `bash test/verify-profile-skills.sh`
in the yellowstone repo is the gate that fails a profile naming a skill that is not installed.

**Adding a skill to a lane that is already running takes `/profile reload`, not `/reload`.** The
exclusion list is generated at launch and survives a pi reload; `/profile reload` re-resolves
through the launcher path, rewrites `settings.json` and calls `ctx.reload()`. A relaunch always
picks it up.

FT-77 (2026-11-17): both role profiles name `git-subrepo-skill`, so leaders and workers get the
operator's globally installed subrepo skill; `ask` deliberately does not.

## Modes

Modes shape the *prompt* and carry a role's duties; profiles choose the *resources*.

| Mode | What it asserts |
|---|---|
| `leader` | you orchestrate one space; drive it through lanes, verify from artifacts, stay inside your space |
| `worker` | you execute one brief; deliver the artifact, report evidence, stop |

```sh
/mode                    # pick base + overlays
/mode use planning       # presets: planning, deep-review, overlord
/mode set leader         # switch role in-session
```

Modes work only under the launcher. They live in `~/.pi/agent/modes/` and `~/.pi/agent/mode-presets/`.

A mode's `replace_base` replaces pi's native base prompt outright — verified: in a `leader` lane the only "You are …" sentence in the composed prompt is the leader contract. `AGENTS.md` still appends after it, which is why that file must stay role-neutral.

## Session switching and role state

`/new` and `/resume` keep the current Pi process and profile runtime. `pi-modes` applies the process `PI_MODE` selector to startup and fresh `/new` sessions, whose branches are empty; `/resume`, `/reload`, and `/fork` restore the mode selection recorded in the selected session and validate it against current definitions and project approvals. `pi-profile` reapplies its already-materialized launch plan on each session start, but does not re-resolve `PI_PROFILE` or the profile catalog. Herdr's managed integration updates the live session pin, while `session-tracker.ts` updates the durable lane record. See `EXECUTION-RECORD.md` §34 for the live disposable-lane verification and edge cases. Fleet support is Linux-only by design; Windows/macOS are outside scope.

## Check a lane

- **Footer** — `profile: leader`, `rooms: <name>`, `3.5%/1.0M`. That percentage is context used; `CH98%` beside it is cache hit rate, not cost.
- **Registration** — `rooms_who`. A footer name is *not* evidence of registration.
- **Profile** — `/profile status`.

## Starting a worker from another lane

```sh
herdr pane create --name "reviewer-myspace" --cwd . --command "PI_PROFILE=worker pil"
```

Name the tab, spawn in the owning space's cwd so it inherits the right `AGENTS.md`, and give it a brief with what to change, why, what "done" is, and what not to touch.

## Reloading the fleet

`~/.overlord/tools/reload-fleet --verify` reloads idle lanes and includes its own lane automatically. The self reload is deferred until the coordinating Pi turn exits, so it cannot interrupt the command coordinating fleet reload. Its detached helper waits up to 24 hours, writes atomic `waiting`, `reloading`, `confirmed`, `waking`, `woken`, `wake_failed`, or `failed` state under `~/.local/state/pil/reload-results/`, and sends one provenance-labeled wake prompt only after confirmed reload. Working lanes are skipped by default.

To interrupt other working lanes explicitly, use `reload-fleet --interrupt-working --verify`. The script sends `Esc` to lanes observed working, waits for a confirmed idle status, rechecks before sending `/reload`, then verifies the result and issues a cautious resume nudge. Lanes that do not reach idle are skipped and cause a nonzero exit. Use `--working-only` to target only currently working lanes, or `--idle-timeout SECONDS` to change the default 30-second wait. Review the target set first with `--dry-run`.

**A reload terminates the lane's background children — launch long work detached.** `/reload` (and
`/profile reload`, and therefore `~/.overlord/tools/reconcile-mode.py`) ends the lane's `bash_bg` jobs
and any process running as a direct child of the session. Measured 2026-11-08: a pinned
`/mode-reapprove` to `lfm3-leader` killed a `llama-server` **8m47s into a 256K prefill** — its log ends
`operator(): cleaning up before exit...`, `jobs` no longer knew the id, and the run produced nothing.
The cost lands hardest on hardware work, where a prefill is minutes, but it applies to any background
job. Anything whose loss costs minutes must be started **detached** (`setsid nohup <cmd> &`) or from a
worker pane, so a reload cannot reach it. This is the one reload consequence that is not merely
inconvenient, and it is why a lane should never treat a `bash_bg` handle as durable state.

## Known cosmetic issues — don't chase these

| Symptom | Reality |
|---|---|
| `[skills] … skill root is not a directory` after a profile switch | `pi-nested-skills` refusing a symlinked root. Harmless — all 13 skills still load |
| `/profile` does not exist | You started with bare `pi`, not `pil`/`pi-profile`. The extension is inert without the launcher |
| `agents-cron list` empty | No tasks are scheduled. That is the normal state |
| `npm test` on the pi-profile-switch fork: 1 failure | Pre-existing, reproduces at the upstream base commit. `npm run check` passes |

## Rules that surprise people

- **Profile and mode are config, and whose call that is depends on your role.** Changing another
  lane's is **not** yours by default — but a role file can grant it: `self-improvement-leader` holds
  a standing grant over fleet/harness config (modes, profiles, skills, hooks, extensions, every
  `AGENTS.md`) and over re-approving a mode definition on a lane whose mode file it changed. Read
  this rule as "not yours **unless your role file grants it**", and check that file rather than
  assuming either way.
- **Choose them at spawn.** A mid-session switch rewrites the prompt prefix and is expensive.
- **Restarting a lane is disruptive.** A bare-`pi` lane that predates the launcher keeps no profile until it restarts — that is expected, not broken.
- **One leader per project.** Don't seat an agent in an empty leader tab; report it.
- **Switching profiles re-mints the active goal's id.** The goal itself survives — objective, paused state, queue position — but the first `goal_complete` carrying the old id is rejected once. Re-read the id and complete again; don't re-send the objective.

## Where things live

| What | Path |
|---|---|
| Instructions | `~/AGENTS.md`, `~/.overlord/AGENTS.md` |
| Skills | `~/.agents/skills/<name>/SKILL.md` |
| Profiles | `~/.pi-profile-switch/profiles/` |
| Modes / presets | `~/.pi/agent/modes/`, `~/.pi/agent/mode-presets/` |
| Settings + packages | `~/.pi/agent/settings.json` |
| Launcher (patched fork) | `~/Code/pi-profile-switch` |
| Fleet hooks package | `~/Code/pi-fleet-hooks` |

## Deeper reading

| Doc | For |
|---|---|
| `CURRENT-STATE-herdr-pin-drift.md` | **read first if the topic is herdr/Pi session pinning** — resolved state, live build, test-failure triage, known limitations |
| `fleet-configuration-model.v5.md` | the design, decisions, and what was rejected |
| `EXECUTION-RECORD.md` | what was changed, with evidence and mistakes |
| `OVERLORD-BRIEFING.md` | what the overlord must know after a restart |
| `HANDOFF-fleet-migration.md` | current state and what remains, in one page |
| `PER-SPACE-DECOMPOSITION.md` | the per-space `AGENTS.md` analysis and the on-activation recipe |
| `SPACE-ROLE-INSTRUCTIONS.md` | leader-only text in a shared space — project mode overlay, the two trust gates, proven through `pil` |
| `BDI-JOIN-DIAGNOSIS.md` | why the beady-eye dashboard shows no live agents, and the data fix |
| `PR-beady-eye.md` | the beady-eye upstream PR prepared and not opened, plus the withdrawn one and why |
| `SPACE-ROLE-INSTRUCTIONS.md` | **leader-only text in a shared space** — the project mode overlay + `PI_MODES` composition, configured and proven |
| `evidence/modes-proof.txt` | the transcript greps behind that proof: one cwd, leader vs worker |
| `evidence/modes-proof.txt` | the transcript greps behind that proof: one cwd, leader vs worker |