# Proposal

## Why

The launch path is the only entry point through which a profile takes effect: it decides which profile is used, whether project resources are trustworthy, and whether any failure must abort before Pi starts. These three currently exist only scattered across code comments. The failure semantics (an unknown profile is a hard failure; a stale name restored from saved state is a soft fallback) have no reviewable specification source.

## What Changes

- Add the baseline specification for the `launcher` capability domain, covering CLI argument parsing and pass-through, initial profile selection, pre-launch failure and exit codes, project trust gating, diagnostic output, instance generation, and subprocess launch.
- No code changes. The specification is taken item by item from `bin/pi-profile.ts`, `src/launcher/args.ts`, `src/launcher/initial-profile.ts`, `src/launcher/discovery.ts`, `src/launcher/model-check.ts`, `src/launcher/spawn.ts`, `src/project-trust.ts`, and `src/settings-generator.ts`.
- No design document. The host architecture and generated-settings mechanism are carried by `docs/architecture/overview.md` and ADR-0005.

## Capabilities

### New Capabilities

- `launcher`: the observable behavior of the `pi-profile` launcher — argument boundaries, initial profile selection and fallback, failure timing and exit codes, trust determination, diagnostic output, the instance directory contract, and subprocess launch.

### Modified Capabilities

(none)

## Impact

- Adds `openspec/specs/launcher/spec.md`, landed at archive time.
- Zero code changes; `src/`, `extensions/`, `bin/`, and `test/` are untouched.
- The specification does **not** describe the cleanup of stale instance directories. The existing sweep implementation scans `<agentDir>/pi-profile/runtime/launch-*`, while instances are written at `<PI_PROFILE_SWITCH_DIR>/instances/<profile>/agent` — two different directory trees, so the sweep is a permanent no-op in production. Writing this into the contract would ossify a defect, so the specification only describes the instance path contract; the defect is handled separately.
- A follow-up change establishes the baseline for the `in-session-switch` capability domain. Overlay semantics (including the rules when the `default` profile is narrowed by an overlay) belong to that domain and are not in this specification.

## Doc Impact

- `docs/architecture/overview.md`: **one wrong assertion needs fixing**. The "Runtime directory" section says "stale directories with dead `pid`s are swept at startup", but the sweep's actual target path differs from the instance path, so the cleanup never happens. Before archiving, change it to state the actual layout: the instance path is fixed per profile and reused, not cleaned; the `pid` file is still written but currently has no consumer.
- `docs/prd.md`: none. The launch entry point and "behavior a profile does not explicitly control stays native Pi" are already covered by the product goals; this change does not alter positioning, goals, or non-goals.
- `CONTEXT.md`: none. `instance`, `Source scope`, and `Project trust` are already defined; the specification uses them without adding terms.
- `docs/adr/`: none. The host architecture is carried by ADR-0005; the specification references rather than copies its reasoning. The ineffective sweep is an implementation defect, not a hard-to-reverse decision.
