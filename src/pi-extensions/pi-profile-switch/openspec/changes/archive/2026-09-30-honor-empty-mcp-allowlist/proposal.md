# Proposal

## Why

A named profile that enables `pi-mcp-adapter` cannot currently select zero MCP servers: `mcps: []` is treated as though `mcps` were omitted. The adapter then retains access to user-level servers that the profile intended to exclude.

## What Changes

- Make an explicit empty `mcps` array an empty selection for user-level servers discovered from the existing standard MCP configuration sources. Omission continues to leave server availability unchanged.
- Apply the same selection at launch, on `/profile use`, and on `/profile reload`; report discovered user-level servers as disabled in `/profile status`.
- Keep trusted project-owned servers outside profile narrowing. Preserve the existing behavior of profiles without an active adapter: an empty list alone does not make them depend on the adapter.
- Add regression coverage for the distinction between an omitted and empty list, including adapter behavior and unchanged source configuration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `profile-catalog`: Distinguish an explicitly empty `mcps` declaration from an omitted field.
- `resource-reference`: Retain the empty selection when an adapter is active without changing the no-adapter boundary.
- `launcher`: Materialize the empty selection for the currently discovered user-level MCP servers.
- `in-session-switch`: Preserve the restriction across switching and reload, and show the resulting status.

## Impact

The change affects MCP discovery gating in `src/launcher/initial-profile.ts`, resolution in `src/profile-resolver.ts`, and tests for generation and switching. It uses the existing instance `mcp.json` filtering path; it adds no field, command, runtime dependency, or credential handling. Adapter-only sources not represented in the current discovery result and trusted project-owned servers are outside this change.

## Doc Impact

- `docs/prd.md`: none: its existing user-level narrowing goal and project-scope non-goal already apply.
- `docs/architecture/overview.md`: clarify that status uses trust-gated server ownership to keep project-owned servers enabled; the existing instance filtering mechanism is unchanged.
- `CONTEXT.md`: none: no domain term changes.
- `docs/adr/`: none: the decision in ADR-0002 remains unchanged.
- `README.md`, `README.zh-CN.md`, `skills/profile-config/SKILL.md`: explain the user-visible difference between omitted and empty `mcps`, including the existing project boundary; correct the skill's empty-list example guidance.
