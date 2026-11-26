> ## ⛔ SUPERSEDED — historical record only
>
> This continuation predates the resolution. The defect it describes is **fixed, deployed, and cut
> over** as of 2026-11-06. Its hypotheses and next actions are obsolete.
>
> Authoritative current state: **`CURRENT-STATE-herdr-pin-drift.md`**.

---

# Continuation Prompt — Herdr Reports This Pi Lane as `working` After Completion

## Mission

Resolve the live Herdr/Pi lifecycle-state defect affecting this coordinator lane:

- lane: `self-improvement-leader`
- Herdr pane: `w1K:p1`
- cwd: `/home/bitnom/Documents/Fleet`

Pi visibly reaches a completed turn, but `herdr agent get w1K:p1` continues to return `agent_status: "working"`. The stale authoritative state prevents the deferred self-reload helper from detecting `idle`, so this lane has not yet reloaded the fixed pi-modes extension. Diagnose the exact failure, implement the narrowest supported fix if needed, deploy it through the owning project’s approved workflow, and prove the live lane transitions correctly.

Do not stop at a plausible explanation. The completion standard is live evidence: Herdr must report this lane idle after a completed turn; the relevant reporter/session identity must be current; the deferred reload must reach a terminal durable result; and the resulting Pi process/session must have the fixed `pi-modes` behavior and `mode:leader`.

## Standing authority and fresh-session operating rules

### Standing authority: act as fleet chief engineer

The operator has explicitly designated this lane the fleet’s chief engineer and authorized it to carry authorized harness work through implementation, verification, deployment, and fleet propagation without pausing to ask for another approval. Treat this as an instruction to act, not merely as permission that can be deferred.

Within that scope, proceed without asking the operator to authorize each step, including:

- inspect, diagnose, modify, test, and deploy `pi`, `pi-modes`, Herdr integration/reporting, launcher/profile code, fleet hooks, skills, modes, and related fleet configuration;
- perform mode approvals and `/mode-reapprove` for project modes when required by the reviewed change;
- use supported canonical landing, package installation, reload, and restart workflows; reload affected lanes at safe stop boundaries and verify the resulting artifacts;
- create focused branches/PRs and merge routine, reviewed harness fixes when repository checks and policy permit; do not push unrelated unpublished commits as a shortcut;
- repair or retire stale reload helpers after checking their exact PID, purpose, and durable state;
- update relevant fleet records and tests so the repair survives the next session and future fleet operation.

Do not add an authorization checkpoint that the operator has expressly removed. If a normal harness step is risky, explain and mitigate the risk, use the narrowest reversible path, and keep moving. Stop only when a real boundary below applies or a technical blocker cannot be cleared within the granted authority.

This standing authority does **not** authorize:

- spending money, using paid resources, or creating new accounts/credentials;
- acting in the operator’s personal/signed-in accounts, providing consent on the operator’s behalf, or sending external messages to real people;
- destructive or irreversible non-harness actions such as deleting a space, force-pushing, wiping stores, or dropping databases;
- crossing an explicit operator hold on a space/lane;
- proceeding with a change whose code/diff cannot be reviewed or whose failure cannot be rolled back. In that case preserve the known-good state, report the concrete blocker, and ask only for what is genuinely outside the authority granted.

For Herdr/pi/extensions updates, authority does not waive the fleet’s review gate: inspect the actual diff against the exact deployed commit, dependencies, scripts, network/credential/filesystem behavior, and load-bearing surface; run focused tests; prove on a disposable lane when warranted; then deploy and verify. This is the engineering procedure, not a request for operator permission.

### Fresh-session procedure

