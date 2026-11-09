# Spec Delta

## MODIFIED Requirements

### Requirement: In-session switching

`/profile use <name>` SHALL wait for Pi's native idle boundary without interrupting a turn, snapshot managed runtime files, re-resolve the target through the launch path, rewrite runtime files in place, and trigger Pi's native reload.

Re-resolution SHALL use the same trust, selected-definition validation, discovery, partial-reference diagnostics, MCP source handling, and native model handoff as launch. Non-fatal diagnostics SHALL NOT prevent switching or reload. A fatal selected-definition or execution failure SHALL retain the existing no-write or rollback guarantees.

Switching MUST NOT restart Pi or change sessionId, message history, or the instance's project-trust input. The `trust.json` link form SHALL remain unchanged. Post-switch project visibility SHALL match direct launch of the target profile.

`/profile use` SHALL persist the selection and discard the previous profile's overlay. `/profile reload` SHALL follow the same path, omit the change summary, and preserve the existing selection-persistence intent. Explicit empty MCP selection SHALL remain restrictive across use and reload; returning to omitted selection SHALL restore native snapshot availability.

#### Scenario: Successful switch
- **WHEN** target resolution and native reload succeed
- **THEN** the runtime uses the target's resolution result without interrupting or restarting the session

#### Scenario: Project-level visibility unchanged by switching
- **WHEN** a trusted-project session switches between a named profile and `default`
- **THEN** native project visibility, sessionId, and history are preserved

#### Scenario: Failure at resolution stage
- **WHEN** the target's winning definition contains a fatal JSON or supported-field shape error
- **THEN** switching reports the cause and writes no runtime files

#### Scenario: Missing references do not reject switching
- **WHEN** the target contains usable references and missing references
- **THEN** switching completes with warnings and keeps only its resolved user-level selection

#### Scenario: Reload retries missing references
- **WHEN** a previously missing selected resource becomes discoverable before `/profile reload`
- **THEN** reload re-resolves the original declaration and makes that selected resource available

#### Scenario: Reload preserves one-shot selection
- **WHEN** a one-shot launch selection is followed by `/profile reload`
- **THEN** reload does not newly persist that selection

#### Scenario: Switching to an empty MCP selection
- **WHEN** a session switches from omitted MCP selection to explicit empty selection
- **THEN** discovered user-level servers become unavailable without a process restart

#### Scenario: Empty MCP selection survives reload
- **WHEN** a profile with an explicit empty MCP selection reloads
- **THEN** discovered user-level servers remain unavailable

#### Scenario: Switching back to omitted MCP selection
- **WHEN** a session switches from explicit MCP selection to omitted selection
- **THEN** native merged-snapshot user-level availability returns

#### Scenario: Extension model survives switch and reload
- **WHEN** a target declares a model registered by an extension loaded during native reload
- **THEN** no standalone pre-extension model check rejects the operation and Pi's native model lifecycle owns selection

### Requirement: Observability surface

Bare `/profile` SHALL open the interactive selector in TUI mode and otherwise print a profile list with a structured payload. The selector and degraded list SHALL preserve activation's project-trust gating and existing source ordering. Each entry SHALL identify its winning source and whether a project definition shadows a global one.

Invalid winning definitions SHALL be shown as unavailable with a file-bearing error while other entries remain usable. The selector MUST NOT activate an unavailable entry; explicit `/profile use` SHALL report that entry's validation error. Reserved-name and illegal-filename entries SHALL be diagnosed under the profile-catalog contract rather than replacing `default` or breaking the list.

`/profile status` SHALL report the active profile, overlay, resolved resource paths, MCP enabled/disabled/missing states, and actual registration winners for conflicts. Empty effective user-level MCP selection SHALL report discovered user servers as disabled while native trusted project servers retain their own state. Skipped-reference and source diagnostics SHALL be visible in displayed and structured status without claiming skipped resources are active or validating MCP tool selector names.

List and status messages SHALL retain structured payloads for non-interactive consumers.

#### Scenario: Untrusted project's profiles are invisible
- **WHEN** an untrusted project contains profiles
- **THEN** neither selector nor degraded list exposes those profiles

#### Scenario: Same-named project definition shadows the global one
- **WHEN** a trusted project overrides a global profile
- **THEN** its list entry reports project source and the shadowing marker

#### Scenario: Empty MCP selection is visible in status
- **WHEN** a profile has an explicit empty effective MCP selection and user servers are discovered
- **THEN** status reports those user servers as disabled rather than enabled

#### Scenario: Project-owned server remains enabled in status
- **WHEN** an explicit empty user-level selection coexists with an enabled trusted-project server
- **THEN** status preserves that server's native enabled state

#### Scenario: Unavailable profile remains visible
- **WHEN** a winning profile file is malformed
- **THEN** listing shows it as unavailable with its file and error, while valid profiles remain selectable

#### Scenario: Skipped resource is not reported as active
- **WHEN** activation skipped a missing resource reference
- **THEN** status contains its diagnostic and does not include it among resolved active resources

#### Scenario: Missing policy server is not enabled in status
- **WHEN** `mcp_tools` names a missing or disabled server
- **THEN** status retains the declared-policy diagnostic without presenting that server as enabled or unrestricted

#### Scenario: Catalog listing does not parse shadowed files
- **WHEN** a valid trusted-project profile shadows a malformed global file
- **THEN** listing shows the valid project winner and its shadowing marker without an error from parsing the global file
