# Fleet TODOs — triage

**Written:** 2026-11-10 by `self-improvement-leader` (lane `ft-todos-triage`), at the operator's
request.
**Subject:** `/home/bitnom/Documents/Assistant/Fleet TODOs.md`.
**This document is a judgement, not a record.** `Fleet TODOs.md` was **not** edited — that directory
is not a git repository, so an edit there would be unrecoverable and un-reviewable. Apply the labels
after reading this. Every claim below is a read of the live tree or a number I measured today; where
I could not verify something I say so instead of asserting it.

---

## 1. The traversal, with the count

I derived the set myself rather than copying the list in the brief.

| Step | Command | Result |
|---|---|---|
| Headings matching `^## FT-<digits>` | `grep -nE '^## FT-[0-9]+' "Fleet TODOs.md" \| wc -l` | **39** |
| File length | `wc -l "Fleet TODOs.md"` | **1,238** |
| Struck-through/completed headings | `grep -nE 'COMPLETED\|RESOLVED' \| grep -E 'FT-[0-9]+'` | **10** |

**39 items in scope. The count agrees with the brief, so I proceeded.** Two things worth recording
because the first number anyone will re-check is this one:

- **The obvious exclusion regex is wrong and returns 0.** `^## ~~FT-[0-9]+~~` matches nothing,
  because the title sits *between* the tildes:
  `## ~~FT-23 · pi's `/new` breaks herdr status~~ · ✅ COMPLETED 2026-11-08` (verified with `od -c`
  on line 344). Anyone re-deriving this will hit it. The working filter is
  `COMPLETED|RESOLVED` + `FT-[0-9]+`, which returns exactly the ten named in the brief:
  FT-23, 24, 25, 29, 31, 36, 40, 41, 42, 43.
- **39 + 10 = 49 headings**, and the highest live number is FT-49 — consistent. No heading was
  skipped and no number is missing between 01 and 49 except the ten struck ones.

In-scope items and their line numbers, for review:
FT-01:15 · FT-02:59 · FT-03:73 · FT-04:91 · FT-05:109 · FT-06:122 · FT-07:133 · FT-08:138 ·
FT-09:162 · FT-10:176 · FT-11:181 · FT-12:188 · FT-13:193 · FT-14:198 · FT-15:203 · FT-16:208 ·
FT-17:233 · FT-18:242 · FT-19:251 · FT-20:258 · FT-21:265 · FT-22:321 · FT-26:555 · FT-27:564 ·
FT-28:569 · FT-30:630 · FT-32:721 · FT-33:759 · FT-34:768 · FT-35:773 · FT-37:806 · FT-38:821 ·
FT-39:825 · FT-44:1081 · FT-45:1090 · FT-46:1134 · FT-47:1161 · FT-48:1207 · FT-49:1220.

Effort is given only where it changes the ordering, and only where the item's own body sizes it.

---

## 2. Labels

### P0 — live harm now (4)

| Item | Label | What I read that decided it |
|---|---|---|
| **FT-32** `/new` switches to default model config | **P0 M** | Three-lane measurement in the body: worker profile asks `high`, `ask` asks `medium`, every lane's footer reads `max`. `~/.pi/agent/pi-profile-state.json` = `{"activeProfile":"leader"}` and `leader.json` carries `defaultThinkingLevel: max` — so a **global** file silently overrides the **launched** profile on every worker and ask turn. Model survives `/new`/`/reload`; the thinking level does not. This is the operator's own P0 shape ("a status field read as health"), fleet-wide, and it bills on every worker turn. `/resume` still unmeasured. |
| **FT-20** memory auto-review failures | **P0 M** | Not a flake — a measured size problem. `~/.pi/agent/pi-hermes-memory/failures.md` is **4,278,128 bytes / 13,277 lines**; the review child is capped at 120 s (`child timed out after 120000ms`), and each failure writes a **~4 MB** `.failures.md.recovery-*` copy — **15** of them, hourly, the two newest stamped `2026-11-10_02:01` and `2026-11-10_03:00`. Still occurring: "Memory auto-review failed" appears in 6 session files, newest `--home-bitnom-.sysops--/2026-11-09T07-46-00-836Z_…jsonl`. Misleading (memory looks maintained), and it burns machine time hourly. |
| **FT-18** pi memory review | **P0 S** | The review this item asks for is the same job as FT-20, and one look finds it: `~/.pi/agent/pi-hermes-memory/` is **397 MB** (235 MB `sessions.db`, 4.1 MB `failures.md`, 15×~4 MB recovery copies, 51 `.retired-*`); `~/.pi/agent/projects-memory` is 54 MB. Answering "has it been doing a good job" is cheap and overdue; the answer is already partly no. |
| **FT-45** suspend and resume idle agents | **P0 L** *[deferred by operator]* | Measured in the body: 43 live `pi` processes holding **7.3 GB** RSS, plus ~53 MB `node pi-profile` wrapper each (**2.2 GB**), **41 of 43 lanes had written no session byte in over an hour** (6 for >6 h, oldest ~152 h), ~21 GB anonymous working set, and the machine swaps continuously at the active lanes' expense. Exactly "burns machine/agent time every hour it stands". Deferral is about *when*, not whether. |

