# FT32 candidate 60afa5c12 — reviewed, NOT accepted; bounded correction release

Parent self-improvement-leader decision. Candidate source diff and worker artifacts read.
No root integration, publication, live configuration mutation or rollout authorized yet.

## Policy decision (within harness authority; not deferred to operator)

Keep minimal pin-suppression approach, not pin synthesis or core precedence change:
when a profile EXPLICITLY declares provider/model/thinking, its declared thinking level governs
startup for that model rather than an inherited GLOBAL pin. Drop only conflicting inherited own-model
pin from generated instance. Matching and unrelated pins may remain; unspecified profile levels/
default profile inherit as before. The real global file remains untouched. Explicit CLI, project and
in-session choices and recorded resumed-session choices retain native Pi precedence. No reset of
resumed sessions to profile spec. This is a defensible FT32 resolution, not an operator blocker.
Record consequence plainly: a conflicting global same-model pin will no longer override that explicit
profile's startup level; it still applies where no such profile declaration exists. No feature redesign.

## Required corrections by implementation worker

1. Complete isolated dev install with exact declared/locked dependency versions and use LOCAL pinned
   Vitest, never npx-selected5.1.0. Review install hooks first; install with --ignore-scripts and scratch
   HOME/agent/profile paths (or equivalently reviewed isolation) so no postinstall can overwrite a live
   skill/config. Registry dependency download permitted, no accounts/paid resource/provider calls.
   No package/lock change just to make installs pass. Verify npm ls, .bin/pi and local tsc/vitest.
   Distinguish locked native Pi version (0.99.2 per review) from deployed Pi1.5.x; regression proof must
   target actual deployed SDK/binary as well, without silently upgrading lock or downgrading runtime.
2. Minimal TEST harness hermeticity: scrub inherited PI_PROFILE/PI_MODE/PI_MODE_CONFIRM_PROJECT/
   PI_ROOMS_NAME/PI_CODING_AGENT_DIR/PI_CODING_AGENT_SESSION_DIR in shared setup/fixture boundary so
   in-process AND subprocess tests don't inherit a real lane's identity/profile. Preserve tests that
   explicitly set those vars; use snapshot/restore and add env-priority regression cases (named profile
   > PI_PROFILE > saved; unknown explicit env errors). No production resolver change unless truly needed.
3. Regression matrix currently sets global conflicting pin only for worker-model while leader/ask
   cases use different models. Add TRUE conflicting same-model pins in EVERY profile case or use one
   shared model with differing profile levels, with max-capable fixture. Assert actual runtime provider,
   model and thinking; explicit absence of conflicting pin, unrelated pins preserved. Matching-pin
   control and no-thinking/no-model cases unchanged. Show tests fail against immutable pre-fix base.
4. Strengthen lifecycle identity and intentional override proof: /new changes session ID but keeps
   declared runtime spec; /reload same session and user-selected provider/model/thinking; /resume and
   process relaunch restore exact selected session plus recorded model/provider/thinking, including
   a choice differing from profile. Preserve native project/CLI overrides and other-model pin semantics.
   Avoid inference from footer or handwritten fixture alone where actual session round-trip is possible.
5. Docs/ADR narrowly explain reviewed startup policy and existing-session behavior. Remove operator-
   decision blocker for this known resolution; retain genuine limitations. Do not rewrite historical
   evidence; date/appended correction for stale/unproven report assertions.
6. Full component suite + full project typecheck MUST be green on frozen final candidate, with both
   dirty real-lane env and clean env if suite hermeticity is part of fix. No skipped/deleted/loosened
   assertions to erase baseline failures. No complete claim while remaining errors unresolved.
   Pin exact source/runtime/tool versions, commands/results, counts and logs. Separate source/runtime
   incompatibility if discovered, don't hide with dependencies symlinked to changing npx caches.

Scope-only correction commit(s) on YOUR existing isolated worktree authorized; no subrepo/root push,
no fleet edits. Coordinate independent verifier through checkpoint files/DM, no concurrent tree writes.
Send final SHA/full diff/artifact and STOP. Parent independent acceptance comes next. If new genuine
unknown remains, record evidence/narrow alternatives instead of broad scope expansion.
