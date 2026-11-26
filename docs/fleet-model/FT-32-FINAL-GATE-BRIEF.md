# FT32 b2e1d0094 — final red gate correction, NOT accepted

Parent self-improvement-leader reviewed result.md, b2e1d0094 diff, clean status and actual L6 log:
51files, 1failed/50passed, tests1failed/856passed857, exit1. Focused85pass and tsc0 are progress,
not full completion. Previous commits60afa5c12/b2e1d0094 must remain immutable; append correction.

Implementation owner ft32-session-worker, own isolated tree /home/bitnom/Code/yellowstone-wt/ft32-session.
No root integration/push/live adoption authorized. Prior brief boundaries remain.

## Required bounded outcome

1. Root-cause and fix the one remaining subagents-compatibility model/project-precedence failure.
   It reproduces on base, so it is not your regression; nevertheless full gate remains red and must
   be resolved before acceptance. Determine whether fixture/provider/model registration, runtime
   resolution version, or real source bug; evidence decides. Minimal fixture/harness/source fix
   preserving the ORIGINAL intended provider/project precedence assertions. Do not delete/skip/
   loosen assertion, change expected result to fallback, or mark complete with 'pre-existing'.
   Do not upgrade/alter unrelated dependency pins; report any materially broader required fix first.
2. Test suite isolation: report says postinstall.test wrote+restored live
   ~/.pi/agent/skills/profile-config/SKILL.md. Content equality after is not absence of write.
   Make further gate runs use scratch HOME/agent/profile targets while preserving intentional dirty
   PI_PROFILE/PI_MODE contamination tests; test fixture should NEVER target real config. Scope a
   minimal committed harness protection if needed. Capture authoritative runtime path/version so
   scratch HOME cannot silently change Pi from deployed1.5.0 to locked0.99.2 or vice versa.
   Preserve/restore all environment; no more real skill write. Confirm final diff includes no live
   mode/profile/global/skill changes; if any byte drift found, report exact paths/hashes.
3. Full component suite clean and dirty env and full tsc green at frozen finalSHA. No unreviewed
   production install/postinstall/hooks, no provider requests. Candidate logs say 'every lifecycle
   spawns deployed pi fromPATH'; prove actual resolved child executable/version rather than prose.
4. Update result.md with precise final test receipts/paths, root cause of final failure, exactSHA,
   changes/rollback, docs and runtime evidence. Existing-session behavior remains correct: preserve
   recorded choices; do NOT suggest /new on real lanes or reset intentional thinking.
5. If pin suppression affects same-model re-selection after switching away, state actual semantics
   accurately in docs/report: generated own-model global pin stays suppressed for instance lifetime;
   unrelated model pins and new explicit per-instance/project/CLI/session choices retain precedence.
   Prior prose 'global own-model pin still applies later in-session' must not be asserted unless proven.

Parent assigns independent review in parallel on immutable b2e1d0094; it will not write/run in your
active tree. Final acceptance will re-run exact finalSHA independently. Append scope-only commit,
send result/commit and STOP. No task closure or publication while gate errors remain.
