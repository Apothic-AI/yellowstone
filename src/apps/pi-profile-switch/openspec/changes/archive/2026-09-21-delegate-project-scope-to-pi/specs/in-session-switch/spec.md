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
