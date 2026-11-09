**Superseded by ADR-0018.**

# Drop pi-mcp-adapter; target Pi's built-in MCP extension

## Context

Pi 0.99.1 ships a built-in MCP extension (`builtin:mcp`) that owns MCP server configuration, connections, and tool registration. The previous pi-profile-switch release delegated all MCP support to the optional `pi-mcp-adapter` package: profiles declared `mcps` and `mcp_tools`, and pi-profile-switch generated an instance `mcp.json` that the adapter consumed.

That delegation created several problems:
- The adapter was an extra package users had to install and keep compatible; a profile declaring `mcps` failed to activate when the adapter was absent.
- The adapter used different encodings (`disabled`, `includeTools`/`excludeTools`) than Pi's built-in extension (`enabled`, `toolExposure`).
- Maintaining a dual-backend path would force pi-profile-switch to reconcile two ownership models for MCP tools in `apply-plan.ts` and to test every MCP feature against both extensions.

Pi's built-in extension is now the only MCP backend pi-profile-switch supports.

## Decision

1. **Native MCP configuration only**: pi-profile-switch reads MCP server definitions from Pi's standard user-level configuration locations (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, and `<agentDir>/mcp.json`) plus the trusted-project classification source (`<projectDir>/.pi/mcp.json`). It no longer discovers `pi-mcp-adapter`-specific files and no longer depends on the `pi-mcp-adapter` package.

2. **Snapshot model**: the launcher and in-session switching materialize a merged `mcp.json` snapshot into the instance directory. The snapshot contains:
   - Selected user-level servers with their merged definitions.
   - Unselected user-level servers encoded as `enabled: false`.
   - An explicit `mcps: []` disables every discovered user-level server; trusted project-level servers remain enabled.
   - Per-server `mcp_tools` replaces the server's merged `toolExposure` with `{"*": "hidden", <selector>: "direct", ...}`; an empty list becomes `{"*": "hidden"}`.

3. **Native tool ownership**: a tool is considered MCP-owned when its winning registration's `sourceInfo.path === "builtin:mcp"`. The previous adapter-attribution logic and package-root resolution are removed.

4. **SSE rejection**: profiles cannot select servers whose definition carries `type: "sse"`, because Pi's built-in extension does not support SSE transports. Activation fails with an actionable message pointing users to the streamable HTTP migration.

## Rejected alternatives

**Dual-backend support.** We considered keeping the adapter path as a fallback while also supporting the built-in extension. Rejected because it would duplicate discovery, encoding, ownership, and test matrices for no user benefit: Pi's built-in extension is available wherever Pi 0.99.1+ is installed, and mixing two MCP backends in one session is undefined.

## Consequences

- Profiles that referenced `pi-mcp-adapter` in `extensions` no longer need to; the built-in extension is selected automatically by Pi when `mcp.json` contains servers.
- `mcp_tools` selectors are now literal MCP tool names as exposed by the built-in extension; the previous prefixed/alias forms from the adapter no longer apply.
- The generated instance `mcp.json` is always a materialized snapshot, never a symlink to the user's configuration.
- In-session `pi mcp add` edits to the instance `mcp.json` are overwritten on the next profile switch or reload, restoring the profile's declared snapshot.

## Related

Behavior contracts: `openspec/specs/resource-reference/spec.md`, `openspec/specs/launcher/spec.md`, `openspec/specs/in-session-switch/spec.md`, and `openspec/specs/profile-catalog/spec.md`; mechanism ownership: `docs/architecture/overview.md`; previous adapter decision: `docs/adr/0002-mcp-integration-locked-to-pi-mcp-adapter.md`.
