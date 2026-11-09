# Spec Delta

## MODIFIED Requirements

### Requirement: Rollback on switch failure

When rewriting runtime files or reloading fails, the runtime files from the snapshot SHALL be restored and the failure cause reported. If a reload was attempted or Pi might have observed rewritten files, the restored files SHALL be reloaded. The runtime MUST NOT remain in a half-switched state.

Pi's interactive mode may swallow a reload rejection or failure without reporting it. A switch SHALL therefore verify after reload that it actually executed; when that cannot be proven, it SHALL be treated as a failure and rolled back.

Restoration SHALL reproduce the snapshot exactly: nonexistence, symlink targets, file content, and permission bits are all restored, and writes MUST NOT go through leftover symlinks into link targets.

Persistence of selection and overlay SHALL happen in the post-reload extension instance, so rollback MUST NOT need to undo state-file writes.

#### Scenario: Reload throws

- **WHEN** reload throws an error
- **THEN** the runtime files are restored to their pre-switch content and reloaded again, and the error states that the target profile failed to activate and why

#### Scenario: Reload silently skipped

- **WHEN** reload neither errors nor actually re-executes the extension
- **THEN** it is treated as a failure and rolled back, reporting that reload did not execute

#### Scenario: Write fails after one managed file changes

- **WHEN** switching a profile changes a managed runtime file and a later write fails before reload
- **THEN** every managed runtime file is restored to its exact pre-switch state, selection and overlay remain unchanged, and the failed profile is not reported as active

### Requirement: Session-start plan application and change summary

Every session start (launch, reload, new, resume, fork) SHALL apply the plan in the current runtime directory. When `tools` is declared, the active tool set SHALL combine its original references expanded against Pi's live non-MCP registry with the MCP-owned tools available under the server and per-server tool selections, plus the native entry points needed to reach enabled MCP tools. When `tools` is absent, Pi's current tool availability SHALL stay unchanged; overlay disabled tool entries still narrow their established base. An absent or empty `mcp_tools` object MUST NOT by itself change Pi's tool state.

When the plan carries disabled tool entries from the overlay, the active tool set SHALL subtract their matches at that moment. The base for overlay resolution SHALL remain the profile's resolved Pi tool references when `tools` is declared, or the runtime's available tool set when it is not; per-server MCP tool filtering SHALL be governed by `mcp_tools` and server selection.

Pi tool literals with zero matches against the applicable live registry SHALL be reported as warnings and MUST NOT be silently dropped. Literal selectors in `mcp_tools` SHALL remain restrictive without a missing-name diagnostic, as specified in "Per-server MCP tool selection" in the resource-reference specification.

When the plan marks the selection for persistence and this session start was triggered by a reload, the active profile SHALL be written to the state file of that profile's source scope.

The change summary produced by a switch SHALL be injected into the next agent turn and SHALL appear exactly once: the mark is cleared after injection and later reloads do not repeat it.

#### Scenario: Tools whitelist re-applied after reload

- **WHEN** the new extension instance executes session start after reload
- **THEN** the active non-MCP tool set is reset to the original references expanded against the live registry, while available MCP-owned tools and their native discovery entry points remain independent of those references

#### Scenario: Built-in MCP extension does not own sibling extension tools

- **WHEN** a profile declares `tools: []`, MCP servers provide tools through Pi's built-in MCP extension, and an unrelated extension registers a tool
- **THEN** the unrelated extension's tool is not active after session start or reload, while MCP tools permitted by MCP policy and their native discovery entry points remain available

#### Scenario: Codemode and deferred access after switch

- **WHEN** the session switches to a profile with `tools: ["read"]` and an enabled server has tools reachable through Pi's codemode or deferred discovery entry points
- **THEN** the model can use both kinds of MCP tool after reload without `tools` explicitly listing either entry point

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
