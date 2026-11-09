# Tasks

## 1. Remove claim-based exclusion

- [x] 1.1 In `src/startup-notifier.ts`, delete `claimFile`, `tryAcquireClaim`, `releaseClaim`, the `CLAIM_STALE_MS` constant, and the `createHash` import; reduce `present()` to display-then-`recordDisplayed` with no claim, keeping the existing error propagation; remove the fs imports that only served claim handling and the "exclusive display claims" wording from the surrounding comments.
  Verification: covers the "Overlapping launches" scenario and the "Within one launch, a notice MUST NOT be displayed twice" sentence of "Best-effort remote checks and global history". `rg -n 'claimFile|tryAcquireClaim|releaseClaim|CLAIM_STALE_MS|createHash' src/startup-notifier.ts` prints nothing and `npm run check` passes. Fact → source: those identifiers are defined in `src/startup-notifier.ts` (claim helpers in the block above `present()`, `CLAIM_STALE_MS` near the top constants, `createHash` in the import block) — re-run the same `rg` before editing to confirm each still exists.

## 2. Rework the concurrency test

- [x] 2.1 In `test/startup-notifier.test.ts`, replace the "two simultaneous launches display the same reminder only once" test (currently around lines 332-349) with a deterministic test named "overlapping launches each display the reminder at most once and history is recorded": each surface has at most one message, the combined count is one or two, `notifications/displayed.json` contains `upgrade:1.1.0`, and a third launch displays nothing; update the describe title at line 266 to drop "and claims".
  Verification: covers "Overlapping launches" and "Already shown target". `npx vitest run test/startup-notifier.test.ts` passes, and the targeted test is stable across repeated runs: `for i in 1 2 3 4 5; do npx vitest run test/startup-notifier.test.ts -t 'overlapping launches' || exit 1; done`. Fact → source: the test name to replace and the describe title are in `test/startup-notifier.test.ts`; confirm with `rg -n 'simultaneous|and claims' test/startup-notifier.test.ts` before editing.

## 3. Documentation sync

- [x] 3.1 Update the notification-state sentence in `docs/architecture/overview.md` (around line 97): remove the transient display claims (`claims/`) item and describe deduplication through the displayed-history record only; keep the existing launcher-spec link.
  Verification: `rg -n 'claims/' docs/architecture/overview.md docs/prd.md CONTEXT.md README.md docs/adr/` prints nothing after the edit; the sentence still links to "../.." launcher requirement and no other file promises display claims. Fact → source: the current wording is `docs/architecture/overview.md:97`; the proposal's Doc Impact section records that `docs/prd.md`, `CONTEXT.md`, and `docs/adr/` need no changes.

## 4. Final verification

- [x] 4.1 Run the project checks on the final tree and confirm the removed machinery leaves no residue.
  Verification: covers all delta scenarios through the existing suites plus the reworked test; `npm run check` and `npm test` both pass; `rg -n 'tryAcquireClaim|releaseClaim|claimFile' src/` and `rg -n 'display the same reminder only once' test/` print nothing. A failure in either command fails the task.
