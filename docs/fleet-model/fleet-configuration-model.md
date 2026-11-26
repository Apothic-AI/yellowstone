# Pi Fleet Configuration Model

**Superseded by [`fleet-configuration-model.v5.md`](fleet-configuration-model.v5.md).**

**Status**: revision 4 — integrated. Decisions locked, alternatives rejected with reasons.
**Date**: 2026-10-31
**Scope**: overlord, leader lanes, worker lanes; pi-modes + pi-profile-switch; herdr spawning
**Evidence rule**: every claim below is either measured on this machine, read from shipped source, or produced by a live test. Unverified items are confined to §10.

---

## 0. Thesis

This fleet's per-turn cost is dominated by **instructions a lane cannot switch off**, not by model choice or tool count.

| Fact | Consequence |
|---|---|
| A lane's context-file stack is fixed by its **cwd**. No extension can remove one. | A worker in its leader's directory costs the same as its leader, with less capability. Worst quadrant. |
| Skills are resolved at **startup** from `PI_CODING_AGENT_DIR` and injected as a name/description/path index. | Per-lane skill narrowing requires a *relocated agent dir*, not a runtime filter. |
| 118 skill descriptions ≈ **9.3k tokens** on every request of every lane. | Skills are the largest controllable cost in the fleet. |
| `~/AGENTS.md` + `~/.overlord/AGENTS.md` = **557 lines / 65k chars ≈ 16.3k tokens**, unsheddable by any config. | The dominant cost is prose, and only rewriting it fixes it. |

Measured baseline before any change:

| Component | Size | ≈ tokens |
|---|---|---|
| `~/AGENTS.md` | 29,130 chars / 201 lines | ~7.3k |
| `~/.overlord/AGENTS.md` | 36,117 chars / 356 lines | ~9.0k |
| Skill index (118 descriptions) | 37,349 chars | ~9.3k |
| **Overlord, before tools or messages** | **~102k chars** | **~25.6k** |
| **Leader or worker, before tools or messages** | **~66k chars** | **~16.6k** |

Every request re-sends this. The plan is judged solely on reducing it.

---

## 1. Decisions locked

The optimal path, committed. Each choice is the one that is *safe and effective*, not merely available.

| # | Decision | Why this and not the alternative |
|---|---|---|
| D1 | **Adopt pi-profile-switch fleet-wide**, installed as the **global launcher from `~/Code/pi-profile-switch`** | It is the only mechanism that narrows skills, and skills are the 9.3k-token line item. Installed from the fork: version-pinned, patchable later, deliberate upgrades. |
| D2 | **Drop `npm:pi-profile-switch` from `settings.json` `packages`** | The launcher injects the extension with `-e`. Keeping both loads it twice and double-registers `/profile`. |
| D3 | **`pil` execs the launcher, not `pi`** | Profiles only exist on the launcher path (§3). `pil` stays one line and keeps sole ownership of identity. |
| D4 | **Three global profiles**: `fleet`, `worker`, `ask`; per-space variation via a project-level profile | Removes the leader/overlord duplication that a four-profile design creates. Project profiles replace a same-named global one wholesale, so distinct names avoid copy-drift. |
| D5 | **Decompose `AGENTS.md` → skills before touching profiles** | Biggest single win (~10–14k tokens), zero infrastructure risk, reversible, and independent of every other step. |
| D6 | **pi-modes shapes prompts; pi-profile-switch scopes resources.** No overlap, no substitution. | They control disjoint layers (§4). Using one in place of the other loses capability, not tokens. |
| D7 | **No fork patch.** Fork is a pinned mirror only. | The one candidate patch is strictly worse than the unpatched launcher (§11). |
| D8 | **Profile and mode are chosen at spawn, never mid-session** (except deliberate, rare switches) | Both re-render the prompt prefix; the launcher's switch path is the expensive one (§8). |

---

## 2. Verified inventory

### 2.1 Package entries in `settings.json` (25)

