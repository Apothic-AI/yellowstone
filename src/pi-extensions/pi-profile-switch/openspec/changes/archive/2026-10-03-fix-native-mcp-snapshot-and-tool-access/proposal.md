# Proposal

## Why

A profile that excludes MCP servers currently writes `enabled: false` placeholders without a transport. Pi validates the entry before checking enablement, so even `mcps: []` produces startup warnings for otherwise valid servers. The same snapshot path can mix fields from different definitions of a same-named server, and a Pi `tools` allowlist can remove the native tools needed to reach otherwise allowed MCP tools. A malformed MCP source can also abort a profile that declares no MCP policy and leave an in-session rewrite incomplete.

## What Changes

- Preserve complete server definitions when marking unselected user-level servers `enabled: false`; never emit transport-less placeholders. Fail with an actionable message if `mcps` selects a server disabled by its source configuration rather than silently reporting it as enabled. Keep Pi's reporting for genuinely invalid definitions that are passed through.
- Treat each later user-level source as a complete replacement of the same-named server definition, not a merge of fields. Continue discovering all existing user-level MCP locations and materializing their merged snapshot for every profile, including `default`; this compatibility behavior is intentional and already recorded in ADR-0016.
- When a profile narrows `tools` and MCP is enabled, keep `codemode` and `tool_search` available in the instance settings even when that list omits them; ensure session-start tool application does not undo that availability. Profiles that do not narrow `tools` continue to use Pi's own activation. Preserve the independence of MCP access from `tools` without re-enabling unrelated non-MCP tools. Verify both native indirect exposure modes against a real Pi subprocess.
- For a profile with no effective MCP declaration (`mcps` absent and `mcp_tools` absent or empty), diagnose malformed user-level MCP sources by path and continue using readable sources rather than aborting startup. Explicit MCP selections or per-server restrictions still fail when discovery cannot be trusted. Precompute generated MCP content before rewriting runtime files, and roll back every write-stage failure during an in-session switch.
- Leave MCP OAuth/log state handling and the existing startup adoption mechanism unchanged; that investigation is deferred.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resource-reference`: Later source replacement semantics, error handling for malformed sources when MCP is undeclared, and MCP access independent of Pi's non-MCP tool selection.
- `launcher`: Valid disabled server entries, availability of MCP access tools alongside a declared `tools` list, and non-fatal undeclared-MCP discovery errors.
- `in-session-switch`: MCP access tools after session-start filtering and exact restoration on write-stage or reload failure.

## Doc Impact

- `docs/prd.md`: none: the goals, non-goals, and additional user-level MCP discovery policy do not change.
- `docs/architecture/overview.md`: update the MCP snapshot, discovery, tool-activation, and write/rollback mechanisms.
- `CONTEXT.md`: none: no terminology changes.
- `docs/adr/`: none: ADR-0016 already records extended user-level discovery and the generated snapshot; this change corrects implementation and error behavior without replacing that decision. ADR-0010/ADR-0012 remain unchanged because MCP runtime-state handling is deferred.
- `README.md`: clarify that profiles preserve access to MCP discovery tools when they restrict Pi tools, and document the non-fatal malformed-source diagnostic when no MCP policy is declared.

## Impact

`src/mcp-config.ts`, `src/profile-resolver.ts`, `src/settings-generator.ts`, `src/switching/apply-plan.ts`, and `src/switching/switch-profile.ts`; focused unit and real-Pi integration tests for config precedence, disabled-entry validity and explicit selection, indirect MCP reachability, startup error handling, and switch rollback. No new profile fields or runtime dependencies.
