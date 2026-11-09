# Design

## Context

See `proposal.md` — Why. Pi's native MCP extension starts in Pi 0.99.1 (ADR-0016). `package-lock.json` currently resolves an older Pi release. ADR-0014 requires a new announcement ID when the action changes materially.

## Goals / Non-Goals

**Goal:** Make installation metadata and the published notice consistent with the native MCP backend.

**Non-goal:** Add runtime version checks or change the notifier's parsing and delivery.

## Decisions

- Use `>=0.99.1` for both the peer and development Pi ranges and regenerate the lockfile with npm. A peer-only update would leave local development resolving an unsupported Pi version; an exact pin would unnecessarily exclude future Pi releases. The npm peer constraint is the compatibility gate.
- Replace the old notice with a new ID, keep the existing expiry, and set `requiresUpgrade: true` because the action asks for upgrades. An in-place edit to the old ID could be suppressed by existing display history; keeping both notices would deliver contradictory advice.
- Align integration test invocations with Pi's current `--mode text` syntax: the upgraded Pi rejects the old `--mode print` syntax with exit code 1. Changing only the invocation keeps the stdout/stderr and trust assertions intact; retaining the old flag would make the supported-Pi test suite fail for an unrelated CLI rename.

**Contract surface:** `package.json` and its generated `package-lock.json` declare the install-time peer range. `announcements.json` publishes one revised notice under the existing feed schema. Exported TypeScript files, methods, signatures, and error types are unchanged.

## Risks / Trade-offs

- Existing installations with unsupported Pi are not retroactively blocked → the notice asks users to upgrade; npm enforces the peer range on future installs.
- Offline users may still see the old cached announcement until the next successful feed refresh → keep the new ID and let the existing cache/expiry behavior handle it.
