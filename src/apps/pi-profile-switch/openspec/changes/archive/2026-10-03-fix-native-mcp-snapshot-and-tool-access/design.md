# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. Pi 0.99.2 validates the transport before treating `enabled: false` as a disabled server. Its MCP extension activates `codemode` for codemode-exposed servers and `tool_search` for deferred-exposed servers on session start. An in-memory run of that actual extension, followed by the current `apply-plan.ts` selection with `tools: ["read"]`, removed each entry point. This verifies the ordering problem without assuming that an MCP tool registered with indirect exposure becomes model-callable merely by passing its name to `setActiveTools`. Real-subprocess tests remain necessary for first-turn and post-switch behavior.

The additional user-level source locations and materialized snapshot are intentional (ADR-0016); default profiles must continue to import valid definitions from them. `src/switching/switch-profile.ts` snapshots managed files before resolution but currently starts its rollback `try` only around reload, after the multi-file write.

## Goals / Non-Goals

**Goals:** Preserve native validation and native MCP invocation routes, avoid cross-source credential mixing, and make undeclared MCP configuration errors diagnostic instead of activation-fatal. Keep the write/rollback boundary safe across initial launch and in-session switches.

**Non-Goals:** No OAuth/log state migration or changed instance sweep (ADR-0010, ADR-0012); no new profile fields, exposure options, resource copies, extra backend, or change to project-owned MCP selection.

## Decisions

### D1: Complete server definitions remain authoritative

`src/mcp-config.ts` replaces a same-named server with the later entire object; it never spreads fields from earlier server entries. The top-level configuration's existing precedence is retained. `src/profile-resolver.ts` marks unselected servers with `{ ...winningDefinition, enabled: false }`, leaving transport and other keys intact. Before materialization, a selected definition whose source says `enabled: false` fails with an actionable `ActivationError`, not an implicit enablement override. A genuinely invalid, unselected server entry can still elicit Pi's native error, as specified by the existing selected/unselected failure tier.

Rejected alternative: omitting unselected entries or writing `{ enabled: false }` stubs. The former violates the explicit-disabled snapshot contract; Pi rejects the latter before testing enablement. Field-wise merging is rejected because a later URL can inherit an earlier authentication header.

### D2: Discovery error tier follows the profile's effective MCP declaration

`loadMergedMcpServers` supports strict and diagnostic modes. A nonempty `mcp_tools` object, including a list mapped to `[]`, and any declared `mcps` array, including `[]`, use strict mode; undeclared `mcps` plus undeclared or empty `mcp_tools` use diagnostic mode. In diagnostic mode malformed JSON or malformed file envelopes are omitted one source at a time, with a path-bearing diagnostic. Valid sources continue to merge. Invalid trusted-project classification is likewise diagnostic when no MCP policy is declared; Pi still reads and reports its trusted project configuration independently. Invalid individual server definitions in otherwise parseable files continue through to Pi for native validation unless explicitly selected under the existing tier. `status` on an unrestricted profile uses the same diagnostic discovery path rather than failing unexpectedly.

Rejected alternative: a single strict loader at every call site; it makes an undeclared field affect a default launch. Silently treating bad JSON as an empty config would hide the cause. A permissive loader for explicit selection would risk an incomplete allowlist.

### D3: Compute before writing; rollback covers writes and reload

Build settings, filtered MCP snapshot, effective enabled-server state, and diagnostics in memory before changing any runtime file. Do not remove the old `mcp.json` until the replacement is ready to write. In the switch orchestrator, catch errors from the entire write-and-reload interval; restore all snapped managed files even when a later write fails before reload, and reload the restored state if Pi could have observed any changed file. Keep persisted selection/overlay changes after verified reload only. A read failure at the preparation stage leaves existing files untouched.

Rejected alternative: protecting only the `mcp.json` write; earlier `settings.json` and `pi-profile.json` writes can already have changed the runtime. File staging alone does not make the multi-file transition atomic without orchestrator rollback.

### D4: MCP discovery entry points survive a declared Pi tools selection

