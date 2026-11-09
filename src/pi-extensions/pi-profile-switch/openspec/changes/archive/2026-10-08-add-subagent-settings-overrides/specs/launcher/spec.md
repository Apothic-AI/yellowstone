# Spec Delta

## ADDED Requirements

### Requirement: Sparse native subagent settings materialization

When a profile declares effective subagent overrides, its instance settings SHALL replace only explicitly declared shared fields and explicitly declared fields within named agent entries in the user's native subagent settings. Undeclared native fields and unmentioned role entries SHALL retain their original JSON values, including native fields outside the profile's supported subset.

Native false values SHALL be materialized as false, not removed. Each activation SHALL derive the result from the current real user settings, not the previous instance's overridden settings. Neither user settings nor agent definitions SHALL be modified or copied as a result of materializing overrides.

A native container that must be patched but is not an object SHALL fail activation before any managed runtime file is written. The error SHALL name the native settings file and nested path and explain how to correct the shape. Containers and entries that are not required for the declared patch MUST NOT acquire new validation requirements.

#### Scenario: Partial role override preserves native fields

- **WHEN** the user settings give reviewer a model, an inherited-context setting, and a child-tool setting, while the profile overrides only its model
- **THEN** the instance changes only the reviewer model and preserves the native context and child-tool JSON values

#### Scenario: Unrelated native subagent settings survive

- **WHEN** the user settings contain other role entries and provider-specific overrides that the profile does not declare
- **THEN** those entries and override objects remain unchanged in the instance

#### Scenario: Explicit false is written literally

- **WHEN** a profile clears a supported native role field with false or disables its advertisement with false
- **THEN** the instance settings contain the explicit false values

#### Scenario: Shared default does not rewrite role entries

- **WHEN** the profile declares only a shared child model default and the user has explicitly pinned some role models
- **THEN** materialization changes the shared default without modifying the pinned role entries

#### Scenario: Empty declaration preserves even uninspected native content

- **WHEN** the profile declares no effective child override and native subagent content has a shape outside the profile subset or an invalid nested shape
- **THEN** materialization preserves that content without introducing a new subagent-validation failure or diagnostic

#### Scenario: Required native container cannot be patched

- **WHEN** a nonempty profile role override needs to patch a native role entry that is not an object
- **THEN** activation fails before managed runtime writes, identifying the native settings file, role entry path, and object-shape remedy

#### Scenario: Untouched malformed native entry is not newly validated

- **WHEN** the profile changes only the shared child model default and an unrelated native role entry is malformed
- **THEN** the profile layer does not fail activation by inspecting that role entry, and native pi-subagents retains responsibility for its own diagnostics

#### Scenario: Real settings and agent definitions are unchanged

- **WHEN** a profile with subagent declarations launches
- **THEN** the real user settings and preexisting agent definition files have byte-identical content after activation, and no agent definition copy is created

### Requirement: Optional subagent integration and native precedence

A profile without effective subagent declarations SHALL remain usable when pi-subagents is absent and SHALL introduce no subagent-specific dependency or startup requirement. A declaration alone MUST NOT install or force-load pi-subagents; extension-reference failures SHALL continue to follow the existing extension contract.

Generated subagent settings SHALL occupy native user-level settings scope. The system MUST NOT merge project settings into the instance, rewrite native provider-specific overrides to make profile values win, or force a live role mapping over pi-subagents' own precedence. Child defaults SHALL NOT be represented as a model or tool permission ceiling.

#### Scenario: Optional extension is absent

- **WHEN** pi-subagents is not installed and the profile declares no effective subagent setting
- **THEN** launch succeeds under the existing profile rules without a subagent warning or package operation

#### Scenario: Declarations do not force a missing extension to load

- **WHEN** the profile declares child settings but pi-subagents is not otherwise loaded, and no explicit extension reference fails
- **THEN** the profile's launch is not rejected for the optional integration, no package is installed, and the runtime observation follows the in-session diagnostic contract

#### Scenario: Native project and provider precedence is preserved

- **WHEN** a native project or provider-specific role override competes with a profile-generated ordinary user-level override
- **THEN** the instance preserves both inputs and pi-subagents determines the winner through its native rules

#### Scenario: User-level extension exclusion remains effective

- **WHEN** the profile excludes the user-level pi-subagents extension through existing extension selection but declares child settings
- **THEN** the child settings do not re-add that extension or exempt it from filtering
