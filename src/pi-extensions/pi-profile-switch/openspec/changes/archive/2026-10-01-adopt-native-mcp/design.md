# Design

## Context

Pi v0.99 ships a built-in MCP extension and `pi-mcp-adapter` no longer exists (see proposal.md — Why). The built-in extension reads MCP server configuration from exactly two places: `<agentDir>/mcp.json` and, in trusted projects, `<cwd>/.pi/mcp.json`. It encodes enablement as `enabled: false` and per-tool visibility as `toolExposure`, with exposure values `codemode`, `codemode-deferred`, `deferred`, `direct`, `hidden` (verified against installed pi 0.99.1: `dist/core/mcp-servers.js`, `dist/extensions/mcp/`). Tools registered by the built-in extension carry `sourceInfo.path === "builtin:mcp"`.

pi-profile-switch currently resolves MCP servers through adapter-recognized locations, gates `mcps`/`mcp_tools` on an adapter being selected (`src/profile-resolver.ts`), writes adapter-only encodings (`disabled: true`, `includeTools`/`excludeTools`), and attributes MCP tools by adapter package identity (`src/switching/apply-plan.ts`). Constraints: user configuration files must not be modified (profile scope is user-level resources only, per ADR-0011); undeclared profile fields must produce no side effects.

## Goals / Non-Goals

**Goals:**

- One MCP backend: Pi's built-in MCP extension. All adapter-specific code paths are deleted.
- Adapter-era user-level config locations keep working: their servers are merged and materialized into the instance `mcp.json` Pi actually reads.
- Profiles keep their existing surface: `mcps` narrows servers, `mcp_tools` narrows tools, `tools` never touches MCP tools. No new profile fields.

**Non-Goals:**

- No support for the legacy SSE transport (migration guidance only).
- No project-scope merge into the instance config; trusted project servers remain Pi's own concern (ADR-0011).
- No tool-name validation or missing-name diagnostics for `mcp_tools` selectors (failure tiering unchanged).
- No exposure-choice surface: selected tools are always `direct`.

## Decisions

### D1: Target only Pi's built-in MCP extension; delete adapter support

ADR required: drop-pi-mcp-adapter

All adapter coupling is removed: `isAdapterExtension`, `MissingMcpAdapterError`, `discoverAdapterServerNames` (`src/mcp-config.ts`), the `hasAdapter` gates (`src/profile-resolver.ts`), `AdapterAttribution`/`resolveAdapterPackageRoot`/`getAdapterAttribution` (`src/switching/apply-plan.ts`), the adapter reference alias (`src/extension-discovery.ts`), and the `pi-mcp-adapter` devDependency.

- Rejected alternative: dual backend with a translation layer. Two semantic worlds (adapter matching vs native encodings) double the maintenance surface and keep obsolete behavior under contract. This repeats the rejection logic of ADR-0002, which ADR-0002's replacement will record.

### D2: Merged snapshot materialized into the instance `mcp.json`

Instance generation always writes `mcp.json` as a generated snapshot; the unrestricted symlink shortcut is removed. The snapshot merges four user-level sources by server name, later sources overriding earlier ones per name:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. real agentDir `mcp.json`

`mcps` selection and `mcp_tools` encodings are then applied on top (see D3). The snapshot is regenerated at launch and on every switch/reload, so in-session `pi mcp add` edits to the instance file are overwritten — accepted snapshot semantics, documented in README.

- Rejected alternative: keep the symlink when unrestricted. The real agentDir file alone misses servers in `~/.agents`/`~/.config/mcp`, which is precisely the extended-read requirement that motivates this change.

### D3: Native config encodings

