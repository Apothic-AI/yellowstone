# Spec Delta

## MODIFIED Requirements

### Requirement: In-session switching

`/profile use <name>` SHALL execute in order: wait for the current agent turn to finish, snapshot the runtime files, re-resolve the target profile through the full launch path, rewrite the runtime files in place, and trigger Pi's native reload.

Waiting SHALL use Pi's native idle wait and MUST NOT interrupt an in-flight turn.

Re-resolution SHALL include the same validation as the launch path: trust determination, catalog read, resource discovery, model and MCP validation. When resolution fails, NO runtime file SHALL be written and the runtime stays in its pre-switch state.

Switching SHALL NOT restart the Pi process; the current session's sessionId and message history SHALL remain unchanged.

Switching SHALL NOT change Pi's project-trust input: the instance's `trust.json` link form is identical before and after a switch, so project-level resource visibility stays stable within one process. Post-switch project-level visibility SHALL match launching directly with the target profile and MUST NOT require a process restart to take effect.

`/profile use` SHALL persist the selection and SHALL discard the pre-switch profile's overlay.

`/profile reload` SHALL follow the same path, but SHALL NOT produce a change summary and SHALL preserve the current profile's existing selection persistence (a one-shot selection made at launch remains one-shot after reload).

An explicit empty `mcps` selection on an adapter-active named profile SHALL have the same effect after `/profile use` and `/profile reload` as at launch. Switching to a profile that omits `mcps` SHALL restore the adapter's normal user-level server availability.

#### Scenario: Successful switch

- **WHEN** `/profile use implement` is executed and both resolution and reload succeed
- **THEN** the runtime files are rewritten with that profile's resolution result and the session is not interrupted

#### Scenario: Project-level visibility unchanged by switching

- **WHEN** the project is trusted, started with a named profile, and `/profile use default` is executed
- **THEN** project-level skills and extensions are visible under both profiles, the process is not restarted, and sessionId and message history are unchanged

#### Scenario: Failure at resolution stage

- **WHEN** the target profile's references cannot resolve
- **THEN** the operation fails reporting the cause, and no runtime file is modified

#### Scenario: Reload preserves one-shot selection

- **WHEN** launched as `pi-profile review` (one-shot selection), followed by `/profile reload`
- **THEN** `review` is still running and the selection is not thereby written into runtime state

#### Scenario: Switching to an empty MCP selection

- **WHEN** an adapter-active session switches from a profile that omits `mcps` to a named profile declaring `mcps: []`
- **THEN** the discovered user-level servers are unavailable without restarting the Pi session

#### Scenario: Empty MCP selection survives reload

- **WHEN** an adapter-active named profile with `mcps: []` executes `/profile reload`
- **THEN** the discovered user-level servers remain unavailable

#### Scenario: Switching back to omitted MCP selection

- **WHEN** an adapter-active session switches from a named profile with `mcps: []` to a profile omitting `mcps`
- **THEN** user-level servers return to their normal adapter-defined availability

### Requirement: Observability surface

Bare `/profile` SHALL open the interactive selector over the visible profiles; outside TUI mode it SHALL degrade to printing the profile list, with the structured payload serving non-interactive consumers.

The selector and the degraded list SHALL show only visible profiles and SHALL use the same trust gating as activation: profiles from an untrusted project MUST NOT appear.

Each list entry SHALL report the winning definition's source and be marked when the project definition shadows a same-named global definition.

`/profile status` SHALL report the active profile, the stored overlay, resolved resources and paths, the MCP server tri-state (enabled, discovered but not enabled, referenced but not discovered), and same-named tool or command conflicts with their actual winners. For a named profile whose active adapter applies `mcps: []`, the discovered user-level servers SHALL be reported as disabled, not enabled, while trusted project-owned servers SHALL remain reported as enabled.

The degraded list and `status` SHALL be emitted as messages carrying structured payloads for non-interactive consumers.

#### Scenario: Untrusted project's profiles are invisible

- **WHEN** the project is untrusted and profiles exist in the project catalog
- **THEN** neither the selector nor the list shows those profiles

#### Scenario: Same-named project definition shadows the global one

- **WHEN** the project and global catalogs define the same-named profile
- **THEN** the list entry reports its source as project and is marked as shadowing the global definition

#### Scenario: Empty MCP selection is visible in status

- **WHEN** a named profile with an active adapter declares `mcps: []` and user-level servers have been discovered
- **THEN** `/profile status` reports no selected user-level servers and reports the discovered user-level servers as disabled

#### Scenario: Project-owned server remains enabled in status

- **WHEN** a named profile with an active adapter declares `mcps: []` and a trusted project defines an enabled server
- **THEN** `/profile status` reports the project-owned server as enabled rather than disabled
