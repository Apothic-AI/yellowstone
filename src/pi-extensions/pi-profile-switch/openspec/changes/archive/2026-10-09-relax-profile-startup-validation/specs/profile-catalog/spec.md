# Spec Delta

## MODIFIED Requirements

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
