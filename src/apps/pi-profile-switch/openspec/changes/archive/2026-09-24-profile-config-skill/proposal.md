# Proposal

## Why

There are currently only two ways to create or modify a profile: hand-writing JSON, or the in-session `/profile create` form wizard. The user's more natural expression is a vague requirement ("set up a profile for code review"), which calls for a conversational configuration path: the agent clarifies the requirement, discovers referenceable resources, and writes out the correct profile file. Shipping a `profile-config` skill with the package provides that path without adding any runtime code.

Depends on the per-profile single-file catalog format (`openspec/changes/archive/2026-09-22-per-profile-config-files/`, merged into the main spec `openspec/specs/profile-catalog/spec.md`): the skill guides the agent to read and write `profiles/<name>.json` single files directly — exactly what that directory format makes possible.

## What Changes

- Add `skills/profile-config/SKILL.md` to the package: guides the agent to create, modify, and delete profiles from the user's vague or explicit requirements. Content covers: the name charset constraint, the bare-definition format and field semantics, the global (`$PI_PROFILE_SWITCH_DIR/profiles/`, default `~/.pi-profile-switch/profiles/`) vs project (`<projectDir>/.pi/profiles/`) storage locations, discovery locations of referenceable resources (`<agentDir>/skills/`, `~/.agents/skills/`, installed packages declared in `<agentDir>/settings.json`, loose files under `<agentDir>/extensions/`, `<agentDir>/mcp.json`; tool reference identity is the tool name in Pi's tool registry; project-level resource visibility does not narrow with profiles, and declaring them has no narrowing effect).
- Install distribution: `postinstall` writes the skill into the user agentDir's `skills/profile-config/`. On upgrade it SHALL always overwrite (the content is package-owned and evolves with the version); residue after uninstall is possible and accepted as uncleaned.
- The skill is an ordinary user-level resource with no runtime special-casing: the default profile and native pi can use it directly; a named profile must declare it in `skills` to include it.
- Default injection at authoring time: when the skill guides the agent to generate a new profile, if that profile declares a `skills` array, `"profile-config"` is included by default unless the user explicitly asks otherwise; no action when the profile does not declare `skills` (undeclared means not narrowed).
- The skill content must handle two boundaries: degrade to outputting JSON with a manual-save suggestion in narrow profiles without the `write` tool; prompt for `/trust` + restart before writing to project scope in sessions where the project is untrusted.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `profile-catalog`: adds the requirement "Distributing the profile-config skill at install", alongside "Seeding the starter profile at install" describing install-time distribution behavior.

## Impact

- Code: `bin/postinstall.js` (distribution logic), `skills/profile-config/SKILL.md` (new), `package.json` (`files` gains `skills`).
- Tests: postinstall distribution, overwrite, and failure-degradation cases.
- Docs: README mentions the skill.

## Doc Impact

- `docs/prd.md`: none — the skill supplements the configuration path and does not change product positioning.
- `docs/architecture/overview.md`: none — no new mechanism; distribution reuses the existing postinstall pattern.
- `CONTEXT.md`: none — no new terms.
- `docs/adr/`: none — distribution reuses the existing postinstall pattern and the filtering model gains no rules. Rejected alternatives recorded here: exposing the skill through Pi's package discovery mechanism (the skill would no longer be an ordinary user-level resource; its visibility semantics would follow package discovery, conflicting with the "no runtime special-casing" positioning); injecting the skill when generating settings (same conflict, and the declare-means-control filtering model would be broken). Neither constitutes a hard-to-reverse decision.
