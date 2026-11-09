# Spec Delta

## Purpose

Defines the behavior of the `/profile` command family inside the Pi process: how switching replaces resources without restarting the process, how failures return to the pre-switch state, the overlay's scope and lifecycle, and where runtime state is written.

## ADDED Requirements

### Requirement: /profile command family and mode gating

`/profile` SHALL accept these subcommands: bare invocation (opens the selector), `use`, `reload`, `customize`, `reset`, `list`, `status`, `create`, `edit`, `delete`, `duplicate`.

Unknown subcommands SHALL be rejected with a usage note. `use` without a name, and `edit` and `delete` without a name, SHALL be rejected with that subcommand's usage.

`create`, `edit`, `delete`, and `duplicate` SHALL be available only in TUI mode; in other modes they SHALL be rejected with an error stating the current mode.

`use`, `reload`, `customize`, `reset`, `list`, `status`, and bare invocation SHALL also be available in non-TUI modes.

#### Scenario: CRUD rejected in non-TUI mode

- **WHEN** `/profile create` is executed in RPC mode
- **THEN** the operation is rejected, the error states that the subcommand requires TUI mode and gives the current mode name, and no catalog is modified

#### Scenario: Unknown subcommand

- **WHEN** `/profile frobnicate` is executed
- **THEN** the operation is rejected and a usage note is printed

### Requirement: In-session switching

`/profile use <name>` SHALL execute in order: wait for the current agent turn to finish, snapshot the runtime files, re-resolve the target profile through the full launch path, rewrite the runtime files in place, and trigger Pi's native reload.

Waiting SHALL use Pi's native idle wait and MUST NOT interrupt an in-flight turn.

Re-resolution SHALL include the same validation as the launch path: trust determination, catalog read, resource discovery, model and MCP validation. When resolution fails, NO runtime file SHALL be written and the runtime stays in its pre-switch state.

Switching SHALL NOT restart the Pi process; the current session's sessionId and message history SHALL remain unchanged.

`/profile use` SHALL persist the selection and SHALL discard the pre-switch profile's overlay.

`/profile reload` SHALL follow the same path, but SHALL NOT produce a change summary and SHALL preserve the current profile's existing selection persistence (a one-shot selection made at launch remains one-shot after reload).

#### Scenario: Successful switch

- **WHEN** `/profile use implement` is executed and both resolution and reload succeed
- **THEN** the runtime files are rewritten with that profile's resolution result and the session is not interrupted

#### Scenario: Failure at resolution stage

- **WHEN** the target profile's references cannot resolve
- **THEN** the operation fails reporting the cause, and no runtime file is modified

#### Scenario: Reload preserves one-shot selection

- **WHEN** launched as `pi-profile review` (one-shot selection), followed by `/profile reload`
- **THEN** `review` is still running and the selection is not thereby written into runtime state

### Requirement: Rollback on switch failure

When reload fails, the runtime files from the snapshot SHALL be restored and reloaded again, then the failure cause reported. The runtime MUST NOT remain in a half-switched state.

Pi's interactive mode may swallow a reload rejection or failure without reporting it. A switch SHALL therefore verify after reload that it actually executed; when that cannot be proven, it SHALL be treated as a failure and rolled back.

Restoration SHALL reproduce the snapshot exactly: nonexistence, symlink targets, file content, and permission bits are all restored, and writes MUST NOT go through leftover symlinks into link targets.

Persistence of selection and overlay SHALL happen in the post-reload extension instance, so rollback MUST NOT need to undo state-file writes.

#### Scenario: Reload throws

- **WHEN** reload throws an error
- **THEN** the runtime files are restored to their pre-switch content and reloaded again, and the error states that the target profile failed to activate and why

#### Scenario: Reload silently skipped

- **WHEN** reload neither errors nor actually re-executes the extension
- **THEN** it is treated as a failure and rolled back, reporting that reload did not execute

### Requirement: Plan application and change summary at session start

Every session start (launch, reload, new, resume, fork) SHALL apply the plan in the current runtime directory: expand the profile's original tool references against Pi's live tool registry at that moment, and set the expansion result as the active tool set.

Tool literals with zero matches against the live registry SHALL be reported as warnings and MUST NOT be silently dropped.

When the plan marks the selection for persistence and this session start was triggered by a reload, the active profile SHALL be written to the state file of that profile's source scope.

The change summary produced by a switch SHALL be injected into the next agent turn and SHALL appear exactly once: the mark is cleared after injection and later reloads do not repeat it.

#### Scenario: Tools whitelist re-applied after reload

- **WHEN** the new extension instance executes session start after reload
- **THEN** the active tool set is reset to the original references expanded against the live registry

#### Scenario: Change summary appears exactly once

- **WHEN** `/profile reload` is executed after a successful switch
- **THEN** only the first turn after the switch receives the change summary

#### Scenario: State write does not overwrite the overlay

