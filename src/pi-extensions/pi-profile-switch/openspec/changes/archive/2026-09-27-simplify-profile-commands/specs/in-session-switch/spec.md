# Spec Delta

## REMOVED Requirements

### Requirement: /profile command family and mode gating

**Reason**: The CRUD subcommands are removed, and with them the TUI-only gating dimension — every remaining form works in every mode. The requirement is replaced by the slimmer `/profile command family` requirement.

**Migration**: Scripts using removed subcommands move to their replacements: `list` → bare `/profile` (which prints the list outside TUI mode), `create`/`edit`/`delete`/`duplicate` → direct file editing or the `profile-config` skill, `customize` → `overlay`, `reset` → `overlay clear`.

### Requirement: CRUD effects on the runtime

**Reason**: The CRUD subcommands are removed, so there are no system-performed catalog mutations left whose runtime effects need governing. Edit-then-reactivate and delete-then-switch orchestration existed only to keep the session consistent with those writes; externally edited catalog files take effect through the normal reload path.

**Migration**: Edit the catalog file directly, then `/profile reload` (or `/profile use <name>`) to apply the new definition. Delete the file directly, switching to another profile first when deleting the active one — otherwise the next reload fails resolution and rolls back until a switch occurs.

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Runtime overlay

The overlay SHALL apply only to the current runtime and MUST NOT be written to any catalog file.

The overlay SHALL be able to disable skills, extensions, and MCP servers already resolved by the current profile, and to replace the tool reference set.

Disable entries SHALL be names or globs, stored as written and re-expanded at every resolution. An unmatched literal SHALL fail and identify the entry. A zero-match glob SHALL NOT fail; it SHALL be surfaced as a warning, following the failure tiering of profile references (ADR-0009).

`/profile overlay disable|enable|tools` SHALL first re-resolve with the candidate overlay (validation happens here), then switch and reload, and only then write the overlay to the state file. When the switch fails, the stored overlay SHALL remain unchanged.

`enable` SHALL remove a stored entry by exact string match; when no stored entry matches, it SHALL fail listing the current entries of that kind.

`/profile overlay clear` SHALL first switch and reload without the overlay, then delete the overlay from the state file. When the switch rolls back, the stored overlay SHALL still match the restored runtime.

Startup SHALL ignore a stored overlay: an overlay MUST NOT survive across runtimes.

The `default` profile does not filter by default. When narrowed by an overlay it SHALL become an "all resources minus the disabled entries" selection, so its skills, extensions, and tools can all be disabled. MCP disabling on the `default` profile SHALL be rejected — it has no MCP whitelist to narrow.

#### Scenario: Overlay does not touch the catalog

- **WHEN** `/profile overlay disable skill git-commit` is executed
- **THEN** that skill is no longer active in the current runtime and the catalog file content is unchanged

#### Scenario: Disabling an unresolved resource

- **WHEN** disabling a literal skill, extension, or MCP server name that the current profile has not resolved
- **THEN** the operation fails with an error identifying the entry

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

### Requirement: Observability surface

Bare `/profile` SHALL open the interactive selector over the visible profiles; outside TUI mode it SHALL degrade to printing the profile list, with the structured payload serving non-interactive consumers.

The selector and the degraded list SHALL show only visible profiles and SHALL use the same trust gating as activation: profiles from an untrusted project MUST NOT appear.

Each list entry SHALL report the winning definition's source and be marked when the project definition shadows a same-named global definition.

`/profile status` SHALL report the active profile, the stored overlay, resolved resources and paths, the MCP server tri-state (enabled, discovered but not enabled, referenced but not discovered), and same-named tool or command conflicts with their actual winners.

The degraded list and `status` SHALL be emitted as messages carrying structured payloads for non-interactive consumers.

#### Scenario: Untrusted project's profiles are invisible

- **WHEN** the project is untrusted and profiles exist in the project catalog
- **THEN** neither the selector nor the list shows those profiles

#### Scenario: Same-named project definition shadows the global one

- **WHEN** the project and global catalogs define the same-named profile
- **THEN** the list entry reports its source as project and is marked as shadowing the global definition