1. This is a fresh Pi session. Read this file completely before taking action.
2. Read `/home/bitnom/AGENTS.md`, `/home/bitnom/Documents/Fleet/AGENTS.md`, and the Herdr skill at `/home/bitnom/.agents/skills/herdr/SKILL.md`.
3. This task concerns Herdr, so first verify `HERDR_ENV=1`. Use Herdr’s installed CLI as the command authority; do not infer syntax.
4. Recreate/update TODOs before work. Exactly one task may be `in_progress`; mark each task complete immediately after verified completion.
5. Do not start a second coordinator Pi process. Do not race the existing lane or its deferred helper.
6. Do not prompt a lane that Herdr reports as working. Do not interrupt active project work merely to force this lane idle. Use the authorized idle-only reload path or prove a safe alternative.
7. Never kill by a command-line pattern. If a helper must be stopped, inspect its exact PID and command immediately beforehand, then signal only that PID.
8. Preserve unrelated dirty files and unpublished commits in any checkout. Never reset, clean, stash, or wholesale merge a dirty canonical tree.
9. Keep operator-facing communication in English.
10. Mode approvals and re-approvals are explicitly authorized; do not gate them on a further operator response. Apply the reviewed change, re-approve, and verify the resulting prompt/session artifact as required.

## Current known facts to verify, not blindly trust

### Herdr’s observed state

At the last observation, all of these were true:

- `herdr agent get w1K:p1` returned `agent_status: "working"`.
- `herdr agent explain w1K:p1 --json` returned:
  - `state: "working"`
  - `screen_detection_skip_reason: "full_lifecycle_hook_authority"`
  - `screen_detection_skipped: true`
  - `visible_idle: false`
  - `visible_working: false`
  - `visible_blocker: false`
- This means Herdr intentionally trusts the Pi lifecycle hook instead of screen detection. The terminal footer is not the authority for this pane while the hook authority is active.
- A known idle comparison lane (`yellowstone-leader`, `w17:p1`) had `agent_status: "idle"` and the same full-lifecycle-hook screen-detection skip reason. Therefore the mechanism can report idle; the problem is specific to this lane’s reporter/state/session path, not simply the global existence of hook authority.

### Processes and sessions

Re-read all of these live; they may have changed after this fresh session starts:

- Previously observed wrapper PID: `947526` (`pi-profile`)
- Previously observed child PID: `947604` (`pi`)
- Previously observed process start: Nov 3, 2026
- Previously observed current active session file:
  `/home/bitnom/.pi/agent/sessions/--home-bitnom-Documents-Fleet--/2026-11-05T23-08-33-552Z_01a1adf8-9b8f-7797-9e5a-a2452268f578.jsonl`
  (The exact UUID/path must be obtained from current process/session records; do not rely on this line if it conflicts with live evidence.)
- Previously observed Herdr agent session path was stale and pointed at an older Fleet session ending in `...f2b7548033e5`, while the durable Pi lane record pointed at the newer session.
- Durable lane record:
  `/home/bitnom/.local/state/pil/sessions/self-improvement-leader.json`

Compare:

- `herdr agent get w1K:p1`
- `herdr pane process-info --pane w1K:p1`
- `/proc/<pi-pid>/environ`
- the lane record above
- the newest Fleet session files under `/home/bitnom/.pi/agent/sessions/--home-bitnom-Documents-Fleet--/`
- Herdr’s stored agent-session path

The session-identity mismatch is a leading hypothesis, not a proven root cause. Establish whether the idle report was absent, rejected as stale/out-of-order, rejected because it referred to a different session, or applied but later overwritten.

### Deferred self-reload helpers

At the last observation, reload results included:

- `~/.local/state/pil/reload-results/self-w1K-p1-1793910981916.json` — terminal `failed`, idle timeout after 300 seconds.
- `~/.local/state/pil/reload-results/self-w1K-p1-1793914957058.json` — stale `waiting` record; its helper PID `504447` was explicitly terminated after exact command-line verification.
- `~/.local/state/pil/reload-results/self-w1K-p1-1793922534867.json` — `waiting`; helper PID previously observed as `719943`, running:
  `python3 /home/bitnom/.overlord/tools/broadcast-to-fleet.py --deferred-self-reload w1K:p1 --deferred-timeout 86400 --deferred-result /home/bitnom/.local/state/pil/reload-results/self-w1K-p1-1793922534867.json`

