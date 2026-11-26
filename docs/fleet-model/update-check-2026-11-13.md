# Update check — 2026-11-13

**Incomplete; no updates applied.** This check ran in place; no session switch was made. The current package declarations and lockfile were left untouched. In particular, npm declarations use unversioned sources and the npm manifest uses ranges, so they are not durable exact-version pins; do not run a blanket update.

## Observations

- Pi: installed 1.5.0; npm registry reports 1.5.2. Actual code diff not yet reviewed; hold.
- Herdr: installed client and server report 0.9.5, server not stale. The inspected GitHub HEAD is `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde`, but installed binary provenance and its corresponding upstream ref have not been established; movement is unknown.
- Npm manifest `~/.pi/agent/npm/package.json`, checked with `npm outdated`: installed active sources with newer versions include `@99percentpeople/pi-thinking-fold` 0.1.11 → 0.1.12, `@narumitw/pi-btw` 0.63.5 → 0.63.8, `@timmyjl12/pi-model-picker` 0.2.0 → 0.2.1, `@xynogen/pix-voice` 0.2.9 → 0.2.12, `pi-copy-message` 4.0.12 → 4.0.13 (wanted; latest dist-tag reports 2.1.0), and `pi-hermes-memory` 0.10.0 → 0.11.0 (latest; outside wanted range). These are candidates, not reviewed diffs; hold all. `pi-themes` latest dist-tag is older than installed and does not establish an upgrade. Npm's `@signalridge/pi-goal` and `pi-pretty-tui` results are not evidence of updates to the active local-path forks.
- Ten Yellowstone subrepo `.gitrepo` branch heads were compared with `git ls-remote`: apothic-todo, bizzy, pi-cache-optimizer, pi-fleet-hooks, pi-goal, pi-modes, pi-persist, pi-pretty-tui, pi-profile-switch and pi-rooms matched their recorded commits. This does not establish whether their local trees differ from those commits.
- Examined 35 instance settings files as well as global settings; they include additional local or relative `pi-parameter-tools` paths, whose provenance and upstream movement have not yet been checked.

## Remaining gate

Inspect actual old/new code and dependency, lifecycle, network, credential, filesystem and load-bearing changes; identify herdr binary provenance and remaining local package refs; establish exact known-good rollback pins without disrupting active instances. Prove each acceptable candidate on a throwaway lane and verify fleet rollout before applying. `git subrepo` is unavailable in this shell. No clean review, throwaway-lane test, restart, or rollout was performed; no claim of update safety is made.
