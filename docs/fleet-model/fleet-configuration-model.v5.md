# Pi Fleet Configuration Model — v5

**Status**: v5 — supersedes `fleet-configuration-model.md` (v4, revision 4) and `fleet-configuration-model.md.bak` (v3).
**Date**: 2026-10-31
**Scope**: overlord, leader lanes, worker lanes; pi-modes + pi-profile-switch; herdr spawning
**Evidence rule**: every claim is measured on this machine, read from shipped source, or produced by a live test. Unverified items are confined to §10.

**What changed since v4.** v4 planned for five skill extractions and four profiles, and recorded pi-modes as incompatible with the launcher. v5 reflects what was actually built: seven skills, three profiles, a patched fork (ADR-0019) that restores modes under the launcher, a new extension repo for the fleet hooks, and the discovery that declaring `extensions` in a profile silently drops every loose script extension.

---

## 0. Thesis

This fleet's per-turn cost is dominated by **instructions a lane cannot switch off**, not by model choice or tool count.

| Fact | Consequence |
|---|---|
| A lane's context-file stack is fixed by its **cwd**. No extension can remove one. | A worker in its leader's directory costs the same as its leader, with less capability. |
| Skills are resolved at **startup** from `PI_CODING_AGENT_DIR` and injected as an index. | Per-lane skill narrowing requires a *relocated agent dir*, not a runtime filter. |
| 125 skill descriptions ≈ **9.9k tokens** on every request of every lane. | Skills are the largest controllable cost. |
| Context files were 557 lines / ~16.3k tokens, unsheddable by any config. | The dominant cost was prose. **Now fixed — §2.** |

### 0.1 Measured state

| Component | Before | After | Change |
|---|---|---|---|
| `~/AGENTS.md` | 201 lines / 29,130 ch | **82 / 4,250** | −85.4% |
| `~/.overlord/AGENTS.md` | 356 / 36,550 | **123 / 6,357** | −82.6% |
| Context files, combined | ~16.4k tokens | **~2.7k** | **−13,768 tok/request** |
| Skill index, orchestrator | ~9.3k | **~1.1k** (13 skills) | −8.2k |
| Skill index, worker | ~9.3k | **~0.2k** (2 skills) | −9.1k |

**Realized, measured from the composition of a live `leader` lane:**

| Component | Chars | ≈ tokens |
|---|---|---|
| `~/AGENTS.md` (role-neutral core) | 4,040 | ~1,010 |
| `leader` mode prompt | 1,503 | ~375 |
| Skill index (13 skills) | 5,723 | ~1,430 |
| **Total fixed overhead** | **11,266** | **~2,816** |

Against the pre-migration comparable — 65,247 chars of instructions plus a 37,349-char index over 118 skills (**~25,649 tokens**) — that is **~22,832 tokens saved per request, per lane**. The earlier ~7k projection counted skill narrowing alone; it missed that `replace_base` also retires pi's native base prompt and that the core itself shrank 85%.

---

## 1. Decisions, with status

| # | Decision | Status |
|---|---|---|
| D1 | Adopt pi-profile-switch fleet-wide, launcher installed **globally from `~/Code/pi-profile-switch`** | **Done** |
| D2 | Drop `npm:pi-profile-switch` from `packages` (avoids double `/profile` registration) | **Done** |
| D3 | `pil` execs the launcher with a bare-`pi` fallback | **Done** |
| D4 | Three global profiles: `fleet`, `worker`, `ask`; per-space variation by project profile | **Done (unpinned)** |
| D5 | Decompose `AGENTS.md` → skills *before* touching profiles | **Done** |
| D6 | pi-modes shapes prompts; pi-profile-switch scopes resources; no substitution | **Done, and now composable** (D9) |
| D7 | No fork patch to pi-modes; pinned mirror only | **Superseded by D9** — the patch belongs to the *wrapper*, not pi-modes |
| D8 | Profile and mode chosen at spawn, not mid-session | Standing rule |
| **D9** | **`modes/` and `mode-presets/` are copied per instance, not symlinked** | **Done** — fork patch + ADR-0019 |
| **D10** | **Profiles do not declare `extensions`; narrowing is `skills` + `tools` only** | **Done** |
| **D11** | **Fleet hooks are a package, not loose files** | **Done** — `Apothic-AI/pi-fleet-hooks` |
| **D12** | **`PI_PROFILE` selects a profile explicitly.** Workers spawn as `PI_PROFILE=worker pil` | **Done** — fork patch + ADR-0020 |
| **D13** | **A role is two artifacts chosen at spawn — a mode for its prompt/duties, a profile for its resources.** `~/AGENTS.md` stays role-neutral: no "if you are a leader" clause | **Done** — `leader` mode written, shared core trimmed to 78 lines |
| **D14** | **The launcher ignores an inherited instance directory as its agent dir** | **Done** — commit `08d9a89` |

