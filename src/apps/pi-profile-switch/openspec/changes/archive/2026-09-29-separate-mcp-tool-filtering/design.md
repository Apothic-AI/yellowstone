# Design

## Context

See [proposal.md](proposal.md). Today `resolveProfile` expands `tools` against built-ins; `applyLaunchPlan` expands the same list against every live Pi tool; `writeRuntimeFiles` generates `mcp.json` only when `mcps` is resolved. The adapter owns MCP tool discovery, gateway routing and server-side `includeTools`/`excludeTools`. Pi exposes the winning tool registration's `sourceInfo.path` through `getAllTools()`. A tool's Pi name cannot reliably identify its MCP origin because adapter prefixes are configurable and gateways can call tools not registered as direct Pi tools.

The server configuration is layered; project-level servers are outside profile narrowing. No adapter package is a required runtime dependency. The adapter does not expose a verifiable live tool-name catalog through every supported extension entry; the profile policy can still be enforced without one.

## Goals / Non-Goals

**Goals:** Keep Pi-tool and per-server MCP-tool selection independent across launch and in-session reload. Enforce MCP restrictions before the first agent turn and through gateway, namespace and script execution. Preserve existing adapter restrictions, validate server keys before activation, and report missing Pi tool literals after session start.

**Non-Goals:** Filter project-only servers; change connection/authentication settings; add MCP transport handling; enumerate every server's tools at launcher startup; add persistent overlay fields.

## Decisions

### 1. Catalog shape and migration

Use `mcp_tools: Record<string, string[]>` in profile JSON. Keys are literal configured server names; values are literal selectors interpreted by the adapter's `includeTools` matching. A selector can match a tool's original or prefixed name; it is not an original-name-only identity. Empty object/omitted field is a no-op, omitted server key means native adapter access, and empty array denies its tools. Do not expose adapter glob patterns through this profile field in the first change: literal selectors keep the profile's declared scope reviewable without introducing wildcard breadth. Selectors are not checked against a live catalog; one that matches nothing stays restrictive without a warning. `tools` becomes non-MCP-only for all profiles, without a legacy mode. README and the distributed skill will explain the selector behavior and migration from old MCP references in `tools`.

ADR required: per-server-mcp-tool-selection

Rejected: implicit adapter-tool passthrough controlled by Pi tool-name globs (prefix drift and indirect calls), and keeping `tools` as a second simultaneous MCP allowlist (breaks the promised omitted-server default).

### 2. Server filtering belongs to the adapter's instance config

`writeRuntimeFiles` will generate a real instance `mcp.json` when either `mcps` needs server filtering or `mcp_tools` has server keys. With no restrictions, keep the existing symlink/pass-through behavior. In the generated instance file, copy the merged user-level server definition, preserving all original connection, resource, and adapter settings. For a nonempty selector list, pass its literals through the adapter's per-server `includeTools`; retain existing `excludeTools`. For an empty list, use `excludeTools: ["*"]` because the adapter treats `includeTools: []` as unrestricted. Do not mutate source files. Server filtering from `mcps`, shared-server disable entries and project-owned definitions retain their existing rules.

A pre-existing nonempty `includeTools` is an additional restriction. The adapter's matching includes prefixed and legacy aliases, with collision handling, so synthetically generated candidate names cannot prove that two different selectors denote the same tool or that replacing one list with another is a safe intersection. A replacement list is safe when every requested literal is also an identical literal in the existing include list, or the existing list contains the universal `*` selector; in either case any tool accepted by the replacement was accepted before it. Otherwise raise `ActivationError` with the server name before writing any runtime file rather than infer an intersection from generated aliases. Preserve existing `excludeTools` for the adapter to apply after inclusion, without trying to pre-remove tools from a synthetic candidate list. Do not import the optional adapter during resolution or copy its changing candidate algorithm. Resolve effective server definitions and restrictions as one in-memory snapshot; the materializer consumes this prepared snapshot so validation and writing cannot diverge. Existing `excludeTools` always wins. Project-only and project-shadowed servers cannot receive a profile tool filter; fail before materialization. When `mcps` is absent, generate a configuration that keeps every previously available user-level server, not an implicit server whitelist.

Rejected: filtering only `getAllTools()` names, which leaves `mcp`, `mcpScript` and namespace proxies able to invoke blocked tools. Rejected: rewriting the user's adapter configuration, which would persist a per-profile choice across other Pi processes.

### 3. Pi tool selection uses registration ownership

On `session_start`, classify each live Pi tool by the winner's `sourceInfo` and the selected adapter entry. For a loose adapter file, match that entry, not its parent extension directory: sibling extensions do not become adapter-owned. For a selected adapter package, identify the package-owned entries without treating unrelated paths as its children. Exclude adapter-owned registrations from `tools` expansion, and preserve their adapter-selected availability when computing `setActiveTools` for a profile declaring `tools`. A legacy `tools` literal or glob that matches only adapter-owned registrations yields a migration diagnostic; a name collision follows Pi's actual winning registration. The existing `defaultTools` setting remains only the built-in boot baseline. With neither `tools` nor an overlay, do not call `setActiveTools` solely because `mcp_tools` is present: the instance configuration enforces it before tool registration. Existing overlay tool-name matching still happens against its established base, and its disabled names are subtracted from the resulting active set.

Rejected: identifying MCP ownership by `mcp__*` or `<server>_*`: prefix overrides, no-prefix direct tools and collisions make that unsafe.

