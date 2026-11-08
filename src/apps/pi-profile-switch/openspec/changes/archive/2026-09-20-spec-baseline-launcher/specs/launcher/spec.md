# Spec Delta

## Purpose

Defines what the `pi-profile` launcher does before the Pi process exists: how it decides which arguments belong to the launcher and which to Pi, how the initial profile is chosen, what must fail before launch, and under what conditions project resources are read.

## ADDED Requirements

### Requirement: CLI argument parsing and pass-through

The launcher's invocation form SHALL be `pi-profile [profile] [--] <pi args>...`.

The launcher SHALL consume exactly two inputs: one optional leading positional argument as the profile name (only when it does not start with `-`), and at most one `--` separator. Any `--` after that separator belongs to Pi.

All other arguments SHALL be passed verbatim to the spawned Pi process, whether or not Pi recognizes them. Positional arguments after the profile name belong to Pi.

`--approve`, `-a`, `--no-approve`, and `-na` SHALL be recognized as one-shot trust input and not passed through. When the same input recurs in contradictory forms, the last occurrence SHALL win.

#### Scenario: Positional argument and pass-through boundary

- **WHEN** launched as `pi-profile review -- --model openai/gpt-5.4 extra`
- **THEN** the profile name is `review` and Pi receives `--model openai/gpt-5.4 extra`

#### Scenario: Unknown Pi arguments pass through

- **WHEN** the user passes a flag Pi does not recognize
- **THEN** the launcher neither intercepts nor rejects it; the flag reaches Pi verbatim

#### Scenario: Trust flags are consumed, last one wins

- **WHEN** both `--approve` and `--no-approve` appear in the arguments
- **THEN** neither is passed to Pi, and the launcher takes the last one as the trust input

### Requirement: Initial profile selection

When a positional argument is given, the launcher SHALL use that name.

When no positional argument is given, the launcher SHALL try in order: the saved selection of a trusted project, the saved global selection, the built-in `default`.

When the name given by positional argument does not exist, the launcher SHALL fail before starting Pi. When a name restored from saved state no longer exists, the launcher SHALL fall back to `default` with a warning and MUST NOT block startup.

An initial selection given via CLI SHALL NOT be written to runtime state.

#### Scenario: Positional argument names an unknown profile

- **WHEN** launched as `pi-profile nosuchprofile`
- **THEN** startup fails, the error names the profile, and no Pi process is created

#### Scenario: Saved selection has gone stale

- **WHEN** no positional argument is given and the saved active profile no longer exists in the catalog
- **THEN** startup continues with `default`, printing a warning that explains the fallback

#### Scenario: Trusted project's saved selection wins

- **WHEN** no positional argument is given, the project is trusted with an active profile in project state, and global state holds a different one
- **THEN** the active profile from project state is used

### Requirement: Pre-launch failure and exit codes

The following failures SHALL abort startup before the Pi process is created: unknown profile, unresolvable references, MCP servers declared while the adapter is unavailable, illegal catalog content, illegal MCP configuration content, declared model failing validation.

The failures above SHALL exit with code `2`. Other unexpected failures SHALL exit with code `1`. Failure messages SHALL be written to stderr.

#### Scenario: Declared model not authenticated

- **WHEN** the model declared by the profile does not exist or is not authenticated
- **THEN** startup exits with code `2` and no Pi process is created

#### Scenario: Catalog content corrupt

- **WHEN** a catalog file's content is illegal
- **THEN** startup exits with code `2` and the error identifies the file path

### Requirement: Project trust gating

Everything in project scope — catalog, runtime state, resources, MCP configuration — SHALL be read only when the project is trusted.

The trust determination SHALL take the first applicable result in this order: one-shot `--approve` or `--no-approve` input; a project containing no trust-requiring resources counts as trusted; the nearest ancestor's stored decision in the real `trust.json`; the user's global `defaultProjectTrust` set to `always`; otherwise untrusted.

Trust-requiring project resources SHALL include pi-profile's own project files `<projectDir>/.pi/profiles.json` and `<projectDir>/.pi/pi-profile-state.json`.