These are historical observations. Re-check current results and processes before doing anything. Do not create a duplicate deferred helper. The helper polls `herdr agent get` every 0.5 seconds and acts only on exactly `idle`; it then sends `/reload`, looks for a fresh `Reloaded` confirmation, records `confirmed`/`waking`/`woken`, and sends one wake prompt. A `waiting` record is not proof of progress.

## pi-modes fix status

The original mode-loss bug is already fixed and merged; do not reopen that investigation unless live evidence shows the fix is absent.

Original bug:

```ts
applyEnvironment: event.reason === "startup"
```

A fresh `/new` session has an empty branch, so the launch role disappeared. The fix is:

```ts
applyEnvironment: event.reason === "startup" || event.reason === "new"
```

Status:

- PR: https://github.com/Apothic-AI/pi-extensions-1/pull/1
- merged commit: `f74ebe77525c9fa76236f66c18cfaea07494352b`
- focused regression coverage exists for `/new` inheritance and `/resume` preservation
- focused extension/mode tests previously passed 44/44
- package quality/release check passed against the merged-main tree
- canonical checkout: `/home/bitnom/Code/apothic-pi-extensions`
- live profile settings load `pi-modes` from `/home/bitnom/Code/apothic-pi-extensions/packages/pi-modes`
- canonical checkout was intentionally not wholesale moved to `main` because it contains unrelated dirty files and unpublished work; preserve that state
- a fleet `/reload` broadcast previously confirmed 40/40 reachable Pi panes; one deleted/unknown non-Pi pane was safely skipped; this coordinator was deferred

The current coordinator may still have the pre-fix extension in memory until its own reload/restart is verified. Do not call the rollout complete until this lane has a fresh process or a verified `/reload` that loaded the fixed source.

## Reporter implementation to inspect

Installed reporter:

```text
/home/bitnom/.pi-profile-switch/instances/launch-3oQ9Sa/extensions/herdr-agent-state.ts
```

Repository source:

```text
/home/bitnom/Code/herdr/src/integration/assets/pi/herdr-agent-state.ts
```

The reporter’s relevant behavior is currently known to be:

- only TUI sessions report lifecycle state
- `session_start` refreshes the session reference, reports the session, then uses `ctx.isIdle()` to publish either `idle` or `working`
- `agent_start` publishes `working`
- `agent_settled` publishes `idle` only if `ctx.isIdle() === true`
- state reports are queued and sent over the Herdr socket, with a short retry
- Herdr treats `herdr:pi` / `pi` as full lifecycle hook authority and suppresses screen detection

Important source locations:

- reporter: `src/integration/assets/pi/herdr-agent-state.ts`
- reporter tests: `src/integration/assets/herdr-agent-state.test.ts`
- lifecycle authority/state routing: `src/terminal/state.rs`
- report API: `src/app/api/panes.rs`, functions `handle_pane_report_agent` and `handle_pane_report_agent_session`
- API dispatch: `src/app/api.rs`
- detection authority: `src/detect/mod.rs`, `full_lifecycle_hook_authority`

Pi host lifecycle source:

```text
/home/bitnom/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
```

The host emits `agent_settled` after marking the agent run inactive, but `isIdle` can still be false during compaction or other host activity. Prove the event/context behavior instead of assuming it.

The Herdr integration test named “Pi reports idle only after the agent settles” expects:

```text
idle -> working -> idle
```

and deliberately ignores stale settlement events while `ctx.isIdle()` is false.

## Investigation plan

### Phase 1 — establish the live state and helper state

1. Verify `HERDR_ENV=1` and record current date/time.
2. Query Herdr state, explanation, process info, lane record, current `/proc` environment, current helper processes, and all result files.
3. Check whether the lane is in a genuine active turn, compacting, retrying, queued continuation, blocked state, or merely stale Herdr authority. Use Pi/Herdr artifacts; do not infer from the model’s footer alone.
4. Inspect the current session transcript tail and timestamps. Identify the latest `agent_start`, `agent_settled`-relevant turn, session switch, reload, and reporter-related events if present.
5. Determine whether the deferred helper is alive, whether it is polling this exact pane, and whether any stale duplicate exists. Do not start another.

