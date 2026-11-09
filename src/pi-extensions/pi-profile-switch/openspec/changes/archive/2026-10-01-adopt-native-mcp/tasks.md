# Tasks

## 1. MCP config sources and merge (src/mcp-config.ts)

- [x] 1.1 Rewrite `getStandardMcpConfigSources(agentDir, projectDir?, options?)` to return only the four user-level sources (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, real agentDir `mcp.json`) plus, when trusted, the project `.pi/mcp.json` classification source. Drop the project-root `.mcp.json` source.
  Verification: covers resource-reference "MCP server reference resolution" scenarios "Untrusted project's MCP configuration does not participate" and "Illegal MCP configuration content"; `npm test -- test/mcp-config.test.ts`.
- [x] 1.2 Make `loadMergedMcpServers(agentDir, projectDir?, options?)` expose the merged user-level config object as `MergedMcpResult.baseConfig` (server names merged in source order, later sources overriding earlier ones). Keep `sharedServers`/`projectServers`/`serverOwners` semantics.
  Verification: covers resource-reference "MCP server reference resolution" scenarios "Later user-level source overrides an earlier one per server name" and "Untrusted project's MCP configuration does not participate"; `npm test -- test/mcp-config.test.ts`.
- [x] 1.3 Delete `discoverAdapterServerNames`, `MissingMcpAdapterError`, and `isAdapterExtension` from `src/mcp-config.ts`.
  Verification: `rg "adapter" src/mcp-config.ts` returns no functional references; `npm test -- test/mcp-config.test.ts test/profile-resolver.test.ts`.
  Failure path: if a consumer still imports a deleted symbol, compilation fails — update that consumer in the same commit.

## 2. Profile resolution and native encodings (src/profile-resolver.ts)

- [x] 2.1 Remove both `hasAdapter` gates: nonempty `mcps` resolves against merged discovery with candidates on unknown names; `mcp_tools` no longer requires the adapter. Filter `usableCandidates` with `enabled !== false` instead of `disabled !== true`.
  Verification: covers resource-reference "MCP server reference resolution" scenarios "Unknown server name" and "Project-owned server cannot be selected"; `npm test -- test/profile-resolver.test.ts`.
- [x] 2.2 Rewrite `buildInstanceMcpConfig(profileName, mcpDiscovery, mcps?, mcpTools?)`: unselected user-level servers are written with `enabled: false` (never `disabled: true`, never omitted); `mcp_tools` for a server replaces its merged `toolExposure` wholesale with `{"*":"hidden", <selector>:"direct", ...}`; an empty list becomes `{"*":"hidden"}`; servers unnamed in `mcp_tools` keep their merged exposure. Delete `computeSafeMcpToolIntersection`.
  Verification: covers launcher "Instance MCP configuration snapshot" scenarios "Restricted MCP configuration disables unselected shared servers", "Empty MCP selection disables discovered user servers", "Tool restriction without a server whitelist", "Empty MCP tool list remains restrictive"; exposure values `direct`/`hidden` fact → authoritative source: installed pi 0.99.1 `dist/core/mcp-servers.js`; `npm test -- test/profile-resolver.test.ts`.
- [x] 2.3 Fail activation with an actionable error when an explicitly selected server's definition carries `type: "sse"`: name the server and point to the streamable HTTP migration. Do not validate any other transport field.
  Verification: covers resource-reference "Selected server uses a transport Pi cannot use" and launcher "Pre-launch failure and exit codes" scenario "Selected MCP server uses a transport Pi cannot use"; SSE rejection fact → authoritative source: installed pi 0.99.1 `dist/extensions/mcp/config.js`; `npm test -- test/profile-resolver.test.ts`.
- [x] 2.4 Update `test/profile-resolver.test.ts`: replace adapter-gate and `includeTools` assertions with native-encoding assertions; adjust fixtures (see `test/fixtures/`).
  Verification: `npm test -- test/profile-resolver.test.ts`; every replaced assertion maps to a scenario in this change's delta specs.

## 3. Instance generation (src/settings-generator.ts)

- [x] 3.1 Collapse the MCP branch of `writeRuntimeFiles` to one path: `loadMergedMcpServers` + `buildInstanceMcpConfig`, then always write the instance `mcp.json` from the snapshot. Delete the symlink shortcut and the adapter-fallback branches.
  Verification: covers launcher "Instance MCP configuration snapshot" scenarios "Unrestricted MCP configuration is materialized as the snapshot" (no symlink) and "Project-sourced MCP servers are not disabled"; `npm test -- test/settings-generator.test.ts test/settings-generator-selection.test.ts`.
