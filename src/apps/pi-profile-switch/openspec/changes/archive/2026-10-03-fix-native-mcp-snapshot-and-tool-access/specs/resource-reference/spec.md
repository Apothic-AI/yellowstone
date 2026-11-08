# Spec Delta

## MODIFIED Requirements

### Requirement: MCP server reference resolution

An MCP server reference's identity SHALL be a server name defined in the merged user-level MCP configuration snapshot. The snapshot SHALL merge by server name from the existing user-level source locations in their established precedence order (defer to the authoritative source list in `src/mcp-config.ts`); each later definition SHALL replace the earlier definition of the same server in full, without inheriting connection, credential, or exposure fields from the earlier definition.

Project-scope configuration SHALL NOT be part of the snapshot: servers defined in a trusted project's `.pi/mcp.json` SHALL be read by Pi itself and SHALL remain outside profile control.

When a profile explicitly declares `mcps` or names any server in `mcp_tools`, illegal configuration content required for discovery SHALL fail activation with an error identifying its file path; the system MUST NOT silently read it as "no servers". When neither field declares an effective MCP policy, illegal content in one user-level source SHALL be diagnosed with its file path without blocking activation; the valid sources SHALL still participate in the snapshot. Illegal content in a trusted project's classification source SHALL NOT block activation without an explicit MCP policy, and Pi SHALL retain ownership of its own project-file diagnostics.

When a profile declares a server name the snapshot does not define, activation SHALL fail with an error identifying the name and near-miss candidates. When `mcps` selects a user-level server explicitly disabled in its winning definition, activation SHALL fail naming the server and telling the user to enable it in the source configuration or remove it from the selection; the profile MUST NOT silently override the source setting. A profile that declares no MCP servers MUST NOT require every MCP source to be valid. An explicitly empty `mcps` list SHALL resolve to an empty server selection.

A server explicitly selected by `mcps` whose definition Pi's built-in MCP extension cannot use — for example the legacy SSE transport — SHALL fail activation with an error naming the server and a migration hint; the authoritative set of supported transports is defined by Pi's built-in MCP extension. A snapshot server not explicitly selected SHALL be passed through to the instance configuration without removing its connection definition, and Pi SHALL report its own configuration errors for it.

#### Scenario: Untrusted project's MCP configuration does not participate

- **WHEN** the project is untrusted and an MCP configuration file exists under the project directory
- **THEN** the servers in that file are not merged into the snapshot and the file is not read

#### Scenario: Illegal MCP configuration content

- **WHEN** a profile declares `mcps` and a user-level MCP configuration is not legal JSON, or is not an object
- **THEN** activation fails with an error identifying the file path, instead of reading it as "no servers"

#### Scenario: Invalid source without MCP policy

- **WHEN** a profile declares neither `mcps` nor any server in `mcp_tools`, one user-level source is malformed, and another contains a valid server definition
- **THEN** activation succeeds with a diagnostic naming the malformed file, and the valid server is present in the generated snapshot

#### Scenario: Malformed trusted-project classification without MCP policy

- **WHEN** a trusted project's MCP file is malformed and the profile declares no effective MCP policy
- **THEN** profile activation continues without merging that file into the user-level snapshot, while Pi handles its project-file diagnostic

#### Scenario: Empty tool policy does not demand valid configuration

- **WHEN** a profile has `mcp_tools: {}` and no `mcps`, and a user-level source is malformed
- **THEN** activation does not fail because of that file and reports its path

#### Scenario: Later user-level source overrides an earlier one per server name

- **WHEN** a later user-level source defines a server with a new URL but omits the earlier definition's authorization header
- **THEN** the snapshot uses the new definition without the earlier authorization header

#### Scenario: Project-owned server cannot be selected

- **WHEN** a trusted project's `.pi/mcp.json` defines server P and a profile names P in `mcps`
- **THEN** activation fails with an error explaining the project-scope boundary, and P remains enabled through Pi's own project read

#### Scenario: Unknown server name

- **WHEN** a profile declares a server name no user-level configuration defines
- **THEN** activation fails with an error identifying the name and near-miss candidates

