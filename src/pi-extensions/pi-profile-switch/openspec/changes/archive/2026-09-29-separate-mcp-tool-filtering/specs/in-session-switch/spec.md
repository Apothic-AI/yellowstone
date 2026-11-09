# Spec Delta

## MODIFIED Requirements

### Requirement: Plan application and change summary at session start

Every session start (launch, reload, new, resume, fork) SHALL apply the plan in the current runtime directory. When `tools` is declared, the active tool set SHALL combine its original references expanded against Pi's live non-MCP registry with the MCP-owned tools available under the server and per-server tool selections. When `tools` is absent, Pi's current non-MCP tool availability SHALL stay unchanged; overlay disabled tool entries still narrow their established base. An absent or empty `mcp_tools` object MUST NOT by itself change Pi's tool state.

When the plan carries disabled tool entries from the overlay, the active tool set SHALL subtract their matches at that moment. The base for overlay resolution SHALL remain the profile's resolved Pi tool references when `tools` is declared, or the runtime's available tool set when it is not; per-server MCP tool filtering SHALL be governed by `mcp_tools` and server selection.

Pi tool literals with zero matches against the applicable live registry SHALL be reported as warnings and MUST NOT be silently dropped. Literal adapter selectors in `mcp_tools` SHALL retain the adapter's restrictive matching without a missing-name diagnostic, as specified in "Per-server MCP tool reference resolution" in the resource-reference specification.

When the plan marks the selection for persistence and this session start was triggered by a reload, the active profile SHALL be written to the state file of that profile's source scope.

The change summary produced by a switch SHALL be injected into the next agent turn and SHALL appear exactly once: the mark is cleared after injection and later reloads do not repeat it.

#### Scenario: Tools whitelist re-applied after reload

- **WHEN** the new extension instance executes session start after reload
- **THEN** the active non-MCP tool set is reset to the original references expanded against the live registry, while available MCP-owned tools remain independent of those references

#### Scenario: Loose adapter file does not own sibling extension tools

- **WHEN** the selected MCP adapter is a loose extension file beside an unrelated extension that registers a tool, and the profile declares `tools: []`
- **THEN** the unrelated tool is not active after session start or reload, while adapter-owned tools permitted by MCP policy remain available

#### Scenario: Disabled tools stay disabled across reload

- **WHEN** the overlay has disabled a tool and a reload occurs
- **THEN** the tool is absent from the active tool set after session start re-applies the plan

#### Scenario: Change summary appears exactly once

- **WHEN** `/profile reload` is executed after a successful switch
- **THEN** only the first turn after the switch receives the change summary

#### Scenario: State write does not overwrite the overlay

- **WHEN** the post-reload instance writes the active profile per the plan
- **THEN** an overlay already in the state file remains unchanged, unless this switch explicitly requested discarding it

#### Scenario: Profile switch changes per-server MCP tool policy

- **WHEN** `/profile use review` switches from a profile allowing all `github` tools to one listing only `search`
- **THEN** the existing Pi session retains its identity and history, and `github` tools other than `search` are no longer callable, including via indirect MCP calls

#### Scenario: Empty MCP list survives reload

- **WHEN** a profile with `mcp_tools: { "github": [] }` reloads
- **THEN** the server remains enabled and no `github` tool becomes callable after the reload

## ADDED Requirements

### Requirement: MCP tool policy observability and switch rollback

`/profile status` SHALL show which enabled servers have unrestricted, explicitly restricted, or no MCP tools, including the declared selectors for explicitly restricted servers; it SHALL NOT report selector validity or missing-name candidates. When `mcps` is undeclared, a server marked disabled by the effective adapter configuration SHALL appear as discovered but not enabled, rather than enabled. A switch or reload failure while applying a per-server restriction SHALL restore the previous MCP and Pi tool availability, not leave a partial policy.

#### Scenario: Status distinguishes absent and empty lists

- **WHEN** an active profile omits `github` from `mcp_tools` and explicitly sets `linear` to `[]`
- **THEN** `/profile status` reports `github` as unrestricted and `linear` as having no enabled MCP tools

#### Scenario: Status respects adapter-disabled servers without an MCP whitelist

- **WHEN** `mcps` is undeclared and the effective adapter configuration marks `linear` disabled while `github` is enabled
- **THEN** `/profile status` reports `github` as enabled and `linear` as discovered but not enabled, without listing `linear` as an unrestricted enabled server

#### Scenario: Failed switch restores previous tool policy

- **WHEN** a profile switch fails during reload after writing a different per-server tool policy
- **THEN** the prior runtime files and tool availability are restored, and the cause is reported
