# Spec Delta

## ADDED Requirements

### Requirement: Subagent override resolution boundaries

Resolution SHALL preserve the profile's validated native subagent declaration without treating its role keys as selectable Resources, registering agents, expanding globs, or applying Resource-reference failure tiering to those keys. Effectively empty declarations SHALL contribute no subagent override to activation.

The declaration alone MUST NOT import pi-subagents, execute extension code, discover agent files, install packages, contact providers, or require child-model authentication. Parent-model validation SHALL retain its existing behavior and MUST NOT be reused to reinterpret child model strings. Final child-model selection, native clearing behavior, runner-specific model handling, and launch failures SHALL remain owned by pi-subagents.

Agent names and advertisement or description declarations MUST NOT enable delegation, alter child prompts directly, or filter unmentioned agents. Existing extension and tool selection SHALL remain the only profile-controlled loading and parent-tool mechanisms in this change.

#### Scenario: Omitted or empty child declarations remain absent from activation

- **WHEN** a profile declares no effective subagent override
- **THEN** activation contains no additional child override and performs no subagent-specific dependency or discovery work

#### Scenario: Child model does not invoke parent-model validation

- **WHEN** a profile declares a child model but no parent model declaration
- **THEN** activation carries the child model string without invoking parent-model authentication or requiring a child-model registry

#### Scenario: Native model syntax is preserved

- **WHEN** a role model contains the native inheritance marker, a provider-qualified model with a thinking suffix, or an external runner's model alias
- **THEN** resolution preserves the nonempty string for pi-subagents rather than translating it into a parent-model declaration

#### Scenario: Unknown role keys are not missing Resource references

- **WHEN** a profile declares an exact role name that is not currently registered
- **THEN** activation retains its override without creating an agent or failing Resource-reference validation, and does not claim that the role exists

#### Scenario: A single role override does not narrow other roles

- **WHEN** a profile overrides only the reviewer and pi-subagents can discover additional roles
- **THEN** the override declaration introduces no availability restriction for the other roles

#### Scenario: Child declaration does not select the extension or tools

- **WHEN** a profile declares subagent overrides without selecting the user-level pi-subagents extension or delegation tools
- **THEN** resolution does not add the extension, grant tools, or alter the existing project-resource boundary
