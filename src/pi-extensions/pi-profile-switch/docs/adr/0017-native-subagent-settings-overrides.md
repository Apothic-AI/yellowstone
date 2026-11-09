# Native subagent settings overrides

## Context

Profiles can change parent model settings and selected Resources, but users also need task-specific child-role model, thinking, description, and advertisement inputs. Pi and pi-subagents already own child-agent discovery, precedence, model resolution, advertisement, and execution. Profile definitions need a bounded opt-in surface that does not create another role registry or copy agent files.

## Decision

Profile definitions accept the native-shaped subset of pi-subagents settings declared by [`schemas/profiles.schema.json`](../../schemas/profiles.schema.json). The profile layer sparsely patches only declared fields in the real user's native settings when generating the existing instance. Native Pi and pi-subagents retain authority over discovery and the final runtime result.

## Rejected alternatives

**Copy agent definitions into profile-owned directories.** Rejected because each profile would fork a role implementation and prompt, contrary to the single-owner reference model.

**Accept arbitrary extension settings.** Rejected because an unbounded settings escape hatch would make profile validation and compatibility unpredictable and expose fields beyond the approved contract.

**Install or load pi-subagents automatically.** Rejected because profile declarations must remain optional inputs and must not become package-management or extension-selection policy.

**Use role entries as an availability list or disable policy.** Rejected because native role discovery and availability belong to pi-subagents; an override map changes only the fields it explicitly names.

## Consequences

- Supported profile fields are owned by the shipped schema; native interpretations and precedence remain owned by the installed pi-subagents documentation.
- Existing native role files, user settings, extension selection, and undeclared role entries remain under their existing owners.
- `/profile status` reports declaration inputs rather than claiming that a live mapping or role field was applied.

## Related

Behavior contracts: [profile-catalog](../../openspec/specs/profile-catalog/spec.md), [resource-reference](../../openspec/specs/resource-reference/spec.md), [launcher](../../openspec/specs/launcher/spec.md), and [in-session-switch](../../openspec/specs/in-session-switch/spec.md). Mechanism: [architecture overview](../architecture/overview.md).
