# Spec Delta

## MODIFIED Requirements

### Requirement: Pre-launch failure and exit codes

Unknown explicitly requested profiles, illegal selected winning definitions, and invalid selected supported-field types SHALL abort startup before Pi is created and exit with code `2`. Illegal winning definitions SHALL NOT cause fallback to a shadowed profile or to `default`. Other unexpected failures SHALL exit with code `1`. Errors SHALL be written to stderr.

Reference misses and MCP source-content errors SHALL follow the resource-reference diagnostic contracts rather than abort startup. Model declarations SHALL follow native Pi validation rather than a launcher preflight. These diagnostics MUST NOT themselves change the child exit code or cause the launcher to suppress a native Pi error. User arguments and native settings precedence SHALL remain unchanged.

#### Scenario: Declared model not authenticated
- **WHEN** a profile declares a model whose credentials are not visible before Pi loads extensions
- **THEN** the launcher starts Pi with that declaration instead of rejecting it with code `2`

#### Scenario: Catalog content corrupt
- **WHEN** the selected winning definition is malformed
- **THEN** startup exits with code `2`, identifies the file, and creates no Pi process

#### Scenario: Unrelated corrupt definition does not stop spawn
- **WHEN** another profile definition is corrupt but the selected definition is valid
- **THEN** the launcher starts Pi without parsing the corrupt definition

#### Scenario: Selected MCP server uses a transport Pi cannot use
- **WHEN** an explicitly selected server uses a transport Pi cannot use
- **THEN** the launcher does not reject it through a transport preflight and native Pi diagnostics and exit behavior remain in control

#### Scenario: Explicitly selected server is disabled
- **WHEN** a profile selects a source-disabled user-level server
- **THEN** the launcher warns and starts Pi without force-enabling that server

#### Scenario: Invalid MCP source under an explicit policy
- **WHEN** `mcps` or `mcp_tools` is declared and a source contains malformed configuration
- **THEN** the launcher warns with its path and starts Pi with valid sources and the remaining restrictions

#### Scenario: Invalid MCP source under no policy
- **WHEN** no effective MCP policy is declared and a source is malformed
- **THEN** the launcher reports its path and starts Pi using remaining valid sources

#### Scenario: Unexpected filesystem failure is not a validation warning
- **WHEN** a required read or runtime write fails with an unexpected filesystem error
- **THEN** startup reports the actual failure rather than pretending activation succeeded

## ADDED Requirements

### Requirement: Restrictive partial materialization

Generated settings SHALL preserve explicit selection intent when references are skipped. Empty effective user-level selections SHALL remain restrictive. MCP policies retained for disabled or missing names MUST NOT create connection definitions or enable those servers; eligible named servers SHALL retain their declared restrictions. Trusted project-owned resources SHALL remain under native trust and precedence.

Warnings already collected during resolution SHALL survive runtime generation without being lost or emitted twice for the same issue in one activation. The original profile files and native user configuration SHALL remain unchanged.

#### Scenario: Missing-only MCP selection disables discovered user servers
- **WHEN** a declared MCP selection contains only missing names and valid sources contain other user-level servers
- **THEN** the generated snapshot keeps those discovered definitions disabled instead of restoring unrestricted availability

#### Scenario: Malformed source does not discard a surviving tool restriction
- **WHEN** one MCP source is malformed and another defines an eligible server named in `mcp_tools`
- **THEN** the snapshot applies the declared tool restriction to that server and reports the malformed source

#### Scenario: Empty effective extension selection stays empty
- **WHEN** every explicitly selected extension reference is skipped
- **THEN** generated user-level settings do not expose unselected extensions, while native project loading remains unchanged

#### Scenario: Diagnostics survive runtime generation
- **WHEN** resolution collects a skipped-reference diagnostic and runtime generation reuses the same issue
- **THEN** launch output reports it once and the active plan retains it for status

### Requirement: Native model declaration handoff

The launcher SHALL materialize complete model declarations into native Pi settings without proving model existence or authentication. It MUST NOT import selected extension code to validate models. Undeclared model inputs, CLI model precedence, project settings precedence, and native fallback SHALL remain Pi's own behavior.

#### Scenario: Extension-registered provider is selected after loading
- **WHEN** a profile declares a provider registered by a selected extension
- **THEN** Pi can load that extension and select the declared model through its native lifecycle

#### Scenario: Truly unavailable model remains a native error
- **WHEN** Pi cannot use the declared model after native loading
- **THEN** the launcher does not claim that the model was validated or replace Pi's native diagnostic and exit behavior

#### Scenario: Model override supplied by CLI
- **WHEN** a profile declaration competes with a native CLI model argument
- **THEN** the CLI argument reaches Pi unchanged and Pi determines precedence
