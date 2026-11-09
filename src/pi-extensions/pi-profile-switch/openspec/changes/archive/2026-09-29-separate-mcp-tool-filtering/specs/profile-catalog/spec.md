# Spec Delta

## MODIFIED Requirements

### Requirement: Profile definition fields

A profile definition SHALL be an object and SHALL contain only these fields: `label`, `description`, `skills`, `extensions`, `mcps`, `tools`, `mcp_tools`, `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `instructions`.

`skills`, `extensions`, `mcps`, and `tools` SHALL be arrays of strings. `mcp_tools` SHALL be an object whose keys are literal MCP server names and whose values are arrays of literal tool selectors passed to the active MCP adapter; glob patterns SHALL be rejected for this profile field. The remaining fields SHALL be strings.

All fields are optional. Undeclared fields SHALL NOT produce any behavior change. An empty `mcp_tools` object SHALL have the same effect as an undeclared one; an empty list for a server SHALL remain distinct from an omitted server key.

On read, unlisted keys SHALL be ignored. On write, only the fields listed above SHALL be written out.

#### Scenario: Field type mismatch

- **WHEN** a profile's `skills` contains a non-string item, its `defaultModel` is not a string, its `mcp_tools` is not an object of string arrays, or the definition itself is not an object
- **THEN** the system reports an error whose message identifies the profile name and the field at fault

#### Scenario: Undeclared fields do not affect behavior

- **WHEN** a profile declares only `skills`
- **THEN** that profile's model, thinking level, and instructions stay at Pi's current state

#### Scenario: Unknown keys are ignored and not written back

- **WHEN** a profile in the catalog carries an unlisted key, and that profile is then rewritten via the wizard
- **THEN** reading does not fail because of that key, and the written-back file does not contain it

#### Scenario: Empty per-server list is retained

- **WHEN** a profile declares `mcp_tools: { "github": [] }`
- **THEN** the parsed definition retains the empty list for `github` rather than treating it as an absent field or absent server key

#### Scenario: Glob is not a literal MCP tool selector

- **WHEN** an `mcp_tools` entry contains a glob pattern
- **THEN** the definition is rejected with an actionable field error explaining that literal adapter tool selectors are required

#### Scenario: Special-looking server keys remain data

- **WHEN** a JSON profile declares an `mcp_tools` server key such as `toString` or `__proto__`
- **THEN** parsing retains it as an explicit server key for resolution; it is neither discarded nor implicitly treated as a discovered server
