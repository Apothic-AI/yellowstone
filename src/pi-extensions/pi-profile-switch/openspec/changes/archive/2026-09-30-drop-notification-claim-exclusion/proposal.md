# Proposal

## Why

Startup notices deduplicate through two mechanisms: the `displayed.json` history and a per-key claim file under `notifications/claims/`. The claim exists to make overlapping launches display the same notice only once, but that cross-process exclusivity is not a product requirement — the launcher spec only requires that a target "has not already been shown" by an earlier launch (`openspec/specs/launcher/spec.md`, Startup upgrade reminder). The guarantee is also unreliable: the claim is released as soon as presentation finishes, so a second launch that reaches the claim after the release displays the same notice anyway; a release CI run failed on exactly that race, and a gated reproduction confirms it deterministically.

Duplicate delivery across overlapping launches is acceptable. Notices are important, and two Pi windows starting at the same time each showing the same reminder once is harmless, whereas missing a reminder is not. The claim therefore buys a cosmetic guarantee at the cost of a TOCTOU failure surface, a stale-claim rule, and a timing-sensitive test.

## What Changes

- Remove claim-based cross-process exclusion from `src/startup-notifier.ts`: the claim file helpers, the stale-claim constant, and the release-on-failure path disappear; presentation becomes "already recorded → skip, otherwise display then record".
- Keep displayed-history deduplication unchanged: one process never displays the same notice twice, and sequential later launches stay silent. Overlapping launches MAY each display the same notice once; overlapping history writes are last-writer-wins, which can re-show one notice on a much later launch.
- State the overlap boundary in the launcher spec so a future reader does not reintroduce the claim mechanism.
- Update the notification-state description in `docs/architecture/overview.md` (no more `claims/`).
- Replace the timing-sensitive concurrent test with deterministic assertions on per-surface counts and recorded history.

Non-goals: no change to the `displayed.json` format, no new dependency, no cleanup of leftover claim files from existing installs (they become inert), no change to notice content or delivery modes.

## Capabilities

### New Capabilities

- none.

### Modified Capabilities

- `launcher`: the requirement "Best-effort remote checks and global history" gains the overlapping-launch boundary — history is consulted per launch and is not synchronized across Pi processes, so overlapping launches MAY each display the same notice once.

## Impact

- `src/startup-notifier.ts`: claim helpers removed, `present` simplified; `runStartupNotifications` options, `NoticeSurface`, and notice content unchanged.
- `test/startup-notifier.test.ts`: the concurrent test and its describe title change; sequential history tests stay.
- `docs/architecture/overview.md`: notification-state sentence updated.
- No CLI, settings, or dependency changes; no exported interface changes.

## Doc Impact

- `docs/prd.md`: none — no product positioning or goal changes.
- `docs/architecture/overview.md`: update the startup-notification state sentence to drop `claims/` and describe history-only deduplication.
- `CONTEXT.md`: none — no terminology changes.
- `docs/adr/`: none — this is a reversible internal simplification; the rejected alternative (fix the claim instead of removing it) is recorded in `design.md`.
