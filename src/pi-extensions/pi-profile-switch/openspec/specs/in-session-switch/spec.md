# in-session-switch Specification

## Purpose
Defines the behavior of the `/profile` command family inside the Pi process: how switching replaces resources without restarting the process, how failures return to the pre-switch state, the overlay's scope and lifecycle, and where runtime state is written.

## Requirements

### Requirement: Sparse resource selection across activation

Switching and reload SHALL apply the resource-reference specification's "Sparse skill and extension selection" contract using the current real user settings. Switching to a profile that omits a previously selected kind SHALL remove the previous profile's restriction for that kind. Deleting a resource field from the current profile and reloading SHALL have the same effect, except for restrictions still declared by the current overlay.

The existing session-preservation, rollback, and selection-persistence contracts SHALL apply to these transitions. Extension-directory representation SHALL transition under the same activation boundary as generated settings. A failed transition SHALL restore the prior instance extension path's absence or exact raw symlink target before reloading; real resource contents MUST remain unchanged.

#### Scenario: Switching restores an omitted kind

- **WHEN** a session switches from an explicit empty or nonempty skill/extension selection to a named profile omitting that kind
- **THEN** that kind returns to current native visibility without a process restart, and session identity and history are retained

#### Scenario: Reload after deleting a field restores native visibility

- **WHEN** the current profile removes its skill or extension field and executes `/profile reload` without an overlay for that kind
- **THEN** the previous field's restriction is removed and the other kind keeps its own current policy

#### Scenario: Reload reflects real user edits

- **WHEN** real user resource settings or package filters change while the active profile omits the affected kind, and the profile reloads
- **THEN** the instance reflects the edited native input rather than retaining the previous instance's resource policy

#### Scenario: Failed activation restores prior resource visibility

- **WHEN** rewriting or reloading fails during a transition between declared and omitted resource selections
- **THEN** the pre-transition runtime files and resource visibility are restored, and the target profile is not reported as active

#### Scenario: Extension discovery representation follows both switch directions

- **WHEN** a session switches between declared and omitted extension selections in either direction, or reloads after adding or deleting the extension field
- **THEN** the instance extension representation follows the launcher layout contract, native patterns retain their meaning, and session identity and history remain unchanged

#### Scenario: Failed mirror transition restores the prior representation

- **WHEN** an extension-path transition or subsequent reload fails while switching between declared and omitted selections
- **THEN** prior settings, plan, extension-path absence or raw link target, and loaded resources are restored without changing real extension files or persisting the failed selection

#### Scenario: Failed activation reports its actionable cause across rollback reload

- **WHEN** activation fails after managed writes or refuses unsafe instance extension-path content and rolls back through a reload
- **THEN** the user receives a diagnostic identifying the failed activation and its cause, including the unsafe path and corrective action for a content refusal; invalidating the old command context does not discard the diagnostic, and reporting does not prevent restoration

### Requirement: Native resource bases for overlays

For a skill or extension kind omitted by the profile, overlay disables SHALL resolve against its native, referenceable discovery result and SHALL remove only matching user-level resources. Native resources outside the overlay's reference vocabulary MUST retain their native visibility. A kind declared by the profile SHALL continue to use its selected reference set as the overlay base.

An overlay for one resource kind MUST NOT turn an undeclared different kind into an allowlist. These rules SHALL apply to named profiles and the `default` profile. Existing overlay grammar, failure tiering, startup lifetime, and project boundaries SHALL remain unchanged.

#### Scenario: Overlay narrows an omitted kind

- **WHEN** a profile omits a skill or extension field and the overlay disables a discovered user-level resource of that kind
- **THEN** only the matching resource is disabled; the remaining native resources, package filters, and settings-only resources remain effective

#### Scenario: Overlay disables a skill loaded through a native plain include