### 4. Validate server keys; do not verify MCP tool names

Before spawn/switch, resolve each own `mcp_tools` server key against the own discovered, enabled user-level server names; prototype-inherited names must not count as discovered servers. Preserve even special-looking JSON keys as policy data until validated. Require the adapter only for nonempty `mcp_tools`; report disabled, unknown or project-only keys as `ActivationError` with candidates. Do not connect to servers as part of profile resolution.

Pass literal tool selectors through to the adapter's restrictive policy without comparing them against a live catalog. A selector can match an original or adapter-prefixed tool name; one matching no tool neither grants access nor produces a missing-name notification, validation state, or candidate list. Keep Pi tool-literal and legacy MCP-reference diagnostics distinct from these unchecked `mcp_tools` selectors. Enforcement continues through the instance configuration without an optional adapter metadata-cache import.

For `/profile status`, derive the effective disabled state alongside discovered server names from the same trusted adapter configuration discovery used for resolution. Without an explicit `mcps` selection, list a server marked `disabled: true` as discovered but not enabled. Report each enabled server's declared tool policy without claiming the original tool names exist. Keep the existing tri-state for an explicit `mcps` selection and for unresolved server references.

### Export surface

| File | Export / signature | Error or result |
| --- | --- | --- |
| `src/profile-catalog.ts` | `ProfileDefinition.mcp_tools?: Record<string, string[]>`; `parseProfileDefinition(name: string, raw: unknown, filePath?: string): ProfileDefinition` | `CatalogError` with field and profile path |
| `src/mcp-config.ts` | Extend `MergedMcpResult` with `serverOwners: Record<string, "user" \| "project">`; keep `loadMergedMcpServers(agentDir: string, projectDir?: string, options?: McpDiscoveryOptions): Promise<MergedMcpResult>` | Winning origin for preflight; retain `McpConfigError` for malformed config |
| `src/profile-resolver.ts` | `ActivationPlan.mcpTools?: Record<string, string[]>` and `ActivationPlan.instanceMcpConfig?: Record<string, unknown>` (memory only); `ResolveInput.mcpDiscovery?: MergedMcpResult`; `resolveProfile(input: ResolveInput): Promise<ActivationPlan>` | `ActivationError` for unknown, disabled, project-owned servers, unsafe filter intersections or missing adapter |
| `src/settings-generator.ts` | `writeRuntimeFiles(runtimeDir: string, plan: ActivationPlan, options: RuntimeFileOptions): Promise<void>` | Consumes prevalidated `instanceMcpConfig` without serializing credentials to `pi-profile.json`; IO errors use existing rollback; never writes source adapter config |
| `src/switching/apply-plan.ts` | `LaunchPlanFile.mcpTools?: Record<string, string[]>`; `PlanApplicationSurface.getAllTools(): Array<{name: string; sourceInfo?: {path: string; source: string}}>`; `applyLaunchPlan(input): Promise<ApplyResult>` | Pi tool-literal and legacy MCP-reference diagnostics in `warnings`; no `mcp_tools` name checks |
| `src/switching/status.ts` | `StatusReport.mcpTools?: McpServerToolStatus[]` with `McpServerToolStatus = {server: string; policy: "unrestricted" \| "restricted" \| "none"; tools?: string[]}`; `buildStatusReport(input: {plan: LaunchPlanFile; overlay?: RuntimeOverlay; discoveredMcpServers: string[]; disabledMcpServers: string[]; commands: RegisteredCommand[]; tools: RegisteredTool[]}): StatusReport` | Caller supplies disabled names from the same trusted server discovery as the discovered names; policy-only status and accurate MCP tri-state, without name-validation fields |

Keep the plan file's new policy data with the existing managed snapshot; switching writes and restores it through the existing rollback path. No new state file.

## Risks / Trade-offs

- [Adapter filtering semantics change] -> Use a development-only adapter dependency for real-adapter fixture tests of original and prefixed literal selectors, nonempty allowlists, empty deny-all, gateway/script attempts and metadata refresh; fail closed on a filter intersection that cannot be proved, including alias collisions. Runtime remains adapter-optional.
- [Original server definitions mix project and user layers] -> Validate ownership after precedence is applied and test a project-only and same-name project override; do not silently narrow project content.
- [Adapter-owned Pi tools appear after `session_start`] -> The adapter's server-side filter is the enforcement layer; test direct-tool hot registration and preserve gateway availability without allowing excluded calls.
- [Literal selector matches an adapter alias] -> Treat the alias as an intentional match under adapter semantics, not as an invalid original name; test prefixed selectors through direct and indirect calls and document that authors must verify which tools a selector matches. An unmatched literal remains restrictive without an unsolicited diagnostic.
- [Legacy `tools` globs change meaning] -> Announce the breaking change with a before/after example, update the shipped example and profile-config skill, and show migration diagnostics on reload.

## Migration Plan

Ship the new field and the changed `tools` semantics together. Document that existing profiles depending on `mcp__*`, server-prefixed patterns, or proxy names in `tools` must move desired restrictions to `mcp_tools`; omission deliberately allows all tools of enabled servers. The built-in `default` remains unfiltered. Preserve catalog files as written; do not auto-rewrite profiles or adapter source files. Rollback of an in-session switch uses the existing full runtime-file snapshot and reload; package downgrade requires users who adopted `mcp_tools` to retain their prior configuration separately because older versions ignore unknown fields.