- Unselected user-level servers are written with `enabled: false`, never omitted and never `disabled: true` (`disabled` is silently ignored by native Pi; omission would still work in the instance file but the explicit mark keeps status reporting and the "discovered but not enabled" contract).
- `mcp_tools` for a server becomes `toolExposure` `{"*": "hidden", <selector>: "direct", ...}` replacing the server's merged `toolExposure` wholesale. Empty list becomes `{"*": "hidden"}`. Servers unnamed in `mcp_tools` keep their merged exposure.
- Selected tools use exposure `direct`: the only exposure that guarantees the tool is reachable by the model regardless of mode and of whether codemode/tool_search are active.
  - Rejected alternative: `codemode` (Pi's default). Reachability would then depend on codemode/tool_search activation state, silently breaking `mcp_tools`' existing promise that permitted tools are callable.
- `computeSafeMcpToolIntersection` is deleted: with `includeTools` gone there is no unsafe intersection to detect.

### D4: SSE two-tier failure (see specs)

A server explicitly selected by `mcps` whose definition carries `type: "sse"` fails activation with the server name and a migration hint. An unselected SSE server passes through into the snapshot and Pi reports its own config error. Detection is deliberately narrow — only the `type` field's value — so pi-profile does not re-implement Pi's transport policy.

- Rejected alternative: validating all transports against Pi's support. Pi's transport policy is Pi's to own; mirroring it in pi-profile drifts on every Pi upgrade.
- Rejected alternative: passing everything through. An explicitly selected but unusable server must fail activation (errors must be actionable), while an unselected one must not block startup (undeclared fields produce no side effects).

### D5: MCP tool ownership by `sourceInfo.path === "builtin:mcp"`

`isMcpOwnedTool` checks the tool's `sourceInfo.path` against `"builtin:mcp"` instead of adapter attribution (package-root walking and loose-file entry matching). Verified in installed pi 0.99.1: built-in extension tools inherit the extension's sourceInfo (`dist/core/resource-loader.js`), and built-in paths use the `builtin:` prefix (`dist/core/source-info.js`, `BUILTIN_PATH_PREFIX`).

- Rejected alternative: namespace sniffing on `mcp__<server>__<tool>` names. The name format is an implementation detail of the built-in extension; the `builtin:mcp` path is Pi's documented identity for built-in extensions.

### D6: Project scope is classification-only

The merge never includes project sources. A trusted project's `.pi/mcp.json` is still read for classification: servers defined only there are marked project-owned, so naming one in `mcps`/`mcp_tools` fails with the project-scope-boundary error instead of a bare unknown-name error. The adapter-era project-root `.mcp.json` source is dropped entirely.

- Rejected alternative: dropping project reads completely and reporting "unknown server". That loses the actionable "a profile cannot narrow a project-level server" diagnosis.

### D7: Module surface

- `src/mcp-config.ts`
  - `getStandardMcpConfigSources(agentDir, projectDir?, options?)`: returns the four user-level sources plus, when trusted, the project `.pi/mcp.json` classification source. Project-root `.mcp.json` removed.
  - `loadMergedMcpServers(agentDir, projectDir?, options?)`: signature unchanged; `MergedMcpResult.baseConfig` is now the merged user-level config object (not just the agentDir file). `sharedServers`/`projectServers`/`serverOwners` semantics unchanged.
  - Deleted: `discoverAdapterServerNames`, `MissingMcpAdapterError`, `isAdapterExtension`.
- `src/profile-resolver.ts`
  - `buildInstanceMcpConfig(profileName, mcpDiscovery, mcps?, mcpTools?)`: signature unchanged; emits `enabled: false` and `toolExposure` per D3. New selected-SSE `ActivationError` per D4.
  - Deleted: `computeSafeMcpToolIntersection`, both `hasAdapter` gates. `usableCandidates` filtering checks `enabled !== false` instead of `disabled !== true`.
- `src/settings-generator.ts`
  - `writeRuntimeFiles` MCP branch collapses to one path: `loadMergedMcpServers` + `buildInstanceMcpConfig` → write. Symlink shortcut deleted.
- `src/switching/apply-plan.ts`
  - Deleted: `AdapterAttribution`, `resolveAdapterPackageRoot`, `getAdapterAttribution`. `isMcpOwnedTool(tool)` now checks `tool.sourceInfo?.path === "builtin:mcp"`.
- `package.json`: remove `pi-mcp-adapter` devDependency.

## Risks / Trade-offs

- [Pi changes exposure values or transport policy] → pi-profile only emits `direct`/`hidden`/`enabled:false` and only special-cases `type: "sse"`; everything else passes through. Verification against installed Pi is part of the task list.
- [Adapter-era profiles use prefixed selectors like `fixture_search`] → they now match nothing and stay restrictive (no crash); migration notes go into README.
- [Wholesale `toolExposure` replacement can expose a tool the merged config hid] → intentional: an explicit selector match is the permission; the spec scenario records it. Rejected conservative merge would keep adapter-era `includeTools` intersection complexity.
- [Snapshot overwrites in-session `pi mcp add` edits] → documented; instance dirs are per-launch and swept, so no user data is lost beyond the instance file itself.
- [Snapshot replicates credentials into instance dirs] → instance dirs already carry profile-generated config and are swept per launch; no new exposure surface.

## Migration Plan

- Users with SSE servers: switch to the server's streamable HTTP URL, or remove the server from profiles' `mcps`.
- Users with prefixed `mcp_tools` selectors: replace with registered tool names.
- `disabled: true` entries in user config: replace with `enabled: false` (they were ignored by native Pi anyway).
- Rollback: revert the change; instance directories are per-launch, so there is no persistent generated state to migrate.
