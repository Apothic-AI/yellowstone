# Decouple team-workflow governance from the repository

## Why

`AGENTS.md` binds team-workflow — a personal skill that is not shipped in this repository — into the project's mandatory process: contributors without the skill hit a broken reference. Repository rules must only mandate tooling the repository itself provides; OpenSpec, whose skills ship in `.pi/skills/`, remains the single mandated process.

## What Changes

- Remove the "Critical paths and team-workflow escalation" bullet from `AGENTS.md`'s "Process discipline and escalation" section.
- Replace it with a workflow-neutral "High-risk paths" note: the same per-session hot paths (launcher startup flow, instance runtime directory generation and sweeping, resource discovery and the filtering model) are kept as caution markers, without naming team-workflow or requiring any workflow beyond OpenSpec.
- Reword the "Final acceptance" bullet in `AGENTS.md` to drop the team-workflow mention: `/opsx-verify` applies to every change.
- team-workflow becomes an opt-in, manually invoked workflow owned by the maintainer; no project file references it.

## Capabilities

- **New Capabilities**: none.
- **Modified Capabilities**: none — this is a pure governance-documentation change (`skip_specs: true`); no product behavior changes.

## Impact

- `AGENTS.md`: contributor-facing process instructions only.
- No source code, runtime dependencies, spec content, or product behavior changes.

## Doc Impact

- `docs/prd.md`: none — product positioning, goals, and non-goals are unchanged.
- `docs/architecture/overview.md`: none — no module boundary or activation flow changes.
- `CONTEXT.md`: none — no terminology changes.
- `docs/adr/`: none — the decision is easily reversible (restoring the escalation bullet) and the rejected alternatives (shipping the skill in-repo, conditional escalation) are recorded here in this proposal, not as a hard-to-reverse lock.