### Phase 2 — prove reporter transport and Herdr application

1. Correlate the reporter’s current session path/id and sequence with Herdr’s stored session identity.
2. Inspect Herdr server logs and source logging behavior to determine whether `pane.report_agent` requests are logged under another event name or omitted.
3. Inspect API return/error handling. The JS reporter currently treats “socket sent a response” as delivery success; that does not necessarily mean the request was accepted. Determine whether `report_agent` returned an error and whether the reporter discards it.
4. Compare this lane against `yellowstone-leader` or a disposable Pi lane that reaches idle. Use a controlled disposable lane if needed; do not fake state in the production pane.
5. Check report sequence monotonicity. The reporter starts `reportSeq` at `Date.now() * 1000`, but a reloaded extension or duplicate reporter could create sequencing/session-authority races. Establish whether the live process has one reporter instance or multiple.
6. Check Herdr’s hook-authority routing for the stale session. Pay attention to `session_report_allows_session_replacement`, `session_ref_is_current`, `accept_hook_report`, source/agent matching, sequence checks, and any rejection path.

### Phase 3 — choose and implement the narrowest fix

Possible root causes include, but are not limited to:

- the `agent_settled` event never reaches the reporter
- `ctx.isIdle()` is false at settlement due to host state and no later event republishes idle
- the reporter sends idle but Herdr rejects it because the reporter’s session ref is stale
- the reporter’s report is accepted by the socket but the API rejects it, with the error hidden by the JS transport helper
- report sequence or duplicate reporter state leaves `working` authoritative
- an old runtime reporter is installed/loaded instead of the expected file
- Herdr’s own authority-state logic fails to clear/reanchor stale Pi session state

Do not patch around this by manually forcing the production pane idle or by deleting authority state without understanding ownership. If code must change:

- inspect the exact installed Herdr binary/version and source commit first
- read the complete relevant diff before updating a load-bearing fleet package
- add a focused regression reproducing the exact stale-session/settled-idle failure
- validate with the owning project’s prescribed tests and package checks
- deploy via supported Herdr installation/reload/restart workflow
- verify on a disposable managed pane before touching the coordinator, unless the fix is demonstrably reporter-only and safe to reload
- record exact deployed commit/version and rollback path

### Phase 4 — recover and verify the coordinator

After the cause is fixed and deployed:

1. Ensure only the intended deferred self-reload helper remains.
2. Verify Herdr transitions this pane to `idle` from the authoritative hook state.
3. Let the helper send `/reload`, or use the supported self-reload mechanism if the helper is demonstrably irrecoverable. Do not use a direct self `/reload` in the same coordination turn if the fleet procedure forbids it; use the documented safe path.
4. Verify the result file reaches `confirmed`, `waking`, and ideally `woken`.
5. Verify the wrapper/child PID or loaded runtime changed as appropriate, and inspect the active extension source/hash/version.
6. Verify the footer shows `mode:leader` and the current session prompt has the fleet leader contract.
7. If a fresh `/new` is used for final proof, verify the new session contains a `pi-mode-state.v3` with `baseKey: leader` and `source: startup`.
8. Verify Herdr now reports `idle` after the final response and that the helper is not left waiting.
9. Only then mark the task complete and report residual risk.

## Verification requirements

A successful final report must include:

- exact root cause and evidence
- exact source file(s), commit(s), and deployed runtime version/hash changed
- focused regression test result and any broader validation result
- Herdr state evidence before and after (`working` -> `idle`)
- current pane process/session identity and confirmation it matches Herdr
- deferred reload result artifact and `/reload` confirmation
- `mode:leader` footer and leader prompt/session evidence
- which lanes or components were intentionally untouched
- any remaining limitation, such as the deleted unknown non-Pi pane or unverified non-Linux support

Do not report “fixed” from a status field alone. Require artifact, log, test, process, or live read evidence.