### P1 — blocks work in flight (3)

| Item | Label | What I read that decided it |
|---|---|---|
| **FT-26** pi-rooms deliverability | **P1 M** | Three separate observations in the body, escalating: a DM stuck `queued`; a room's messages not arriving at all; then delivery arriving as a **backlog that derailed the lane's turn** until the operator spammed ESC. Silent non-delivery plus a queued receipt that reads as pending is an unblockable-by-the-lane failure. Not P0 only because frequency is unmeasured. This also gates FT-45's resume trigger #2. |
| **FT-37** thinking tags in pi assistant messages | **P1 L** | `FT-37-47-MECHANISM.md` already answers the mechanism question with citations: pi never parses tags — `@earendil-works/pi-ai/dist/api/openai-completions.js:376` only builds thinking blocks from `reasoning_content|reasoning|reasoning_text`, and `:418-420` appends `delta.content` to a text block unconditionally. Two lanes (`ft37-47-corpus`, `ft37-47-mechanism`) are already active. P1 because the pair is already funded with work in flight and it is the prerequisite for FT-47. |
| **FT-47** tool tags in deepseek responses | **P1 L** | Same defect as FT-37, and the **dangerous** half: `FT-37-47-MECHANISM.md` records that the `<tool_call>` prose is "a re-narration of a tool call the model also emitted natively", so a naive parser "would execute the same tool twice". The correct action is render-inert, not conversion. It must land with FT-37, not after it by accident. |

### P2 — real defect, workaround exists (6)