- [x] 3.2 Update `test/settings-generator.test.ts` and `test/settings-generator-selection.test.ts`: remove symlink expectations, assert snapshot materialization and `enabled: false` output.
  Verification: `npm test -- test/settings-generator.test.ts test/settings-generator-selection.test.ts`.

## 4. MCP tool ownership (src/switching/apply-plan.ts)

- [x] 4.1 Delete `AdapterAttribution`, `resolveAdapterPackageRoot`, and `getAdapterAttribution`. Rewrite `isMcpOwnedTool(tool)` to return `tool.sourceInfo?.path === "builtin:mcp"`.
  Verification: covers in-session-switch "Session-start plan application and change summary" scenario "Built-in MCP extension does not own sibling extension tools"; built-in extension tools carry `sourceInfo.path === "builtin:mcp"` fact → authoritative sources: installed pi 0.99.1 `dist/core/resource-loader.js`, `dist/core/source-info.js`; `npm test -- test/apply-plan.test.ts`.
- [x] 4.2 Update `test/apply-plan.test.ts`, `test/switch-profile.test.ts`, and `test/status.test.ts`: replace adapter-attribution fixtures with `builtin:mcp` sourceInfo fixtures; keep non-MCP and sibling-extension ownership cases.
  Verification: `npm test -- test/apply-plan.test.ts test/switch-profile.test.ts test/status.test.ts`.

## 5. Discovery cleanup (src/extension-discovery.ts, package.json)

- [x] 5.1 Remove the `npm:pi-mcp-adapter` reference-alias comment and any adapter handling from `src/extension-discovery.ts`; remove the `pi-mcp-adapter` devDependency from `package.json`.
  Verification: `rg -i "adapter" src/extension-discovery.ts package.json` returns no hits; `npm run check` passes after install.
  Failure path: `npm install` updates `package-lock.json` — include it in the same commit.
- [x] 5.2 Update `test/extension-discovery.test.ts` and `test/extension.test.ts`: drop adapter extension fixtures and any adapter-alias assertions.
  Verification: `npm test -- test/extension-discovery.test.ts test/extension.test.ts`.

## 6. Status observability (src/switching/status.ts)

- [x] 6.1 Adjust `disabledMcpServers` handling in `src/switching/status.ts` to the snapshot model: servers marked `enabled: false` by the merged user-level configuration appear as discovered but not enabled; remove adapter-discovery wording from comments.
  Verification: covers in-session-switch "MCP tool policy status and switch rollback" scenario "Status respects merged-config-disabled servers without an MCP whitelist" and "Observability surface" scenarios "Empty MCP selection is visible in status" and "Project-owned server remains enabled in status"; `npm test -- test/status.test.ts test/observability.integration.test.ts`.

## 7. Integration tests (native semantics)

- [x] 7.1 Rewrite `test/mcp.integration.test.ts` around snapshot semantics: merged user-level sources materialized into the instance, `enabled: false` for unselected servers, selected-SSE activation failure, unselected-SSE pass-through, project servers absent from the instance file.
  Verification: `npm test -- test/mcp.integration.test.ts`; spawn launcher only via `runLauncher` from `test/helpers/launcher-runner.ts`.
- [x] 7.2 Rewrite `test/mcp-tools.integration.test.ts` around `toolExposure` encoding: selector allowlist replaces exposure wholesale, empty list denies all, prefixed selector matches nothing and stays restrictive, no adapter activation requirement.
  Verification: covers resource-reference "Unified failure tiering for references" (literal MCP selectors are not diagnosed) and "Per-server MCP tool selection" scenario "Unmatched literal selector stays restrictive without a diagnosis"; `npm test -- test/mcp-tools.integration.test.ts`; spawn launcher only via `runLauncher` from `test/helpers/launcher-runner.ts`.
- [x] 7.3 Update `test/switch.integration.test.ts` and `test/observability.integration.test.ts`: switch/reload re-materializes the snapshot; in-session `pi mcp add` edits to the instance config are overwritten on switch.
  Verification: covers in-session-switch "In-session switching" scenarios; `npm test -- test/switch.integration.test.ts test/observability.integration.test.ts`; spawn launcher only via `runLauncher` from `test/helpers/launcher-runner.ts`.

## 8. Error message wording (src/profile-catalog.ts)

