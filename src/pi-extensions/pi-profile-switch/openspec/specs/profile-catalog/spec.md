# profile-catalog Specification

## Purpose
Defines where profiles are read from, what content is legal, and which definition wins among same-named profiles. It is the data source of the profile selection mechanism: the other three capability domains all start from the definitions resolved by this one.

## Requirements

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

### Requirement: Catalog file format validation

Activation SHALL validate only the selected profile's winning definition, after source precedence and project trust have been determined. It MUST NOT read unrelated definition contents or a shadowed global definition. Selecting `default` SHALL require no catalog definition read.

Each selected file SHALL contain legal JSON with an object as its top-level value. Invalid JSON, object shape, or supported-field types SHALL reject that profile with an actionable error naming its file and, for field errors, profile and field. A present but invalid winning definition MUST NOT fall back to the shadowed definition or to `default`.

Listing SHALL isolate definition errors per winning entry instead of failing the whole catalog. Directory enumeration failures other than a missing directory SHALL remain errors.

#### Scenario: Illegal catalog content
- **WHEN** the selected winning file is not legal JSON or its top-level value is not an object
- **THEN** activation fails with its file path and does not substitute another profile

#### Scenario: Unrelated malformed file
- **WHEN** a valid profile is selected and another profile file contains malformed JSON or invalid field types
- **THEN** the valid profile activates without reading the other file's contents

#### Scenario: Default with corrupt catalog entries
- **WHEN** `default` is selected and catalog files are malformed
- **THEN** activation does not read those definitions and continues

#### Scenario: Project winner shadows corrupt global definition
- **WHEN** a trusted project provides a valid selected definition over a malformed same-named global file
- **THEN** the project definition activates without reading the global file's contents

#### Scenario: Invalid project winner does not fall back
- **WHEN** the trusted project's selected definition is malformed and a valid same-named global definition exists
- **THEN** activation fails naming the project file rather than using the global definition

#### Scenario: Invalid entry does not break listing
- **WHEN** a visible winning definition is malformed
- **THEN** listing retains that entry as unavailable with a path-bearing diagnostic and still lists valid entries

### Requirement: Profile definition fields

A profile definition SHALL be an object. Supported fields and their shapes SHALL defer to `schemas/profiles.schema.json`. The optional `subagents` field SHALL follow "Optional native subagent override definitions". All fields SHALL remain optional. Undeclared fields MUST NOT gain new behavior through validation or diagnostic handling.

The existing distinctions between omitted and explicitly empty resource selections SHALL be retained. An empty `mcp_tools` object SHALL have the same effect as omission; an empty selector list for a named server SHALL remain a deny-all tool policy. Glob server names or tool selectors in `mcp_tools` SHALL remain field errors.

On read, unknown top-level keys SHALL be ignored with a warning naming the profile, key, and supported-field candidates derived from the authoritative schema. On write, only supported fields SHALL be emitted. Unknown keys MUST NOT be forwarded to Pi as native settings. Unsupported fields inside a declared `subagents` object SHALL follow its field-specific validation contract rather than the top-level unknown-key rule.

#### Scenario: Field type mismatch
- **WHEN** a selected definition, including a declared `subagents` object, violates the authoritative supported-field shape
- **THEN** activation fails identifying the file, profile, and offending field

#### Scenario: Undeclared fields do not affect behavior
- **WHEN** a profile declares only a skill selection
- **THEN** validation adds no model, thinking-level, instructions, or native subagent settings override

#### Scenario: Unknown keys are ignored and not written back
- **WHEN** a profile contains an unknown top-level key and is later rewritten through a supported writer
- **THEN** reading warns without blocking, the key has no effect, and the written definition omits it

#### Scenario: Empty per-server list is retained
- **WHEN** a profile assigns an empty tool selector list to a server
- **THEN** parsing retains the server's deny-all tool policy

#### Scenario: Explicitly empty server selection is retained
- **WHEN** a profile declares an empty MCP server selection
- **THEN** parsing retains it as an explicit selection rather than omission

#### Scenario: Glob is not a literal MCP tool selector
- **WHEN** a profile uses a glob in an `mcp_tools` key or selector
- **THEN** parsing rejects the field with an actionable literal-name requirement

#### Scenario: Special-looking server keys remain data
- **WHEN** a profile uses a special-looking JSON property name as an MCP server key
- **THEN** parsing retains it as own data without treating it as implicitly discovered

### Requirement: Optional native subagent override definitions

A profile SHALL accept the native-shaped optional subagent override subset defined by `schemas/profiles.schema.json`. Accepted thinking levels SHALL defer to Pi's supported thinking-level contract. Field types and supported native clearing values SHALL agree between the runtime parser and the shipped schema.

An omitted declaration, an empty declaration, an empty agent override map, or a map containing only empty role entries SHALL express no subagent control. Native clearing values and explicitly false boolean values SHALL remain distinct from omission.

