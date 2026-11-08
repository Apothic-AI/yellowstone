# Spec Delta

## MODIFIED Requirements

### Requirement: Unified failure tiering for references

Reference resolution SHALL be tiered by error certainty and MUST NOT silently drop any reference.

An unmatched literal SHALL fail activation. A zero-match glob SHALL be collected as a warning item, visible in launch output and status queries, without blocking activation.

Pi tool references are the exception: they are unknowable before spawn, so they neither fail on a pre-spawn miss nor get recorded as warning items. After session start, missing Pi tool literals SHALL be reported. Literal MCP tool selectors in `mcp_tools` are restrictive policy inputs rather than pre-spawn-resolvable references; they SHALL remain in the policy without a missing-name diagnostic, as specified in "Per-server MCP tool selection".

#### Scenario: Different outcomes for literals and globs

- **WHEN** a profile references both a nonexistent literal skill name and a zero-match skill glob
- **THEN** activation fails because of the literal, while the glob itself only produces a warning item

## REMOVED Requirements

### Requirement: MCP server reference resolution and the adapter dependency

**Reason**: `pi-mcp-adapter` is no longer supported. MCP server resolution now happens against the merged user-level configuration snapshot; server selection no longer depends on an adapter being active. The replacement contract is the ADDED requirement "MCP server reference resolution".

**Migration**: Profiles declaring `mcps` no longer need to select an adapter extension. The standard user-level configuration locations continue to be read and are merged into the instance configuration at launch and on switch; server names must be defined in one of the user-level locations.

### Requirement: Per-server MCP tool reference resolution

**Reason**: The contract's core is the adapter's literal tool-selector matching (original or prefixed names), adapter-side restrictions, and the unsafe-intersection failure — all adapter semantics that disappear with the adapter. With native Pi, restriction is expressed as per-server tool exposure and selectors are literal registered tool names.

**Migration**: Profiles keep declaring `mcp_tools` with the same field shape. Selectors must now be the tools' literal registered names; adapter-era prefixed aliases no longer match. The replacement contract is the ADDED requirement "Per-server MCP tool selection".

## ADDED Requirements

### Requirement: MCP server reference resolution

An MCP server reference's identity SHALL be a server name defined in the merged user-level MCP configuration snapshot. The snapshot SHALL merge, by server name, the standard user-level configuration locations — `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, and the real agent directory's `mcp.json` — with later locations in that list overriding earlier ones per server name.

Project-scope configuration SHALL NOT be part of the snapshot: servers defined in a trusted project's `.pi/mcp.json` SHALL be read by Pi itself and SHALL remain outside profile control.

When any merged configuration content is illegal, the system SHALL report an error identifying the file path and MUST NOT silently read it as "no servers". When a profile declares a server name the snapshot does not define, activation SHALL fail with an error identifying the name and near-miss candidates.

A profile that declares no MCP servers MUST NOT depend on any MCP configuration content. An explicitly empty `mcps` list SHALL resolve to an empty server selection.

A server explicitly selected by `mcps` whose definition Pi's built-in MCP extension cannot use — for example the legacy SSE transport — SHALL fail activation with an error naming the server and a migration hint; the authoritative set of supported transports is defined by Pi's built-in MCP extension. A snapshot server not explicitly selected SHALL be passed through to the instance configuration unchanged, and Pi SHALL report its own configuration errors for it.

#### Scenario: Untrusted project's MCP configuration does not participate

- **WHEN** the project is untrusted and an MCP configuration file exists under the project directory
- **THEN** the servers in that file are not merged into the snapshot and the file is not read

#### Scenario: Illegal MCP configuration content

- **WHEN** an MCP configuration at a user-level location is not legal JSON, or is not an object
- **THEN** an error is reported identifying the file path, instead of reading it as "no servers"

#### Scenario: Later user-level source overrides an earlier one per server name

- **WHEN** a server name appears in `~/.agents/mcp.json` and in the real agent directory's `mcp.json` with different definitions
- **THEN** the snapshot carries the real agent directory's definition, because it is the later source in the merge order

#### Scenario: Project-owned server cannot be selected

- **WHEN** a trusted project's `.pi/mcp.json` defines server P and a profile names P in `mcps`
- **THEN** activation fails with an error explaining the project-scope boundary, and P remains enabled through Pi's own project read

#### Scenario: Unknown server name

- **WHEN** a profile declares a server name no user-level configuration defines
- **THEN** activation fails with an error identifying the name and near-miss candidates

#### Scenario: Empty selection without any MCP extension

