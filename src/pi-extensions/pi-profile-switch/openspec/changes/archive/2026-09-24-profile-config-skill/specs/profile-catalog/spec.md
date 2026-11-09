# Spec Delta

## ADDED Requirements

### Requirement: Distributing the profile-config skill at install

When the package is installed, the system SHALL write the shipped `profile-config` skill into the user agentDir's `skills/profile-config/` directory. The skill guides the agent to create, modify, and delete profile files.

The skill is an ordinary user-level resource: the system MUST NOT introduce filtering exemptions or runtime special-casing for it; a named profile includes it only when it declares a reference to it.

Upgrade installs SHALL always overwrite the skill's content to match the package version. Distribution failure MUST NOT fail the install.

#### Scenario: First install

- **WHEN** `profile-config` does not yet exist under the user agentDir's `skills/`
- **THEN** the install writes the shipped skill files

#### Scenario: Upgrade overwrite

- **WHEN** the user agentDir's `skills/profile-config/` already exists and its content differs from the shipped version
- **THEN** the install overwrites it with the shipped version

#### Scenario: Distribution failure degrades to a warning

- **WHEN** writing the skill files fails (e.g. the target directory is not writable)
- **THEN** the install degrades to a warning and continues; the install itself does not fail