| # | Entry | Class |
|---|---|---|
| 1 | `npm:@howaboua/pi-subdir-agents` | prompt (late) |
| 2 | `git:github.com/Apothic-AI/bizzy@apothic-main` | infrastructure — `pi-bizzy-bg-tasks` 2.3.0: `bash_bg`, `jobs`, `monitor` |
| 3 | `npm:@99percentpeople/pi-thinking-fold` *(object form, `extensions: ["-index.min.js"]`)* | UX |
| 4 | `npm:pi-web-access` | capability — `web_search`, `fetch_content`, `get_search_content`, `source_check` |
| 5 | `npm:pi-auto-compact` | infrastructure |
| 6 | `npm:@spences10/pi-themes` | UX |
| 7 | `npm:pi-nested-skills` | infrastructure |
| 8 | `npm:@narumitw/pi-btw` | UX |
| 9 | `git:github.com/bitnom/pi-cache-optimizer@feat/opencode-cache-stats` | infrastructure |
| 10 | `git:github.com/Apothic-AI/pi-pretty-tui@test/composer-selection-on-apothic` | UX |
| 11 | `npm:pi-copy-message` | UX |
| 12 | `npm:@timmyjl12/pi-model-picker` | UX |
| 13 | `npm:@arhen/pi-core-tps-stats` | UX |
| 14 | `/home/bitnom/Code/pi-extensions-apothic/packages/pi-goal` | **control plane** — local checkout |
| 15 | `git:github.com/Apothic-AI/pi-rooms@master` | **control plane** |
| 16 | `git:github.com/Apothic-AI/apothic-todo@main` | control plane |
| 17 | `git:github.com/Apothic-AI/pi-persist@main` | prompt (every request) |
| 18 | `npm:agents-cron` | **control plane** |
| 19 | `npm:pi-hermes-memory` | **control plane** |
| 20 | `npm:@xynogen/pix-voice` | UX |
| 21 | `npm:pi-beads-extension` *(object form, `extensions: []`, `prompts: ["./prompts/*.md"]`)* | control plane |
| 22 | `npm:pi-double-paste` | UX |
| 23 | `npm:pi-paster` | UX |
| 24 | `npm:@tryinget/pi-modes` | prompt layer |
| 25 | `npm:pi-profile-switch` | launch layer — **to be removed (D2)** |

`defaultTools: ["+codemode", "+speak"]`.

### 2.2 Builtin extensions

`builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, `builtin:tool-search`.

Verified by live test (§10 T1): a declared profile allowlist does **not** disable them, and they **cannot** be named as profile references. `builtin:codemode` and `builtin:tool-search` are rejected with `unknown extension … not loaded`, while `codemode` still executed (`6*7` → `42`) under a two-package allowlist.

**Rule: never list builtins in a profile.** They load by default and are disabled only by `-builtin:<name>`.

### 2.3 Skill roots

| Root | Count | Narrowed by profiles? |
|---|---|---|
| `~/.agents/skills` | 118 `SKILL.md` (140 dirs) | Yes — force-excluded with `-<path>` |
| `~/.pi/agent/skills` | 8 | Yes — additive allowlist |
| `<project>/.pi/skills` | per project | **No** — project trust governs only |
| package-shipped (`profile-config`, `scheduler`) | — | follows the package |

Agent-dir skills: `avoid-ai-writing`, `dagr-producer`, `humanizer`, `mycord-discord-skill`, `mycord-telegram-skill`, `profile-config`, `vastai`, `vastai-sdk`.

The media/video/design cluster is **42 of the 140 directories** — `hyperframes*`, `archify*`, `faceted-*`, `embedded-captions`, `talking-head-recut`, `product-launch-video`, `motion-graphics`, `slideshow`, `music-to-video`, `general-video`, `media-use`, `design-taste*`, `hallmark`, `high-end-visual-design`, `minimalist-ui`, `industrial-brutalist-ui`, `gpt-taste`, `stitch-design-taste`, `redesign-existing-projects`, `ideogram4-modal`, `cliproxy-media`, `decart`, `lucida*`, `vrm-avatar*`, `easytranscriber`, `qwen-tts*`, `cartesia*`, `spotify-*`, `youtube-*`, `vastai*`, `ai-dj`, `adhd`.

### 2.4 Six prompt surfaces

pi-modes controls **one** of them. Any design assuming otherwise will be surprised by a lane whose prompt is dominated by a surface pi-modes never sees.

| # | Surface | Switchable? |
|---|---|---|
| 1 | Context files — agent dir + cwd + parents + per-dir `AGENTS.override.md` | **Only by cwd** |
| 2 | `SYSTEM.md` / `APPEND_SYSTEM.md` (agent dir, project `.pi/`) | only by profile |
| 3 | `pi-persist` trailing items (`current_datetime`, `todo_reminder`) — every request | only by profile |
| 4 | `pi-hermes-memory` `STANDING.md` (`standingInstructionsEnabled: true`) | only by profile |
| 5 | `pi-modes` base + ordered overlays | **yes, in-session, cheap** |
| 6 | `pi-subdir-agents` — nested `AGENTS.md` appended at discovery | only by profile |

---

## 3. Extension capability matrix

### 3.1 pi-modes (`@tryinget/pi-modes` 0.6.0)

| Controls | Does not |
|---|---|
| Prompt base: `append`, `replace_base`, `replace_final` | Resources (skills/extensions/tools/MCPs) |
| Ordered overlays with `requires` / `conflictsWith` / `before` / `after` | Model or thinking level |
| SHA-256 drift fingerprints, `/mode-reapprove` | Authority of any kind |
| Presets; project-mode confirmation with hidden-character defense | Any of the other five prompt surfaces |
| `/mode-status --json`, `/mode-preview --json` | |

Installed schema properties are exactly `schemaVersion`, `key`, `label`, `description`, `promptStrategy`, `systemPrompt`, `requires`, `conflictsWith`, `before`, `after`. No resource field exists and the source never touches tools or extensions. This will not change; do not plan around it doing so.

### 3.2 pi-profile-switch (0.16.0)

| Controls | Does not |
|---|---|
| `skills`, `extensions`, `mcps`, `tools`, `mcp_tools` allowlists | Ordered prompt composition |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel` | Project-scope resources |
| `instructions` — one appended string, no ordering or drift tracking | Builtin extension selection (cannot be named; not needed) |
| `subagents` role overrides — **inert here**, pi-subagents not installed | |
| `/profile use`, `/profile reload`, `/profile overlay` | |