| Item | Label | What I read that decided it |
|---|---|---|
| **FT-01** yellowstone as a git-subrepo monorepo | **P2 M** | Code-complete, and **no longer the gate it declares itself**. `~/Code/yellowstone` holds 15 `.gitrepo`s; `~/.pi/agent/settings.json` sources every local extension from `~/Code/yellowstone/src/pi-extensions/*`; `EXECUTION-RECORD.md` records "code-complete on `master`, migration outstanding" then "38 of 41 live lanes monorepo-sourced". **But** my own sweep of the 32 live instances found **2 still loose** — `launch-5CYz9A` and `launch-mDBqWg`, both `"../../Code/apothic-pi-extensions/packages/pi-modes"`. Note my first sweep said 0: it only looked for the absolute form, and `FT-01-RETIREMENT-PLAN.md` §2 warns that "an absolute-path grep reports the absolute one only" — this is that trap, live. `pi-modes` is one of the three checkouts that must retire last. Deleting `~/Code` today breaks two lanes. Workaround: relaunch those two at their stop boundary. |
| **FT-05** bdi / beads naming stays in sync | **P2 M** | The naming half is done — `~/.overlord/tools/bdi-reconcile.py` runs on `bdi-reconcile.timer` every 25 s and clears a join unless "the bead is not closed, `agent_pane` is a live herdr pane, the agent on that pane is not `no-agent`, and the claimant matches"; `~/.config/beady-eye/config.toml` has the one-`[[projects]]`-per-tracker shape the fleet record prescribes. What is **not** done is the operator's actual complaint: the pane shows "38 trees with no live agent" / "48 unclaimed panes" — accurate, and useless. Workaround: `~/.overlord/tools/beads-board.py`. |
| **FT-09** Unblock TUI: show workspace, tab and pane name | **P2 S** | 1 of 3 done. `plugin/herdr.js:109` populates `origin.workspace_name = ws.label ?? ws.name ?? ws.custom_name`, and `plugin/tui.js:82` renders `[origin.workspace_name \|\| 'workspace']` — the literal `workspace` in the operator's sample is the **missing-field fallback**, not a missing feature; web already carries `workspace_name`/`workspace_id` (`web/src/deck.ts:83,86`). Still absent: the pane is shown by **ID only** (`plugin/tui.js:83`), and **tab is never rendered** — there is no tab field in `meta()` at all. |
| **FT-22** Reasoning summaries not well-formatted | **P2 M** | `grep -rn 'reasoning' ~/Code/yellowstone/src/pi-extensions/pi-pretty-tui/src/*.ts` → **0 matches**, so this is not a pretty-tui formatting bug as the title suspects; the concatenation happens where text blocks are appended (`openai-completions.js:418-420` appends `delta.content` with no separator). User-visible on every expanded thought item, no workaround beyond reading through it, does not block anything. Distinct from FT-37/47 (this is newlines in *parsed* summaries, not raw tags). |
| **FT-27** random pi TUI upward scrolling | **P2 M** | Body only, and that is the honest finding: the item is an unstarted investigation with no culprit, no reproduction and no measurement. Visible every time a lane works (history jumps up several lines and snaps back); no workaround; nothing blocked. |
| **FT-49** MemoryHigh on a fleet slice | **P2 M** *[deferred by operator]* | The measured condition is real and bad — `memory.high = max` on `user@1000.service`, `memory.current` 16.1 GiB against `memory.swap.current` 16.1 GiB mid-afternoon; aggregate PSS 5.55 GiB across 95 pids versus 10.23 GiB summed RSS (~1.8× overstatement, launchers only 26.6 MiB). It is FT-45's **containment** half: it makes lanes pay first, it does not reclaim the 7.3 GB. Judge it with FT-45, not separately. |

### P3 — improvement or quality (21)

