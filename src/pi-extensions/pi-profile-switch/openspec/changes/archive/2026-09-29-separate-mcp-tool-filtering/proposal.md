# Proposal

## Why

`tools` currently filters Pi built-ins, extension tools, and MCP tools as one registry. A profile that selects a few Pi tools must also enumerate or glob potentially hundreds of MCP tools to retain them. This makes per-server tool selection impractical and lets a single wildcard admit unintended MCP operations.

## What Changes

- Add optional `mcp_tools` to profile definitions: server names map to lists of literal adapter tool selectors. The adapter matches original and prefixed tool names; this profile field does not accept globs. An omitted server allows all its tools; a nonempty list allows only tools matched by its selectors; an empty list allows none without disabling the server. `{}` behaves like omission.
- **BREAKING:** `tools` will select only non-MCP Pi tools, including for existing profiles. Former MCP entries in `tools` cease to govern MCP access and receive migration guidance. `mcps` continues to select servers; the new field narrows tools within those servers.
- Validate explicit server references before activation, including keys that resemble inherited object properties. Treat MCP tool selectors as restrictive adapter inputs without runtime name checks or missing-name notices; an unmatched selector cannot widen access. When an existing adapter allowlist cannot be combined safely, fail before writing runtime files rather than broaden access. A server restriction applies across direct tools and indirect MCP call paths, not just model-facing tool names.
- Keep the project-level resource boundary and the adapter's existing restrictions intact. No profile owns MCP connection parameters, credentials, or server implementations.

Discovery and defaults cannot express a different tool list for the same server in two profiles: discovery yields the server's actual catalog, and a single default can only allow everything or nothing. A per-profile field is necessary for that choice.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `profile-catalog`: accept and validate the per-server `mcp_tools` field.
- `resource-reference`: separate Pi tool selection from MCP tool selection, resolve server references, and apply the adapter's literal selector matching without name diagnostics or permission widening.
- `launcher`: materialize per-server tool restrictions in the instance without changing adapter-owned source configuration.
- `in-session-switch`: reapply tool policies on reload without treating unrelated sibling extensions as MCP-owned, preserve rollback and overlay behavior, and report effective adapter-disabled servers accurately in status.

## Impact

Catalog parser and schema, resolver and launch plan, instance MCP configuration generation, in-session tool application and reporting, profile-config skill, examples and README, plus unit and real-Pi integration tests. No new runtime dependency; add the adapter as a development-only integration-test dependency. Profiles with MCP names or globs in `tools` need migration to `mcp_tools` where they intended tool restrictions.

## Doc Impact

- `docs/prd.md`: clarify that Pi tool selection and per-server MCP tool selection are independent, and the scope of default availability.
- `docs/architecture/overview.md`: update the filtering and activation flow to describe adapter-side MCP tool filtering and Pi tool attribution.
- `CONTEXT.md`: none: existing Profile, Resource, and adapter terms cover the new field.
- `docs/adr/`: add ADR-0015 for the durable catalog format and the choice of adapter-side per-server enforcement over Pi tool-name globs.
- `README.md`, `README.zh-CN.md`, `examples/example.json`, `skills/profile-config/SKILL.md`, `schemas/profiles.schema.json`: update the documented configuration, migration guidance, and examples; do not promise MCP tool-name validation.
