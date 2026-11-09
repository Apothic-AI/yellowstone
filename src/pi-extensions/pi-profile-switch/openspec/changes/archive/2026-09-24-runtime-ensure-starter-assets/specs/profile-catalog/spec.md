# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Seeding the starter profile at install`
  TO: `### Requirement: Seeding the starter profile`
- FROM: `### Requirement: Distributing the profile-config skill at install`
  TO: `### Requirement: Distributing the profile-config skill`

## MODIFIED Requirements

### Requirement: Seeding the starter profile

When the package is installed and on every launcher startup, if the global profiles directory contains no profile file yet, the system SHALL write the starter profile file shipped with the package, defining a profile named `ask`. When any profile file already exists in the directory, it MUST NOT be overwritten. Seeding at launcher startup SHALL complete before the initial profile is resolved, so the seeded result is visible to this launch. Seeding failure MUST NOT fail the install or the launch and SHALL degrade to a warning.

#### Scenario: First install

- **WHEN** the global `profiles/` directory does not exist or contains no `.json` file
- **THEN** the starter profile file `ask.json` is written

#### Scenario: Existing catalog

- **WHEN** the global `profiles/` directory already contains at least one `.json` file
- **THEN** no new file is written and the install continues

#### Scenario: Backfill at startup

- **WHEN** the launcher starts and the global `profiles/` directory contains no `.json` file (e.g. install-time seeding was skipped)
- **THEN** the startup flow writes the starter profile file `ask.json`, and that profile is visible to this launch's initial profile resolution

#### Scenario: No overwrite at startup

- **WHEN** the launcher starts and the global `profiles/` directory already contains at least one `.json` file
- **THEN** no new file is written and startup continues

#### Scenario: Startup seeding failure degrades to a warning

- **WHEN** the seeding write fails at launcher startup (e.g. the target directory is not writable)
- **THEN** a warning is printed and startup continues

### Requirement: Distributing the profile-config skill

When the package is installed and on every launcher startup, the system SHALL write the shipped `profile-config` skill into the user agentDir's `skills/profile-config/` directory. The skill guides the agent to create, modify, and delete profile files.

The skill is an ordinary user-level resource: the system MUST NOT introduce filtering exemptions or runtime special-casing for it; a named profile includes it only when it declares a reference to it.

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
- **THEN** the startup flow writes or overwrites it with the shipped version, and the skill is visible to this session

#### Scenario: Content already in sync at startup

- **WHEN** the launcher starts and `skills/profile-config/SKILL.md` content already matches the shipped version
- **THEN** no file is written and startup continues

#### Scenario: Startup distribution failure degrades to a warning

- **WHEN** writing the skill files fails at launcher startup (e.g. the target directory is not writable)
- **THEN** a warning is printed and startup continues