| Item | Label | What I read that decided it |
|---|---|---|
| **FT-02** collapsible leader-watcher list (bizzy) | **P3 S** | Not implemented: the only `collapse` hits in `bizzy/src` are unrelated (`format.ts:19` "command collapsed to", `output.ts:46` `\r` redraw collapsing); no `watchers-collapsed` / `remember-watchers-toggle`. Cheap because the pattern already exists in the sibling extension: `apothic-todo/src/config.ts:8-20` (`persistCollapsed`, `collapsed`) and `src/index.ts:61-63`. |
| **FT-03** collapsible monitor events | **P3 S** | Same shape as FT-02/04, no persistence requirement, one new key (`collapse-monitor-events`, default true) plus `/toggle-collapse-monitor-events`, and a more informative title. No defect — ergonomics. |
| **FT-04** collapsible pi-rooms messages | **P3 S** | `grep -rn 'collapse' ~/Code/yellowstone/src/pi-extensions/pi-rooms/src/*.ts` → **0 matches**. Third instance of one shape; do all three in one pass. |
| **FT-06** multi-leader rooms in the leader prompts | **P3 S** | Not implemented. The global `~/.pi/agent/modes/leader.json` (9,014-char `systemPrompt`) has **0** hits for `multi-leader`, `multiple leaders` or `room`; `~/.overlord/AGENTS.md` likewise 0. One paragraph in two files. |
| **FT-07** self-improvement-leader review gate | **P3 S** | Not implemented in the global contract: `~/.pi/agent/modes/leader.json` has **0** hits for `review` and **0** for `self-improvement-leader`. (The *space* delta `~/Documents/Fleet/.pi/modes/leader.json` has `self-improvement-leader`:1 and `review`:5 — that is the space half, not the fleet-wide rule.) No live defect; it is the missing mechanism behind several incidents already in `EXECUTION-RECORD.md`. |
| **FT-08** context-threshold continuation and relaunch nudge | **P3 L** | The body has narrowed its own scope correctly (retire mid-session compaction **if** bili pans out; keep continuation files for resets and session loss regardless) and says testing "has turned into an extensive, ongoing, and not yet complete process" — lane `billion-context-leader` is live. Nothing is broken; the item is waiting on an experiment, and cannot be closed before its verdict. |
| **FT-12** pi-persist item scoping assistant-leader to relay work | **P3 S** | `~/.pi/agent/pi-persist.json` holds exactly 3 items — `current_datetime`, `todo_reminder`, `english_to_operator`. No assistant-leader item, and `assistant-leader` is a live lane (33 agents listed). The intent is behavioural; I did **not** measure that lane doing its own research, so I am not calling it a defect. |
| **FT-14** instruct agents to use memory deliberately | **P3 S** | `~/AGENTS.md` has exactly **1** "memory" occurrence — the skills-table row pointing at `pi-hermes-memory-usage`. **Do not do this before FT-18/FT-20**: telling every agent to use the memory store more, while that store is a 4.1 MB append-only log that already times out its own review, makes the measured problem worse. Order matters here and the ordering is the whole judgement. |
| **FT-16** xcgx 400 `messages[1].role` | **P3 M** | Its own reproduction path is missing: the item says "I have just created `~/.pi/agent/secrets/subrouter-xcgx`", and `~/.pi/agent/secrets/` contains `subrouter`, `subrouter-argon`, `subrouter-claude`, `subrouter-deepseek-flash`, `subrouter-gemini` — **no `subrouter-xcgx`**. The symptom is also already avoided by not routing to xcgx. Cannot progress without creating a provider secret, which is an operator/credential action. |
| **FT-17** pi-goal mid-turn nudge interval | **P3 M** | `pi-goal/src/settings.ts` `GoalSettings` = `{toolVisibility, experimental{goals,notices}, rpc{enabled}, continuationLimits{automaticTurns,noProgressTurns}}` — **no nudge or interval field**, and `grep -rn 'nudge' src/` returns 0; the only steer injection is `runtime.ts:589-616 queueBudgetWrapUp()`, a token-budget wrap-up. So "not configurable today" is verified. The item is an investigation plus a design question (its own note: an immediate wake on idle "is actually a problem because going idle with monitors set is one of our best patterns") — no measured harm. |
| **FT-19** TODOs accumulation | **P3 S** | The item's own second question is the one that matters, and it answers in the safe direction: nothing injects completed TODOs per request. The only prompt-side artefact is the static tool description at `apothic-todo/src/index.ts:41`; the rest is `renderCall`/`renderResult` and `view.ts:26` `contextAncestors`. What remains is a retention policy plus the real cost — every `todo list` result persists in the transcript forever. |
| **FT-21** fleet roster (`synod`) | **P3 L** | Unstarted: `~/Code/synod` exists with **zero commits** (`git log` → "your current branch 'master' does not have any commits yet") and only `herdr-synod/` and `pi-synod/` directories. The largest unstarted design item in the file; no defect today because lanes join data ad hoc. It absorbs FT-11. |
| **FT-28** pi token stats reset | **P3 M** | The installed extension is the third-party `npm:@arhen/pi-core-tps-stats` in `~/.pi/agent/settings.json` — not our fork — so the four asks (reset command, two modes, toggle, JSONL logging) are all new work. Per `~/AGENTS.md`'s component-fork rule this likely means forking it first. Feature request, no defect. |
| **FT-30** pi-fabric/codemode comparison and review | **P3 M** | Unstarted evaluation; nothing in the tree records a verdict. No defect — an option being left unexamined. |
| **FT-33** nail-down or abandon jujutsu/jj support | **P3 S** | The item's premise is **confirmed**: `herdr plugin list` shows `ezracerpac.jj-waltz (jj-waltz) enabled` and `mroth.jj-status (jj status) enabled`, both from GitHub refs, alongside 13 others. Installed, enabled in every pane, never tested. I found no measured misbehaviour, so this is risk, not a defect — but the decision is small and cheap. |
| **FT-35** added toggle to pi-persist | **P3 M** | The toggle exists (`src/toggle.ts:18-19`, `cli.ts:61,196`, `index.ts:194`). The item's **Update** asks for session scoping and per-model config, and that collides head-on with a documented invariant in `toggle.ts`: "The durable state is `piPersist.enabled` in pi's own global settings file. **It is global on purpose: a project must not be able to turn the operator's context on or off.**" No per-model machinery exists. See §5 — this is a decision, not a priority. |
| **FT-38** lane name derivation | **P3 S** | `~/.local/bin/pil` slugs the herdr tab label, refuses auto-generated numeric labels (lines 130-133), and its own comment (lines 11-14) rests the safety on an observation: the label "is unique across the fleet (verified: 60 tabs, 0 collisions, 0 invalid)". I found **no runtime collision guard** — two panes in one tab, or two identically-labelled tabs, would produce the same lane name. Safe today by invariant, not by construction. |
| **FT-39** per-mode or per-profile model settings | **P3 S** | The question is already answered by the files: all three profiles carry `defaultProvider`/`defaultModel`/`defaultThinkingLevel` (`ask` medium, `leader` max, `worker` high), and **no mode file carries any model key**. So: per-profile yes, per-mode no — and the per-profile thinking level is not honoured (FT-32). What is left is the cost decision in §5. |
| **FT-44** Rebrand Yellowstone | **P3 M** | Unstarted: no `Lodestone` or `Shasta` anywhere under `~/Documents/Fleet` or `~/.overlord`. Naming/branding; blocks nothing. |
| **FT-46** herdr plugin support for grouping and nesting workspaces | **P3 M** | Its premise has **moved**: the item says "`workspace close` exposes a `--group` flag and can fail with `workspace_group_close_required`", but the installed build's `herdr workspace close --help` accepts only `<workspace_id>` — no `--group` at all. Re-measure the API surface against the serving binary before answering; as written the question is not well-formed. |
| **FT-48** bdi-reconcile: exit before the fork when nothing changed | **P3 S** *[deferred by operator]* | Measured: 3,313 invocations a day, **0 log lines in 24 h** — ~2.3 `python3` forks per minute doing nothing. No user-visible defect, so P3; the fix is a few bash lines before the `exec`. The deferral is not a reason to call it P4 — the waste is real and still accruing. |

