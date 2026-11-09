# Spec Delta

## Purpose

Defines where profiles are read from, what content is legal, and which definition wins among same-named profiles. It is the data source of the profile selection mechanism: the other three capability domains all start from the definitions resolved by this one.

## ADDED Requirements

### Requirement: Catalog file locations and discovery

The system SHALL read profile definitions from two locations: the global catalog and the project catalog.

The global catalog is the `profiles.json` under the workspace root, which defaults to `~/.pi-profile-switch` and can be overridden by `PI_PROFILE_SWITCH_DIR`. When that file does not exist, the system SHALL fall back to reading `<agentDir>/profiles.json`.

The project catalog is `<projectDir>/.pi/profiles.json`.

A missing file SHALL be treated as an empty catalog, not an error.

#### Scenario: Falling back to the legacy path when the preferred global file is missing

- **WHEN** `~/.pi-profile-switch/profiles.json` does not exist and `~/.pi/agent/profiles.json` does
- **THEN** the system reads `~/.pi/agent/profiles.json` as the global catalog

#### Scenario: Workspace root overridden by environment variable

- **WHEN** `PI_PROFILE_SWITCH_DIR` is set and a `profiles.json` exists under it
- **THEN** the system reads that file as the global catalog and does not read the default workspace root

### Requirement: Catalog file format validation

The system SHALL report an error when catalog content is illegal and MUST NOT silently degrade to an empty catalog.

The top-level value SHALL be an object. `schemaVersion` SHALL equal `1`. `profiles` SHALL be an object whose keys are profile names and whose values are profile definitions. The JSON syntax SHALL be legal.

Validation failures SHALL be actionable: the error SHALL identify the file at fault; field-level errors SHALL additionally identify the profile name and field name.

#### Scenario: Illegal catalog content

- **WHEN** the catalog's `schemaVersion` is not `1`, or its `profiles` is not an object, or its content is not legal JSON
- **THEN** the system reports an error whose message identifies the file at fault, and no empty catalog is produced

### Requirement: Profile definition fields

