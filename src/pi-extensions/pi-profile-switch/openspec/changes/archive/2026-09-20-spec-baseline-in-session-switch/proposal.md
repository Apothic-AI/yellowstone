# Proposal

## Why

In-session switching is the layer users touch most often and the layer with the highest failure cost: switching means rewriting the runtime files a running process depends on. Rollback, the overlay's scope of effect, and state being written after reload rather than before — these three decide whether a failure leaves a half-switched runtime, and they currently exist only in code comments.

## What Changes

- Add the baseline specification for the `in-session-switch` capability domain, covering the `/profile` command family and mode gating, the switch and reload flow, failure rollback, plan application and the change summary at session start, the runtime overlay, the runtime state file, the observability surface (selector, `list`, `status`), and CRUD's in-session effects.
- No code changes. The specification is taken item by item from `extensions/pi-profile/index.ts`, `src/switching/`, and `src/runtime-state-store.ts`.
- No design document. The mechanisms of reload and generated settings are carried by "Activation flow" in `docs/architecture/overview.md` and by ADR-0005.

## Capabilities

### New Capabilities

- `in-session-switch`: the observable behavior of the `/profile` command family inside the Pi process — sequencing and failure semantics of switch and reload, the overlay's scope, the location and merge rules of runtime state, and the runtime effects of observability and CRUD commands.

### Modified Capabilities

(none)

## Impact

- Adds `openspec/specs/in-session-switch/spec.md`, landed at archive time.
- Zero code changes; `src/`, `extensions/`, `bin/`, and `test/` are untouched.
- CRUD's write semantics (failure conditions, scope ownership, concurrent overwrite) already live in the `profile-catalog` capability specification; this specification covers only their **effects** on the runtime and does not repeat the write rules.
- This change is the final piece of the four capability-domain baselines.

## Doc Impact

- `docs/prd.md`: none. "Switching without process restart", "the overlay is a temporary adjustment that does not touch the catalog", and "switching preserves the session" are already covered by the product goals and runtime semantics; this change does not alter positioning, goals, or non-goals.
- `docs/architecture/overview.md`: none. The in-session switching part of "Activation flow" and "Known limitations" already describe this domain's mechanism and deviations; the specification only adds verifiable behavior.
- `CONTEXT.md`: none. `RuntimeOverlay`, `Runtime state`, `ActivationPlan`, and `Runtime reload` are already defined; the specification uses them without adding terms.
- `docs/adr/`: none. This change introduces no hard-to-reverse decision; the reload mechanism is carried by ADR-0005.
