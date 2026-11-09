# Proposal

## Why

Under a named profile, the launcher completes the project-trust determination before spawn, and silently judges the project as untrusted when `ask` has no stored decision (ADR-0011's accepted trade-off). But the determination's result is completely invisible: the user opens an untrusted directory, the project catalog is not read, project-level resources are invisible, and there is no hint anywhere in the UI — the user can only guess at the cause. Silent failure violates the project's "errors must be actionable" principle.

## What Changes

- At startup, when the project is determined untrusted and the project directory contains content skipped because of that — pi-profile's own project files (`.pi/profiles/`, `.pi/pi-profile-state.json`, project MCP configuration) or any trust-requiring Pi project resources (`.pi/settings.json`, `.pi/extensions`, etc.) — the launcher SHALL print one diagnostic to stderr.
- The diagnostic SHALL state: the project is untrusted, which content is therefore invisible, and how to authorize (`/trust` persists the decision and takes effect on the next launch; `-- --approve` grants one-shot trust for this launch). Startup continues as usual and the exit code is unchanged.
- The determination logic itself is unchanged: the trust decision order is untouched, no interactive prompt is introduced, and Pi's native ask behavior is unaffected.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `launcher`: the "Launch diagnostic output" requirement gains a new diagnostic class (untrusted project).

## Impact

- Code: `src/launcher/` (emit the diagnostic after the determination); the trust determination and spawn flow are unchanged.
- Tests: cases for the diagnostic firing and not firing.
- No dependency changes.

## Doc Impact

- `docs/prd.md`: none — product positioning and non-goals unchanged.
- `docs/architecture/overview.md`: none — the filtering model and trust-gating mechanism are unchanged; only one more diagnostic output.
- `CONTEXT.md`: none — no new terminology.
- `docs/adr/`: none — does not overturn ADR-0011's determination trade-off; only adds observability of its result.