### P4 — close it (5)

Each of these names what makes it already satisfied.

| Item | Label | Evidence that it is already true / superseded |
|---|---|---|
| **FT-10** leader access to agent-cron tools | **P4 S** | Already true, verified two ways: `npm:agents-cron` is in the **global** `~/.pi/agent/settings.json` (so every lane inherits it), and in this leader lane `tool_search` loaded **`schedule_task`** — "Create, inspect, enable, run, or delete scheduled prompt tasks", reading `.agents/cron/config.json`. Nothing to add. |
| **FT-11** workspaces and agents directory | **P4 S** | Superseded by **FT-21**, in the item's own words: "This item has been superseded by or at the very least now depends on FT-21. The more reasonable pattern would be to instruct (In ~/AGENTS.md) how to use synod." `~/Code/synod` is the empty repo FT-21 will fill. Close it as a duplicate of FT-21; do not carry a second description of the same directory. |
| **FT-13** yellowstone install-and-pin package | **P4 S** | The purpose is already met by a different mechanism: `install.sh` has explicit stages (`herdr\|pi\|plugins\|skills`), `scripts/doctor.sh` verifies the result, and `herdr/plugins.toml` is "the plugin manifest, with pinned refs" (README). A separate extension+plugin whose only job is "install them and pin versions" would duplicate the installer. If the operator wants the *form* rather than the outcome, that is a preference, not a gap — say so before building it. |
| **FT-15** subrouter provider-management skill | **P4 S** | Already built: `~/.agents/skills/subrouter-provider-ops/SKILL.md` — "Test, benchmark, subscribe, and manage SubRouter marketplace providers (merchants) for a given model. Use when comparing SubRouter merchants on speed or price… pruning slow or expensive merchants, or verifying which merchant actually served a request" (36 cheap/cost/price references), with `llm-provider-benchmark` as its timing companion. Exactly the ask. |
| **FT-34** leader mode agent spawned a codex worker | **P4 S** | Already true across the surfaces that carry role duty: **0** `codex` hits in `~/AGENTS.md`, `~/Documents/Fleet/AGENTS.md`, `~/Documents/Fleet/.pi/modes/*.json` and `~/.pi/agent/modes/*.json`. Scope stated honestly: I did not sweep all ~100 skills; the hits outside those four surfaces are about codex-as-a-product (pricing, cliproxy, braintrust) and archived `.bak` files, not about spawning codex as a worker. |

