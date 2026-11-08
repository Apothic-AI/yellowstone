# Spec Delta

## MODIFIED Requirements

### Requirement: Runtime overlay

The overlay SHALL apply only to the current runtime and MUST NOT be written to any catalog file.

The overlay SHALL be able to disable skills, extensions, MCP servers, and tools, through one uniform grammar: `/profile overlay disable|enable skill|extension|mcp|tool <name-or-glob>`. For tools, the set an entry disables from SHALL be the profile's resolved tool references when the profile declares `tools`, and the runtime's available tool set when it does not.

Disable entries SHALL be names or globs, stored as written and re-expanded at every resolution. An unmatched literal SHALL fail and identify the entry. A zero-match glob SHALL NOT fail; it SHALL be surfaced as a warning, following the failure tiering of profile references (ADR-0009).

`/profile overlay disable|enable` SHALL first re-resolve with the candidate overlay (validation happens here), then switch and reload, and only then write the overlay to the state file. When the switch fails, the stored overlay SHALL remain unchanged.

`enable` SHALL remove a stored entry by exact string match; when no stored entry matches, it SHALL fail listing the current entries of that kind.

`/profile overlay clear` SHALL first switch and reload without the overlay, then delete the overlay from the state file. When the switch rolls back, the stored overlay SHALL still match the restored runtime.

Startup SHALL ignore a stored overlay: an overlay MUST NOT survive across runtimes.

The `default` profile does not filter by default. When narrowed by an overlay it SHALL become an "all resources minus the disabled entries" selection, so its skills, extensions, and tools can all be disabled. MCP disabling on the `default` profile SHALL be rejected — it has no MCP whitelist to narrow.

#### Scenario: Overlay does not touch the catalog

- **WHEN** `/profile overlay disable skill git-commit` is executed
- **THEN** that skill is no longer active in the current runtime and the catalog file content is unchanged

#### Scenario: Disabling an unresolved resource

- **WHEN** disabling a literal skill, extension, MCP server, or tool name that the current profile has not resolved
- **THEN** the operation fails with an error identifying the entry

#### Scenario: Disabling a tool narrows the active tool set

- **WHEN** `/profile overlay disable tool bash` is executed
- **THEN** `bash` is no longer part of the active tool set in the current runtime

#### Scenario: Tool disable on a profile without declared tools

- **WHEN** the active profile declares no `tools` and `/profile overlay disable tool bash` is executed
- **THEN** the runtime's available tool set minus `bash` becomes active

#### Scenario: Removed tools replace-form is rejected

- **WHEN** `/profile overlay tools read grep` is executed
- **THEN** the operation is rejected with the overlay usage note, and the stored overlay is unchanged

#### Scenario: Zero-match glob succeeds with a warning

- **WHEN** `/profile overlay disable skill git-*` matches no resolved skill
- **THEN** the entry is stored, the operation succeeds, and a warning reports the zero-match glob

#### Scenario: Stored glob is re-expanded on reload

- **WHEN** the overlay stores `git-*` and a later reload resolves a new skill matching that glob
- **THEN** the re-expanded overlay disables the new skill as well

#### Scenario: Enable removes a stored entry

- **WHEN** the stored overlay disables `git-*` and `/profile overlay enable skill git-*` is executed
- **THEN** the entry is removed and the matching resources become active again

#### Scenario: Enable without a matching stored entry

- **WHEN** `/profile overlay enable skill git-commit` is executed and no stored skill entry equals that string
- **THEN** the operation fails listing the current skill disable entries

#### Scenario: Reset restores the definition

- **WHEN** `/profile overlay clear` is executed while an overlay exists
- **THEN** the runtime returns to the profile definition's content and the overlay is deleted from the state file

#### Scenario: MCP disabling on the default profile is rejected

- **WHEN** an overlay disabling some MCP server is applied to the `default` profile
- **THEN** the operation fails with an error explaining that the profile has no MCP whitelist to narrow

### Requirement: Plan application and change summary at session start

Every session start (launch, reload, new, resume, fork) SHALL apply the plan in the current runtime directory: expand the profile's original tool references against Pi's live tool registry at that moment, and set the expansion result as the active tool set.

When the plan carries disabled tool entries from the overlay, the active tool set SHALL be the expansion of the base — the profile's tool references, or the live registry when the profile declares none — minus the tools matched by the disabled entries at that moment.

Tool literals with zero matches against the live registry SHALL be reported as warnings and MUST NOT be silently dropped.

When the plan marks the selection for persistence and this session start was triggered by a reload, the active profile SHALL be written to the state file of that profile's source scope.

The change summary produced by a switch SHALL be injected into the next agent turn and SHALL appear exactly once: the mark is cleared after injection and later reloads do not repeat it.

#### Scenario: Tools whitelist re-applied after reload

- **WHEN** the new extension instance executes session start after reload
- **THEN** the active tool set is reset to the original references expanded against the live registry

#### Scenario: Disabled tools stay disabled across reload

- **WHEN** the overlay has disabled a tool and a reload occurs
- **THEN** the tool is absent from the active tool set after session start re-applies the plan

#### Scenario: Change summary appears exactly once

- **WHEN** `/profile reload` is executed after a successful switch
- **THEN** only the first turn after the switch receives the change summary

#### Scenario: State write does not overwrite the overlay

- **WHEN** the post-reload instance writes the active profile per the plan
- **THEN** an overlay already in the state file remains unchanged, unless this switch explicitly requested discarding it