---

## 2. Instruction decomposition (the dominant win)

Each heavy file was split into an invariant core and on-demand skills.

`~/AGENTS.md` (82 lines) now holds only: standing behaviour, the six never-violate rules, orchestration invariants, the self-actuation limits, a skill routing table, and the herdr note.

`~/.overlord/AGENTS.md` (123 lines) now holds: the two-tab map, the eight operational invariants, role boundary, the live reserved-space table, delegate-don't-build, and escalate-don't-absorb.

### 2.1 Skills created

| Skill | Holds |
|---|---|
| `context-economy` | one-pass recon, keyhole limits, probe-once, poll in large slices, waits that fire on failure, context thresholds and the >50% ritual |
| `lane-identity` | tab-label derivation, `pil`, why pins don't survive restarts, `owner` is never a role |
| `pi-goal-contracts` | the three tools, queue verbs, why `/goal <obj>` wipes the queue, never `--tokens`, abort-pause recovery |
| `pi-rooms-protocol` | pinning, pane ids as correlation not identity, three delivery states, DM vs prompt, room-creation gate |
| `pi-hermes-memory-usage` | policy-only retrieval, what to save and where, supersede-not-duplicate, STANDING.md boundary |
| `pi-persist-usage` | section vs trailing economics, CLI, templates, sizing rules |
| `overlord-operations` | board, watchers and re-arming, taking control of leaders, handled vs escalated, portfolio, beads joining, comms, topology |

`overlord-operations` is global rather than project-scope because `~/.overlord` is **not** in `trust.json`, so project-scope skills there would be invisible. Leaders pay ~150 bytes of dead index entry for it; nudging trust was judged the worse trade.

---

## 3. The launcher is mandatory, and what it does

**The extension is inert without it.** `extensions/pi-profile/index.ts` returns at line 134 when `PI_CODING_AGENT_DIR` is unset, and `pi.registerCommand("profile")` sits at line 175 — after that guard. Installed as a pi package, `/profile` is never registered. That was the fleet's state before Phase 3.

The launcher spawns `pi -e <its extension>` with `PI_CODING_AGENT_DIR` pointed at `~/.pi-profile-switch/instances/launch-<id>`, a symlink mirror of the real agent dir, and forwards args verbatim (`--print`, `--tools`, `--model`).

### 3.1 Capability matrix

| pi-modes controls | pi-profile-switch controls |
|---|---|
| prompt base: `append`, `replace_base`, `replace_final` | `skills`, `extensions`, `mcps`, `tools`, `mcp_tools` allowlists |
| ordered overlays with `requires` / `conflictsWith` / `before` / `after` | `defaultProvider`, `defaultModel`, `defaultThinkingLevel` |
| drift fingerprints, `/mode-reapprove` | `instructions` — one string, no ordering or drift tracking |
| presets, project-mode confirmation | `/profile use`, `/profile reload`, `/profile overlay` |

pi-modes' schema properties are exactly `schemaVersion`, `key`, `label`, `description`, `promptStrategy`, `systemPrompt`, `requires`, `conflictsWith`, `before`, `after`. No resource field exists and none will appear — do not plan around it.

### 3.2 The modes/symlink incompatibility, and its fix

`pi-modes` fails closed on a mode path crossing a symlink boundary. The mirror linked `modes/` and `mode-presets/` into every instance, so every mode and preset was silently unavailable under the launcher — visible only as one `Prompt mode warning`.

Fixed in the **wrapper**, not the reader (ADR-0019): both directories are now copied into the instance as real files, after the mirror, and registered with the sweep so they are not treated as foreign state. pi-modes' boundary check stays intact.

