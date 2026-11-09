# Spec Delta

## ADDED Requirements

### Requirement: Subagent overrides follow profile activation and rollback

Profile switching and reload SHALL apply subagent overrides through the same instance rewrite and native reload boundary as other profile settings. Rebuilding SHALL follow "Sparse native subagent settings materialization" in the launcher specification.

Switching to a profile without effective subagent declarations SHALL remove previous-profile child overrides and restore the current real user's native subagent settings. Removing fields from the current profile and reloading SHALL remove only those profile contributions. Current real-settings edits SHALL be reflected on the next activation.

A settings-write or reload failure SHALL restore the previous child settings and profile declaration exactly under the existing rollback contract. The system SHALL preserve Pi's session identity and history. It MUST NOT add child launches, live-task mutation, or task cancellation merely to enforce new defaults; Pi and pi-subagents SHALL retain their native reload and existing-run lifecycle.

#### Scenario: Switching removes previous child overrides

- **WHEN** the session switches from a profile with reviewer overrides to a profile with no effective subagent declaration
- **THEN** instance child settings match the current real-user base, the previous declaration is absent from profile status, and session identity and history are retained

#### Scenario: Reload removes a deleted role field

- **WHEN** the active profile deletes a reviewer description override but keeps its model override and reloads
- **THEN** the instance restores the native description input while retaining the profile model input

#### Scenario: Activation picks up real-user edits

- **WHEN** the real user's subagent settings change after launch and the profile reloads
- **THEN** the new instance result uses the edited base rather than accumulating patches from the previous instance

#### Scenario: Failed activation restores child settings and declarations

- **WHEN** a write or reload fails after instance child settings have changed
- **THEN** the previous settings and profile declaration are restored exactly, and no new selection or child policy is reported as active

#### Scenario: Defaults do not create or manage child runs

- **WHEN** a profile containing child defaults is activated or reloaded
- **THEN** the profile integration issues no child launch, task-reconfiguration, or task-cancellation request of its own

### Requirement: Declared subagent status and extension observations

When the active profile has effective child declarations, `/profile status` SHALL include those declarations in its displayed and structured output, labeled as profile declarations rather than effective runtime mappings. The status SHALL direct users to pi-subagents' native model inspection for the live mapping. Runtime-owned agent fields that pi-subagents does not permit overriding MUST NOT be reported as successfully applied.

Extension availability SHALL be observed from Pi's registered tool or command ownership rather than active-tool selection or the profile's selected-extension list alone. Registration names alone SHALL NOT prove ownership. A positively observed native extension SHALL be recognized even when loaded by CLI or project discovery, or when its delegation tool is registered but inactive.

When effective declarations exist but the native extension cannot be confirmed, session-start/reload diagnostics SHALL be non-fatal and actionable. They SHALL identify the profile, explain that overrides might be inactive, and suggest checking native extension loading and live model inspection. An inconclusive observation SHALL NOT be presented as proof of unload or role validity. Without effective declarations, the system SHALL omit subagent-specific status and perform no subagent-specific observation or warning.

#### Scenario: Status separates declaration from runtime mapping

- **WHEN** the active profile declares a reviewer model and description
- **THEN** status reports those as declared inputs and gives native model-inspection guidance without claiming that the final model, advertisement, or description has been applied

#### Scenario: No declaration produces no new status or warning

- **WHEN** the active profile omits effective child declarations
- **THEN** status has no child-override section or structured child field, and startup/reload performs no child-specific registration observation or diagnostic

#### Scenario: Missing native registration produces an actionable warning

- **WHEN** effective declarations exist and no pi-subagents-owned registration can be confirmed
- **THEN** startup or reload continues with a profile-named warning that explains the observation limit and how to check native loading and the live mapping

#### Scenario: Lazy delegation is not treated as unload

- **WHEN** pi-subagents owns a registered but inactive delegation tool or its lazy loader
- **THEN** the extension is positively observed without activating any tool, and no missing-extension warning is emitted

#### Scenario: CLI or project loading is recognized

- **WHEN** pi-subagents is loaded through CLI or native project discovery instead of the profile's selected user-level extensions
- **THEN** its owned registrations confirm the integration without changing extension selection or project trust

#### Scenario: Same-named foreign registration does not prove loading

- **WHEN** another extension wins a registration name normally used by pi-subagents and no other owned registration confirms pi-subagents
- **THEN** the observation remains unconfirmed and does not claim that the foreign registration consumes the profile's child settings

#### Scenario: Inconclusive ownership is non-fatal

- **WHEN** registration ownership cannot be resolved because metadata or a package manifest is unavailable
- **THEN** the observation is reported as unconfirmed rather than unloaded, activation remains successful, and no extension code is imported to resolve the uncertainty
