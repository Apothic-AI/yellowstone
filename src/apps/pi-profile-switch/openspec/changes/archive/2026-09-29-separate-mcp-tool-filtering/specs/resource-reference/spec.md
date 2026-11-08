# Spec Delta

## MODIFIED Requirements

### Requirement: Tool reference resolution

A `tools` reference's identity SHALL be Pi's non-MCP tool name. References SHALL be expanded against the non-MCP part of Pi's tool registry at that moment; the winner of a same-named registration SHALL determine whether a tool is MCP-owned. MCP-provided tools, including the available ways to invoke them, MUST NOT be enabled or disabled by a profile's `tools` list. This rule SHALL apply to existing and new profiles alike.

Before spawn, resolution SHALL expand only against built-in tool names, because tools contributed by extensions are unknowable until extension code runs. After session start, the extension SHALL re-expand the original references against the live registry that includes non-MCP extension tools. MCP tools available under the profile's MCP server and tool selections SHALL remain usable independently of `tools`.

When `tools` is undeclared, the resolution result MUST NOT contain a tools field and Pi's current available tool set SHALL remain unchanged, except when a declared per-server MCP tool restriction itself changes MCP availability.

Literal tool references SHALL NOT be validated or recorded at resolution time; literals for which no non-MCP tool is provided SHALL be reported by the post-session-start expansion and MUST NOT be silently dropped. References that previously matched only MCP tools SHALL receive actionable migration guidance directing users to `mcp_tools`.

#### Scenario: Only built-in tools expanded before spawn

- **WHEN** a profile declares a glob that only matches extension-contributed tools
- **THEN** the pre-spawn resolution contains no results for that glob and does not fail because of it

#### Scenario: Live registry expansion after session start

- **WHEN** the session starts and the extension expands the original references against the live registry
- **THEN** globs cover non-MCP extension tools, and literals without a corresponding non-MCP tool are reported

#### Scenario: tools undeclared

- **WHEN** a profile does not declare `tools` and does not restrict MCP tools
- **THEN** the resolution result contains no tools field and Pi's current available tool set is not modified

#### Scenario: Existing tools list no longer excludes MCP

- **WHEN** an existing profile declares `tools: ["read"]` and an enabled MCP server offers `search`
- **THEN** `read` and the server's `search` tool are usable; other non-MCP tools absent from `tools` are not enabled by this profile

#### Scenario: Legacy MCP reference gives migration guidance

- **WHEN** a profile's `tools` references match only MCP-owned tools in the live registry
- **THEN** the reference no longer selects those tools and the user receives a diagnostic naming `mcp_tools` as the replacement

### Requirement: Unified failure tiering for references

Reference resolution SHALL be tiered by error certainty and MUST NOT silently drop any reference.

An unmatched literal SHALL fail activation. A zero-match glob SHALL be collected as a warning item, visible in launch output and status queries, without blocking activation.

Pi tool references are the exception: they are unknowable before spawn, so they neither fail on a pre-spawn miss nor get recorded as warning items. After session start, missing Pi tool literals SHALL be reported. Literal adapter selectors in `mcp_tools` are restrictive policy inputs rather than pre-spawn-resolvable references; they SHALL remain in the policy without a missing-name diagnostic.

#### Scenario: Different outcomes for literals and globs

- **WHEN** a profile references both a nonexistent literal skill name and a zero-match skill glob
- **THEN** activation fails because of the literal, while the glob itself only produces a warning item

## ADDED Requirements

### Requirement: Per-server MCP tool reference resolution

`mcp_tools` SHALL narrow tools within each explicitly named MCP server using the active adapter's literal tool-selector matching, independently of the Pi `tools` field. The profile-catalog field contract defines which literals are accepted; the adapter MAY match a tool by its original or prefixed name. A server not named in `mcp_tools` SHALL retain its normal tool availability. An empty object SHALL change nothing. A server mapped to an empty list SHALL offer no callable MCP tools while remaining an enabled server; a nonempty list SHALL permit only tools matched by listed selectors. Adapter-side restrictions already placed on a server MUST NOT be widened.

Every server key SHALL resolve to a discovered, profile-controllable, enabled server; an unknown, disabled, or project-only server SHALL fail activation with an error naming the server and usable candidates or the project-scope boundary. A nonempty `mcp_tools` declaration SHALL require an active MCP adapter; an absent or empty `mcp_tools` object SHALL introduce no adapter dependency.

Literal selectors in `mcp_tools` SHALL NOT be checked against a server's tool list or produce missing-name notifications or validation status. A selector matching no tool SHALL remain restrictive: it MUST NOT silently become an unrestricted server. Existing adapter exclusions SHALL continue to apply. If an existing adapter allowlist and the profile policy cannot be combined without potentially widening the former, activation SHALL fail with an actionable error naming the server before writing runtime files. The resulting restriction SHALL hold for direct tools and indirect routes through MCP gateways, proxies, and scripts, including tools added after the initial session start.

#### Scenario: Missing server key defaults to all tools

- **WHEN** an enabled `github` server offers `search` and `delete`, and `mcp_tools` has no `github` entry
- **THEN** both tools remain available, subject to the server's existing restrictions, regardless of the profile's `tools` list

#### Scenario: Explicit per-server whitelist

- **WHEN** `mcp_tools` sets `github` to `["search"]` and the server offers `search` and `delete`
- **THEN** only `search` is available through direct and indirect MCP tool invocation; `delete` is not exposed or callable

#### Scenario: Prefixed literal follows adapter matching

- **WHEN** server `fixture` offers original tool `search`, the adapter recognizes `fixture_search` as a name for that tool, and `mcp_tools` sets `fixture` to `["fixture_search"]`
- **THEN** `search` is available through direct and indirect MCP tool invocation because the literal selector matches it; tools not matched by that selector remain unavailable

#### Scenario: Empty server list denies all tools

- **WHEN** `mcp_tools` sets `github` to `[]`
- **THEN** no tool offered by `github` can be exposed or called, while the server remains enabled for its non-tool functions

#### Scenario: Server name typo fails before activation

- **WHEN** `mcp_tools` names a server absent from the discovered and enabled profile-controllable servers
- **THEN** activation fails with the name and usable server candidates

#### Scenario: Special-looking unknown server is not discovered

- **WHEN** `mcp_tools` names `toString` or `__proto__` but no such server was discovered
- **THEN** activation fails with that server name and usable candidates instead of treating the key as implicitly present

#### Scenario: Unmatched literal selector stays restrictive without a diagnosis

- **WHEN** `mcp_tools` lists `serach` for `github` but the adapter matches no offered tool to that selector, regardless of whether its complete tool list has been discovered
- **THEN** `search` remains unavailable through direct and indirect MCP tool calls, and the user receives no tool-name validation warning or missing-name status

#### Scenario: Existing adapter restrictions are not widened

- **WHEN** the adapter already excludes an MCP tool and `mcp_tools` lists a selector matching that tool
- **THEN** the tool remains unavailable, and the restriction does not silently become permission to invoke it

#### Scenario: Unsafe allowlist intersection fails before runtime writes

- **WHEN** an existing adapter `includeTools` and the profile's literal selectors use different spellings that could match the same tool or collide with another tool's name
- **THEN** activation fails with the server name and an unsafe-intersection explanation before runtime files are written, rather than replacing the adapter's restriction with a potentially wider one

#### Scenario: Project-only server is outside the narrowing boundary

- **WHEN** `mcp_tools` names a server defined only by trusted project configuration
- **THEN** activation fails with an explanation that a profile cannot narrow that project-level server, and the project server is unchanged
