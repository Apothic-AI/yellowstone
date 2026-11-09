# Spec Delta

## MODIFIED Requirements

### Requirement: Distributing the profile-config skill

When the package is installed and on every launcher startup, the system SHALL write the shipped `profile-config` skill into the user agentDir's `skills/profile-config/` directory. The skill guides the agent to create, modify, and delete profile files.

The skill is an ordinary user-level resource: the system MUST NOT introduce filtering exemptions or runtime special-casing for it. Its session visibility SHALL follow "Sparse skill and extension selection" and "Narrowing boundary of project-level resources" in the resource-reference specification.

When an existing skill file's content differs from the shipped version it SHALL be overwritten with the shipped version; when the content matches, nothing is written. Distribution failure MUST NOT fail the install or the launch and SHALL degrade to a warning.

#### Scenario: First install

- **WHEN** `profile-config` does not yet exist under the user agentDir's `skills/`
- **THEN** the install writes the shipped skill files

#### Scenario: Upgrade overwrite

- **WHEN** the user agentDir's `skills/profile-config/` already exists and its content differs from the shipped version
- **THEN** the install overwrites it with the shipped version

#### Scenario: Distribution failure degrades to a warning

- **WHEN** writing the skill files fails at install time (e.g. the target directory is not writable)
- **THEN** the install degrades to a warning and continues; the install itself does not fail

#### Scenario: Backfill or sync at startup

- **WHEN** the launcher starts and the user agentDir's `skills/profile-config/SKILL.md` does not exist or its content differs from the shipped version (e.g. install-time distribution was skipped, or the package has been upgraded)
- **THEN** the startup flow writes or overwrites it with the shipped version, making it available to ordinary skill discovery; its session visibility follows the resource-reference contract

#### Scenario: Content already in sync at startup

- **WHEN** the launcher starts and `skills/profile-config/SKILL.md` content already matches the shipped version
- **THEN** no file is written and startup continues

#### Scenario: Startup distribution failure degrades to a warning

- **WHEN** writing the skill files fails at launcher startup (e.g. the target directory is not writable)
- **THEN** a warning is printed and startup continues

#### Scenario: Omitted skills includes the ordinary configuration skill

- **WHEN** a named profile omits `skills` and native user settings allow the distributed `profile-config` skill
- **THEN** the skill is available without adding a profile reference or applying a filtering exemption

#### Scenario: Explicit selection can exclude the configuration skill

- **WHEN** a named profile declares an empty skill list or a reference list that does not select `profile-config`
- **THEN** the distributed skill remains installed but is not visible in the session

#### Scenario: Native exclusion still hides the configuration skill

- **WHEN** native user settings exclude `profile-config` and the named profile omits `skills`
- **THEN** distribution does not bypass that exclusion or force the skill into the session
