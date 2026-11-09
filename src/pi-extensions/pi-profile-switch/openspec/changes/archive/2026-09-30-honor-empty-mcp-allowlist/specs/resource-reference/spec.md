# Spec Delta

## MODIFIED Requirements

### Requirement: MCP server reference resolution and the adapter dependency

An MCP server reference's identity SHALL be a server name discovered in `pi-mcp-adapter` configuration.

Discovery SHALL read the standard configuration locations recognized by the adapter; project-scope configuration SHALL be read only when the project is trusted. When configuration content is illegal the system SHALL report an error identifying the file path and MUST NOT silently read it as "no servers".

When a profile declares MCP servers while the adapter's discovery result is unavailable, activation SHALL fail: this covers both the adapter being inactive and no usable server discovery result.

A profile that declares no MCP servers MUST NOT depend on the adapter because of that. With an active adapter, an explicitly empty `mcps` list SHALL resolve to an empty server selection, even when discovery finds no servers. Without an active adapter, an empty `mcps` list alone SHALL leave MCP availability unchanged and SHALL NOT introduce an adapter dependency.

#### Scenario: Untrusted project's MCP configuration does not participate

- **WHEN** the project is untrusted and an MCP configuration file exists under the project directory
- **THEN** the servers in that file do not appear in the referenceable set and the file is not read

#### Scenario: Illegal MCP configuration content

- **WHEN** an MCP configuration at a standard location is not legal JSON, or is not an object
- **THEN** an error is reported identifying the file path, instead of reading it as "no servers"

#### Scenario: MCP servers declared but adapter unavailable

- **WHEN** a profile declares a nonempty `mcps` list while `pi-mcp-adapter` is not active
- **THEN** activation fails with an error explaining that the adapter must be selected in the profile's extensions, or the `mcps` declaration must be removed

#### Scenario: Empty selection with active adapter

- **WHEN** a named profile declares `mcps: []` and selects the adapter, whether or not any server is discovered
- **THEN** resolution retains an empty server selection rather than treating `mcps` as undeclared

#### Scenario: Empty selection without adapter

- **WHEN** a named profile declares `mcps: []` without selecting the adapter
- **THEN** activation does not fail for a missing adapter and no MCP availability is changed by the empty declaration

#### Scenario: Unknown server name

- **WHEN** a profile declares a server name the adapter has not discovered
- **THEN** activation fails with an error identifying the name
