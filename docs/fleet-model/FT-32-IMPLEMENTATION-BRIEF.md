# FT-32 — durable per-lane provider/model/thinking across session lifecycle

Parent: self-improvement-leader. Bead: swarm-c0l.9.2. Worker: ft32-session-worker.
Post-maintenance gate swarm-c0l.9.41 explicitly confirmed by overlord and closed; work is authorized.
Canonical root: /home/bitnom/Code/yellowstone (git-subrepo, NO jj). Coordinate worktree/write ownership
with yellowstone-leader; implementation lives in an isolated worktree, not root until accepted.

## Outcome

Resolve the FULL operator FT32 at /home/bitnom/Documents/Assistant/Fleet TODOs.md:721 onwards:
provider/model/REASONING EFFORT spec must persist correctly through fresh launch, /new, /reload,
/resume and process relaunch/session restore. A model-only passing /new proof is NOT completion.
Historical three-profile probe: leader max, worker high, ask medium in profile/instance settings,
yet every footer max. global activeProfile=leader was a hypothesis, not established root cause.
Do not assume it; follow current code, isolate actual precedence. Preserve intentional user model /
thinking selection according to reviewed existing contract; if durability precedence genuinely
ambiguous, report concrete alternatives and evidence, not a speculative broad redesign.

## Deliverables (worker owns research, edit, tests, integration preparation)

1. Current root-cause/reproduction evidence and source paths, covering all named lifecycle legs.
   Distinguish launched profile, active profile, per-model pin, settings and actual runtime selection.
   Effective-state evidence must come from real session/SDK APIs or recorded state, not footer alone.
2. Minimal source fix and focused regression tests in isolated Yellowstone worktree, committed without
   attribution trailers. Record exact base/candidate SHAs, diff, tests and actual counts, rollback.
3. Behavioral matrix: leader/worker/ask (or equivalent differing local fixture defaults), conflicting
   global state, valid per-model/user overrides, /new/reload/resume/relaunch, same selected-session
   identity/goal/mode invariants. Use local harness/SDK with no paid provider calls. Real throwaway
   Pi lane proof at appropriate acceptance stage; never mutate global activeProfile merely to test.
4. Artifact /home/bitnom/.local/state/ft32-session/result.md and concise evidence files. Include
   reviewed change/security surface, exact test commands/results, unresolved failures/limits, affected
   consumers and proposed safe rollout. Report readiness to parent and Yellowstone leader.

Use graft to understand code. Read all applicable AGENTS and relevant skills. Check disk before
heavy work. No research/integration by leaders. No private provider requests/accounts, holds, external
messages or unrelated config. No global profile/mode/AGENTS edits or live fleet rollout during
implementation. No /new or changed objective on real fleet lanes; throwaway lanes only. Agents must
spawn through named herdr tabs with pil; you do not spawn peers or close unrelated tabs. Ask parent
for disposable-lane ownership if needed. Preserve unrelated dirty files.

Scope-only source commit after green focused gates is authorized; NO push, subrepo publication,
root integration or live launch/config edit before parent independent exact-SHA acceptance. Final
publication requires exact-final-commit gates, existing-room announcement, normal HEAD:master root
push and fresh advertised-ref equality. Actual deployment must be diff-reviewed, proved on one lane,
recorded, and reload/relaunch adopted by affected consumers with per-lane preservation receipts.
Maintenance pause authority is the LEADER's alone; worker does not inherit it.

Do NOT close/update Beads, source TODO heading or parent dagr; parent is single writer. No new issue
work (FT50/51 are only enumerated; FT47 remains open). After FT32 closure another NEW handoff and
overlord same-session compaction is mandatory before next issue.

Send an early root-cause/checkpoint when verified, then continue minimal fix under this scope.
Finish with evidence artifact + exact commit and stop. Parent will assign independent acceptance.
