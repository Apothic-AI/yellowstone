# Per-server MCP tool selection and Pi tool filtering separation

## Context

Previously, a profile's `tools` array filtered Pi built-ins, extension tools, and MCP tools as a single shared registry. This created several issues:
- Selecting a few Pi tools required explicitly enumerating or globbing (`mcp__*`, `github_*`) all MCP tools to prevent them from being hidden.
- Wildcards in `tools` could unintentionally admit sensitive MCP tools across multiple servers.
- Filtering only through Pi's model-facing tool registry (`setActiveTools`) left indirect execution routes—such as the `mcp` gateway proxy, `mcpScript`/`mcpCode`, and namespace proxies—able to invoke excluded tools.
- MCP tool prefixes are configurable and can change or collide, making tool names an unreliable identifier of MCP origin.

## Decision

1. **Independent `mcp_tools` catalog field**:
   Add optional `mcp_tools: Record<string, string[]>` to profile definitions. Keys are literal configured MCP server names; values are literal selectors passed to the adapter. A selector may be an original or prefixed name, and both spellings can select the same server tool.
   - Omitted `mcp_tools` or `{}`: no restrictions on MCP tools.
   - Omitted server key: full native tool access for that server.
   - Nonempty selector list: restricts that server to only tools matched by its selectors.
   - Empty list (`[]`): denies all tools for that server while leaving the server enabled for its non-tool functions.
   - Literal selectors only (no globs): keeps the profile's declared scope reviewable without adapter pattern breadth.

2. **`tools` is strictly non-MCP**:
   `tools` governs only non-MCP Pi tools (built-in and extension-contributed tools, classified strictly by the winning registration's `sourceInfo`). Live MCP tools remain usable independently of `tools`. Legacy MCP references in `tools` receive actionable migration guidance.

3. **Enforcement via instance configuration**:
   Per-server tool restrictions are materialized in the generated instance `mcp.json` consumed by `pi-mcp-adapter`:
   - Nonempty selector lists use `includeTools`. A prior nonempty `includeTools` may be replaced only when every requested selector is the identical literal in that list, or the existing list is `"*"`; otherwise activation fails before runtime writes rather than infer a safe intersection from aliases. Existing `excludeTools` stays in place for adapter evaluation.
   - Empty lists use `excludeTools: ["*"]` because the adapter treats `includeTools: []` as unrestricted.
   - Filtering at the adapter level blocks unauthorized tools across direct tools, gateway proxies, and script execution paths alike before runtime files are written. User and project configuration files are never modified.

## Rejected alternatives

**Filter MCP tools solely via `setActiveTools()`.** Rejected because indirect call paths (`mcp` gateway tool, `mcpScript`, namespace proxies) bypass model-facing registry filtering.

**Keep `tools` as a simultaneous allowlist for MCP tools.** Rejected because it breaks the promised omitted-server default and forces users to duplicate server policies in tool-name globs.

**Allow globs in `mcp_tools`.** Rejected for the initial version because patterns obscure the exact adapter tool identifiers being restricted and make profile review less reliable.

**Rewrite source configuration files.** Rejected because it would leak per-profile selections across concurrent Pi processes and violate byte-identity preservation.

## Consequences

- Breaking change for profiles with MCP tool references in `tools`: users must move desired MCP tool restrictions to `mcp_tools`.
- Independent configuration: selecting a subset of Pi tools (e.g. read-only `["read", "grep"]`) no longer strips enabled MCP tools.
- Fail-closed security: server filtering occurs at the adapter source level before tool registration, protecting against indirect calls. Literal selectors are not checked against a tool catalog; an unmatched selector remains restrictive without a tool-name diagnostic, as required by the [resource-reference contract](../../openspec/changes/separate-mcp-tool-filtering/specs/resource-reference/spec.md#requirement-per-server-mcp-tool-reference-resolution).

## Related

Proposal: `openspec/changes/separate-mcp-tool-filtering/proposal.md`; design: `openspec/changes/separate-mcp-tool-filtering/design.md`; spec deltas: `openspec/changes/separate-mcp-tool-filtering/specs/`; adapter mechanics: `docs/adr/0002-mcp-integration-locked-to-pi-mcp-adapter.md`.