When the prepared snapshot or trusted project contains an enabled MCP server **and the profile declares `tools`**, add Pi's built-in `codemode` and `tool_search` names to the generated instance `defaultTools` baseline, regardless of whether the user listed them in that profile. On every session start, retain their actual native registrations when applying the Pi tools allowlist; do not retain a same-named tool registered by another extension. Continue retaining MCP-owned tools by `builtin:mcp`. Overlay tool disables still subtract an explicitly disabled entry point: an overlay is an intentional runtime narrowing, unlike omission from `tools`. If an entry point is unavailable because its built-in extension was disabled or replaced, surface an actionable diagnostic instead of treating another extension's tool as an MCP gateway. Profiles with `tools` undeclared do not change `defaultTools` or `setActiveTools` merely because MCP is present; Pi's native activation remains in control. Profiles whose effective server set is empty do not add entry points solely because disabled definitions exist.

Rejected alternative: setting only `defaultTools`; the post-start `setActiveTools` currently removes the gateways again. Preserving every tool with either gateway name would let unrelated registrations escape the tools allowlist. Changing every allowed MCP tool to `direct` would override the user's native exposure decisions. The two default entry points are a user-requested convenience for narrowed profiles, not a new profile field; their authoritative identities and behavior are Pi's, not a profile-maintained inventory.

### D5: Export surface and sequencing

- `src/mcp-config.ts`: extend `McpDiscoveryOptions` (or an equivalent optional parameter) with `invalidSource: "throw" | "diagnose"` (default `"throw"`); extend `MergedMcpResult` with `diagnostics: string[]`. Keep `getStandardMcpConfigSources(...)` and `loadMergedMcpServers(agentDir, projectDir?, options?)` call signatures compatible with existing callers; `McpConfigError` remains the strict-mode error type. Do not include server connection values in diagnostics.
- `src/profile-resolver.ts`: keep `buildInstanceMcpConfig(profileName, mcpDiscovery, mcps?, mcpTools?)` and `resolveProfile(input)` signatures; add selected-disabled `ActivationError` with source-level remediation. Server-override semantics are owned by discovery, not by this module.
- `src/settings-generator.ts`: prepare settings, MCP config, and enabled-server/gateway decision before `writeRuntimeFiles(runtimeDir, plan, options)` mutates disk; return its diagnostics as `Promise<{ warnings: string[] }>` and extend `GeneratedRuntime` with `warnings: string[]` so the launcher prints them on stderr. Extend the generated `pi-profile.json` plan with a gateway-preservation marker derived from the prepared effective snapshot and declared `tools`, not a catalog field. `generateRuntimeDir(plan, options)` keeps its signature.
- `src/switching/apply-plan.ts`: extend `LaunchPlanFile` with the optional gateway marker; `applyLaunchPlan(input)` keeps its signature and native-registration checks; only the narrow `PlanApplicationSurface` may gain a native-active-tool query if preserving the Pi-provided active entry points requires it.
- `src/switching/switch-profile.ts`: keep `switchProfile(name, deps, options?)` and `SwitchError`/`SwitchResult`; include preparation diagnostics in `SwitchResult.warnings` and roll back write-stage failures as well as reload failures. `bin/pi-profile.ts` prints `GeneratedRuntime.warnings`. `extensions/pi-profile/index.ts` applies diagnostic discovery for status only when the active plan has no MCP policy.

## Risks / Trade-offs

- [The two gateway tools may not be registered when a user disables their built-in extensions] -> Never substitute a same-named third-party tool; report why indirect access is unavailable, and cover this in an integration test.
- [An overlay explicitly disables a native entry point while MCP stays enabled] -> Keep the overlay's explicit choice; test the disabled outcome and surface Pi's native or profile warning about the unavailable route.
- [A malformed source omitted from an unrestricted snapshot contains servers Pi would otherwise have discovered] -> Print its path and a repair instruction; keep all other valid sources, and never apply the diagnostic mode to a declared policy.
- [Source files change between resolution and materialization] -> Preparation must use one coherent snapshot for validation and writing; do not validate one version then reread another after runtime writes begin.
- [Adding entry points alters the model-facing tool set in profiles that declare `tools`] -> Limit this exception to effective MCP availability; do not alter default/unrestricted profiles or unrelated tool registrations.

## Migration Plan

No profile-file migration: connection parameters remain in user-owned files and existing per-server selectors are unchanged. Replace the instance snapshot on the next launch, `/profile use`, or `/profile reload`. Roll back by reverting this change; the real MCP configuration is never rewritten.