Verified: warning gone, `modes/worker.json` and all three presets present as real files, two consecutive launches with zero diagnostics.

### 3.3 Reference forms — verified

| Form | Resolves to |
|---|---|
| `git:github.com/Apothic-AI/pi-rooms@master` | `@apothic-ai/pi-rooms` |
| `npm:@tryinget/pi-modes` | `@tryinget/pi-modes` |
| `/home/bitnom/Code/pi-extensions-apothic/packages/pi-goal` | `@signalridge/pi-goal` |

Builtins cannot be referenced: `builtin:codemode` is rejected as unknown, and needs no reference because builtins load by default and are disabled only by `-builtin:<name>`.

---

## 4. Target architecture

### 4.1 Lane classes

| Class | cwd | Profile | Mode |
|---|---|---|---|
| **Overlord** | `~/.overlord` | `fleet` | `overlord` |
| **Leader** | `<project>` | `fleet` or `<space>` | project preset |
| **Worker** | `<project>` (inherited) | `worker` | `worker` base |
| **Read-only** | anywhere | `ask` | none |

### 4.2 Profiles — `extensions` deliberately undeclared

**D10: no profile declares `extensions`.** `extensions` is a profile-managed path, so a declared selection makes it `no-mirror`; the instance then has no loose-extension directory and every loose script extension disappears. That would silently drop `herdr-agent-state.ts` (herdr-owned, publishes agent state to the socket) and both fleet hooks.

Undeclared, the instance symlinks the real `extensions/` directory and everything loads. The cost is that UX extensions ride along in worker lanes; the benefit is that nothing silently vanishes. `tools` narrowing already removes most extension tool descriptions, so extension-level filtering adds little.

| Profile | Skills | Tools | Extensions |
|---|---|---|---|
| `fleet` | 13 (dagr-producer, beads, unblock, herdr, agents-cron, profile-config, context-economy, lane-identity, pi-goal-contracts, pi-rooms-protocol, pi-hermes-memory-usage, overlord-operations, pi-persist-usage) | `*` | undeclared |
| `worker` | 2 (beads, context-economy) | 13 explicit | undeclared |
| `ask` | 1 (context-economy) | 13 explicit, read-only | 3 extensions, no pi-modes |

Worker keeps `pi-rooms` (must answer in rooms it was added to), `bash_bg`/`jobs`/`monitor` (must background long work), and `pi-web-access`. It drops `pi-goal` (briefs, not objectives) and `agents-cron` (policy forbids worker scheduling).

### 4.3 Modes and presets

`~/.pi/agent/modes/worker.json` — `replace_base` with a terse worker contract. `replace_base` sets the base while Pi still appends context files, skills and cwd, so the worker keeps its directory's rules and loses the orchestrator framing. It cannot drop an `AGENTS.md`; only a different cwd can.

Presets: `planning` (native+plan), `deep-review` (native+plan+review), `overlord` (native+plan+explain).

### 4.4 Per-space divergence

A space needing more writes `<project>/.pi/profiles/<space>.json` under a **distinct name** — never a same-named override, because a project profile replaces the global one wholesale and an "override" becomes silent duplication.

---

## 5. Spawning

### 5.1 `pil`

```bash
exec "$PROFILE_BIN" "$@"   # pi-profile when present
exec "$PI_BIN" "$@"        # bare-pi fallback, so a missing launcher never stops a lane
```

`pil` still resolves no profiles and knows nothing about resources. `PI_ROOMS_NAME` survives because the launcher spawns with `{...process.env, ...generated.env}` and sets only `PI_CODING_AGENT_DIR`. No recursion risk: Node's `spawn` does not see shell functions, so the `.bashrc` `pi()` → `pil` shim cannot loop.

Resolution order: a positional name → **`PI_PROFILE`** → the project's saved selection → the global saved selection → `default`. An unknown `PI_PROFILE` fails the launch rather than falling back, so a mistyped role cannot silently start an unfiltered lane.