- **WHEN** a profile omits skills, native settings directly include a referenceable user-level skill inside the real agent directory, and an overlay disables that skill
- **THEN** the skill is no longer visible through either its direct include or runtime discovery path while unrelated skills retain native visibility

#### Scenario: Overlay does not narrow an unrelated kind

- **WHEN** a named or `default` profile has no skill/extension selections and an overlay disables only skills, only extensions, or only tools
- **THEN** every unrelated resource kind retains native visibility and native extension controls

#### Scenario: Removing a native-base overlay restores native visibility

- **WHEN** a profile omits a resource kind and the overlay enables its stored disable entry or clears the overlay
- **THEN** that kind returns to current native visibility rather than an empty selection or a wildcard allowlist

#### Scenario: Native-base overlay glob is re-expanded

- **WHEN** a stored disable glob belongs to an omitted resource kind and a newly discovered user-level resource matches it on reload
- **THEN** the new match is disabled and nonmatching native resources remain visible

### Requirement: /profile command family

`/profile` SHALL accept these subcommands: bare invocation (opens the selector), `use`, `reload`, `status`, and `overlay`.

Unknown subcommands SHALL be rejected with a usage note naming the accepted set. `use` without a name SHALL be rejected with that subcommand's usage.

All forms SHALL be available in every mode, including non-TUI modes; the bare selector's behavior outside TUI mode is defined by the observability surface.

#### Scenario: Unknown subcommand

- **WHEN** `/profile frobnicate` is executed
- **THEN** the operation is rejected and a usage note naming the accepted subcommands is printed

#### Scenario: use without a name

- **WHEN** `/profile use` is executed without a name
- **THEN** the operation is rejected with the `use` usage note

#### Scenario: Non-TUI availability

- **WHEN** `/profile status` or an `/profile overlay` form is executed in a non-TUI mode
- **THEN** it executes normally and is not rejected for the mode

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

### Requirement: MCP tool policy status and switch rollback

`/profile status` SHALL show which enabled servers have unrestricted, explicitly restricted, or no MCP tools, including the declared selectors for explicitly restricted servers; it SHALL NOT report selector validity or missing-name candidates. When `mcps` is undeclared, a server the merged user-level configuration marks `enabled: false` SHALL appear as discovered but not enabled, rather than enabled. A switch or reload failure while applying a per-server restriction SHALL restore the previous MCP and Pi tool availability, not leave a partial policy.

#### Scenario: Status distinguishes absent and empty lists

- **WHEN** an active profile omits `github` from `mcp_tools` and explicitly sets `linear` to `[]`
- **THEN** `/profile status` reports `github` as unrestricted and `linear` as having no enabled MCP tools

#### Scenario: Status respects merged-config-disabled servers without an MCP whitelist

- **WHEN** `mcps` is undeclared and the merged user-level configuration marks `linear` with `enabled: false` while `github` is enabled
- **THEN** `/profile status` reports `github` as enabled and `linear` as discovered but not enabled, without listing `linear` as an unrestricted enabled server

#### Scenario: Failed switch restores previous tool policy

- **WHEN** a profile switch fails during reload after writing a different per-server tool policy
- **THEN** the prior runtime files and tool availability are restored, and the cause is reported

### Requirement: Subagent overrides follow profile activation and rollback

Profile switching and reload SHALL apply subagent overrides through the same instance rewrite and native reload boundary as other profile settings. Rebuilding SHALL follow "Sparse native subagent settings materialization" in the launcher specification.

Switching to a profile without effective subagent declarations SHALL remove previous-profile child overrides and restore the current real user's native subagent settings. Removing fields from the current profile and reloading SHALL remove only those profile contributions. Current real-settings edits SHALL be reflected on the next activation.

A settings-write or reload failure SHALL restore the previous child settings and profile declaration exactly under the existing rollback contract. The system SHALL preserve Pi's session identity and history. It MUST NOT add child launches, live-task mutation, or task cancellation merely to enforce new defaults; Pi and pi-subagents SHALL retain their native reload and existing-run lifecycle.