- **WHEN** a named profile declares `mcps: []` and no MCP extension is selected
- **THEN** resolution retains an empty server selection, activation does not fail for a missing extension, and no MCP availability is changed by the empty declaration

#### Scenario: Selected server uses a transport Pi cannot use

- **WHEN** a profile's `mcps` names a server whose definition uses a transport Pi's built-in MCP extension does not support
- **THEN** activation fails with an error naming the server and a migration hint

#### Scenario: Unselected server with a bad transport passes through

- **WHEN** a profile omits `mcps` and the merged snapshot contains a server whose definition Pi's built-in MCP extension does not support
- **THEN** activation succeeds, the server definition is written to the instance configuration unchanged, and Pi reports its own configuration error for it

### Requirement: Per-server MCP tool selection

`mcp_tools` SHALL narrow tools within each explicitly named MCP server, independently of the Pi `tools` field, by exposing only tools matched by the listed selectors and hiding all others. A selector SHALL be a literal tool name as registered by Pi's built-in MCP extension; prefixed or aliased selector spellings from the adapter era SHALL NOT match. The profile-catalog field contract defines which literals are accepted.

A server not named in `mcp_tools` SHALL retain its configured tool availability. An empty object SHALL change nothing. A server mapped to an empty list SHALL offer no callable MCP tools while remaining an enabled server; a nonempty list SHALL permit only tools matched by listed selectors. The profile's per-server policy SHALL replace the server's tool exposure from the merged configuration wholesale: a tool the merged configuration hides SHALL become available only when a selector matches it.

Every server key SHALL resolve to an enabled user-level server in the merged configuration snapshot; an unknown, disabled, or project-only server SHALL fail activation with an error naming the server and usable candidates or the project-scope boundary. An absent or empty `mcp_tools` object SHALL introduce no MCP configuration dependency.

Literal selectors in `mcp_tools` SHALL NOT be checked against a server's tool list or produce missing-name notifications or validation status. A selector matching no tool SHALL remain restrictive: it MUST NOT silently become an unrestricted server. The resulting restriction SHALL hold for direct tools and indirect routes through MCP gateways, proxies, and scripts, including tools added after the initial session start.

#### Scenario: Missing server key defaults to all tools

- **WHEN** an enabled `github` server offers `search` and `delete`, and `mcp_tools` has no `github` entry
- **THEN** both tools remain available, subject to the server's configured tool exposure, regardless of the profile's `tools` list

#### Scenario: Explicit per-server whitelist

- **WHEN** `mcp_tools` sets `github` to `["search"]` and the server offers `search` and `delete`
- **THEN** only `search` is available through direct and indirect MCP tool invocation; `delete` is not exposed or callable

#### Scenario: Prefixed adapter alias no longer matches

- **WHEN** server `fixture` registers original tool `search` and `mcp_tools` sets `fixture` to `["fixture_search"]`, the adapter-era prefixed spelling
- **THEN** no `fixture` tool is exposed, because a selector must be the tool's literal registered name; the restriction remains in force without a missing-name diagnostic

#### Scenario: Empty server list denies all tools

- **WHEN** `mcp_tools` sets `github` to `[]`
- **THEN** no tool offered by `github` can be exposed or called, while the server remains enabled for its non-tool functions

#### Scenario: Server name typo fails before activation

- **WHEN** `mcp_tools` names a server absent from the merged user-level snapshot
- **THEN** activation fails with the name and usable server candidates

#### Scenario: Special-looking unknown server is not discovered

- **WHEN** `mcp_tools` names `toString` or `__proto__` but no such server was defined in the merged snapshot
- **THEN** activation fails with that server name and usable candidates instead of treating the key as implicitly present

#### Scenario: Unmatched literal selector stays restrictive without a diagnosis

- **WHEN** `mcp_tools` lists `serach` for `github` but no registered `github` tool has that name
- **THEN** `search` remains unavailable through direct and indirect MCP tool calls, and the user receives no tool-name validation warning or missing-name status

#### Scenario: Profile policy replaces merged tool exposure

- **WHEN** the merged configuration hides one of a server's tools and `mcp_tools` lists a selector matching that tool
- **THEN** that tool becomes available through direct and indirect MCP tool calls, and every unlisted tool on the server is hidden

#### Scenario: Project-only server is outside the narrowing boundary

- **WHEN** `mcp_tools` names a server defined only by trusted project configuration
- **THEN** activation fails with an explanation that a profile cannot narrow that project-level server, and the project server is unchanged