**Workers must be spawned as `PI_PROFILE=worker pil`, not bare `pil`.** Resolution is cwd-scoped, and a worker deliberately shares its leader's cwd so it inherits that space's context files — so a saved selection cannot tell the two roles apart and a bare `pil` gives the worker the leader's `fleet` profile. Verified: `PI_PROFILE=worker` resolves `worker` with 2 skills and 13 tools; a positional name still wins over the env var; an unknown value exits 2.

**Roles are expressed as `PI_MODE=<role>`, mirroring `PI_PROFILE`.** `PI_MODE` is pi-modes' own documented startup selector, so no launcher change was needed for it:

| Role | Spawn | Prompt comes from | Resources from |
|---|---|---|---|
| Leader | `PI_MODE=leader pil` | `leader` mode (`replace_base`) | `fleet` profile |
| Worker | `PI_MODE=worker PI_PROFILE=worker pil` | `worker` mode (`replace_base`) | `worker` profile |
| Overlord | `pil` in `~/.overlord` | that space's `AGENTS.md` | `fleet` profile |

Verified from the composed prompt in the session transcript, not by asking the model: a `leader` lane's prompt contains the leader contract and **no other “You are …” identity** — `replace_base` really does replace pi's native base. `AGENTS.md` still appends after it, which is precisely why that file must stay role-neutral.

### 5.2 `agents-cron`

Runs on **plain `pi`**, with capability pinned in the task record (`--model`, `--thinking`, `--tools`). Routing a scheduled task through a profile would let a profile edit silently change what a scheduled job can do.

---

## 6. Verification status

| # | Claim | Status |
|---|---|---|
| T1 | A declared profile allowlist does not disable builtins; builtins cannot be named | **Verified** — `codemode` ran (`6*7`→`42`); `builtin:*` rejected |
| T2 | `git:`, `npm:` and absolute-path reference forms resolve | **Verified**, zero diagnostics |
| T3 | All extension state is shared by symlink | **Verified** by observation — goal, persist, bizzy, memory, todo, rooms, sessions all symlinked. **Re-confirmed inside a live launcher instance** (not only headless): all eight state paths symlink into `~/.pi/agent` |
| T4 | The wrapper works with `--print` | **Verified** — exit 0, clean stream split |
| T5 | Per-type package filters under a profile | **Answered** — packages whose filter leaves nothing selectable cannot be referenced (`pi-thinking-fold`); it was already inert on bare `pi` |
| T6 | One real `agents-cron` firing, no TTY | **Verified.** `task_370a9ce0` (once, `--at`, explicit model/thinking/tools) fired on the 23:15:16 timer tick and wrote its artifact: `T6_SUCCESS 23:15:27 artifact=NOTTY_TASK_OK`. The full path — timer → service → no-TTY child → model call → tool use — works end to end |
| T7 | A live goal survives a profile switch | **Partial.** A real in-session switch (`default` → `fleet`) completed live: session survived, TODO state intact, 13 skills resolved, footer shows `profile: fleet`. The goal half is unrun — see §10 |
| T8 | Loose script extensions under a declared profile | **Answered** — they vanish; hence D10 |
| T9 | pi-modes composes with the launcher | **Fixed and verified live** (D9) — `modes/` and `mode-presets/` exist as real directories inside a running launcher instance, carrying `worker.json` and the three presets |
| T10 | The fork's own gate passes | **`npm run check` passes.** `npm test`: 841 passed, 1 failed — `subagents-compatibility.integration.test.ts` expects `fixture/project-model` and gets the real session model. **Pre-existing**: the identical failure reproduces at base commit `5d378fa` in a clean worktree, so it is environmental, not caused by the two local commits |
| T11 | Switching profiles leaves no broken resource root | **Known cosmetic defect, not patched.** After a switch, `pi-nested-skills` warns `扫描技能目录失败：<instance>/skills (skill root is not a directory)`. Cause: the switch leaves the mirrored `skills` **symlink** in place, and `lstat().isDirectory()` is false for a symlink. Harmless — a `fleet` lane still lists all 13 skills and a fresh launch emits no warning. Fix options are a one-line `lstat`→`stat` in `pi-nested-skills`, or not creating the mirrored root when skills are declared. Neither is worth a new fork for a warning that costs nothing |
| T12 | Role modes reach the prompt and replace the native base | **Verified** from the transcript: a `PI_MODE=leader` lane's composed prompt contains "You are the leader of one space" and no other "You are …" identity; `PI_MODE=worker` likewise. An earlier YES/NO self-report probe said NO for all three cases — model introspection is not evidence, the transcript is |
| T13 | A launcher started inside a lane reads the real agent dir | **Fixed and verified** (`08d9a89`). Before: an inherited `PI_CODING_AGENT_DIR` made `getAgentDir()` return the parent's instance, so the new instance mirrored stale settings and a swept-on-exit directory. After: launched from inside this lane, the new instance carries `leader.json`, `worker.json` and all three presets |
| T14 | Realized saving vs the projection | **Measured: ~22,832 tokens/request**, against a ~7k projection. Composition of a live leader lane is 11,266 chars (~2,816 tok) versus ~25,649 pre-migration |