**Mechanics.** A launcher that spawns `pi -e <its extension>` as a child with `PI_CODING_AGENT_DIR` pointed at `~/.pi-profile-switch/instances/<id>` — a symlink mirror of the real agent dir (§9). Args forward verbatim, so `--print`, `--tools` and `--model` pass through unchanged.

**The launcher is mandatory, not optional.** As a pi package the shipped extension is **inert**: `extensions/pi-profile/index.ts` returns immediately when `PI_CODING_AGENT_DIR` is unset (line 134), and `pi.registerCommand("profile", …)` sits at line 175 — *after* that guard. Under bare `pi`, `/profile` is never registered. Verified: `PI_CODING_AGENT_DIR` is unset in this environment, and the package copy cannot run its own launcher (`Cannot find module '@earendil-works/pi-coding-agent'`, peer not resolvable from `~/.pi/agent/npm/`).

**State today:** installed as `npm:pi-profile-switch` from the registry, so **it does nothing at all**. Provenance: the fork at `~/Code/pi-profile-switch` (`origin` = `Apothic-AI/pi-profile-switch`, `main` @ `5d378fa`, v0.16.0, zero local commits) is byte-identical in every shipped file. `pi-goal` is installed by absolute local path; pi-profile-switch is the one package that broke that convention.

**Reference forms — verified, not guessed.** All three resolve with no diagnostics:

| Form | Resolves to |
|---|---|
| `git:github.com/Apothic-AI/pi-rooms@master` | `@apothic-ai/pi-rooms` → `~/.pi/agent/git/github.com/Apothic-AI/pi-rooms/index.ts` |
| `npm:@tryinget/pi-modes` | `@tryinget/pi-modes` → `extensions/mode.ts` |
| `/home/bitnom/Code/pi-extensions-apothic/packages/pi-goal` | `@signalridge/pi-goal` → `src/index.ts` |

---

## 4. Target architecture

### 4.1 Lane classes

| Class | cwd | Profile | Mode | Rationale |
|---|---|---|---|---|
| **Overlord** | `~/.overlord` | `fleet` | `planning` | Unique second `AGENTS.md`; full control plane |
| **Leader** | `<project>` | `fleet` or `<space>` | project preset | Owns its space's run, beads, room |
| **Worker** | `<project>` (inherited) | `worker` | `worker` base | Narrowed resources; cwd is unavoidable, so the mode carries the terseness |
| **Read-only** | anywhere | `ask` | none | No writes, no control plane |

Worker lanes are **not** cheaper by virtue of being workers — same cwd, same context files. Their saving comes entirely from `worker.json` (skills, extensions, tools) and the `worker` mode's `replace_base`.

### 4.2 Profiles

Saved as `~/.pi-profile-switch/profiles/<name>.json`.

**Why three profiles and not five.** A profile is a *resource declaration*, not a role. Overlord and leader lanes need the same resources, and everything that actually distinguishes them is expressed somewhere a profile does not reach:

| Difference between an overlord and a leader | Expressed by |
|---|---|
| Loads a second `AGENTS.md` (its own space's) | **cwd** |
| Orchestrator framing vs project framing | **pi-modes mode/preset** |
| Which resource set *this lane* uses | **its own `/profile use` selection** |
| Project stack skills | **`<project>/.pi/skills`** — never narrowed by a profile |

Profiles are shared declarations; **selections are per-lane**. The overlord pins `fleet` in `~/.overlord`; each leader pins `fleet` in its own repo. Two lanes, two selections, one declaration.

A `leader.json` twin would be byte-identical except for one optional entry, duplicating 23 extension identifiers and 11 skill names. The failure mode of that duplication is silent: a new control-plane extension added to one file and missed in the other breaks an entire lane class, and it surfaces as "beads doesn't work in that space" rather than as an error.

When a lane class genuinely diverges, the mechanism already exists: a space writes `<project>/.pi/profiles/<space>.json` under a **distinct name** — never a same-named override, because a project profile replaces the global one wholesale and an "override" becomes silent duplication. A media space adding `pix-voice` and the render skills is the canonical case.

If a genuinely overlord-only resource ever appears, splitting `fleet` becomes warranted. Today none exists: rooms, goals, beads, scheduling, memory, persist and todo are used by both roles, and `fleet` is named for the resource set rather than for a role so that the shared ownership stays obvious.

#### `fleet.json` — control plane for overlord and leaders

```json
{
  "label": "Fleet",
  "description": "Orchestrator lane: full control plane, no project edits",
  "extensions": [
    "/home/bitnom/Code/pi-extensions-apothic/packages/pi-goal",
    "git:github.com/Apothic-AI/pi-rooms@master",
    "git:github.com/Apothic-AI/apothic-todo@main",
    "git:github.com/Apothic-AI/pi-persist@main",
    "git:github.com/Apothic-AI/bizzy@apothic-main",
    "git:github.com/bitnom/pi-cache-optimizer@feat/opencode-cache-stats",
    "npm:agents-cron",
    "npm:pi-hermes-memory",
    "npm:pi-beads-extension",
    "npm:@tryinget/pi-modes",
    "npm:pi-nested-skills",
    "npm:pi-web-access",
    "npm:pi-auto-compact",
    "npm:@howaboua/pi-subdir-agents",
    "npm:@spences10/pi-themes",
    "git:github.com/Apothic-AI/pi-pretty-tui@test/composer-selection-on-apothic",
    "npm:@timmyjl12/pi-model-picker",
    "npm:@arhen/pi-core-tps-stats",
    "npm:pi-copy-message",
    "npm:pi-double-paste",
    "npm:pi-paster",
    "npm:@narumitw/pi-btw",
    "npm:@99percentpeople/pi-thinking-fold"
  ],
  "skills": [
    "dagr-producer", "beads", "unblock", "herdr", "agents-cron",
    "profile-config",
    "context-economy", "lane-identity", "pi-goal-contracts",
    "pi-rooms-protocol", "pi-hermes-memory-usage"
  ],
  "mcps": ["*"],
  "tools": ["*"],
  "defaultProvider": "subrouter-deepseek-flash",
  "defaultModel": "deepseek-v4.1-flash-1017",
  "defaultThinkingLevel": "max"
}
```

`context-economy`, `lane-identity`, `pi-goal-contracts`, `pi-rooms-protocol` and `pi-hermes-memory-usage` are **created by Phase 2** (§6); they do not exist yet. Listing a missing skill produces a warning and continues, so ordering is safe but noisy — create the skills first.

Two entries are **deliberately absent** and are not oversights:
- `npm:@xynogen/pix-voice` — voice is the `comms` lane's job. A space that needs it gets a project profile.
- `npm:pi-profile-switch` — injected by the launcher via `-e` (D2).

#### `worker.json` — bounded task in a leader's space

```json
{
  "label": "Worker",
  "description": "Bounded task: no scheduling, no self-goal, no room creation",
  "extensions": [
    "git:github.com/Apothic-AI/pi-rooms@master",
    "git:github.com/Apothic-AI/apothic-todo@main",
    "git:github.com/Apothic-AI/bizzy@apothic-main",
    "git:github.com/Apothic-AI/pi-persist@main",
    "npm:pi-hermes-memory",
    "npm:@tryinget/pi-modes",
    "npm:pi-nested-skills",
    "npm:pi-web-access",
    "npm:pi-auto-compact",
    "npm:@howaboua/pi-subdir-agents",
    "git:github.com/Apothic-AI/pi-pretty-tui@test/composer-selection-on-apothic",
    "npm:@arhen/pi-core-tps-stats",
    "npm:pi-copy-message"
  ],
  "skills": ["beads", "context-economy"],
  "tools": [
    "read", "bash", "edit", "write", "grep", "find", "ls",
    "todo", "codemode", "tool_search",
    "bash_bg", "jobs", "monitor"
  ],
  "defaultProvider": "subrouter-deepseek-flash",
  "defaultModel": "deepseek-v4.1-flash-1017",
  "defaultThinkingLevel": "high"
}
```

Each inclusion or omission is a decision:

- **`pi-rooms` kept.** Policy forbids workers *creating* rooms but requires them to answer in one they were added to. Dropping it would make every worker unreachable in a room — a policy/capability mismatch, not a saving.
- **`pi-goal` dropped.** Workers take briefs, not objectives; only orchestrators set goals, and `toolVisibility: after-first-goal` hides the tools anyway until a goal exists.
- **`agents-cron` dropped.** Policy already forbids workers from scheduling.
- **`bash_bg`, `jobs`, `monitor` kept (bizzy).** Workers run long commands and must background them; the fleet contract requires progress piped to a log rather than a blocked session.
- **`pi-web-access` kept.** Research is ordinary worker work.

#### `ask.json` — read-only

```json
{
  "label": "Ask",
  "description": "Read-only Q&A: no writes, no control plane",
  "extensions": [
    "npm:pi-web-access",
    "npm:pi-hermes-memory",
    "npm:@howaboua/pi-subdir-agents"
  ],
  "skills": ["context-economy"],
  "tools": [
    "read", "bash", "grep", "find", "ls",
    "web_search", "fetch_content", "get_search_content", "source_check",
    "memory_search", "session_search",
    "codemode", "tool_search"
  ],
  "defaultProvider": "subrouter-deepseek-flash",
  "defaultModel": "deepseek-v4.1-flash-1017",
  "defaultThinkingLevel": "medium"
}
```

Every listed tool must have a loaded provider. An earlier draft declared `"extensions": []` while listing `web_search`, `fetch_content` and `memory_search` — tools that do not exist without `pi-web-access` and `pi-hermes-memory`. `skills: []` would also disable `profile-config`, making profiles uneditable conversationally from this profile; edit from `default`.

#### Per-space profiles

A space needing more than `fleet` writes `<project>/.pi/profiles/<space>.json` — a **distinct name**, derived from `fleet.json`, never a same-named override (a project profile replaces the global one wholesale, which turns an override into silent duplication). Pin it with `/profile use <space>` once inside that project; the launcher remembers it per project.

### 4.3 pi-modes presets

Resource scope is the profile's job; prompt shape is the mode's. Because a worker inherits its leader's cwd, the mode is the only lever that makes its *instructions* terse.

`~/.pi/agent/modes/worker.json`:

```json
{
  "schemaVersion": 2,
  "key": "worker",
  "label": "Worker",
  "description": "Bounded task. Deliver the brief, report evidence, stop.",
  "promptStrategy": "replace_base",
  "systemPrompt": "You are a worker lane executing one brief. Deliver exactly what the brief asks and nothing adjacent. Report completion with the artifact: file path, commit, test count, or command output. Never claim success you did not verify. Never create rooms, never schedule work, never set goals. If blocked, say what is missing and who owns it, then stop."
}
```

`replace_base` sets the base, and Pi still appends context files, skills and cwd — so the worker keeps its directory's rules while losing the orchestrator framing. It cannot drop an `AGENTS.md`; only a different cwd can (§7).

Presets:

| Preset | Composition | Use |
|---|---|---|
| `planning` | `native` + `plan` | Overlord planning turns |
| `deep-review` | `native` + `plan` + `review` | Reviewing a lane's output |
| `overlord` | `native` + `plan` + `explain` | Default overlord shaping |
| `worker` | base `worker`, no overlays | Every worker lane |

Project presets live in `<project>/.pi/mode-presets/` and require `--confirm-project` on first use.

> **Phase 5 finding — pi-modes does not compose with the launcher.** `pi-modes` fails closed on a symlinked mode path (`src/mode-definitions.ts:322`, `mode path crosses symbolic-link boundary`), and the wrapper symlinks the *whole* agent dir into the instance — `modes/` and `mode-presets/` included. So `~/.pi/agent/modes/worker.json` is unreachable under **any** profile, and every preset in `~/.pi/agent/mode-presets/` is too.
>
> Verified: `pi-profile fleet` emits `Prompt mode warning: …/instances/<id>/modes: mode path crosses symbolic-link boundary` on every launch.
>
> Consequences: (a) the `worker` mode's terse `replace_base` — one of the two levers that makes a worker cheaper than its leader — does not take effect under the `worker` profile; (b) overlays (`plan`, `review`, `explain`) are unavailable in any profiled lane. Modes still work on bare `pi`, and per-project modes still work in a **trusted** project (`<project>/.pi/modes`) because those are read from the project dir, not through the agent dir. `~/.overlord` is not in `trust.json`, so project modes do not work there either.
>
> Options: (1) fork-patch the generator to materialize `modes`/`mode-presets` as real copies per instance instead of symlinks; (2) accept pi-modes as a bare-`pi`-only tool and drop it from the profiled lane classes; (3) move per-space modes into trusted project dirs. Not decided.

### 4.4 What the narrowing buys

| Lane | Skills | Δ from today |
|---|---|---|
| Overlord / leader | 11 named | ~9.3k → ~0.9k = **−8.4k** |
| Worker | 2 named | ~9.3k → ~0.2k = **−9.1k** |
| Ask | 1 named | ~9.3k → ~0.1k = **−9.2k** |

Plus Phase 2's decomposition, which removes ~10–14k of always-on `AGENTS.md` text from *every* lane independently of profiles.

---

## 5. Spawning

### 5.1 `pil` gains one line

`pil` derives the lane name from the herdr tab label, exports `PI_ROOMS_NAME`, renames the herdr agent in the background, then `exec`s the real binary. Profiles exist only on the launcher path (§3.2), so the exec target changes:

```bash
# was: exec "$PI_BIN" "$@"
exec "$(command -v pi-profile)" "$@"
```

That is the whole change. `pil` still resolves no profiles, names no lanes, and knows nothing about resources. `PI_ROOMS_NAME` survives because the launcher spawns with `{...process.env, ...generated.env}` and sets only `PI_CODING_AGENT_DIR`.

Two mechanical notes:

- **No recursion risk.** `pi-profile` spawns `pi` by bare name; Node's `spawn` does not see shell functions, so the `.bashrc` `pi()` → `pil` shim cannot loop.
- **Process tree.** The pane's foreground process becomes the wrapper, which spawns `pi` as a child with `stdio: "inherit"`. Pane reads, footer inspection and `herdr agent prompt` still work; the wrapper forwards SIGINT/SIGTERM.

Resolution order when `pil` passes no profile argument: the project's saved selection → the global saved selection → `default`. So each space self-pins, and no spawn command needs a profile argument.

```bash
# pin once, inside the space
cd ~/Code/neti && /profile use neti     # then every `pil` in this cwd uses it
```

### 5.2 Deliberate overrides

For a one-off worker in a leader's cwd, bypass resolution explicitly:

```bash
herdr pane create --name "reviewer-neti" --cwd . --command "pi-profile worker"
```

Name the tab first — `pil` refuses an auto-generated numeric label, and the name is fixed at spawn.

### 5.3 `agents-cron`

Tasks run as isolated `pi --print` sessions in their **own** cwd, so they inherit that project's context-file stack, not the registering lane's. They run on **plain `pi`**, not the launcher, and pin their capability in the task record:

```bash
agents-cron add --name "daily-neti-health" --schedule "0 6 * * *" \
  --prompt-file /path/brief.md \
  --model "subrouter-deepseek-flash/deepseek-v4.1-flash-1017" \
  --thinking max \
  --tools read,bash,grep,web_search
```

Rationale: a scheduled task's capability must be fixed in the task record. Routing it through a profile makes a profile edit silently change what a scheduled job can do — the failure mode is invisible until it matters. `pi-profile <name> --print` does work (args forward verbatim) and remains available for a task that genuinely needs profile narrowing.

---

## 6. Migration phases

Optimal order: cheapest-and-safest highest-leverage first, infrastructure only when it unlocks something, adoption last.

### Phase 1 — measure (no changes)

On a scratch lane record the footer `%/1M` for: plain `pi`, `pi-profile ask`, `pi-profile worker`. Confirms the §0 model before committing to it.

### Phase 2 — decompose `AGENTS.md` → skills

The biggest win, with no infrastructure dependency and full reversibility.

1. Create the new skills under `~/.agents/skills/`: `context-economy`, `lane-identity`, `pi-goal-contracts`, `pi-rooms-protocol`, `pi-hermes-memory-usage`. Reuse the existing `beads`, `agents-cron`, `dagr-producer`, `unblock`, `herdr` skills unchanged.
2. Reduce `~/AGENTS.md` to an invariant core (~40 lines): the unrecoverable-if-missed actions, hard naming invariants, and pointers to skills.
3. Reduce `~/.overlord/AGENTS.md` the same way (~60 lines): the eight numbered operational invariants plus the escalation boundary.
4. Verify a fresh leader lane can still name its lane, load `beads`, load `dagr-producer`, and answer "may I write into a project repo?" — without the removed text.
5. `~/.overlord/tools/reload-fleet`.

### Phase 3 — install the launcher and move the spawn path

1. `cd ~/Code/pi-profile-switch && npm install && npm install -g .` — installs the launcher from the fork, with its peer resolved.
2. Remove `"npm:pi-profile-switch"` from `settings.json` `packages` (D2).
3. Change `pil`'s exec target (D3).
4. Restart one lane and confirm: `/profile` exists, `rooms_who` shows the lane under its tab-derived name, `jobs list` works, `goal` tools appear after `/goal add`.

### Phase 4 — profiles and pins

1. Write `fleet.json`, `worker.json`, `ask.json`.
2. Pin the overlord: `/profile use fleet` in `~/.overlord`.
3. Pin each leader space: `/profile use fleet` (or its own project profile) in that repo.
4. Confirm `/profile status` reports the resolved resource counts you expect.

### Phase 5 — modes

1. Write `~/.pi/agent/modes/worker.json`.
2. Write the `planning`, `deep-review`, `overlord` presets.
3. Per-space presets in `<project>/.pi/mode-presets/` as needed.

### Phase 6 — prove the two unverified paths (§10)

1. One real `agents-cron` firing, no TTY.
2. One control-plane lane doing `/profile use` → `goal_complete` on a live goal.

### Phase 7 — rolling adoption

Leaders first (one quiet space, one full tranche: rooms reply, goal complete, todo persistence, `jobs` after a `bash_bg`), then the overlord last because it is the intake surface, then workers via brief convention.

---

## 7. The cwd-only constraint

Pi renders its prompt as: base (`customPrompt` under `replace_base`) → addendum → context files → skills → cwd.

- `pi-modes` `replace_base` **cannot** drop an `AGENTS.md`. It sets the base; Pi appends context files after it.
- `pi-profile-switch` **cannot** drop project-scope context files — its own docs state project resources are never encoded: *"Pi discovers them natively whenever the project is trusted."*
- `AGENTS.override.md` replaces a same-directory `AGENTS.md` only *in that directory*.

Therefore a cheaper instruction set comes from (a) a different cwd, or (b) a smaller file. There is no third lever — which is why Phase 2 is a writing task, not a configuration task.

---

## 8. Cache economics

`pi-cache-optimizer` rewards prefix stability.

| Action | Effect |
|---|---|
| `pi-modes` overlay switch | prefix intact — overlays render last as `prompt_overlay_<n>` |
| `pi-modes` `replace_base` / `replace_final` | new prefix — expensive, choose at spawn |
| `/profile use` | rewrites `settings.json` + runtime dir — new prefix, most expensive |
| `pi-persist` `section` edit | invalidates everything after it — avoid |
| `pi-persist` `trailing` edit | never cached, never invalidates |

Current `pi-persist` config is both-trailing (`current_datetime`, `todo_reminder`) — correct, keep it. Never move `bd prime` or memory output into a `section`.

Rule (D8): **stable at spawn, cheap at the margin.**

---

## 9. State fidelity (verified)

The wrapper relocates `PI_CODING_AGENT_DIR` to `~/.pi-profile-switch/instances/<id>`, then **symlink-mirrors the entire real agent dir** into it. `syncAgentSymlinks` reads every agent-dir entry and links files and directories alike, skipping only `MANAGED_INSTANCE_FILES` (`settings.json`, `mcp.json`, `APPEND_SYSTEM.md`, `pi-profile.json`, `trust.json`, `pid`, `extensions`).

`SEEDED_STATE_FILES` / `SEEDED_STATE_DIRS` are **not** an allowlist. They pre-create paths Pi makes at runtime, so a dangling link exists before Pi's first write and the write lands in the real agent dir instead of being stranded in a swept instance.

Observed on a real declared-selection profile: `pi-goal.json`, `pi-persist.json`, `bizzy.json`, `hermes-memory-config.json`, `pi-todo-state.json`, `model-picker.json`, `pi-auto-compact.json`, `rooms/`, `pi-hermes-memory/`, `pi-cache-optimizer-stats.d/`, `sessions/`, `missions/`, `auth.json`, `models-store.json` — all symlinks into `~/.pi/agent`. Per-instance real files were exactly `settings.json`, `mcp.json`, `pi-profile.json`, `pid`. `mode-approvals.json` was absent only because it does not exist in the real dir yet; the mirror links what exists.

**This is why D1 is fleet-wide.** An earlier revision of this document claimed goal/persist/bizzy/memory state was unseeded and made that a blocker. It read `SEEDED_STATE_FILES` without reading `syncAgentSymlinks`. There is no seeding work, and nothing for the fork to patch.

| Concern | Status |
|---|---|
| Goal / persist / bizzy / memory / rooms / todo state | shared by symlink — no action |
| `settings.json` per instance | by design — it is the filter |
| Two lanes writing one shared state file | pre-existing; all lanes already share `~/.pi/agent` |
| `APPEND_SYSTEM.md` | **managed** — the generator writes a profile's `instructions` into the instance copy; it does not merge with a global one. You have none today, so no conflict — but do not introduce one while using profile `instructions`. |

---

## 10. Verification checklist

Only genuinely unverified items remain. Everything else is measured or read from source.

| # | Item | How |
|---|---|---|
| **T1** | ~~Builtin refs and codemode survival~~ | **Done.** Builtins rejected as references; `codemode` executed under a two-package allowlist |
| **T2** | ~~Reference forms~~ | **Done.** `git:`, `npm:` and absolute-path forms all resolve |
| **T3** | ~~State sharing~~ | **Done.** All state symlinked (§9) |
| **T4** | ~~`--print` under the wrapper~~ | **Done.** Exit 0, clean stdout, correct stream split |
| **T5** | Per-type package filters survive the profile rewrite | `pi-thinking-fold` carries `extensions: ["-index.min.js"]`, `pi-beads-extension` carries `extensions: []` + `prompts: [...]`. The instance's `packages` array kept all 25 entries in order; the per-type filters were **not** inspected. Diff `settings.json` in the instance against `~/.pi/agent/settings.json` |
| **T6** | One `agents-cron` firing with no TTY | Install one low-frequency task under the launcher's PATH; read its run artifact |
| **T7** | A live goal survives a profile switch | In a control-plane lane: `/goal add …` → change profile → `goal_complete` |
| **T8** | ~~Per-type package filters survive the profile rewrite~~ | **Answered — and worse than expected.** A settings package whose `extensions` filter leaves nothing selectable cannot be referenced at all: `npm:@99percentpeople/pi-thinking-fold` (`extensions: ["-index.min.js"]`) and `npm:pi-beads-extension` (`extensions: []`) both report *"declares no extension entries … not loaded"*. Beads survives anyway (its prompts are an unmanaged kind that passes through). **Thinking-fold is genuinely lost** in any declared profile — cosmetic UX only. `npm:@spences10/pi-themes` was never a referenceable extension (it is a themes package); themes survive as an unmanaged dir. `mcps: ["*"]` matched nothing and was removed. |
| **T9** | pi-modes composes with the wrapper | **No — see §4.3.** Symlinked `modes/` is rejected by pi-modes' symlink-boundary check. |

---

## 11. Rejected alternatives

Recorded so they are not re-proposed.

| Alternative | Rejected because |
|---|---|
| **Fork-patch the extension to register `/profile` without `PI_CODING_AGENT_DIR`** | Two disqualifiers. (a) Under bare `pi` the in-session switch rewrites "the runtime files in place", i.e. the *real* `~/.pi/agent` — `settings.json`, `mcp.json`, `APPEND_SYSTEM.md`, `trust.json` — live for all 60 lanes. (b) It still cannot narrow skills: the index is resolved at startup into the cached prefix. Strictly worse than the unpatched launcher, with a fleet-wide blast radius. |
| **Keep `pil` on bare `pi`, use `PI_PROFILE` env** | `PI_PROFILE` is not a documented selection input (the documented inputs are the project and global saved selections). And with `PI_CODING_AGENT_DIR` unset the extension is inert, so no env var can help. |
| **Per-lane hand-maintained `PI_CODING_AGENT_DIR`** | It is the wrapper's own mechanism without the wrapper: more code to own, and it re-implements symlink mirroring that is already verified correct. |
| **Maintain a four-profile split (`overlord.json` + `leader.json`)** | Duplicates 23 extension identifiers and ~11 skill names across two files that differ by one optional entry. Violates D4; per-space project profiles cover the real differences. |
| **Narrow `extensions` but not `skills`** | Leaves the 9.3k-token index untouched, which is the largest single controllable line. |
| **`skills: ["*"]` with skill discipline instead of an allowlist** | Compliance is not a mechanism. A lane cannot decline to load a description it was handed. |
| **Move prompt bulk into `pi-modes` `replace_base` instead of skills** | `replace_base` still renders context files after it (§7), so it cannot remove the `AGENTS.md` cost; and it makes every edit a drift event requiring `/mode-reapprove`. |
| **Route `agents-cron` through a profile** | A profile edit would silently change a scheduled task's capability. Keep capability pinned in the task record (§5.3). |
| **Delete the fork** | It costs nothing to keep and is where any future patch would land, given upstream is byte-identical today. Keep as a pinned mirror; it holds no commits of ours. |

---

## 12. Summary table

| Concern | pi-modes | pi-profile-switch | Context files | pi-persist | hermes STANDING | subdir-agents |
|---|---|---|---|---|---|---|
| Skills | — | ✅ allowlist | — | — | — | — |
| Extensions / tools | — | ✅ allowlist | — | — | — | — |
| Model / thinking | — | ✅ | — | — | — | — |
| Prompt ordering | ✅ | — | — | — | — | — |
| Drift detection | ✅ | — | — | — | — | — |
| Removable by cwd? | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Switchable in-session | ✅ cheap | ⚠️ expensive | ❌ | ⚠️ | ❌ | ❌ |

---

## 13. Verdict

Adopt both, fleet-wide, and rewrite `AGENTS.md` first.

- **Phase 2 is the plan.** 557 lines of always-on instruction, unsheddable by any extension, is the dominant cost. No configuration change touches it.
- **pi-profile-switch is Phase 3**, because skills are the second-largest cost and only a relocated agent dir can narrow them. The launcher is mandatory; the package-only install is inert; the fork needs no patch.
- **pi-modes shapes prompts** — cheap overlays in-session, `replace_base` for worker lanes. It cannot scope resources and never will.
- **Verify T5–T7 before rolling across the fleet.** Everything else is already measured.

Projected steady state for an orchestrator lane: ~25.6k → ~7k tokens of fixed overhead per request, with the remaining bulk being tools and message history rather than instructions the lane cannot refuse.