Role-map keys SHALL identify exact, case-sensitive canonical agent names rather than patterns or an availability list. Empty, surrounding-whitespace, and glob-pattern keys SHALL be rejected. Special-looking JSON keys SHALL remain own data properties.

Malformed shapes, blank text values, invalid thinking values, and unsupported nested fields SHALL fail catalog validation. An actionable error SHALL identify the profile file, profile name, full nested field path, and the expected form or supported-field candidates. Previously configured native fields outside the profile's supported subset SHALL remain legal in the user's Pi settings; the subset restricts profile declarations only.

#### Scenario: Supported role overrides are accepted

- **WHEN** a profile declares a reviewer model, a supported thinking level, a nonempty description, and a boolean advertisement value
- **THEN** the parser accepts those fields and the shipped schema accepts the same definition

#### Scenario: Empty declarations express no control

- **WHEN** a profile omits `subagents`, declares `subagents: {}`, or declares an agent override map whose entries are all empty
- **THEN** it declares no additional subagent behavior and does not create an empty role-availability selection

#### Scenario: False values survive parsing

- **WHEN** a role override uses native clearing values for model or thinking and sets `advertise: false`
- **THEN** parsing retains each explicitly false field for native consumption instead of treating it as absent

#### Scenario: Invalid nested field reports its full path

- **WHEN** `subagents.agentOverrides.reviewer.advertise` is not a boolean or a declared text field is blank
- **THEN** validation fails naming the file, profile, full nested field path, and expected form

#### Scenario: Unsupported child policy is rejected

- **WHEN** a profile places a child-tool selection, child-skill selection, role-disable field, or role-availability list inside `subagents`
- **THEN** validation rejects the unsupported nested field with supported-field candidates rather than silently ignoring it

#### Scenario: Unsupported thinking value is rejected

- **WHEN** a declared shared or role-specific thinking value is outside Pi's supported thinking contract
- **THEN** validation fails at that nested field and offers the accepted values derived from the authoritative contract

#### Scenario: Role name patterns are rejected

- **WHEN** an override-map key is a glob pattern, an empty name, or a name with surrounding whitespace
- **THEN** validation fails explaining that an exact canonical agent name is required

#### Scenario: Special-looking agent keys remain data

- **WHEN** a JSON profile contains `toString` or `__proto__` as an agent override key
- **THEN** parsing preserves it as an own data entry without modifying object prototypes or inventing an agent registration

#### Scenario: Project profile replacement does not inherit child settings

- **WHEN** a global profile declares subagent overrides and a same-named trusted-project profile omits them
- **THEN** the winning project profile contains no inherited global-profile subagent declaration

### Requirement: Built-in default profile

The system SHALL always provide `default` with source `builtin` and an empty definition. Catalog files MUST NOT redefine it; supported writers SHALL reject attempts to edit or delete it.

A reserved-name catalog file SHALL be diagnosed during listing and ignored as a definition. It MUST NOT prevent activation of `default` or another valid profile.

#### Scenario: Default defined in a catalog
- **WHEN** a catalog contains `default.json`
- **THEN** listing reports its path, retains the native `default` entry, and does not block valid profile activation

### Requirement: Profile sources and project override

Every resolvable profile SHALL report its source according to the existing source contract. A trusted project's same-named definition SHALL completely replace the global definition without merging or appending fields. Precedence SHALL be decided before reading definition contents.

Deleting the project file SHALL reveal the global definition on the next resolution. An invalid project winner SHALL remain the winner and SHALL fail according to "Catalog file format validation" rather than revealing the global definition.

#### Scenario: Project entry completely replaces global entry
- **WHEN** global and trusted-project definitions share a name and declare different fields
- **THEN** resolution uses only the project definition and reports project source

#### Scenario: Global entry restored after project override deleted
- **WHEN** a same-named project override is deleted
- **THEN** the next resolution reads the global definition and reports global source

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

### Requirement: Profile name constraints

Profile names SHALL satisfy the authoritative name rule in `src/profile-catalog.ts`. Supported writers SHALL reject illegal names with an explanation of the rule. Illegal filenames encountered during listing SHALL produce path-bearing diagnostics without making valid profiles unavailable. Targeted activation SHALL reject an illegal requested name without using it as a filesystem traversal path.

The system SHALL NOT add case-collision validation beyond the filesystem's existing behavior.

#### Scenario: File with an illegal name
- **WHEN** a catalog contains a JSON filename that violates the name rule
- **THEN** listing diagnoses and excludes that entry while valid entries and targeted activation remain usable

#### Scenario: Writing an illegal name
- **WHEN** a supported writer receives an illegal profile name
- **THEN** it rejects the name with the authoritative rule

#### Scenario: Invalid requested name cannot escape catalog
- **WHEN** activation receives a name containing a path traversal
- **THEN** it rejects the name without reading outside the catalog