Also verified: `fleet`, `worker`, `ask` all launch clean; `fleet` resolves all references; 66 lanes reloaded and confirmed (`66 sent, 0 failed, verified 66/66`).

---

## 7. The cwd-only constraint

Pi renders: base (`customPrompt` under `replace_base`) → addendum → context files → skills → cwd.

- `replace_base` cannot drop an `AGENTS.md`.
- `pi-profile-switch` cannot drop project-scope context files — by design, project resources are never encoded.
- `AGENTS.override.md` replaces a same-directory `AGENTS.md` only in that directory.

A cheaper instruction set therefore comes from a different cwd or a smaller file. Phase 2 shrinks the file; there is no third lever.

---

## 8. Cache economics

| Action | Effect |
|---|---|
| pi-modes overlay switch | prefix intact — overlays render last |
| `replace_base` / `replace_final` | new prefix — choose at spawn |
| `/profile use` | rewrites settings + runtime dir — most expensive |
| pi-persist `section` edit | invalidates everything after it — avoid |
| pi-persist `trailing` edit | never cached, never invalidates |

Both pi-persist items are trailing; keep them that way. Never move `bd prime` or memory output into a section.

---

## 9. State fidelity

The wrapper symlink-mirrors the whole agent dir. Only `settings.json`, `mcp.json`, `APPEND_SYSTEM.md`, `pi-profile.json`, `trust.json`, `pid`, `extensions` are per-instance; `modes` and `mode-presets` are per-instance **copies** (D9).

`SEEDED_STATE_FILES` is not an allowlist — it pre-creates paths Pi makes at runtime so a dangling link exists before the first write.

Observed symlinked: `pi-goal.json`, `pi-persist.json`, `bizzy.json`, `hermes-memory-config.json`, `pi-todo-state.json`, `model-picker.json`, `pi-auto-compact.json`, `rooms/`, `pi-hermes-memory/`, `pi-cache-optimizer-stats.d/`, `sessions/`, `missions/`, `auth.json`, `models-store.json`.

`APPEND_SYSTEM.md` is generated from a profile's `instructions` and does not merge with a global one. You have none today; do not introduce one while using profile instructions.

---

## 10. Outstanding work