**Tally: P0 4 · P1 3 · P2 6 · P3 21 · P4 5 = 39.** Three carry the operator's deferral and are
marked in place (FT-45, FT-48, FT-49).

---

## 3. Items that are the same issue

The pair is cheaper than either half, and in two cases doing one half alone is actively dangerous.

| Pair | Why it is one job | What to do |
|---|---|---|
| **FT-37 + FT-47** | The file says "Probably related"; `FT-37-47-MECHANISM.md` now says they are the *same* mechanism with one recommended fix — a `message_end` reclassification **gated on content-block type, not tag text**, plus `registerMarkdownTransformer` for the live view. Doing FT-47's rendering without FT-37's mechanism re-invents the parser. | One extension, two symptoms. Never convert `<tool_call>` prose into tool calls — the prose re-narrates a call the model also emitted natively; converting executes it twice. |
| **FT-18 + FT-20** | The review is the diagnostic; the failure is the finding. `failures.md` at 4,278,128 B with a 120 s child timeout and 15×~4 MB hourly recovery copies is the answer to "has memory been doing a good job". | One investigation. Cap/rotate the log and stop the recovery-copies-whole-file path; the timeout should disappear with it. |
| **FT-32 + FT-39** | Same surface: per-profile model settings. FT-39 asks whether per-profile settings are possible; FT-32's measurement shows `defaultProvider`/`defaultModel` are honoured but `defaultThinkingLevel` is overridden by global `activeProfile`. FT-39's answer *is* FT-32's defect. | Fix the thinking-level source once; then FT-39's remaining question is a cost decision (§5), not engineering. |
| **FT-02 + FT-03 + FT-04** | One shape — a collapsible chat section with a config key and a toggle command — in three renderers. FT-02's body even says the feature already exists in apothic-todo and should behave "exactly the same". | One pass, three call sites, one shared config idiom (`apothic-todo/src/config.ts:8-20` is the template). |
| **FT-06 + FT-07** | Two paragraphs, both to the global `~/.pi/agent/modes/leader.json` (FT-06 also touches the overlord contract). Both are currently 0-hit absent. | One edit, one reload, one re-approve per affected lane. |
| **FT-45 + FT-49** | Each cross-references the other and they address the same measured condition: FT-45 reclaims (7.3 GB RSS from 43 lanes), FT-49 contains (`memory.high = max` today). | Judge together; FT-49 without FT-45 throttles without reclaiming. |
| **FT-05 + FT-48** | Both are bdi/beads join machinery — FT-05 wants the pane to be useful, FT-48 wants the reconciler to stop forking for nothing on the same data. | Read the reconciler's own semantics (`bdi-reconcile.py` docstring) before either: "Everything else is cleared" means many empty joins are *correct*, which is why the pane looks empty. |
| **FT-11 + FT-21** | FT-11's own Update says it is superseded by FT-21. | Close FT-11 as P4; keep the description in FT-21. |

Two more, weaker but worth noting: **FT-01 + FT-13** (both are "yellowstone does install/pin", one is
the mechanism, the other a proposal to duplicate it), and **FT-08 + FT-45** (both touch what an idle
or reset lane should do; FT-08's continuation file is the only surviving state a suspend must not
lose).

---

## 4. Items where reality has moved

These are stale in a way that shrinks or kills them — check before spending effort.

