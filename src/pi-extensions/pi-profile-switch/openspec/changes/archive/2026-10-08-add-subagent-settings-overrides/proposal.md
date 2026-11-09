# Proposal

## Why

Profiles cannot currently vary pi-subagents role models or descriptions without editing shared Pi settings or agent definitions. Optional native settings overrides let a task-specific profile change those choices while leaving unconfigured profiles and existing agent implementations alone.

## What Changes

- Add an optional `subagents` object to profile definitions. The first release supports native shared model and thinking defaults, plus per-agent model, thinking, description, and advertisement overrides. The shipped profile schema owns the supported subset; upstream override fields outside that subset are not implicitly accepted in profiles.
- Layer only declared fields onto the real user's native subagent settings in the existing instance settings file. Preserve unrelated native settings and untouched fields within the same agent entry. Rebuild from the real settings on every activation so previous-profile overrides cannot leak.
- Treat omitted and effectively empty declarations as no additional subagent control. They introduce no pi-subagents installation, import, discovery, authentication, or diagnostic requirement.
- Keep extension selection separate. A subagent declaration neither installs nor loads pi-subagents, grants delegation tools, disables unmentioned agents, nor changes project-resource filtering. No per-agent allowlist, disable policy, child tools/skills selection, or capability-ceiling integration is included.
- Keep pi-subagents responsible for agent discovery, final model selection, provider/project/per-run precedence, advertisement, execution, and existing-run lifecycle. Do not copy agent definitions or reinterpret description text as a system prompt.
- Report the active profile's declared overrides through `/profile status`, explicitly distinguished from live role mappings. Give a non-fatal, actionable runtime diagnostic when declarations exist but the native extension cannot be confirmed from Pi's registration ownership. Inactive lazy delegation tools are not evidence that an extension is unloaded.

### Configuration necessity

| Addition | Why discovery or a fixed default cannot replace it |
| --- | --- |
| Optional `subagents` object | Separates child settings from parent model defaults and expresses whether the profile declares any child behavior. |
| Shared model/thinking defaults | Desired cost and reasoning effort vary by task; installed models do not reveal the user's choice for that profile. |
| Named model/thinking overrides | Role-specific assignments differ from a shared default and can intentionally replace an agent's existing assignment. |
| Named description override | Deployment-specific role explanations cannot be inferred from a shared agent definition. |
| Named advertisement override | The user decides which role descriptions merit parent-prompt space for the current task. |

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `profile-catalog`: accept and validate the optional native override subset without changing profile replacement, trust, or unknown top-level-key behavior.
- `resource-reference`: carry declared child settings without introducing an agent registry, interpreting role names as selections, or invoking parent-model validation for child models.
- `launcher`: materialize sparse user-settings overrides, preserve native precedence and source files, and retain optional-extension startup compatibility.
- `in-session-switch`: remove stale overrides during switching/reload, include them in existing rollback protection, and expose declarations and runtime extension observations without claiming an effective live mapping.

## Impact

- Catalog/schema and resolution: `src/profile-catalog.ts`, `schemas/profiles.schema.json`, `src/profile-resolver.ts`, and a small shared subagent-settings module.
- Instance generation: `src/settings-generator.ts`; no additional managed file, environment variable, state directory, or cleanup rule.
- Runtime/status: `src/switching/apply-plan.ts`, `src/switching/status.ts`, `extensions/pi-profile/index.ts`, and a registration-observation helper. Switching continues to use the existing settings/plan snapshot boundary.
- Tests: parser/schema, sparse settings application, startup without the optional extension, registration diagnostics, switch/reload/rollback, and offline real-pi-subagents compatibility tests.
- Dependencies: no new production or peer dependency. A pinned development-only pi-subagents fixture provides reproducible compatibility evidence; its version is recorded in `package.json` and the lockfile, not duplicated in documentation.
- User guidance: `README.md`, `README.zh-CN.md`, `skills/profile-config/SKILL.md`, and `examples/example.json`. The install-time starter remains unchanged and does not require pi-subagents.

## Doc Impact

- `docs/prd.md`: recognize optional child-role behavior declarations in product positioning, with a link to the behavior contracts; retain the existing resource-selection and no-copy boundaries.
- `docs/architecture/overview.md`: document sparse native-settings materialization, registration-based observations, and the existing reload/rollback integration; link to specs for behavior.
- `CONTEXT.md`: extend the Profile definition to mention optional child-role settings; do not introduce agents as a new selectable Resource category.
- `docs/adr/`: add `docs/adr/0017-native-subagent-settings-overrides.md` during implementation to record the durable native-shaped configuration boundary and rejection of agent-file copies, a generic settings escape hatch, automatic loading, and per-agent selection. Existing ADRs remain unchanged.
