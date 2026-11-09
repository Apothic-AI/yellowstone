# Spec Delta

## ADDED Requirements

### Requirement: Catalog directory locations and discovery

The system SHALL read profile definitions from two locations: the global catalog and the project catalog.

The global catalog is the `profiles/` directory under the workspace root, which defaults to `~/.pi-profile-switch` and can be overridden by `PI_PROFILE_SWITCH_DIR`.

The project catalog is the `<projectDir>/.pi/profiles/` directory.

Each regular file with the `.json` extension in the directory SHALL define one profile; the filename minus the `.json` suffix is the profile name. Other entries (non-`.json` files, subdirectories) SHALL be ignored.

A missing directory SHALL be treated as an empty catalog, not an error. The system MUST NOT read any historical paths outside the two locations above.

#### Scenario: Workspace root overridden by environment variable

- **WHEN** `PI_PROFILE_SWITCH_DIR` is set and a `profiles/` directory exists under it
- **THEN** the system reads that directory as the global catalog and does not read the default workspace root

#### Scenario: Directory does not exist

- **WHEN** the global or project `profiles/` directory does not exist
- **THEN** the corresponding catalog is treated as empty, without an error

#### Scenario: Non-JSON entries are ignored

- **WHEN** a `profiles/` directory contains `review.json`, a subdirectory, and a file without the `.json` suffix
- **THEN** only `review.json` participates in resolution; the other entries produce neither errors nor profiles

## MODIFIED Requirements

### Requirement: Catalog file format validation

The system SHALL report an error when any profile file's content is illegal and MUST NOT degrade silently.

Each profile file's top-level value SHALL be an object — the complete definition of that profile — without envelope fields such as `schemaVersion`. The JSON syntax SHALL be legal.

Validation failures SHALL be actionable: the error SHALL identify the file at fault; field-level errors SHALL additionally identify the profile name and field name.

#### Scenario: Illegal catalog content

- **WHEN** a profile file's content is not legal JSON, or its top-level value is not an object
- **THEN** the system reports an error whose message identifies the file at fault, and the whole catalog read fails

### Requirement: Built-in default profile

The system SHALL always provide a built-in profile named `default`, whose source is `builtin` and whose definition contains no fields.

`default` MUST NOT be defined in a catalog: a `default.json` under any profiles directory is an error. `default` MUST NOT be editable and MUST NOT be deletable.

#### Scenario: Default defined in a catalog

- **WHEN** a `default.json` exists under any profiles directory
- **THEN** the system reports an error whose message identifies the file path

### Requirement: Project trust gate

The project catalog's content SHALL participate in resolution only when the project is trusted. When the project is untrusted, the system MUST NOT read any file of the project catalog, and writes with project scope SHALL fail.

#### Scenario: Untrusted project's catalog files are not read

- **WHEN** the project is untrusted and a `.pi/profiles/` directory exists under it
- **THEN** reads with project scope return an empty result without an error, and the files in that directory are not read

#### Scenario: Writing to an untrusted project's catalog

- **WHEN** any write is performed with project scope while the project is untrusted
- **THEN** the operation fails with a message stating that the directory is untrusted

### Requirement: Profile list ordering

The list SHALL start with `default`, followed by global entries in filename lexicographic order, then names that exist only in the project catalog, also in filename lexicographic order.

#### Scenario: List ordering

- **WHEN** the global catalog contains `b.json` and `a.json`, and the project catalog contains `c.json`
- **THEN** the list order is `default`, `a`, `b`, `c`

### Requirement: Profile create, edit, and duplicate

Create SHALL write a complete definition in the specified scope; it SHALL fail when a same-named profile already exists in that scope.

Edit SHALL replace the complete definition of an existing profile in the specified scope; it SHALL fail when the profile is not in that scope.

Duplicate SHALL write a complete copy of an existing definition under a new name in the specified scope; it SHALL fail when the source does not exist or the new name already exists.

Definitions SHALL be validated before writing. When validation fails or any precondition above is unmet, the profiles directory MUST NOT be modified.

#### Scenario: Same-named entry exists in target scope

- **WHEN** creating `review` in the global scope, or duplicating `review` as `implement`, while the global catalog already contains the target name
- **THEN** the operation fails with a message identifying the name and scope, and the target file is unchanged

#### Scenario: Editing a profile not in that scope

- **WHEN** editing in project scope a name that exists only in the global catalog
- **THEN** the operation fails with a message identifying the name and scope

#### Scenario: Illegal definitions do not land

- **WHEN** writing a definition whose `skills` contains a non-string item
- **THEN** the operation fails, and the target file stays unchanged or is not created

### Requirement: Catalog writes

A write SHALL affect only the target profile's own file: create and edit write `<name>.json`, delete removes `<name>.json`, and all other files MUST NOT be touched. The file content is the complete definition as formatted JSON, containing only the declared fields that passed validation.

Concurrent modifications SHALL be treated as last-writer-wins per same-named single file; concurrent writes to different names do not affect each other. A wizard save MUST NOT block because the directory was concurrently modified by another instance.

#### Scenario: Written file structure

- **WHEN** a write completes
- **THEN** the target profile's file is formatted JSON whose top level is the profile's definition, without envelope fields such as `schemaVersion`

#### Scenario: Saving after concurrent edits

- **WHEN** another process adds another profile to the same profiles directory while the wizard is open
- **THEN** the save succeeds and the added profile is unaffected

### Requirement: Seeding the starter profile at install

When the package is installed, if the global profiles directory contains no profile file yet, the system SHALL write the starter profile file shipped with the package, defining a profile named `ask`. When any profile file already exists in the directory, it MUST NOT be overwritten. Seeding failure MUST NOT fail the install.

#### Scenario: First install

- **WHEN** the global `profiles/` directory does not exist or contains no `.json` file
- **THEN** the starter profile file `ask.json` is written

#### Scenario: Existing catalog

- **WHEN** the global `profiles/` directory already contains at least one `.json` file
- **THEN** no new file is written and the install continues

## ADDED Requirements

### Requirement: Profile name constraints

Profile names SHALL match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. On read, a `.json` file with an illegal name in the profiles directory SHALL be an error identifying the file path; on write, an illegal name SHALL fail with an explanation of the rule.

Two names differing only in case are the same file on case-insensitive filesystems; the system SHALL NOT provide extra validation for this case.

#### Scenario: File with an illegal name

- **WHEN** the global `profiles/` directory contains `我的 profile.json`
- **THEN** the system reports an error whose message identifies the file path and the name rule

#### Scenario: Writing an illegal name

- **WHEN** creating a profile named `foo bar`
- **THEN** the operation fails with a message explaining the allowed name charset

## REMOVED Requirements

### Requirement: Catalog file locations and discovery

**Reason**: the catalog changed from a single-file `profiles.json` to a `profiles/` directory of one file per profile, and the legacy fallback path was deleted with it; the discovery rules are taken over by "Catalog directory locations and discovery".

**Migration**: split each profile in the old `profiles.json` into `profiles/<name>.json` (bare definitions, without the `schemaVersion` envelope); `<agentDir>/profiles.json` is no longer read.
