# Design

## Context

See [proposal.md](proposal.md#why). The launcher currently requests MCP discovery only when `mcps` has entries; the resolver likewise turns `mcps: []` into an absent selection. Once the resolver retains an empty selection, the existing `buildInstanceMcpConfig` already omits agentDir-only servers and emits `disabled: true` for unselected shared user-level servers. Instance file generation already treats a defined `mcps` array as restrictive.

The selected adapter must be identified without executing extension code. `loadMergedMcpServers` covers the existing standard sources and tags trusted project-owned names; adapter-only imports and package/plugin discovery are outside this change. The current status formatter cannot distinguish a project-owned server from an unselected user-level one when `mcps` is defined.

## Goals / Non-Goals

**Goals:** Make the existing selection path accept an empty resolved MCP list, and preserve the no-adapter behavior of `mcps: []`.

**Non-Goals:** Discover additional adapter sources, filter project-owned servers, introduce a server-control extension, or change `mcp_tools` semantics.

## Decisions

### 1. Select the adapter before deciding whether an empty declaration needs discovery

For a named profile with `mcps: []`, use the already discovered extension entries to determine whether the profile selects `pi-mcp-adapter`. If it does, request the normal MCP discovery result even if that result has zero servers. Resolve an empty selection and prepare its instance MCP configuration. If it does not, skip the extra MCP discovery and leave the declaration inert, preserving profiles that already contain `mcps: []` without an adapter. Nonempty declarations keep their current dependency and validation path. The same resolver is called at launch and during switching.

This avoids interpreting a missing adapter as a reason to read configuration or fail a profile that previously launched. Always discovering MCP configuration for any present `mcps` field was rejected: a malformed config would newly block a profile that does not load the adapter. Treating every empty list as absence was rejected because it is the reported bug.

### 2. Reuse the instance configuration filter, not a tool-level workaround

Keep the prepared `mcps: []` distinct from undefined through the activation plan and into `writeRuntimeFiles`. The existing `buildInstanceMcpConfig` can omit agentDir-only servers and disable discovered shared user-level servers without changing user files. It already leaves project-owned entries alone. Do not use `setActiveTools` or `mcp_tools` to simulate server removal: MCP calls can be made through gateways and indirect routes, and a tool filter is not a server filter.

### 3. Derive status from the same discovery ownership

Pass the project-owned server names from the trust-gated MCP discovery result to `buildStatusReport`. With a defined `mcps` selection, include enabled, non-disabled project-owned servers alongside selected user-level servers and exclude them from the disabled group. Preserve the existing handling of adapter-disabled servers when `mcps` is omitted. Relying on the plan's `mcps` array alone was rejected: an empty selection would incorrectly report a trusted project's still-enabled servers as disabled.

## Export surface

- `src/launcher/initial-profile.ts`: `resolveInitialProfile(...)` keeps its existing signature and error types; an empty selection changes only its internal discovery gate.
- `src/profile-resolver.ts`: `resolveProfile(input: ResolveInput): Promise<ActivationPlan>` and `buildInstanceMcpConfig(profileName: string, mcpDiscovery: MergedMcpResult, mcps?: string[], mcpTools?: Record<string, string[]>): Record<string, unknown>` keep their signatures. `ActivationPlan.mcps` remains `string[] | undefined`; `[]` is now a meaningful value when the adapter is selected. Existing `ActivationError` handles unavailable required discovery.
- `src/switching/status.ts`: `buildStatusReport(input: { plan: LaunchPlanFile; overlay?: RuntimeOverlay; discoveredMcpServers: string[]; disabledMcpServers: string[]; projectMcpServers?: string[]; commands: RegisteredCommand[]; tools: RegisteredTool[] }): StatusReport` adds the optional project ownership input; `RegisteredCommand` and `RegisteredTool` retain their existing internal shapes. The return type and status fields do not change. `extensions/pi-profile/index.ts` supplies these names from `loadMergedMcpServers(...).projectServers`. The optional input preserves existing callers.
- No serialized file shape, catalog schema, new error type, or external dependency changes.

## Risks / Trade-offs

- [Adapter server sources outside the current discovery result remain available] -> Keep this change limited to the established discovery scope; tests assert only discovered standard sources. Do not claim an adapter-wide deny-all.
- [A project server shadows a user-level server name] -> Use the existing project-ownership result when generating the instance file and building status; test the shadowed name as project-owned.
- [An empty array already appears in profiles as a no-op] -> Document the behavior change when the adapter is active; leaving `mcps` undeclared preserves pass-through behavior.

## Migration Plan

No file migration is required. Existing profiles using `mcps: []` with an active adapter acquire the empty selection on the next launch or reload; omitting the field restores pass-through behavior. Profiles without an active adapter keep their previous behavior. Rolling back the package restores the previous empty-list behavior without rewriting user configuration.