A profile definition SHALL be an object and SHALL contain only these fields: `label`, `description`, `skills`, `extensions`, `mcps`, `tools`, `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `instructions`.

`skills`, `extensions`, `mcps`, and `tools` SHALL be arrays of strings. The remaining fields SHALL be strings.

All fields are optional. Undeclared fields SHALL NOT produce any behavior change.

On read, unlisted keys SHALL be ignored. On write, only the fields listed above SHALL be written out.

#### Scenario: Field type mismatch

- **WHEN** a profile's `skills` contains a non-string item, or its `defaultModel` is not a string, or the definition itself is not an object
- **THEN** the system reports an error whose message identifies the profile name and the field at fault

#### Scenario: Undeclared fields do not affect behavior

- **WHEN** a profile declares only `skills`
- **THEN** that profile's model, thinking level, and instructions stay at Pi's current state

#### Scenario: Unknown keys are ignored and not written back

- **WHEN** a profile in the catalog carries an unlisted key, and that profile is then rewritten via the wizard
- **THEN** reading does not fail because of that key, and the written-back file does not contain it

### Requirement: Built-in default profile

The system SHALL always provide a built-in profile named `default`, whose source is `builtin` and whose definition contains no fields.

`default` MUST NOT be defined in a catalog file. `default` MUST NOT be editable and MUST NOT be deletable.

#### Scenario: Default defined in a catalog

- **WHEN** any catalog file's `profiles` contains the key `default`
- **THEN** the system reports an error whose message identifies the file path

### Requirement: Profile sources and project override

Every resolvable profile SHALL carry a source: `builtin`, `global`, or `project`. Global catalog entries have source `global`; project catalog entries have source `project`.

A project entry SHALL completely replace a same-named global entry and MUST NOT merge with or append to any of its fields. Once the project entry is deleted, the same-named global entry SHALL become resolvable again immediately.

#### Scenario: Project entry completely replaces global entry

- **WHEN** both the global and project catalogs define `review`, the global declaring `skills: ["a"]` and the project declaring `tools: ["read"]`
- **THEN** resolving `review` yields source `project` and a definition containing only `tools: ["read"]`

#### Scenario: Global entry restored after project override deleted

- **WHEN** the project catalog deletes the `review` from the previous example
- **THEN** resolving `review` yields source `global` and the globally declared definition

### Requirement: Project trust gate

The project catalog's content SHALL participate in resolution only when the project is trusted. When the project is untrusted, the system MUST NOT read the project catalog file, and writes with project scope SHALL fail.

#### Scenario: Untrusted project's catalog file is not read

- **WHEN** the project is untrusted and a `.pi/profiles.json` exists under it
- **THEN** reads with project scope return an empty result without an error, and that file is not read

#### Scenario: Writing to an untrusted project's catalog

- **WHEN** any write is performed with project scope while the project is untrusted
- **THEN** the operation fails with a message stating that the directory is untrusted

### Requirement: Profile list ordering

The list SHALL start with `default`, followed by global entries in catalog-file order, then names that exist only in the project catalog.

#### Scenario: List ordering

- **WHEN** the global catalog defines `b`, `a` in that order, and the project catalog defines `c`
- **THEN** the list order is `default`, `b`, `a`, `c`

### Requirement: Profile create, edit, and duplicate

Create SHALL write a complete definition in the specified scope; it SHALL fail when a same-named profile already exists in that scope.

Edit SHALL replace the complete definition of an existing profile in the specified scope; it SHALL fail when the profile is not in that scope.

Duplicate SHALL write a complete copy of an existing definition under a new name in the specified scope; it SHALL fail when the source does not exist or the new name already exists.

Definitions SHALL be validated before writing. When validation fails or any precondition above is unmet, the catalog file MUST NOT be modified.

#### Scenario: Same-named entry exists in target scope

- **WHEN** creating `review` in the global scope, or duplicating `review` as `implement`, while the global catalog already contains the target name
- **THEN** the operation fails with a message identifying the name and scope, and the file is unchanged

#### Scenario: Editing a profile not in that scope

- **WHEN** editing in project scope a name that exists only in the global catalog
- **THEN** the operation fails with a message identifying the name and scope

#### Scenario: Illegal definitions do not land

- **WHEN** writing a definition whose `skills` contains a non-string item
- **THEN** the operation fails and the file content stays unchanged

### Requirement: Profile deletion

Delete SHALL remove a profile from the specified scope. It SHALL fail — rather than no-op — when the profile is not in that scope.

When deleting the currently active profile, the request SHALL specify a replacement profile, or it SHALL fail.

#### Scenario: Deleting a nonexistent profile

- **WHEN** deleting from the global scope a name not present in the global catalog
- **THEN** the operation fails with a message identifying the name

#### Scenario: Deleting the active profile without a replacement

- **WHEN** deleting the currently active profile without providing a replacement
- **THEN** the operation fails with a message asking to choose a replacement profile first

### Requirement: Catalog writes

Writes SHALL be whole-file overwrites, emitting formatted JSON whose top level contains `schemaVersion: 1` and `profiles`. Writes SHALL contain only the declared fields that passed validation.

Concurrent modifications SHALL be treated as last-writer-wins on the whole file: writing reads the entire file first, so one write overwrites another process's simultaneous changes to other profiles. A wizard save MUST NOT block because the file was concurrently modified by another instance.

#### Scenario: Written file structure

- **WHEN** a write completes
- **THEN** the file's top level is `schemaVersion` and `profiles`, containing that write's definitions

#### Scenario: Saving after concurrent edits

- **WHEN** another process adds another profile to the same catalog file while the wizard is open
- **THEN** the save succeeds, but the added profile is not preserved in the file

### Requirement: Seeding the starter profile at install

When the package is installed, if the global workspace has no catalog file yet, the system SHALL write the starter catalog shipped with the package, containing a profile named `ask`. When a catalog file already exists it MUST NOT be overwritten. When the legacy path `<agentDir>/profiles.json` exists, seeding SHALL be skipped. Seeding failure MUST NOT fail the install.

#### Scenario: First install

- **WHEN** neither the global workspace nor the legacy path has a catalog file
- **THEN** the starter catalog is written, containing the `ask` profile

#### Scenario: Existing catalog

- **WHEN** the global workspace already has `profiles.json`, or a catalog file exists at the legacy path
- **THEN** no new file is written and the install continues
