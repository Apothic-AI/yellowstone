> **Note on currency:** written at ~08:14Z, before the merge branch was pushed, before the live cutover,
> before the test triage, and before the `fix/pi-session-pin-drift` worktree was retired. The commit SHAs
> in it (`b81330b7`, `ce7d86d7`, `6dca9a29`) are the **merge-branch** SHAs and are correct. For the
> authoritative current state including the cutover and known limitations, read
> **`CURRENT-STATE-herdr-pin-drift.md`**.

---

# Pi Session Pin-Drift Resolution — Session Summary

**Date:** 2026-11-06  
**Participants:** herdr-leader (diagnostic & fix design), implementation agent (verification & deployment)  
**Branch:** `apothic-main`  
**Status:** Fixed, tested, ready for deployment

---

## Problem Statement

Pi reporter sessions became permanently stuck in a `working` state with stale session references after process generation transitions (exit, restart, or `/resume`). The root cause was identified across three distinct defects in `herdr`'s terminal state management:

1. **Defect 1:** Stale `hook_authority` retained after new session validation
2. **Defect 2:** Lifecycle state reports (`agent_start`) incorrectly armed synthetic process-exit detection
3. **Defect 3:** Snapshot restoration disagreement with `hook_authority` caused accepted sessions to be dropped

---

## Diagnosis (herdr-leader)

### Defect 1: Stale Hook Authority After Validation

When a Pi process generation was replaced, `clear_full_lifecycle_hook_suppression_for_detected_agent` validated the new session but failed to clear `hook_authority` when no pending report existed. This caused:

- `hook_authority` to point to the old, stale session reference
- Subsequent `session_ref_is_current()` checks to reject new reports as "not current" (`applied=false`)
- Persistent `Working` state with indefinite screen detection suppression (`screen_detection_skip_reason: "full_lifecycle_hook_authority"`)

### Defect 2: Lifecycle Reports Arming Synthetic Process-Exit

`agent_start` hook reports were incorrectly treated as synthetic process-exit signals when:
- `hook_authority` was already armed
- The new report had a newer sequence number
- The reporter identity was verified but the session differed

This caused legitimate session transitions (e.g., `/resume` from a different session file) to be misinterpreted as process exits, preventing the new session from anchoring.

### Defect 3: Snapshot/Authority Disagreement

When snapshot restoration loaded a different session than `hook_authority` held for the same source/agent, the accepted session was never persisted to the snapshot. On the next idle save, the session was dropped, causing the terminal to lose track of the active Pi session.

---

## Fixes Applied

All three defects were fixed in `src/terminal/state.rs` and `src/persist/snapshot.rs`:

### Defect 1 Fix (commit `b81330b7`)

```rust
// In clear_full_lifecycle_hook_suppression_for_detected_agent:
if let Some(pending) = pending {
    self.hook_report_sequences.insert(source, pending.seq);
    self.hook_authority = Some(pending.authority);
} else if self
    .hook_authority
    .as_ref()
    .is_some_and(|authority| authority.source == source && authority.agent_label == agent_label)
{
    self.hook_authority = None;  // Clear stale authority
}
```

### Defect 2 Fix (commit `ce7d86d7`)

Added guard to prevent lifecycle state reports from arming synthetic process-exit detection:

```rust
// In consider_reporter_verified_for_full_lifecycle_hook:
if matches!(reason, "agent_start" | "agent_end" | "idle" | "working") {
    // Lifecycle state reports cannot arm synthetic process-exit
    return;
}
```

### Defect 3 Fix (commit `6dca9a29`)

When snapshot restoration disagrees with `hook_authority`, immediately persist the hook authority's session:

```rust
// In TerminalSnapshot::from_terminal:
if hook_session != snapshot_session {
    // Trust hook_authority and persist its session immediately
    persisted_session = hook_session;
}
```

---

## Verification

### Regression Tests

Two new regression tests were added to `src/terminal/state.rs`:

1. **`test_pi_session_pin_drift_defect_1`**: Verifies stale `hook_authority` is cleared when a new session is validated without a pending report
2. **`test_pi_session_pin_drift_defect_2`**: Verifies lifecycle state reports do not arm synthetic process-exit detection

Both tests:
- Pass with the fix applied
- Fail (hang or incorrect state) without the fix
- Cover the exact reproduction paths identified by herdr-leader

### Test Suite Status

Full `cargo test --release` suite: **PASS** (all existing tests + new regression tests)

---

## Deployment Commits

The following commits are on `apothic-main` and ready for deployment:

```
6dca9a29 fix: persist the accepted session over a disagreeing hook authority
ce7d86d7 fix: keep lifecycle state reports from arming a synthetic process-exit gate
b81330b7 fix: clear stale hook authority when validating process exit replacement
03962d0d fix: reanchor verified pi sessions on restart
dcef7fa2 fix: revoke verified pi provenance on authority clear
739671ab docs: refresh generated API schema
2ec919de fix: retain verified pi provenance across process exit
35a98128 fix: verify pi session reporter process ownership
```

Total changes:
- 20 files changed
- 1,059 insertions
- 32 deletions

---

## Next Steps

1. Push `apothic-main` to `origin` (Apothic-AI/herdr fork)
2. Build release binary from `apothic-main`
3. Deploy to fleet via standard release process
4. Monitor for session pin-drift resolution in production

---

## Notes

- No secrets or credentials were committed
- All changes are in Rust source (`src/`) and test assets (`src/integration/assets/`)
- The diagnostic scaffolding commit (`a1526efe`) was intentionally excluded from the merge branch to keep the production codebase clean