- **WHEN** the post-reload instance writes the active profile per the plan
- **THEN** an overlay already in the state file remains unchanged, unless this switch explicitly requested discarding it

### Requirement: Runtime overlay

The overlay SHALL apply only to the current runtime and MUST NOT be written to any catalog file.

The overlay SHALL be able to disable skills, extensions, and MCP servers already resolved by the current profile, and to replace the tool reference set.

Disabling a resource not resolved by the current profile SHALL fail and identify the name.

`/profile customize` SHALL first re-resolve with the candidate overlay (validation happens here), then switch and reload, and only then write the overlay to the state file. When the switch fails, the stored overlay SHALL remain unchanged.

`/profile reset` SHALL first switch and reload without the overlay, then delete the overlay from the state file. When the switch rolls back, the stored overlay SHALL still match the restored runtime.

Startup SHALL ignore a stored overlay: an overlay MUST NOT survive across runtimes.

The `default` profile does not filter by default. When narrowed by an overlay it SHALL become an "all resources minus the disabled entries" selection, so its skills, extensions, and tools can all be disabled. MCP disabling on the `default` profile SHALL be rejected — it has no MCP whitelist to narrow.

#### Scenario: Overlay does not touch the catalog

- **WHEN** `/profile customize disable skill git-commit` is executed
- **THEN** that skill is no longer active in the current runtime and the catalog file content is unchanged

#### Scenario: Disabling an unresolved resource

- **WHEN** disabling a skill, extension, or MCP server that the current profile has not resolved
- **THEN** the operation fails with an error identifying the name

#### Scenario: Reset restores the definition

- **WHEN** `/profile reset` is executed while an overlay exists
- **THEN** the runtime returns to the profile definition's content and the overlay is deleted from the state file

#### Scenario: MCP disabling on the default profile is rejected

- **WHEN** an overlay disabling some MCP server is applied to the `default` profile
- **THEN** the operation fails with an error explaining that the profile has no MCP whitelist to narrow

### Requirement: Runtime state

Runtime state SHALL live in a state file: `<projectDir>/.pi/pi-profile-state.json` for project scope, and `pi-profile-state.json` under the workspace root for global scope.

The write location SHALL be decided by the active profile's source scope; the built-in `default` SHALL count as global scope.

State SHALL hold two items — the active profile and the overlay — updatable independently: writing one MUST NOT erase the other.

A missing or corrupt state file SHALL be read as empty state and MUST NOT produce an error. Other read failures SHALL propagate.

#### Scenario: Updating the active profile preserves the overlay

- **WHEN** state already holds an overlay and a switch then updates only the active profile
- **THEN** the overlay is still in the state

#### Scenario: Corrupt state file

- **WHEN** the state file's content is not legal JSON
- **THEN** the read yields empty state and neither launch nor switching fails because of it

### Requirement: Observability surface

Bare `/profile` SHALL open the interactive selector; when the environment has no interactive UI it SHALL degrade to printing the profile list.

`/profile list` SHALL list only visible profiles and SHALL use the same trust gating as activation: profiles from an untrusted project MUST NOT appear.

Each list entry SHALL report the winning definition's source and be marked when the project definition shadows a same-named global definition.

`/profile status` SHALL report the active profile, the stored overlay, resolved resources and paths, the MCP server tri-state (enabled, discovered but not enabled, referenced but not discovered), and same-named tool or command conflicts with their actual winners.

`list` and `status` SHALL be emitted as messages carrying structured payloads for non-interactive consumers.

#### Scenario: Untrusted project's profiles are invisible

- **WHEN** the project is untrusted and profiles exist in the project catalog
- **THEN** neither the list nor the selector shows those profiles

#### Scenario: Same-named project definition shadows the global one

- **WHEN** the project and global catalogs define the same-named profile
- **THEN** the list entry reports its source as project and is marked as shadowing the global definition

### Requirement: CRUD effects on the runtime

`create` and `duplicate` SHALL only modify the catalog and MUST NOT affect the current runtime.

When `edit` modifies the currently active profile it SHALL reactivate it immediately after saving; when modifying an inactive profile it MUST NOT affect the runtime.

When `delete` removes the currently active profile, it SHALL require choosing a replacement profile before deletion and switch to it afterwards; if another scope still holds a same-named profile, the revealed same-named definition SHALL be reactivated instead.

#### Scenario: Editing an inactive profile

- **WHEN** editing a profile that is not currently active
- **THEN** the save succeeds and the current runtime and active profile are unchanged

#### Scenario: Editing the active profile

- **WHEN** editing the currently active profile and saving
- **THEN** the profile is reactivated immediately after saving and the new definition takes effect

#### Scenario: Deleting the active profile

- **WHEN** deleting the currently active profile and the name exists in no other scope
- **THEN** a replacement profile is required before deletion, and the switch to the replacement happens after deletion
