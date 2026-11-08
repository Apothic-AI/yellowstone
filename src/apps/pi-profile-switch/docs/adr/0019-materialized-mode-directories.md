# Mode and preset directories are materialized, not linked

For the instance lifecycle, see [ADR-0010](0010-per-launch-instance-lifecycle.md). For why profiles reference rather than vendor user resources, see [ADR-0004](0004-profiles-reference-shared-resources.md).

## Context

The agent-dir mirror links every entry of the real agentDir into the instance, skipping only the profile-managed files. `modes/` and `mode-presets/` therefore arrived in the instance as directory symlinks.

`pi-modes` refuses to read a mode path that crosses a symbolic-link boundary and fails closed per file. Under the launcher, every mode and every preset was silently unavailable — the only diagnostic was a single `Prompt mode warning: … mode path crosses symbolic-link boundary` line on stderr. On a bare `pi` the same configuration worked, so the failure appeared only for profiled lanes: the exact lanes the launcher exists to serve.

The two readers disagree at a lower level than either's contract: the mirror is defined as a symlink snapshot, and pi-modes is defined to reject symlinked mode paths. Neither is wrong.

## Decision

`modes/` and `mode-presets/` are **copied** into the instance as real directories on every launch, after the mirror completes. They are excluded from the mirror loops and from the sweep's foreign-content test, because pi-profile regenerates them each launch and they carry no third-party state.

The alternative — teaching pi-modes to tolerate a symlinked root — was rejected. Its boundary check is a deliberate, documented protection against mode text arriving from outside the expected tree, and weakening it to accommodate a mirror is the wrong direction of change.

This is not the resource copying [ADR-0004](0004-profiles-reference-shared-resources.md) rejects. ADR-0004 rejects **profile-owned** copies of user resources, which fork implementations into N maintained variants. These copies live in a per-launch instance directory that is destroyed on exit, and the source of truth remains the user's agentDir.

## Consequences

- Modes and presets work under every profile; the worker lane's `replace_base` base and the shipped overlays are usable again.
- Each launch pays one recursive copy of two small directories. Absent sources are skipped, and a failed copy leaves the instance without those resources rather than failing activation.
- An edit to a mode file while a lane runs does not reach that lane, because the copy is a snapshot. This matches how every other mirrored resource already behaves, and `/profile reload` regenerates the files it manages.
- If a future Pi or pi-modes change makes a symlinked mode root acceptable, this can be reverted by removing the copy step; no other decision depends on it.