The trust determination MUST NOT execute any extension code.

The `default` profile SHALL preserve Pi's native trust behavior: the trust flag recorded by the launcher SHALL be re-attached to the Pi process. Named profiles MUST NOT forward that flag.

#### Scenario: One-shot trust input beats stored decision

- **WHEN** `trust.json` records the current project as untrusted, and this launch carries `--approve`
- **THEN** project resources are readable in this launch

#### Scenario: Project defaultProjectTrust is ask

- **WHEN** the user's global setting is `ask` and `trust.json` has no record for the current project
- **THEN** the project counts as untrusted, and neither project-scope files nor resources are read

#### Scenario: Only pi-profile's project files exist

- **WHEN** the project directory contains only `.pi/profiles.json` and no project resources Pi recognizes
- **THEN** the project is still judged to contain trust-requiring resources and is not auto-trusted for "having no project resources"

### Requirement: Launch diagnostic output

The launcher SHALL print non-fatal diagnostics to stderr and continue startup: extension discovery warnings, and glob references with zero matches during resolution.

#### Scenario: Zero-match glob

- **WHEN** a glob reference in the profile matches nothing in this resolution
- **THEN** startup continues, and stderr carries a warning identifying the zero-match reference

### Requirement: Instance directory contract

The launcher SHALL generate one instance directory per launch at `<PI_PROFILE_SWITCH_DIR>/instances/<profile>/agent`, with the workspace root defaulting to `~/.pi-profile-switch`. Multiple launches of the same profile SHALL reuse the same path.

The directory SHALL be handed to the Pi process via `PI_CODING_AGENT_DIR`. The launcher SHALL remove `PI_CODING_AGENT_SESSION_DIR` from the child process environment so that session storage is decided by the instance; the instance's `sessions` is a mirror of the real agentDir's corresponding directory.

The managed files in the instance (`settings.json`, `pi-profile.json`, `mcp.json`, `APPEND_SYSTEM.md`, `trust.json`, `pid`, `extensions`) are generated by pi-profile. All other files and directories under the real agentDir SHALL be mirrored into the instance as symlinks, with broken links cleaned up at link time.

`trust.json` SHALL be linked only under the `default` profile; named profiles MUST NOT link it.

When a profile declares `mcps`, the instance's `mcp.json` SHALL be the generated filter result containing only the allowed server definitions. For unselected servers in shared locations among the configuration sources (user-level standard MCP configuration, project `.mcp.json`), the instance configuration SHALL explicitly mark them disabled and MUST NOT rely on omission alone: these locations are read directly by the adapter, and without a disable mark an omitted server does not become ineffective.

User configuration files MUST NOT be modified.

#### Scenario: Instance path fixed per profile

- **WHEN** the same profile is launched twice in a row
- **THEN** both launches use the same instance path

#### Scenario: Unrestricted MCP configuration is linked directly

- **WHEN** the profile does not declare `mcps` and `mcp.json` exists under the real agentDir
- **THEN** the instance's `mcp.json` is a symlink to that file and its content is not rewritten

#### Scenario: Named profiles do not link trust.json

- **WHEN** launched with a named profile
- **THEN** no `trust.json` link exists in the instance

#### Scenario: Restricted MCP configuration disables unselected shared servers

- **WHEN** the profile declares `mcps` allowing only server A, while the user-level shared configuration also defines server B
- **THEN** the instance's `mcp.json` contains A's definition and contains B with a disable mark; B is not connected

### Requirement: Subprocess launch

The launcher SHALL start the real Pi binary and load the pi-profile extension shipped with the package via `-e`. User arguments SHALL be appended verbatim after the extension argument.

The launcher SHALL forward the child process's exit code and forward signals to the child process.

#### Scenario: Argument order

- **WHEN** the launcher builds Pi's argv
- **THEN** the order is: extension argument, the trust flag under the `default` profile, user arguments

#### Scenario: Exit code forwarding

- **WHEN** the Pi child process exits with code N
- **THEN** the launcher exits with code N