- **FT-01** declares itself a gate over the rest ("let's not think about resolving any of them until
  this one is completed") and it is now code-complete. **The gate is open**; the other 38 items do
  not need to wait. What is left is one decision (retire `~/Code`?) and one cadence (relaunch the
  lazy lanes). Note the 2 still-loose instances above — the residual is invisible to an absolute-path
  check, which is why my first count said zero.
- **FT-09** is 1 of 3 done and the operator's screenshot is the *fallback*, not the missing feature.
  Workspace name already renders when the item's origin carries it. Only pane-name and tab are
  actually absent.
- **FT-10, FT-15, FT-34** are already true. All three are cheap closes.
- **FT-11** is superseded by FT-21 in its own text.
- **FT-13**'s purpose is met by `install.sh` + `doctor.sh` + pinned `herdr/plugins.toml`.
- **FT-33**'s premise is confirmed rather than refuted — the plugins *are* installed — so it grows
  slightly rather than shrinking: it is now "two enabled plugins never validated", not "maybe I
  installed something once".
- **FT-46**'s premise is refuted: no `--group` flag exists on the serving build, so the item's
  framing needs re-measurement.
- **FT-16**'s stated prerequisite file (`~/.pi/agent/secrets/subrouter-xcgx`) does not exist.
- **FT-19**'s worst fear is not the case: nothing injects completed TODOs per request.
- **FT-05**'s naming half is done by `bdi-reconcile.py`; only the operator-facing usefulness half
  remains.
- **FT-17**'s "is it configurable" is verified **no** (no interval/nudge field in `GoalSettings`), so
  the investigation half is already complete and only the policy design remains.

---

## 5. What gates what

| Item | Gates | Count |
|---|---|---|
| **FT-37** | **FT-47** — the rendering half cannot be written before the mechanism exists, and the mechanism doc's warning is the safety condition for FT-47. | 1 |
| **FT-26** | **FT-45** resume trigger #2 (a queued DM must not sit unread while a lane is suspended). FT-45 says so itself: "see also FT-26". | 1 |
| **FT-18 + FT-20** | **FT-14** — instructing agents to use memory more is counterproductive until the store is bounded and the review succeeds. | 1 |
| **FT-32** | **FT-39** — per-profile *model* choice is only meaningful once per-profile *thinking level* is actually honoured. | 1 |
| **FT-21** | **FT-11** (absorbed), and every future "consistently join pi/herdr/extension data" ask — `bdi`, `leader-board.py` and `beads-board.py` each re-solve part of it today. | 1 + the class |

Nothing in the file gates three or more items, and **nothing gates the whole file any more** —
FT-01's self-declared hold is discharged (§4). That is the most consequential finding here: the
operator is free to take items in priority order instead of waiting on the monorepo.

---

## 6. Needs the operator — product decisions, not defects

I am not inventing a priority for these. Each is a P3 above, but no amount of engineering settles it.

1. **FT-39 — do we want per-lane or per-profile model *selection* at all**, given the concrete
   trigger was `deepseek-v4.1-flash-1017-uncensored` at **7–8× the standard model's cost**? The
   mechanics already exist for provider/model; only the policy (which lane gets the expensive model,
   gated how?) is missing. A spend decision.
2. **FT-35 — is a session-scoped, per-model `/pi-persist-toggle` wanted**, given the code states the
   opposite as an invariant: "It is global on purpose: a project must not be able to turn the
   operator's context on or off." If the operator wants per-model switching, that invariant needs
   rewording first, deliberately — not patched around.
3. **FT-01 — retire the `~/Code` fleet checkouts?** `FT-01-RETIREMENT-PLAN.md` says "planning only.
   Nothing here authorises a deletion", 20 checkouts are in scope, and 6 of the 13 subrepo
   checkouts are live lanes' working directories. Only 7 are safe to remove today. Plus the 2 loose
   instances above.
4. **FT-08 — whether bili is adopted** decides whether the mid-session compaction path is retired.
   The item already separates the two failures correctly; the verdict is someone else's experiment
   (lane `billion-context-leader`).
5. **FT-33 — jj or not.** Two plugins are already enabled fleet-wide; "nail down" and "abandon" are
   both one-line decisions, but which one is a preference.
6. **FT-16 — create `subrouter-xcgx` or drop the item.** Adding a provider secret is a credential
   action; the reproduction cannot proceed without it.
7. **FT-44 — the brand name** (Lodestone / Shasta) is a taste decision before any agent runs.

---

## 7. The deferred three

Labelled by intrinsic priority, deferral preserved. Nothing below recommends un-deferring.

| Item | Intrinsic label | One line |
|---|---|---|
| **FT-45** suspend/resume idle agents | **P0 L** *[deferred by operator]* | The only open item whose measured cost is in gigabytes and accrues hourly; also the one that most needs a written design before anyone touches it, which is what the item asks for. |
| **FT-48** bdi-reconcile early exit | **P3 S** *[deferred by operator]* | 3,313 spawns/day for 0 log lines. Real waste, small fix, no user-visible defect. |
| **FT-49** MemoryHigh on a fleet slice | **P2 M** *[deferred by operator]* | The containment half of FT-45; `memory.high = max` today, and `memory.swap.current` equal to `memory.current` is the symptom it exists to stop. |

---

## 8. If only three things are read from this

Ordering consequence, not a work plan — the operator asked for judgement, not fixes.

1. **FT-32** first, because it is the only *measured, fleet-wide, per-turn* wrongness in the file and
   its fix is a source-of-truth question (`activeProfile` vs the launched profile) rather than a
   feature. Every worker turn is currently running at max reasoning because a global file wins.
2. **FT-18 + FT-20** second, because the diagnosis is already in hand (4.1 MB log, 120 s timeout, 15
   hourly 4 MB copies, 397 MB directory) and it is the cheapest P0 to retire. Do it **before**
   FT-14, which would otherwise push more traffic into the same store.
3. **FT-37 + FT-47** third, because it is the only pair already funded with two lanes and it carries
   the one trap in the file that would double-execute tools if the wrong fix is taken.

Then the five P4s, all of which are closes rather than work: FT-10, FT-11, FT-13, FT-15, FT-34.

---

## 9. Method and limits

What I actually did, so the next reader can judge the weight:

- Read all 1,238 lines of `Fleet TODOs.md`; every label cites a line I read, a file I opened, or a
  number I measured.
- Measured today: `grep`/`wc` on the TODO file and its headings; `.gitrepo` inventory of
  `~/Code/yellowstone` and the package sources in `~/.pi/agent/settings.json`; both path forms across
  32 instance `settings.json` files; `herdr plugin list` (15 plugins); `herdr agent list` (33
  agents); `herdr workspace close --help`; `~/.local/bin/pil`; `pi-goal/src/settings.ts`;
  `pi-persist/src/toggle.ts`; `apothic-todo/src/{config,index}.ts`; `unblock/plugin/{tui,herdr}.js`
  and `web/src/deck.ts`; the three profile files; both mode trees; `~/.pi/agent/pi-persist.json`;
  `~/.config/beady-eye/config.toml`; `bdi-reconcile.py`; `~/.agents/skills/*`; `~/Code/synod`;
  `~/.pi/agent/pi-hermes-memory/` (sizes, recovery and retired counts, mtimes); six session files
  matching "Memory auto-review failed".

What I did **not** verify, stated so nobody reads more into a label than is there:

- **FT-27** and **FT-30** have no live evidence either way — they are unstarted investigations, and
  their labels come from the body alone.
- **FT-12** — I confirmed the config contents, not that `assistant-leader` is actually doing its own
  research.
- **FT-34** — I searched four prompt surfaces, not all ~100 skills (§2).
- **FT-32** — I verified the profile fields and the body's measurement; I did not re-run the
  three-lane probe, and `/resume` remains unmeasured by anyone.
- **FT-05** — I confirmed the reconciler's semantics and the beady-eye config shape, not what the
  pane renders this minute.
- **FT-26** — frequency is still unmeasured; the label reflects consequence, not rate.

One correction to my own work, recorded because it is the same trap the fleet already documented: my
first sweep of instance `settings.json` files reported **0 loose** `~/Code` sources. It was wrong —
it looked only for the absolute path. Checking the relative `../../Code/` form as well gives **2**
(§2, FT-01). `FT-01-RETIREMENT-PLAN.md` §2 warns about exactly this, and I hit it anyway.
