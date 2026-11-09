# Design

## Context

See `proposal.md` — Why for motivation. Today `src/startup-notifier.ts` presents each candidate through `present()`, which acquires an exclusive per-key claim file under `notifications/claims/`, displays the notice, records the key in `displayed.json`, and releases the claim. Displayed history is read once per launch before candidate evaluation. The claim's only purpose is to keep two overlapping launches from displaying the same notice; it does not protect the history write itself, and it releases the claim before a second launch's retry can observe anything but the recorded history.

## Goals / Non-Goals

**Goals:**

- Remove claim-based cross-process exclusion while keeping same-launch and across-launch deduplication through `displayed.json`.
- Make the overlapping-launch behavior explicit in the launcher spec.
- Replace the timing-sensitive concurrent test with deterministic assertions.

**Non-Goals:**

- Changing the `displayed.json` format or making history updates lossless.
- Cleaning up claim files left on existing installs.
- Changing notice content, delivery modes, refresh/backoff behavior, or any exported interface.

## Decisions

**1. Delete claim exclusion instead of fixing it.**

Rationale: the launcher spec requires only that a target "has not already been shown" by an earlier launch; nothing requires two overlapping launches to coordinate. The claim's guarantee is also unreliable — it is released as soon as presentation finishes, so a second launch that arrives after the release displays the notice anyway (confirmed: a gated reproduction produced two identical reminders, and the release CI run failed on the concurrent test). Removing the claim deletes a TOCTOU window, an unreadable-claim window (an empty claim file is treated as stale and deleted while held), and a 10-minute stale rule.

Alternatives considered:

- Re-read history after acquiring the claim and treat an unreadable claim as held: restores a reliable exactly-once guarantee, but keeps the claim lifecycle, the stale rule, and a concurrency-sensitive test for a purely cosmetic property. Rejected.
- Keep the mechanism and only fix the test: leaves the flaky failure mode and the correctness surface in place. Rejected.

**2. Presentation becomes check-in-memory, display, record.**

`displayed` is read once per launch and extended after each successful presentation, so one launch never displays the same notice twice. A notice whose key is already recorded is skipped without a claim check. History writes stay read-modify-write (last-writer-wins): overlapping launches recording different keys can lose one key and re-show that notice on a much later launch. This behavior predates the change — per-key claims never serialized different keys — and is accepted. A per-key marker format would remove the lost update but changes the private format, `docs/architecture/overview.md`, and several tests; that is deliberately out of scope.

**3. Failure behavior is unchanged.**

A display that throws records nothing and propagates as today; the missing claim release is the only difference. A later launch retries because no key was recorded.

**4. No ADR required.**

The decision is reversible (claims can be restored), introduces no external dependency or durable format lock, and `notifications/displayed.json` keeps its format. The existing `notifications/claims/` files become inert; no code reads them after this change, and cleanup is intentionally excluded.

**Export surface:** no exported interface changes. `runStartupNotifications`, its options, and `NoticeSurface` are untouched. Private removals inside `src/startup-notifier.ts`: `claimFile`, `tryAcquireClaim`, `releaseClaim`, `CLAIM_STALE_MS`, and the `createHash` import (its only use was the claim file name). `present()` keeps its signature and becomes sequential display-then-record.

## Risks / Trade-offs

- [Two overlapping launches can each display the same notice once] → Accepted by decision; each window showing the reminder is harmless and the spec states the boundary. Mitigation is the explicit spec scenario plus the deterministic test bound (each surface at most one, total one or two).
- [A lost history update can re-show one notice on a later launch] → Pre-existing and bounded to one extra reminder; accepted. A per-key marker format is the follow-up if it ever becomes annoying.
- [Leftover `claims/` files from crashed runs remain on disk] → Inert and tiny; no reader exists after the change. Cleanup intentionally out of scope.
- [Removing a code path reduces coverage of cross-process exclusivity] → The removed guarantee is no longer enforced by design; replacement tests assert the new invariants (per-surface bound, recorded history, later launches silent).

## Migration Plan

No data migration. Existing `displayed.json` remains valid; `claims/` leftovers are ignored. Rollback is a revert of the change; the claim directory becomes used again.