- [x] 8.1 Update the `mcp_tools` glob rejection in `src/profile-catalog.ts` (line 128) from `"literal adapter tool selectors are required"` to `"literal MCP tool names are required"`; update the comment on line 47.
  Verification: covers profile-catalog "Profile definition fields" scenario "Glob is not a literal MCP tool selector"; `npm test -- test/profile-catalog.test.ts`.
- [x] 8.2 Update the assertion in `test/profile-catalog.test.ts` that matches `/n tool selectors are required/i` so it matches the new wording.
  Verification: `npm test -- test/profile-catalog.test.ts`.

## 9. Documentation

- [x] 9.1 Keep `docs/adr/0016-drop-pi-mcp-adapter.md` as the new decision and the single top line `**Superseded by ADR-0016.**` in `docs/adr/0002-mcp-integration-locked-to-pi-mcp-adapter.md`; replace links to the active change in ADR-0016 with stable main-spec references after sync (or refer to the change by name without a path).
  Verification: ADR-0016 follows the house format and identifies the `adopt-native-mcp` change; `rg -q '^\*\*Superseded by ADR-0016\.\*\*$' docs/adr/0002-mcp-integration-locked-to-pi-mcp-adapter.md` succeeds; `! rg -q 'openspec/changes/adopt-native-mcp/' docs/adr/0016-drop-pi-mcp-adapter.md` fails if a link will break on archive. Fact → authoritative source: `openspec/specs/resource-reference/spec.md` and `openspec/specs/launcher/spec.md` after sync.
- [x] 9.2 Update `docs/architecture/overview.md`: describe the MCP snapshot and `builtin:mcp` ownership in the mechanism rows and the `mcp-config.ts`/`apply-plan.ts` module descriptions; keep behavior details in the main specs and point the MCP mechanism row to the main resource-reference spec, not the active change. Refer to "Instance directory layout" for managed files/trust.json and "Instance MCP configuration snapshot" for `mcp.json`.
  Verification: `! rg -q 'openspec/changes/adopt-native-mcp/' docs/architecture/overview.md` fails if an active-change link remains; `rg -q 'openspec/specs/resource-reference/spec.md' docs/architecture/overview.md` succeeds; `! rg -qi 'adapter' docs/architecture/overview.md` fails on obsolete wording. Fact → authoritative sources: `openspec/specs/launcher/spec.md`, `openspec/specs/resource-reference/spec.md` (after sync), and `src/mcp-config.ts`/`src/switching/apply-plan.ts` for implementation details.
- [x] 9.3 Update `docs/prd.md`: rewrite the "No MCP connection parameters or credentials" non-goal (line 66) and the adapter-absence availability guarantee (line 76) against native Pi config and snapshot semantics.
  Verification: `rg -i "adapter" docs/prd.md` returns no functional references.
- [x] 9.4 Update `CONTEXT.md`: rewrite the `pi-mcp-adapter` term (line 15) and `McpServerRegistry` term (line 24) definitions for the snapshot model.
  Verification: terminology consistent with `openspec/config.yaml` avoid-words.
- [x] 9.5 Correct `README.md` (MCP usage): `mcps: []` keeps every discovered user-level server, including agentDir-only servers, in the generated snapshot with `enabled: false`; preserve native selector and SSE migration guidance and in-session `pi mcp add` snapshot semantics.
  Verification: `! rg -q 'agentDir-only servers are omitted' README.md` fails on the incorrect claim; `rg -q 'enabled: false' README.md` succeeds; `! rg -qi 'adapter' README.md` fails on obsolete wording. Fact → authoritative sources: `openspec/specs/launcher/spec.md` ("Instance MCP configuration snapshot") and `openspec/specs/resource-reference/spec.md` ("Per-server MCP tool selection") after sync.
- [x] 9.6 Update `skills/profile-config/SKILL.md`: rewrite the MCP discovery locations, selector forms, and adapter-activation requirement facts (lines 57, 59, 74, 109, 111, 117–118) against native Pi semantics.
  Verification: `rg -i "adapter" skills/profile-config/SKILL.md` returns no functional references.

## 10. Final validation

- [x] 10.1 Run `openspec validate adopt-native-mcp --strict` after revising the deltas and `openspec validate --specs` after syncing the main specs; fix every reported issue.
  Verification: both commands exit 0; a malformed or incomplete delta or main spec causes a nonzero exit.
- [x] 10.2 Run `npm run check` and `npm test` on the final tree after documentation and spec sync.
  Verification: both commands exit 0; no test was weakened by removing adapter coverage without a replacement scenario from the delta specs.
