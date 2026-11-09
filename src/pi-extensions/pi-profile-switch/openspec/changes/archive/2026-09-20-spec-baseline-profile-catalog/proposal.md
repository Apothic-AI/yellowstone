# Proposal

## Why

pi-profile-switch is implemented and working, but `openspec/specs/` is empty. Behavior contracts currently exist only in three indirect places: the code itself, the mechanism descriptions in `docs/architecture/overview.md`, and the decision records of 7 ADRs. Without a verifiable specification, later changes can only be "change the code, touch up the description along the way" — there is no way to tell whether a change breaks existing behavior, nor to point at "this requirement was violated" in review.

This change establishes the first part of the baseline: the `profile-catalog` capability domain.

## What Changes

- Add the baseline specification for the `profile-catalog` capability domain, covering profile definitions and field validation, catalog file parsing, profile sources and override rules, and the observable behavior of create/edit/delete/duplicate.
- No code changes. The specification is taken item by item from the existing implementation: `src/profile-catalog.ts`, `src/profile-catalog-store.ts`, `src/switching/profile-crud.ts`, `src/workspace.ts`, `bin/postinstall.js`.
- No design document. This domain's mechanisms are already carried by `docs/architecture/overview.md` and ADR-0003, ADR-0004; there is no pending new design.

## Capabilities

### New Capabilities

- `profile-catalog`: profile definitions and field validation, catalog file reading and writing, profile sources and the resolution rule of project-over-global, and the observable behavior of create/edit/delete/duplicate.

### Modified Capabilities

(none)

## Impact

- Adds `openspec/specs/profile-catalog/spec.md`, landed at archive time.
- Zero code changes; `src/`, `extensions/`, `bin/`, and `test/` are untouched.
- Follow-up changes establish baselines for the `resource-reference`, `launcher`, and `in-session-switch` capability domains in turn.

## Doc Impact

- `docs/prd.md`: none. This change does not alter positioning, goals, or non-goals; "project-level definitions override global definitions" is already the goal corresponding to a non-goal item.
- `docs/architecture/overview.md`: none. The catalog module and source resolution are already described there; the specification only adds verifiable behavior and introduces no new mechanism. At archive time, verify no mechanism leaked into the specification.
- `CONTEXT.md`: none. The four terms `Profile`, `Catalog`, `Source scope`, and `default profile` are already defined; the specification uses them without adding terms.
- `docs/adr/`: none. This change introduces no hard-to-reverse decision; non-inheritance semantics are carried by ADR-0003, reference-not-copy semantics by ADR-0004.