1. ~~**T6**~~ — closed. The no-TTY path and the whole timer → task → artifact chain are verified (§6).
2. ~~**T7**~~ — closed by the overlord, with the `goal_id` re-mint caveat (§6).
3. ~~**No profile pinned**~~ — the global saved selection is `fleet`; a launch with no argument resolves `fleet` with 13 skills (verified). Per-space pins remain optional, only for a space that needs more than `fleet`.
4. ~~**No real lane through the patched launcher**~~ — this lane and the overlord both run through it, and the launcher carries five commits.
5. **The fork gate is settled**: `npm run check` passes; the single `npm test` failure reproduces identically at base commit `5d378fa`, so it predates the patch. Worth reporting upstream as an environment-sensitive fixture.
6. ~~**Rollout**~~ — **closed 2026-11-01T07:06Z: every leader-role lane carries `PI_MODE=leader`**, read from `/proc/<pid>/environ` of each lane's own `pi` process, never from a lane's self-report. At closure that was **22 of 22 named `*-leader` lanes** Twenty-three leader lanes had been restarted with bare `pil` before roles became artifacts, so they carried the `fleet` profile but **no leader mode**; with the shared core role-neutral that left them under-specified. The overlord's re-run with `PI_MODE=leader` closed the gap. The last two were restarted at their own stop boundaries, not to convenience the rollout: `starla-leader` (w6:pD) 06:10Z, `herdr-voice-leader` (w1J:pE) 06:51Z.

   **The rollout is now an invariant, not a project.** The overlord's watcher re-runs `tools/rollout-modes.sh` on candidates and caught a *new* leader lane unprompted: `comms-leader` appeared in `w1T` after this count was written and was restarted and verified at 07:03:32Z. Any `*-leader` tab created from now on is self-healing at its next stop boundary; nothing needs re-arming.

   *Re-verify in one pass:* enumerate named agents with `herdr agent list`, then for each pane read `PI_MODE` from `/proc/<pid>/environ` of the `pi` process whose `HERDR_PANE_ID` matches. Two traps: the process rewrites its argv0 to a space-padded `pi`, so match a trimmed first token (`ps -o comm=`, not an exact cmdline compare), and a pane keeps several pids — its shell, the launcher, and the agent — so take the newest `pi` or you will read a stale shell's env and conclude a compliant lane is role-less.

   *Amendment, 2026-11-01T10:14Z — count the role, not the name.* There are now **23 leader-role panes but only 22 named lanes**. The extra is `w1Z:p1` in the new `Assistant` space: `PI_MODE=leader`, `PI_PROFILE` resolving `fleet`, `humanizer` scoped at `~/Documents/Assistant/.pi/skills/`, and a live rooms registration — but `herdr agent list` reports **no name** for that pane, so a name-driven audit silently omits it. An audit that counts `*-leader` names understates the fleet by exactly the lanes whose identity is broken; enumerate panes and read their env, then compare against the name list rather than starting from it.

   *Watcher lesson:* my first guard fired a plateau after 8 minutes and reported failure while both lanes were doing real work. The fleet's own rule is `working` > 45 minutes = stale. A guard tuned shorter than that produces exactly the false alarms the contract warns a watcher against.
7. **Per-space `AGENTS.md`** — analysed in [`PER-SPACE-DECOMPOSITION.md`](PER-SPACE-DECOMPOSITION.md). Rule: decompose a space when it is activated, not in bulk. Only one of the 65 spaces currently has a live agent, and six of the large files are one template.

---

## 11. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Patch pi-modes to tolerate a symlinked mode root | Its boundary check is a deliberate, advertised protection. Patch the wrapper. |
| Register `/profile` without `PI_CODING_AGENT_DIR` | Under bare `pi` the in-session switch rewrites the **real** `~/.pi/agent` live for every lane, and it still cannot narrow skills, which are resolved at startup. |
| `PI_PROFILE` env as launch selection | Not a documented input; the documented inputs are the saved selections. Inert anyway without the launcher. |
| Per-lane hand-maintained `PI_CODING_AGENT_DIR` | Re-implements the wrapper's verified mirroring to own more code. |
| Declare `extensions` per profile | Silently drops every loose script extension (D10). |
| Keep four profiles (`overlord` + `leader`) | Byte-identical duplication of 23 identifiers and 11 skill names; drift is silent. |
| Narrow extensions but not skills | Leaves the largest controllable line untouched. |
| `skills: ["*"]` plus discipline | A lane cannot decline a description it was handed. |
| Move prompt bulk into `replace_base` | Still renders context files after the base; makes every edit a drift event. |
| Route `agents-cron` through a profile | A profile edit would silently change a scheduled task's capability. |
| Package `herdr-agent-state.ts` | Installed and overwritten by herdr, gated on `HERDR_INTEGRATION_VERSION`. |
| Put the fleet hooks in `pi-extensions-apothic` | That repo is public and forbids describing the maintainer's machine; these hooks do. |
| Fork `pi-thinking-fold` | Not a code problem — its settings filter excluded its own only entry. Fixed with `[]`. |
| Delete the fork | It now carries two of our commits and ADR-0019. |

---

## 12. Verdict

The dominant cost is fixed and live. The remaining lever is skill narrowing, which needs one pinned profile per lane class and a spawn through the patched launcher.

Do T6 and T7 from a lane that is itself spawned through `pil` — that makes the tests into proof of the spawn path rather than a separate exercise.