#### Scenario: Switching removes previous child overrides

- **WHEN** the session switches from a profile with reviewer overrides to a profile with no effective subagent declaration
- **THEN** instance child settings match the current real-user base, the previous declaration is absent from profile status, and session identity and history are retained

#### Scenario: Reload removes a deleted role field

- **WHEN** the active profile deletes a reviewer description override but keeps its model override and reloads
- **THEN** the instance restores the native description input while retaining the profile model input

#### Scenario: Activation picks up real-user edits

- **WHEN** the real user's subagent settings change after launch and the profile reloads
- **THEN** the new instance result uses the edited base rather than accumulating patches from the previous instance

#### Scenario: Failed activation restores child settings and declarations

- **WHEN** a write or reload fails after instance child settings have changed
- **THEN** the previous settings and profile declaration are restored exactly, and no new selection or child policy is reported as active

#### Scenario: Defaults do not create or manage child runs

- **WHEN** a profile containing child defaults is activated or reloaded
- **THEN** the profile integration issues no child launch, task-reconfiguration, or task-cancellation request of its own

### Requirement: Declared subagent status and extension observations

When the active profile has effective child declarations, `/profile status` SHALL include those declarations in its displayed and structured output, labeled as profile declarations rather than effective runtime mappings. The status SHALL direct users to pi-subagents' native model inspection for the live mapping. Runtime-owned agent fields that pi-subagents does not permit overriding MUST NOT be reported as successfully applied.

Extension availability SHALL be observed from Pi's registered tool or command ownership rather than active-tool selection or the profile's selected-extension list alone. Registration names alone SHALL NOT prove ownership. A positively observed native extension SHALL be recognized even when loaded by CLI or project discovery, or when its delegation tool is registered but inactive.

When effective declarations exist but the native extension cannot be confirmed, session-start/reload diagnostics SHALL be non-fatal and actionable. They SHALL identify the profile, explain that overrides might be inactive, and suggest checking native extension loading and live model inspection. An inconclusive observation SHALL NOT be presented as proof of unload or role validity. Without effective declarations, the system SHALL omit subagent-specific status and perform no subagent-specific observation or warning.

#### Scenario: Status separates declaration from runtime mapping

- **WHEN** the active profile declares a reviewer model and description
- **THEN** status reports those as declared inputs and gives native model-inspection guidance without claiming that the final model, advertisement, or description has been applied

#### Scenario: No declaration produces no new status or warning

- **WHEN** the active profile omits effective child declarations
- **THEN** status has no child-override section or structured child field, and startup/reload performs no child-specific registration observation or diagnostic

#### Scenario: Missing native registration produces an actionable warning

- **WHEN** effective declarations exist and no pi-subagents-owned registration can be confirmed
- **THEN** startup or reload continues with a profile-named warning that explains the observation limit and how to check native loading and the live mapping

#### Scenario: Lazy delegation is not treated as unload

- **WHEN** pi-subagents owns a registered but inactive delegation tool or its lazy loader
- **THEN** the extension is positively observed without activating any tool, and no missing-extension warning is emitted

#### Scenario: CLI or project loading is recognized

- **WHEN** pi-subagents is loaded through CLI or native project discovery instead of the profile's selected user-level extensions
- **THEN** its owned registrations confirm the integration without changing extension selection or project trust

#### Scenario: Same-named foreign registration does not prove loading

- **WHEN** another extension wins a registration name normally used by pi-subagents and no other owned registration confirms pi-subagents
- **THEN** the observation remains unconfirmed and does not claim that the foreign registration consumes the profile's child settings

#### Scenario: Inconclusive ownership is non-fatal

- **WHEN** registration ownership cannot be resolved because metadata or a package manifest is unavailable
- **THEN** the observation is reported as unconfirmed rather than unloaded, activation remains successful, and no extension code is imported to resolve the uncertainty
