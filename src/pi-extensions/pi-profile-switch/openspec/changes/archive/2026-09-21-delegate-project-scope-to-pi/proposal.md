# Proposal

## Why

Project-level resources (`.pi/skills`, `.pi/extensions`, ancestor `.agents/skills`, `.pi/prompts`, `.pi/themes`, `.pi/settings.json`) are currently suppressed wholesale by pi-profile using Pi's trust gate: generated settings set `defaultProjectTrust: "never"`, and a named profile's instance does not link `trust.json`. This creates two problems:

1. The isolation surface is wider than the positioning. A profile only declares skills, extensions, tools, and mcps, but the gate covers "all project-level resources" — project-level prompts/themes/settings get blocked along.
2. In-session switching cannot undo it. Pi's trust determination runs once per process, per cwd; `session.reload()` keeps `SettingsManager.projectTrusted` and does not re-run the determination. So after switching from a named profile back to `default`, skills in `.pi/skills` (the openspec skills, for example) remain invisible until the process restarts.

Project-level resources belong to the project, not to the profile. A profile's narrowing surface should be limited to user-level resources; project-level resource visibility should be decided by Pi's own trust determination. This boundary eliminates both problems at once: the gate is no longer pi-profile's to open or close, and switching no longer has "a flag to change".

## What Changes

- The instance's `trust.json` unconditionally exists as a symlink to the real agentDir (also established when the target does not exist yet, same class as `auth.json`). Named profiles no longer delete that link.
- The launcher forwards the recorded one-shot trust input (`--approve` / `--no-approve`) to the Pi process of any profile; previously only `default` forwarded it, and under named profiles a divergence of "launcher judges untrusted, Pi still admits per stored decision" could occur.
- Generated settings no longer express project-level narrowing: no more `-<path>` exclusions for project-level skills, and selected project-level skills/extensions are no longer written as attached paths. Project-level resources are discovered natively by Pi.
- Generated settings no longer merge project `.pi/settings.json`, and the "strip project `packages`" logic goes with it. That merge-and-strip was a substitute from the gate-closed era; with the gate open it would instead get project packages installed into the global npm root (a launch side effect) and must go. Project packages now follow Pi's native path, installed under the project `.pi/npm`.
- **BREAKING** (product promise): profiles cannot hide project-level resources. A trusted project's `.pi/skills`, `.pi/extensions`, and ancestor `.agents/skills` are visible under every profile, and unselected project resources are no longer excluded.
- A trusted project's resources stay in the resolution vocabulary: a profile referencing project-level skills/extensions still resolves successfully, with no "unmatched" failure or zero-match warning; such selections are simply no longer written into generated settings.
- The narrowing surface of `mcps` shrinks to user sources: servers defined by project `.mcp.json` / `.pi/mcp.json` are no longer marked disabled.
- Unchanged: the strict tools whitelist (no tool discovery exists at project level), and the existing behavior that named profiles do not initiate a trust prompt (a named profile's instance still has `defaultProjectTrust: "never"` when no stored decision exists).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `launcher`: "Project trust gating" now gates only pi-profile's own project files and project MCP configuration reads, and states that project-level resource visibility belongs to Pi; "Instance directory contract" requires `trust.json` to be a link under every profile; "Subprocess launch" trust-flag forwarding covers all profiles; "Instance runtime-state seed" gains `trust.json` among its file-class seeds.
- `resource-reference`: "Skill reference resolution" and "Extension reference resolution" gain project-level participation semantics — a trusted project's project-level resources are resolvable but not narrowable; `mcps` narrowing does not apply to project-sourced servers.
- `in-session-switch`: "In-session switching" gains one verifiable contract — post-switch project-level visibility matches launching directly with that profile, without a process restart.

## Impact

- Code: `src/settings-generator.ts` (trust link, project-level handling of skills/extensions, project settings merge and packages stripping, MCP disable marks), `bin/pi-profile.ts` (trust-flag forwarding), `src/launcher/initial-profile.ts` and `src/switching/switch-profile.ts` (no longer passing project settings), `src/mcp-config.ts` (distinguishing project-sourced servers).
- Tests: `test/project-scope.integration.test.ts` (visibility assertions for trusted projects inverted), `test/settings-generator.test.ts`, `test/settings-generator-selection.test.ts`, `test/launcher-spawn.test.ts`, `test/mcp-config.test.ts`, `test/mcp.integration.test.ts`, `test/switch-profile.test.ts`, `test/initial-profile.test.ts`, `test/cross-cutting.integration.test.ts`, `test/observability.integration.test.ts`.
- No new dependencies, no new user-visible configuration fields (so no "why discovery cannot replace it" justification is required).
- User-visible impact: in a trusted project, every profile sees project-level resources; behavior keys (including model-related ones) of project `.pi/settings.json` override profile declarations at runtime — this is Pi's merge order, which this change accepts and records.

## Doc Impact

- `docs/prd.md`: add one boundary to the non-goals section — a profile's isolation surface is user-level resources; project-level resources are decided by Pi's trust determination. Link to the architecture document for the mechanism; do not restate it.
- `docs/architecture/overview.md`: rewrite the "Project level" row (from "whitelist + trust gating" to "decided natively by Pi, profiles do not participate"), the "packages (project)" row (no longer stripped), the `trust.json` row (linked under every profile), the generated settings row (no longer merging project settings); rewrite two "Known limitations" entries ("trust determination of project resources is only performed by the launcher", "project-scope package skills are not referenceable").
- `CONTEXT.md`: none — the term set is unchanged and the definition of `Project trust` still holds.
- `docs/adr/`: add a new numbered file recording the hard-to-reverse decision "project scope belongs to Pi; profiles narrow user-level only" and the rejected alternatives (keep isolating via the gate, add exclusions for project-level resources).
