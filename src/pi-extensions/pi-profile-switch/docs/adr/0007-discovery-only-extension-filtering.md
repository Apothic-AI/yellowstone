# Discovery-only filtering; retiring resources.json and ResourceRegistry

Supersedes ADR-0006.

## Context

ADR-0006 introduced extension auto-discovery but kept `resources.json` as an explicit override layer, with `dependsOn` (dependency closure and cycle detection) and `alwaysOn` (system extensions that cannot be disabled).

The cost in practice:

- Pi itself has no extension dependency graph and no always-on extension concept. Managing dependencies inside pi-profile means turning it into an ad-hoc package manager.
- Two configuration surfaces, `profiles.json` and `resources.json`, plus the `/profile resource [list|create|edit|delete]` command family, significantly expanded the concept and CLI surface.

## Decision

Retire `resources.json`, `resources.schema.json`, and `ResourceRegistry` completely. Extensions adopt the same pure "discover and filter" model as skills:

1. Discovery reads installed user packages and loose extension files in standard directories.
2. Profiles declare extension references directly. Resolution is a pure filter over the discovered set — no dependency closure, no cycle detection.
3. The runtime overlay may disable any resolved extension; the `alwaysOn` restriction is removed.
4. The `/profile resource *` command family and its wizards are deleted; `/profile` manages profiles only.

## Rejected alternatives

**Keeping `resources.json` as an override layer** (ADR-0006's design). Rejected for the two costs in Context.

## Consequences

- An extension at a non-standard path can only be referenced by a profile via absolute path; it can no longer be registered under a stable ID.
- Without dependency declarations, a profile must list every extension it needs itself.
