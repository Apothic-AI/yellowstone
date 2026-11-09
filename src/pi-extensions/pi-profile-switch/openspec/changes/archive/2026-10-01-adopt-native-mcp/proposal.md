# Proposal

## Why

Pi v0.99 ships a built-in MCP extension and `pi-mcp-adapter` is no longer installed or supported. The built-in reads only `<agentDir>/mcp.json` (plus a trusted project's `.pi/mcp.json`), supports only stdio and streamable HTTP transports, and encodes enablement as `enabled: false` and tool narrowing as `toolExposure`. pi-profile-switch still discovers MCP servers through adapter-owned config locations, gates `mcps`/`mcp_tools` on the adapter being active, and writes adapter-specific keys (`disabled: true`, `includeTools`/`excludeTools`) that native Pi silently ignores. On Pi 0.99+, profiles that declare MCP servers fail activation, and servers configured in the adapter-era locations (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`) become invisible to every session.

## What Changes

- **BREAKING** Drop `pi-mcp-adapter` support entirely: remove adapter detection, adapter attribution, `MissingMcpAdapterError`, and the devDependency. `mcps`/`mcp_tools` no longer require the adapter to be active.
- MCP server discovery merges the user-level sources (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, and the real agentDir's `mcp.json`) into a snapshot that is materialized as the instance's `mcp.json` — the only global-scope file native Pi reads.
- **BREAKING** Config encoding changes to native Pi semantics: unselected user-level servers are written `enabled: false` (was `disabled: true`); `mcp_tools` selectors become `toolExposure` `{"*":"hidden", <selector>:"direct"}` (was an `includeTools`/`excludeTools` intersection). A profile's `mcp_tools` replaces the server's configured `toolExposure` wholesale.
- **BREAKING** A selected server using the legacy SSE transport fails activation with migration guidance; an auto-included SSE server passes through and Pi reports it as a config error.
- Project scope: a trusted project's `.pi/mcp.json` stays in the discovery list solely for project-owned classification (Pi reads it itself); the adapter-era project-root `.mcp.json` source is dropped.
- The instance `mcp.json` is always materialized from the snapshot (the symlink shortcut is removed); in-session `pi mcp add` edits to the instance config are overwritten on profile switch — documented as snapshot semantics.
- MCP-owned tool detection for the `tools` allowlist switches from adapter attribution to `sourceInfo.path === "builtin:mcp"`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resource-reference`: MCP server reference resolution, per-server MCP tool reference resolution, and selector failure tiering are rewritten against native Pi semantics (merged user-level snapshot, `enabled: false`, `toolExposure`, SSE failure tiering, project-owned boundary).
- `profile-catalog`: field contracts for `mcps`/`mcp_tools` no longer depend on an adapter being selected.
- `launcher`: instance generation always materializes `mcp.json` from the merged user-level snapshot instead of symlinking or adapter-filtering.
- `in-session-switch`: switch/reload re-materialize the snapshot; MCP-owned tool classification uses the built-in MCP extension path, and status reports server availability from the merged snapshot without adapter gating.

## Doc Impact

- `docs/prd.md`: update — the "No MCP connection parameters or credentials" non-goal and the adapter-absence guarantee refer to `pi-mcp-adapter`; they must be rewritten against native Pi config and the snapshot model.
- `docs/architecture/overview.md`: update — the MCP servers & tools mechanism rows and the `mcp-config.ts`/`apply-plan.ts` module descriptions change with the mechanism.
- `CONTEXT.md`: update — the `pi-mcp-adapter` and `McpServerRegistry` term definitions are adapter-specific.
- `docs/adr/`: `ADR required: drop-pi-mcp-adapter` — a new numbered ADR records the hard-to-reverse decision to target native Pi MCP only; ADR-0002 is superseded.
- `README.md`: update — install/usage facts about `mcps`/`mcp_tools` semantics, adapter requirements, and migration.
- `skills/profile-config/SKILL.md`: update — the shipped profile-authoring skill documents adapter discovery locations, adapter selector forms, and the adapter-activation requirement for `mcps`/`mcp_tools` (lines 57, 59, 74, 109, 111, 117–118); these must be rewritten against native Pi semantics.

## Impact

- `src/mcp-config.ts`: source list trimmed to user-level sources, adapter errors removed, merge result reused for the snapshot.
- `src/profile-resolver.ts`: adapter gates removed, native encodings in instance config generation, SSE validation on explicit selection.
- `src/settings-generator.ts`: always-materialize snapshot path replaces the symlink/adapter-fallback paths.
- `src/switching/apply-plan.ts`: adapter attribution removed; `isMcpOwnedTool` matches `builtin:mcp`.
- `src/extension-discovery.ts`: adapter reference-alias comment removed.
- `package.json`: `pi-mcp-adapter` devDependency removed.
- Tests: `test/profile-resolver.test.ts` and integration fixtures for adapter-driven MCP scenarios are replaced with native-semantics cases.
