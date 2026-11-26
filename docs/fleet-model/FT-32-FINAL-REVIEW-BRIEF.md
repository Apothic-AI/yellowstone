# FT32 independent final review — immutable candidate, no implementation writes

Owner ft32-final-review; parent self-improvement-leader. FT32 swarm-c0l.9.2.
Implementation ft32-session-worker p2F active; do not prompt or edit/reset its tree.
Base0d69f38e1b53a423a0751acc808f2c5c34066c3e, reviewed candidate
b2e1d00940f045a0bb6fa93c9461c22988d79c12 (includes60afa5c12).
Read parent briefs FT-32-{IMPLEMENTATION,CANDIDATE-REVISION,FINAL-GATE}-BRIEF.md as applicable
(note exact filename candidate revision is FT-32-CANDIDATE-REVISION.md), operator FT32 source,
worker result/checkpoint /home/bitnom/.local/state/ft32-session/ and independent baseline
/home/bitnom/.local/state/ft32-acceptance/baseline.md. Existing candidate NOT accepted (fullsuite1red).

## Immediate independent deliverable

1. Inspect EXACT immutable candidate diff against base in canonical Yellowstone objects. Use graft for
   code scope; your own immutable read-only review worktree if tests require (check disk first).
   No runs/writes in active /home/bitnom/Code/yellowstone-wt/ft32-session. No root writer/push/deploy.
2. Verify all provider/model/thinking lifecycle assertions, native CLI/project/user/session overrides,
   actual runtime binary/version and fixture shape. Assess semantics of suppressing only conflicting
   inherited own-model global pin for explicitly declared profile. Parent DECIDED that policy (not
   operator blocker); do not relitigate core/global alternative. Other pins preserved, no spec no
   suppression, resume keeps recorded state, /new derives declared spec. Same-model pin remains
   suppressed for generated instance lifetime; docs must not claim it magically reappears on /model.
3. Adversarial focused probes/test review to identify real omissions/regressions: provider/model
   switch, identity on new/reload/resume/relaunch, explicit CLI/project choice, user global settings
   byte preservation, literal malformed maps/no unrelated key loss. Do not invent huge new harness.
4. Audit test isolation: candidate setup clears lane vars but postinstall.test still writes+restores
   live ~/.pi/agent/skills/profile-config/SKILL.md if HOME real. NEVER run with real HOME; use scratch
   HOME/agent/profile dirs, --ignore-scripts isolated dependency install after hook review, locked
   toolchain and explicit deployed binary for runtime proof. No provider calls, network billing,
   account or credentials; fixture stream throws/no requests. Preserve meaningful assertions.
5. Deliver /home/bitnom/.local/state/ft32-final-review/review.md with exactSHA/diff security review,
   independently checked tests or concrete evidence, actual counts, deficiencies and acceptance
   requirements. Candidate currently has 1red fullsuite subagents model/project precedence; worker
   owns bounded correction. Don't duplicate that fix or waive red. Send concise findings to parent
   and implementation worker. Finish initial review and STOP; parent sends FINAL greenSHA for exact
   acceptance before integration. No Beads/parent dagr/operator TODO edits, no subagents.

## Later exact-final-SHA phase (NOT started until parent supplies SHA)

Independently rerun full component suite clean+dirty and fulltsc on immutable finalSHA with isolated
HOME and pinned deps; deployed runtime path/version proof. Need final diff security review and
mechanical receipts before parent accepts. Real throwaway interactive Pi lane proof must be assigned
by parent with named herdr tab+pil; no headless agent spawning, no /new real fleet lanes, no leader
manual implementation. No release/publication/rollout until exact acceptance.
