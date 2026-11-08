# Spec Delta

## MODIFIED Requirements

### Requirement: Pre-launch failure and exit codes

The following failures SHALL abort startup before the Pi process is created: unknown profile, unresolvable references, explicit MCP selection or per-server restriction while the configuration required to resolve it cannot be read, selected MCP servers that the winning source explicitly disables or whose definition Pi's built-in MCP extension cannot use, illegal catalog content, declared model failing validation.

The failures above SHALL exit with code `2`. Other unexpected failures SHALL exit with code `1`. Failure messages SHALL be written to stderr. Malformed MCP configuration without an effective MCP policy SHALL instead be diagnosed by path on stderr, and the Pi process SHALL still start with valid discovered definitions.

#### Scenario: Declared model not authenticated

- **WHEN** the model declared by the profile does not exist or is not authenticated
- **THEN** startup exits with code `2` and no Pi process is created

#### Scenario: Catalog content corrupt

- **WHEN** a catalog file's content is illegal
- **THEN** startup exits with code `2` and the error identifies the file path

#### Scenario: Selected MCP server uses a transport Pi cannot use

- **WHEN** a profile's `mcps` names a server whose definition Pi's built-in MCP extension cannot use
- **THEN** startup exits with code `2`, the error names the server and a migration hint, and no Pi process is created

#### Scenario: Explicitly selected server is disabled

- **WHEN** `mcps` selects a user-level server that its source marks `enabled: false`
- **THEN** startup exits with code `2`, identifies the server and how to enable it at the source, and creates no Pi process

#### Scenario: Invalid MCP source under an explicit policy

- **WHEN** a profile declares `mcps` or names a server in `mcp_tools` and a required user-level MCP source is malformed
- **THEN** startup exits with code `2`, identifies the source path, and creates no Pi process

#### Scenario: Invalid MCP source under no policy

- **WHEN** the active profile has no effective MCP declaration and a user-level source is malformed
- **THEN** startup prints a diagnostic identifying the source and starts Pi using the remaining valid sources

### Requirement: Instance MCP configuration snapshot

The instance's `mcp.json` SHALL always be the generated MCP configuration snapshot, never a symlink or a copy of the real agentDir file. The snapshot SHALL contain the merged user-level server definitions in the established source order (defer to the authoritative source list in `src/mcp-config.ts`). When a profile declares `mcps`, only the selected servers SHALL remain enabled. For unselected user-level servers, the instance configuration SHALL preserve the winning server's full definition and explicitly set `enabled: false`; it MUST NOT rely on omission or emit an invalid transport-less placeholder. An explicitly empty `mcps` selection SHALL disable every user-level server from the merged snapshot. Servers defined in project-level locations SHALL NOT be written into the instance configuration at all: Pi reads trusted project MCP configuration itself, and those servers SHALL stay enabled.

When `mcp_tools` names any server, the instance's MCP configuration SHALL carry that server's tool restriction as tool exposure — every tool hidden except tools matched by the listed selectors, which SHALL be directly exposed — even if `mcps` is undeclared. Servers omitted from `mcp_tools` SHALL retain their configured tool exposure. An explicitly empty tool list SHALL deny all the named server's tools, not restore an unrestricted server. Profile-generated restrictions MUST NOT alter project-owned servers.

User configuration files MUST NOT be modified.

#### Scenario: Unrestricted MCP configuration is materialized as the snapshot

- **WHEN** the profile does not declare `mcps` and does not name any server in `mcp_tools`, and `mcp.json` exists under the real agentDir
- **THEN** the instance's `mcp.json` is a generated file containing the merged user-level server definitions, and it is not a symlink

#### Scenario: Restricted MCP configuration disables unselected shared servers

- **WHEN** the profile declares `mcps` allowing only server A, while another user-level location also defines valid server B
- **THEN** the instance's `mcp.json` contains A's definition and B's complete definition with `enabled: false`; B is not connected and Pi reports no missing-transport configuration error for B

#### Scenario: Project-sourced MCP servers are not disabled

- **WHEN** the profile declares `mcps` allowing only server A, while a trusted project's `.pi/mcp.json` defines server P
- **THEN** P does not appear in the instance's `mcp.json` and remains enabled and usable through Pi's own project read

#### Scenario: Empty MCP selection disables discovered user servers

- **WHEN** a named profile declares `mcps: []` and user-level configuration defines valid servers in more than one source
- **THEN** none of those servers can be connected or called, each is written with its complete definition and `enabled: false` in the instance, Pi reports no missing-transport error for them, and the source configuration files are unchanged

#### Scenario: Project-sourced server survives an empty selection

- **WHEN** a named profile declares `mcps: []` and a trusted project defines an enabled server
- **THEN** that project-owned server remains enabled and callable

#### Scenario: Tool restriction without a server whitelist

- **WHEN** a profile declares no `mcps`, but sets `mcp_tools` for an enabled user-level server
- **THEN** the instance carries that server's tool exposure restriction, and other user-level servers remain enabled with their configured exposure

#### Scenario: Empty MCP tool list remains restrictive

- **WHEN** an enabled user-level server is assigned `[]` in `mcp_tools`
- **THEN** the instance configuration prevents every tool on that server, including tools later discovered, while leaving its non-tool functions and user configuration files unchanged

## ADDED Requirements

### Requirement: MCP access entry points in generated settings

When a profile declares a `tools` selection and at least one MCP server is enabled in the active session, the generated instance settings SHALL make Pi's available MCP discovery entry points active even when the profile does not list them in `tools`. The authoritative set of Pi's MCP discovery entry points SHALL be Pi's own tool registry and MCP exposure behavior, not a profile-specific configuration field. A profile that disables all user-level MCP servers MUST NOT re-enable those servers by enabling discovery entry points. When `tools` is undeclared, Pi's own startup tool selection SHALL remain in control. Other non-MCP tools excluded by `tools` SHALL remain excluded.

#### Scenario: Native indirect entry points are available without explicit tools references

- **WHEN** a profile enables an MCP server and declares `tools: ["read"]` without listing Pi's MCP discovery entry points
- **THEN** its instance settings allow both native discovery entry points while the unrelated non-MCP tools excluded by `tools` remain inactive

#### Scenario: No enabled MCP server

- **WHEN** a profile disables every user-level MCP server and there is no enabled project-level MCP server
- **THEN** the instance settings do not enable MCP discovery entry points solely because disabled server definitions appear in the snapshot
