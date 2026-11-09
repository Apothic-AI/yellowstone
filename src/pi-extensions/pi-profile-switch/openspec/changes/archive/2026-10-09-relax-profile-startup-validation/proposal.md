# Proposal

## Why

One malformed profile currently prevents every profile, including `default`, from starting because catalog loading parses every definition before selecting a name. Model preflight also rejects providers and authentication supplied by extensions that the launcher has not loaded; missing resource references and malformed MCP sources unnecessarily prevent otherwise usable sessions.

## What Changes

- Resolve the selected name and winning source before reading its definition. Unrelated files and shadowed global definitions cannot block activation; invalid winning definitions still fail without falling back to another profile.
- Keep lists usable when individual definitions are invalid. Show unavailable entries with actionable errors, preserving trust gating and source ordering.
- **BREAKING**: Replace fatal missing skill, extension, and MCP references with warnings and partial resolution. Explicit selections remain selections even when no reference resolves; failures never restore unrestricted user-level resources.
- Remove launcher-side model existence and authentication preflight. Preserve model declarations as native settings so Pi's extension-loading and model-selection lifecycle owns the result.
- Warn and ignore unknown top-level fields. Keep selected-profile JSON, object-shape, and field-type errors fatal. An unsupported parent thinking-level string produces a warning and no thinking override.
- Diagnose malformed MCP sources even under an explicit MCP policy. Merge valid sources, preserve restrictions, and do not force-enable source-disabled servers. Delegate transport usability to Pi rather than maintain a launcher-side transport gate.
- Apply the same resolution policy to launch, `/profile use`, and `/profile reload`. Preserve rollback for actual runtime write or reload failures.
- No new command, user-visible configuration field, runtime dependency, resource copy, or extension execution in the launcher.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `profile-catalog`: selected-file validation, per-entry error isolation, source precedence before parsing, unknown-field diagnostics.
- `resource-reference`: non-blocking reference diagnostics, restrictive partial resolution, deferred model validation, resilient MCP discovery.
- `launcher`: revised startup failure boundary, diagnostic delivery, model pass-through and restricted MCP materialization.
- `in-session-switch`: tolerant switching/reload and unavailable catalog entries with persisted resolution diagnostics.

## Impact

Changes concentrate in `src/profile-catalog.ts`, `src/profile-resolver.ts`, `src/extension-discovery.ts`, `src/launcher/initial-profile.ts`, `src/launcher/model-check.ts`, `src/mcp-config.ts`, `src/settings-generator.ts`, `src/switching/`, and `extensions/pi-profile/index.ts`. Catalog and plan interfaces need additive diagnostics and asynchronous targeted reading; tests expecting fatal reference failures must change.

Initial planning inspected local `main` at `851564a` in the `fix/profile-verify` worktree. Integration uses `origin/main` as its baseline. The upstream [sparse selection](../../../specs/resource-reference/spec.md#requirement-sparse-skill-and-extension-selection) and [subagent boundary](../../../specs/resource-reference/spec.md#requirement-subagent-override-resolution-boundaries) contracts remain in effect except for the explicitly modified clauses in this change. Unmerged work in the original worktree is not a dependency.

## Doc Impact

- `docs/prd.md`: none: product goals and non-goals remain unchanged; native compatibility and resource narrowing remain the governing principles.
- `docs/architecture/overview.md`: update catalog interfaces, diagnostics transport, launch ordering, and removal of standalone model preflight; link behavior contracts instead of duplicating them.
- `CONTEXT.md`: none: existing domain terminology remains sufficient.
- `docs/adr/`: add the next available numbered ADR for tolerant activation with restrictive partial resolution and deferred model judgment; mark ADR-0009 and ADR-0016 superseded with the required single top line in each file. For ADR-0016, the new ADR replaces only launcher-side transport rejection; its other MCP decisions remain in effect by reference. Keep both historical ADR bodies intact. The next number is chosen from the authoritative directory at implementation time.
- `README.md`: link the revised validation and diagnostic contracts from profile usage guidance.
- `skills/profile-config/SKILL.md`: update editing guidance to distinguish fatal shapes from non-fatal references and native model validation.
