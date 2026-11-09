# Proposal

## Why

Only one capability domain's baseline exists in `openspec/specs/` so far. `resource-reference` is the prerequisite of the remaining domains: how references in a profile resolve, whether a resolution failure blocks or warns, and which tools are unknowable before spawn — these decisions constrain both the launch and switching paths at once. Without this specification, any change to reference resolution can only be assessed by reading code.

## What Changes

- Add the baseline specification for the `resource-reference` capability domain, covering discovery and resolution of the four reference classes — skill, extension, MCP server, tool — plus resolution and validation of profile-level settings fields.
- No code changes. The specification is taken item by item from `src/skill-registry.ts`, `src/extension-discovery.ts`, `src/mcp-config.ts`, `src/profile-resolver.ts`, and `src/switching/tool-references.ts`.
- No design document. The mechanisms are carried by the filtering model in `docs/architecture/overview.md` and ADR-0007, ADR-0008; failure tiering is carried by ADR-0009. The specification only states behavior.

## Capabilities

### New Capabilities

- `resource-reference`: the referenceable forms and discovery sources of the four reference classes, success and failure semantics of reference resolution, failure tiering, and validation of profile-level settings fields.

### Modified Capabilities

(none)

## Impact

- Adds `openspec/specs/resource-reference/spec.md`, landed at archive time.
- Zero code changes; `src/`, `extensions/`, `bin/`, and `test/` are untouched.
- Follow-up changes establish baselines for the `launcher` and `in-session-switch` capability domains in turn.

## Doc Impact

- `docs/architecture/overview.md`: **one known limitation needs adding**. `src/skill-registry.ts` excludes project-scope package skills (their packages live under the project `.pi/npm`, which generated global settings cannot reference). This limitation was previously recorded in `docs/specs/initial-implementation/issues/03-project-catalogs-scope-state.md`, a file deleted along with the matt system; only a code comment remains. Write it into "Known limitations" before archiving.
- `docs/prd.md`: none. The four resource classes are already covered by "Product goals"; this change does not alter positioning, goals, or non-goals.
- `CONTEXT.md`: none. The four terms `Resource`, `SkillRegistry`, `ExtensionDiscovery`, and `McpServerRegistry` are already defined; the specification uses them without adding terms.
- `docs/adr/`: none. Failure tiering is carried by ADR-0009; ownership of discovery and entry enumeration by ADR-0007 and ADR-0008 respectively; the specification references rather than copies their reasoning.
