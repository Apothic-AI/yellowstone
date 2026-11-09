# Spec Delta

## MODIFIED Requirements

### Requirement: Profile definition fields

A profile definition SHALL be an object. Its supported fields SHALL defer to the authoritative profile schema in `schemas/profiles.schema.json`, including the optional `subagents` field.

`skills`, `extensions`, `mcps`, and `tools` SHALL be arrays of strings. `mcp_tools` SHALL be an object whose keys are literal MCP server names and whose values are arrays of literal MCP tool names as registered by Pi's built-in MCP extension; glob patterns SHALL be rejected for this profile field. `subagents` SHALL follow "Optional native subagent override definitions". The remaining supported fields SHALL be strings.

All fields are optional. Undeclared fields SHALL NOT produce any behavior change. An empty `mcp_tools` object SHALL have the same effect as an undeclared one; an empty list for a server SHALL remain distinct from an omitted server key. An explicitly empty `mcps` array SHALL be retained as an empty server selection and SHALL remain distinct from an undeclared `mcps` field.

On read, unlisted top-level keys SHALL be ignored. On write, only supported fields SHALL be written out. Unsupported fields inside a declared `subagents` object SHALL follow its field-specific validation contract rather than the top-level unknown-key rule.

#### Scenario: Field type mismatch

- **WHEN** a profile's `skills` contains a non-string item, its `defaultModel` is not a string, its `mcp_tools` is not an object of string arrays, its `subagents` declaration violates its field contract, or the definition itself is not an object
- **THEN** the system reports an error whose message identifies the profile name and the field at fault

#### Scenario: Undeclared fields do not affect behavior

- **WHEN** a profile declares only `skills`
- **THEN** that profile's model, thinking level, instructions, and native subagent settings receive no additional override

#### Scenario: Unknown keys are ignored and not written back

- **WHEN** a profile in the catalog carries an unlisted top-level key, and that profile is then rewritten via the wizard
- **THEN** reading does not fail because of that key, and the written-back file does not contain it

#### Scenario: Empty per-server list is retained

- **WHEN** a profile declares `mcp_tools: { "github": [] }`
- **THEN** the parsed definition retains the empty list for `github` rather than treating it as an absent field or absent server key

#### Scenario: Explicitly empty server selection is retained

- **WHEN** a profile declares `mcps: []`
- **THEN** the parsed definition retains the empty array and treats it as an explicit selection of no user-level servers, distinct from omitting `mcps`

#### Scenario: Glob is not a literal MCP tool selector

- **WHEN** an `mcp_tools` entry contains a glob pattern
- **THEN** the definition is rejected with an actionable field error explaining that literal MCP tool names are required

#### Scenario: Special-looking server keys remain data

- **WHEN** a JSON profile declares an `mcp_tools` server key such as `toString` or `__proto__`
- **THEN** parsing retains it as an explicit server key for resolution; it is neither discarded nor implicitly treated as a discovered server

## ADDED Requirements

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