#### Scenario: Explicitly selected server is disabled in source

- **WHEN** `mcps` selects a server whose winning user-level definition has `enabled: false`
- **THEN** activation fails naming that server and explaining how to enable it in the source or remove it from `mcps`

#### Scenario: Empty selection without any MCP extension

- **WHEN** a named profile declares `mcps: []` and no MCP extension is selected
- **THEN** resolution retains an empty server selection, activation does not fail for a missing extension, and no MCP availability is changed by the empty declaration

#### Scenario: Selected server uses a transport Pi cannot use

- **WHEN** a profile's `mcps` names a server whose definition uses a transport Pi's built-in MCP extension does not support
- **THEN** activation fails with an error naming the server and a migration hint

#### Scenario: Unselected server with a bad transport passes through

- **WHEN** a profile omits `mcps` and the merged snapshot contains a server whose definition Pi's built-in MCP extension does not support
- **THEN** activation succeeds, the server definition is written to the instance configuration unchanged, and Pi reports its own configuration error for it

### Requirement: Tool reference resolution

A `tools` reference's identity SHALL be Pi's non-MCP tool name. References SHALL be expanded against the non-MCP part of Pi's tool registry at that moment; the winner of a same-named registration SHALL determine whether a tool is MCP-owned. MCP-provided tools, including the Pi-provided entry points required to invoke them, MUST NOT be enabled or disabled solely by a profile's `tools` list. This rule SHALL apply to existing and new profiles alike. The available MCP entry points and their names SHALL defer to Pi's MCP tool-exposure behavior, rather than a profile-maintained inventory.

Before spawn, resolution SHALL expand only against built-in tool names, because tools contributed by extensions are unknowable until extension code runs. After session start, the extension SHALL re-expand the original references against the live registry that includes non-MCP extension tools. MCP tools available under the profile's MCP server and tool selections SHALL remain usable independently of `tools`.

When `tools` is undeclared, the resolution result MUST NOT contain a tools field and Pi's current available tool set SHALL remain unchanged, except when a declared per-server MCP tool restriction itself changes MCP availability. Pi's native MCP discovery behavior SHALL remain in control.

Literal tool references SHALL NOT be validated or recorded at resolution time; literals for which no non-MCP tool is provided SHALL be reported by the post-session-start expansion and MUST NOT be silently dropped. References that previously matched only MCP tools SHALL receive actionable migration guidance directing users to `mcp_tools`.

#### Scenario: Only built-in tools expanded before spawn

- **WHEN** a profile declares a glob that only matches extension-contributed tools
- **THEN** the pre-spawn resolution contains no results for that glob and does not fail because of it

#### Scenario: Live registry expansion after session start

- **WHEN** the session starts and the extension expands the original references against the live registry
- **THEN** globs cover non-MCP extension tools, and literals without a corresponding non-MCP tool are reported

#### Scenario: tools undeclared

- **WHEN** a profile does not declare `tools` and does not restrict MCP tools
- **THEN** the resolution result contains no tools field, and Pi's current non-MCP tool selection is not otherwise narrowed by the profile

#### Scenario: Existing tools list no longer excludes MCP

- **WHEN** an existing profile declares `tools: ["read"]` and an enabled MCP server offers `search`
- **THEN** `read` and the server's `search` tool are usable; other non-MCP tools absent from `tools` are not enabled by this profile

#### Scenario: Codemode access survives tools selection

- **WHEN** an enabled MCP server offers a tool reachable through Pi's codemode entry point and a profile declares `tools: ["read"]`
- **THEN** the model can invoke that MCP tool through the entry point without the profile also enabling unrelated non-MCP tools

#### Scenario: Deferred access survives tools selection

- **WHEN** an enabled MCP server offers a tool reachable through Pi's deferred discovery entry point and a profile declares `tools: []`
- **THEN** the model can discover and invoke that MCP tool through the entry point without other non-MCP tools becoming active

#### Scenario: Legacy MCP reference gives migration guidance

- **WHEN** a profile's `tools` references match only MCP-owned tools in the live registry
- **THEN** the reference no longer selects those tools and the user receives a diagnostic naming `mcp_tools` as the replacement
