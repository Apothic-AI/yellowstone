# launcher Specification

## Purpose
Defines what the `pi-profile` launcher does before the Pi process exists: how it decides which arguments belong to the launcher and which to Pi, how the initial profile is chosen, what must fail before launch, and which project-scope content pi-profile reads.

## Requirements

### Requirement: Independent skill and extension materialization

Generated instance settings SHALL implement "Sparse skill and extension selection" from the resource-reference specification independently for each kind. For an undeclared kind without an overlay, the instance SHALL preserve the user's native resource settings and package-filter meaning, including the distinction between an absent package filter and an explicitly empty native package filter. Generated paths SHALL retain their native meaning when the agent directory changes.

Restricting one kind MUST NOT inject an empty filter for the other kind into a configured package. Native built-in extension controls SHALL remain effective when resource settings are rewritten. Source user settings and profile files MUST NOT be rewritten as part of activation.

#### Scenario: Mixed package preserves undeclared skills

- **WHEN** a configured package supplies skills and extensions, and a profile declares only an extension selection
- **THEN** the generated package entry narrows extensions while preserving the original skill-filter meaning and unrelated package properties

#### Scenario: Mixed package preserves undeclared extensions

- **WHEN** a configured package supplies skills and extensions, and a profile declares only a skill selection
- **THEN** the generated package entry narrows skills while preserving the original extension-filter meaning and unrelated package properties

#### Scenario: Native empty package filter remains empty

- **WHEN** native user settings explicitly disable one resource kind in a package with an empty filter and a profile omits that kind
- **THEN** generated settings keep that kind disabled rather than treating the native empty filter as unrestricted

#### Scenario: Native paths survive the instance boundary

- **WHEN** native skill or extension settings include absolute paths, paths relative to the real agent directory, or paths containing native include/exclude controls, and the profile omits that kind
- **THEN** the instance exposes the same enabled resources as native Pi and keeps the same exclusions effective

#### Scenario: Native extension patterns retain their discovery meaning

- **WHEN** a profile omits extensions and native settings contain basename exclusions or marker-less glob filters, with or without native plain includes
- **THEN** the same extensions are enabled as under native Pi; a glob that is inert for native automatic discovery does not become a filter for that discovery, and its filtering of native plain includes is preserved

#### Scenario: Omitted kinds do not freeze package discovery

- **WHEN** an undeclared kind belongs to a configured package that read-only discovery cannot resolve before startup
- **THEN** generated settings preserve the native declaration instead of replacing that kind with an empty or discovery-derived allowlist

#### Scenario: Source files remain unchanged

- **WHEN** a named profile activates with omitted, empty, or mixed skill/extension fields
- **THEN** the real user settings and profile files remain byte-identical after activation

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

### Requirement: Project trust gating

Project-scope content that pi-profile reads itself — the project catalog, project runtime state, project MCP configuration — SHALL be read only when the project is trusted.

The visibility of project-level resources (`.pi/skills`, `.pi/extensions`, ancestor `.agents/skills`, `.pi/prompts`, `.pi/themes`, `.pi/settings.json`) SHALL be decided by Pi's own project-trust determination. pi-profile MUST NOT narrow, attach, or exclude these resources through generated settings.

The trust determination SHALL take the first applicable result in this order: one-shot `--approve` or `--no-approve` input; a project containing no trust-requiring resources counts as trusted; the nearest ancestor's stored decision in the real `trust.json`; the user's global `defaultProjectTrust` set to `always`; otherwise untrusted.

Trust-requiring project resources SHALL include pi-profile's own project files `<projectDir>/.pi/profiles/` and `<projectDir>/.pi/pi-profile-state.json`.

The trust determination MUST NOT execute any extension code.

The trust flag recorded by the launcher SHALL be re-attached to the spawned Pi process and SHALL behave identically for every profile: one-shot trust input SHALL determine both the project catalog's readability and Pi's project-level visibility under any profile; the two MUST NOT diverge.

#### Scenario: One-shot trust input beats stored decision

- **WHEN** `trust.json` records the current project as untrusted, and this launch carries `--approve`
- **THEN** project resources are readable in this launch

#### Scenario: Named profiles forward the trust flag too

- **WHEN** launched as `pi-profile doc -- --no-approve`
- **THEN** the Pi process receives `--no-approve`, and the flag does not appear among the user arguments

#### Scenario: Project defaultProjectTrust is ask

- **WHEN** the user's global setting is `ask` and `trust.json` has no record for the current project
- **THEN** neither the project catalog nor project runtime state is read, and a named profile's project-level resources are not visible

#### Scenario: Only pi-profile's project files exist

- **WHEN** the project directory contains only a `.pi/profiles/` directory and no project resources Pi recognizes
- **THEN** the project is still judged to contain trust-requiring resources and is not auto-trusted for "having no project resources"

### Requirement: Launch diagnostic output

The launcher SHALL print non-fatal diagnostics to stderr and continue startup: extension discovery warnings, glob references with zero matches during resolution, and the untrusted-project notice.

When the project-trust determination is untrusted and the project directory contains content unavailable because of that — pi-profile's project files or any trust-requiring Pi project resources — the launcher SHALL print one diagnostic stating that the project is untrusted, which content is therefore invisible, and how to authorize: `/trust` persists the trust decision (effective on the next launch), `-- --approve` grants one-shot trust for this launch. This diagnostic SHALL behave identically for every profile, including `default`. Startup SHALL continue as usual and the exit code is unchanged.

When the project is trusted, or untrusted but contains no trust-requiring content, this diagnostic SHALL NOT be printed.

#### Scenario: Zero-match glob

- **WHEN** a glob reference in the profile matches nothing in this resolution
- **THEN** startup continues, and stderr carries a warning identifying the zero-match reference

#### Scenario: Untrusted project has skipped content

- **WHEN** the project is untrusted and trust-requiring content such as `.pi/profiles/` or `.pi/extensions` exists under the project directory
- **THEN** startup continues with an unchanged exit code, and stderr carries a diagnostic stating the project is untrusted, the invisible content, and how to authorize (`/trust` and `-- --approve`)

#### Scenario: No diagnostic for trusted projects

- **WHEN** the project is trusted
- **THEN** the untrusted-project diagnostic is not printed

#### Scenario: Untrusted but no trust-requiring content

- **WHEN** launched with `--no-approve` and the project directory contains neither trust-requiring resources nor pi-profile project files
- **THEN** the untrusted-project diagnostic is not printed

### Requirement: Instance directory layout

The launcher SHALL generate one instance directory per launch at `<PI_PROFILE_SWITCH_DIR>/instances/launch-<random id>`, with the workspace root defaulting to `~/.pi-profile-switch`. Each launch SHALL use a previously nonexistent path; multiple launches of the same profile MUST NOT reuse the same path.

The directory SHALL be handed to the Pi process via `PI_CODING_AGENT_DIR`. The launcher SHALL remove `PI_CODING_AGENT_SESSION_DIR` from the child process environment so that session storage is decided by the instance; the instance's `sessions` is a mirror of the real agentDir's corresponding directory.

Managed instance paths SHALL defer to the authoritative managed-path definition in `src/settings-generator.ts`. Managed content is generated by pi-profile; `pid` SHALL record the Pi child process ID of this launch. The content contract for the generated `mcp.json` is the "Instance MCP configuration snapshot" requirement. All unmanaged files and directories under the real agentDir SHALL be mirrored into the instance as symlinks, with broken links cleaned up at link time.

For a selection profile that omits `extensions`, the managed instance `extensions` path SHALL be a symlink to the real agentDir's corresponding path, even when that target does not yet exist. For a declared extension selection, that generated link SHALL be absent and the existing restrictive selection contract SHALL apply. The ordinary `default` profile without an overlay SHALL retain its existing representation. Activation MUST NOT remove or overwrite pre-existing non-symlink content at the instance extension path; it SHALL fail with an actionable path-bearing error instead.

`trust.json` SHALL be a symlink to the corresponding path in the real agentDir, and this SHALL hold for every profile: it MUST NOT be omitted or removed because the profile is not `default`, and MUST NOT be skipped because the target file does not exist yet (trust decisions Pi writes through the link land in the real agentDir).

Reclamation of an instance containing an extension-directory symlink MUST NOT traverse, modify, adopt, or delete the link's target or its contents. The existing "Stale instance sweep" contract SHALL remain applicable to content in real instance directories.

#### Scenario: Instance path fixed per profile

- **WHEN** the same profile is launched twice in a row
- **THEN** the two launches use different instance paths (scenario name kept from the old contract's wording; the assertion has been inverted)

#### Scenario: Named profiles do link trust.json

- **WHEN** launched with a named profile
- **THEN** a `trust.json` link exists in the instance and points at the corresponding path in the real agentDir (scenario name kept from the old contract's wording; the assertion has been inverted)

#### Scenario: Omitted extensions use native automatic discovery

- **WHEN** a selection profile omits `extensions`
- **THEN** its instance extension path links to the real extension directory and loaded extensions follow native automatic-discovery semantics

#### Scenario: Missing native extension directory remains linked

- **WHEN** a selection profile omits `extensions` and the real extension directory is absent
- **THEN** the instance link still points at that real path without creating or populating the target directory

#### Scenario: Declared extensions do not retain the native mirror

- **WHEN** a profile declares an empty or nonempty extension selection
- **THEN** the instance has no generated extension-directory link that could reveal extensions outside that selection

#### Scenario: Pre-existing extension-path content blocks activation safely

- **WHEN** an activation would change the instance extension path and that path contains a real file or directory
- **THEN** activation fails before managed writes, names the path and a corrective action, and leaves that content and real user resources untouched

#### Scenario: Sweep does not follow the extension mirror

- **WHEN** a dead reclaimable instance contains an extension-directory symlink
- **THEN** the instance can be reclaimed without changing any target resource or adopting target content

### Requirement: Instance MCP configuration snapshot

The instance's `mcp.json` SHALL always be the generated MCP configuration snapshot, never a symlink or a copy of the real agentDir file. The snapshot SHALL contain the merged user-level server definitions in the established source order (defer to the authoritative source list in `src/mcp-config.ts`). When a profile declares `mcps`, only the selected servers SHALL remain enabled. For unselected user-level servers, the instance configuration SHALL preserve the winning server's full definition and explicitly set `enabled: false`; it MUST NOT rely on omission or emit an invalid transport-less placeholder. An explicitly empty `mcps` selection SHALL disable every user-level server from the merged snapshot. Servers defined in project-level locations SHALL NOT be written into the instance configuration at all: Pi reads trusted project MCP configuration itself, and those servers SHALL stay enabled.

When `mcp_tools` names any server, the instance's MCP configuration SHALL carry that server's tool restriction as tool exposure — every tool hidden except tools matched by the listed selectors, which SHALL be directly exposed — even if `mcps` is undeclared. Servers omitted from `mcp_tools` SHALL retain their configured tool exposure. An explicitly empty tool list SHALL deny all the named server's tools, not restore an unrestricted server. Profile-generated restrictions MUST NOT alter project-owned servers.

User configuration files MUST NOT be modified.

#### Scenario: Unrestricted MCP configuration is materialized as the snapshot

- **WHEN** the profile does not declare `mcps` and does not name any server in `mcp_tools`, and `mcp.json` exists under the real agentDir
- **THEN** the instance's `mcp.json` is a generated file containing the merged user-level server definitions, and it is not a symlink

#### Scenario: Restricted MCP configuration disables unselected shared servers

- **WHEN** the profile declares `mcps` allowing only server A, while another user-level location also defines valid server B
- **THEN** the instance's `mcp.json` contains A's definition and B's complete definition with `enabled: false`; B is not connected and Pi reports no missing-transport configuration error for B

#### Scenario: Project-sourced MCP servers are not disabled

- **WHEN** the profile declares `mcps` allowing only server A, while a trusted project's `.pi/mcp.json` defines server P
- **THEN** P does not appear in the instance's `mcp.json` and remains enabled and usable through Pi's own project read

#### Scenario: Empty MCP selection disables discovered user servers

- **WHEN** a named profile declares `mcps: []` and user-level configuration defines valid servers in more than one source
- **THEN** none of those servers can be connected or called, each is written with its complete definition and `enabled: false` in the instance, Pi reports no missing-transport error for them, and the source configuration files are unchanged

#### Scenario: Project-sourced server survives an empty selection

- **WHEN** a named profile declares `mcps: []` and a trusted project defines an enabled server
- **THEN** that project-owned server remains enabled and callable

#### Scenario: Tool restriction without a server whitelist

- **WHEN** a profile declares no `mcps`, but sets `mcp_tools` for an enabled user-level server
- **THEN** the instance carries that server's tool exposure restriction, and other user-level servers remain enabled with their configured exposure

#### Scenario: Empty MCP tool list remains restrictive

- **WHEN** an enabled user-level server is assigned `[]` in `mcp_tools`
- **THEN** the instance configuration prevents every tool on that server, including tools later discovered, while leaving its non-tool functions and user configuration files unchanged

### Requirement: MCP access entry points in generated settings

When a profile declares a `tools` selection and at least one MCP server is enabled in the active session, the generated instance settings SHALL make Pi's available MCP discovery entry points active even when the profile does not list them in `tools`. The authoritative set of Pi's MCP discovery entry points SHALL be Pi's own tool registry and MCP exposure behavior, not a profile-specific configuration field. A profile that disables all user-level MCP servers MUST NOT re-enable those servers by enabling discovery entry points. When `tools` is undeclared, Pi's own startup tool selection SHALL remain in control. Other non-MCP tools excluded by `tools` SHALL remain excluded.

#### Scenario: Native indirect entry points are available without explicit tools references

- **WHEN** a profile enables an MCP server and declares `tools: ["read"]` without listing Pi's MCP discovery entry points
- **THEN** its instance settings allow both native discovery entry points while the unrelated non-MCP tools excluded by `tools` remain inactive

#### Scenario: No enabled MCP server

- **WHEN** a profile disables every user-level MCP server and there is no enabled project-level MCP server
- **THEN** the instance settings do not enable MCP discovery entry points solely because disabled server definitions appear in the snapshot

### Requirement: Stale instance sweep

The launcher SHALL sweep stale directories under the instance root `<PI_PROFILE_SWITCH_DIR>/instances` before generating this run's instance, and SHALL only reclaim instance directories of the shape it generates; other directories under the root MUST NOT be deleted.

Whether to reclaim an instance directory SHALL be decided in this order: keep when `pid` is parseable and the process is alive (including present but unsignalable); reclaim when `pid` is parseable and the process is gone; when `pid` is missing or unparseable, reclaim only if the directory mtime is beyond the grace period.

For an instance directory judged reclaimable, the launcher SHALL examine each first-level entry not generated by pi-profile (neither a symlink nor a managed generated artifact) and route it by content:

- If the entry is a regular file or directory whose content does not reference its own instance's path (directories are checked recursively over all their content; exceeding the scan limit counts as undecidable) and the real agentDir has no same-named entry, the launcher SHALL move it into the real agentDir (adoption) and print a one-line notice to stderr naming the entry and its destination.
- If the entry meets the conditions above but the real agentDir already has a same-named entry, the launcher SHALL delete the instance copy (the real agentDir wins) and print a one-line notice to stderr naming the entry. This branch SHALL NOT compare the two sides' content.
- If the entry's content references its own instance's path, the scan limit was exceeded so it cannot be decided, or the entry is not a regular file or directory, the launcher SHALL keep the entry and print a warning to stderr; the warning SHALL identify the directory, the unrecognized entries, and the available dispositions.

Unrecognized entries inside the managed `extensions/` directory SHALL only be handled with the warning above and MUST NOT be adopted or deleted.

When any kept unrecognized entries exist, the instance directory SHALL be kept as a whole; once all unrecognized entries have been adopted or deleted, the directory SHALL be reclaimed.

Sweeping SHALL be best-effort: an error in a single directory MUST NOT interrupt the sweep or block startup. Instance directories SHALL NOT be deleted at exit; reclamation happens only in later launches' sweeps.

#### Scenario: Kept while pid is alive

- **WHEN** an instance directory's `pid` points at a still-running process
- **THEN** the directory is not reclaimed

#### Scenario: Reclaimed after pid exits

- **WHEN** the process an instance directory's `pid` points at no longer exists
- **THEN** the directory is reclaimed

#### Scenario: Directory without pid kept within grace period

- **WHEN** an instance directory has no `pid` file and its mtime is within the grace period
- **THEN** the directory is not reclaimed

#### Scenario: Kept with warning when unrecognized entries exist

- **WHEN** a reclaimable instance directory contains unrecognized entries whose content references the instance's path, that exceed the scan limit, or that are not regular files or directories
- **THEN** the directory is kept, and stderr carries a warning identifying the directory and the entries (scenario name kept from the old contract's wording; the condition has been narrowed to the non-adoptable subset)

#### Scenario: Unrecognized entry adopted into the real agentDir

- **WHEN** a reclaimable instance directory contains an unrecognized entry whose content does not reference the instance's path, and no same-named entry exists under the real agentDir
- **THEN** the entry is moved into the real agentDir with a one-line notice on stderr; when no other kept entries remain in the directory, the directory is reclaimed

#### Scenario: Instance copy deleted when the real agentDir already has the entry

- **WHEN** a reclaimable instance directory contains an unrecognized entry whose content does not reference the instance's path, but the real agentDir already has a same-named entry
- **THEN** the instance copy is deleted without content comparison, with a one-line notice on stderr; when no other kept entries remain in the directory, the directory is reclaimed

#### Scenario: Unrecognized entries inside managed directories only warn

- **WHEN** a reclaimable instance directory's managed `extensions/` directory contains an unrecognized entry
- **THEN** the entry is neither adopted nor deleted, the directory is kept, and stderr carries a warning identifying the entry

#### Scenario: Directories not of this run's shape are not deleted

- **WHEN** a directory not matching the current generation shape exists under the instance root
- **THEN** the directory is not deleted and does not affect this launch

### Requirement: Instance runtime-state seed

Before mirroring the real agentDir into the instance, the launcher SHALL point the state paths Pi creates at runtime at the real agentDir, so these writes do not land inside the instance:

| Path | Form | Seed method |
| --- | --- | --- |
| `sessions`, `missions` | Directory | Created under the real agentDir when missing, left as-is when present; the launcher MUST NOT write their content |
| `auth.json`, `models-store.json` | File | A symlink is created inside the instance pointing at the corresponding real-agentDir path; the link SHALL be created even when the target file does not exist |

For file-class paths, the launcher SHALL NOT delete the link inside the instance because the real agentDir lacks the corresponding file, and MUST NOT create or write that file itself; the file's content and format are Pi's to decide.

Paths not covered by the seed are still handled per "Stale instance sweep".

#### Scenario: Symlink established on first launch

- **WHEN** any profile is launched while no `missions` directory exists under the real agentDir
- **THEN** a `missions` directory appears under the real agentDir, and `missions` inside the instance is a symlink to it

#### Scenario: Not rewritten when present

- **WHEN** a `missions` directory with records already exists under the real agentDir
- **THEN** that directory's content is unchanged, and `missions` inside the instance is a symlink to it

#### Scenario: Symlink established even when the target file does not exist

- **WHEN** any profile is launched while no `auth.json` exists under the real agentDir
- **THEN** `auth.json` inside the instance is a symlink to the corresponding real-agentDir path, and no `auth.json` is created under the real agentDir

#### Scenario: Writes through the symlink land in the real agentDir

- **WHEN** a process writes `auth.json` inside the instance
- **THEN** the real agentDir's `auth.json` receives the content, and the entry inside the instance remains a symlink

#### Scenario: Symlinks survive an in-place rewrite of the same instance directory

- **WHEN** the same instance directory is rewritten in place (in-session switching)
- **THEN** `auth.json` and `models-store.json` are still symlinks

### Requirement: Subprocess launch

The launcher SHALL start the real Pi binary and load the pi-profile extension shipped with the package via `-e`. User arguments SHALL be appended verbatim after the extension argument.

The launcher SHALL forward the child process's exit code and forward signals to the child process.

#### Scenario: Argument order

- **WHEN** the launcher builds Pi's argv
- **THEN** the order is: extension argument, recorded one-shot trust flag (when present), user arguments

#### Scenario: Exit code forwarding

- **WHEN** the Pi child process exits with code N
- **THEN** the launcher exits with code N

### Requirement: Startup upgrade reminder

On a pi-profile launch, the system SHALL compare the running pi-profile-switch package version with the npm registry's installable `latest` tag. It SHALL obtain the tag without requiring the registry's full package-metadata response to fit within the remote-response limit. It SHALL show a concise upgrade reminder with the installed and target versions and the global-install command only when the target is newer and that target has not already been shown. It MUST NOT automatically install a package, show release notes, or use an announcement as the authoritative latest version. A target that is not newer, including when the running package is a prerelease ahead of `latest`, MUST NOT trigger a reminder.

#### Scenario: New stable version
- **WHEN** npm's installable `latest` is newer than the running package and has not been shown
- **THEN** one concise upgrade reminder names both versions and the global-install command, without release details

#### Scenario: Already shown target
- **WHEN** a later launch sees the same target version after its upgrade reminder was displayed
- **THEN** the ordinary upgrade reminder is not displayed again, regardless of the selected profile or project

#### Scenario: No newer installable version
- **WHEN** the running package is at or ahead of npm's installable `latest`
- **THEN** no ordinary upgrade reminder is displayed

#### Scenario: Large package metadata with a bounded latest tag
- **WHEN** the registry's full package-metadata response exceeds the notifier's remote-response limit, but an installable `latest` tag newer than the running package is available in a bounded response and has not been shown
- **THEN** the ordinary upgrade reminder is displayed without requiring the full package-metadata response

### Requirement: Applicable startup announcements

The system SHALL retrieve a single maintainer-published `announcements.json` feed. It SHALL display a concise announcement only if its identifier is unique, its content is valid and bounded, it applies to the running package version, it has not expired, and that identifier has not been displayed before. An announcement SHALL supply its own action text; a details document or link MUST NOT be required. An announcement explicitly requiring an upgrade SHALL replace the ordinary upgrade reminder in the same launch. The remote feed MUST NOT control execution, install packages, alter profile behavior, or add text to the agent's prompts.

#### Scenario: Applicable first-time announcement
- **WHEN** an unexpired, valid announcement applies to the installed version and its identifier has not been displayed
- **THEN** its concise message and action are displayed and the identifier is recorded for subsequent launches

#### Scenario: Wrong version or expired announcement
- **WHEN** an announcement does not apply to the installed version or has passed its expiry
- **THEN** it is not displayed, including when it came from a locally cached response

#### Scenario: Upgrade action takes precedence
- **WHEN** an applicable announcement explicitly requires an upgrade and a newer installable version is known
- **THEN** the announcement is displayed and the ordinary upgrade reminder is suppressed for that launch

#### Scenario: Untrusted instructions in announcement text
- **WHEN** an announcement body contains instructions to alter the agent's behavior
- **THEN** it remains notification text only and does not enter the agent's system prompt or command execution path

### Requirement: Best-effort remote checks and global history

Remote checks SHALL use a bounded duration and SHALL NOT delay Pi startup, change its exit code, or prevent profile activation. Remote results SHALL be refreshed no more often than once per day per source during normal operation; cache and displayed-history SHALL survive separate launches and SHALL be shared across profiles and projects, not stored in project content or a reclaimable instance directory. Within one launch, a notice MUST NOT be displayed twice. Displayed history SHALL be consulted when a launch evaluates its candidates and is not synchronized across Pi processes that overlap in time; two overlapping launches are not required to display a given notice only once overall. In offline operation or when a remote request fails, the system SHALL use previously validated cached results if available and SHALL otherwise omit the notification. Invalid remote content MUST NOT replace a valid cache and SHALL produce a bounded diagnostic identifying the failing source; expected offline or network failures MUST NOT spam users. A request still pending when Pi exits MUST NOT keep the process alive just to finish a check.

#### Scenario: Cache reuse
- **WHEN** a second launch happens before the refresh interval elapses
- **THEN** no new remote request is required and the locally cached data is used

#### Scenario: Offline launch
- **WHEN** the existing Pi offline mode is enabled or remote access is unavailable at launch
- **THEN** Pi starts normally, using previously validated cached results when available and otherwise showing no remote notice; explicit offline mode does not initiate remote requests

#### Scenario: Invalid announcement feed
- **WHEN** the remote announcement response is malformed or violates the announcement limits
- **THEN** previously valid cached announcements remain usable and the failure produces a bounded, actionable diagnostic without blocking startup

#### Scenario: Slow network and short-lived process
- **WHEN** a remote check has not completed by the time a non-interactive Pi process exits
- **THEN** the process exits without waiting for that check; a later launch can use successfully cached information

#### Scenario: Overlapping launches
- **WHEN** two launches evaluate the same not-yet-recorded notice before either records it
- **THEN** each launch displays the notice at most once, and neither launch is required to suppress it because of the other; a launch that evaluates after either recorded the notice does not display it again

### Requirement: Startup-only mode-safe delivery

Startup notices SHALL be presented in Pi's interactive UI when available and on stderr in non-interactive modes. They MUST NOT be written to stdout, inserted into structured Pi output, or injected into the agent's prompts. The notice check SHALL run once per Pi process launch, not again on session reload, profile switching, new, resume, or fork. The notifier SHALL behave the same for the `default` and named profiles and MUST NOT change their resource selection, trust determination, Pi arguments, settings, or session behavior.

#### Scenario: Interactive launch
- **WHEN** an eligible notice is available during an interactive Pi launch
- **THEN** it appears as an in-session notification rather than only in pre-TUI launcher output

#### Scenario: Non-interactive launch
- **WHEN** an eligible notice is available in a non-interactive mode
- **THEN** it is printed only to stderr and stdout retains Pi's native output format

#### Scenario: Profile reload does not rerun notices
- **WHEN** a notice has been considered and the same Pi process reloads or switches profiles
- **THEN** no second startup notice check or display is triggered by that session event

### Requirement: Native MCP Pi version compatibility

The package SHALL declare a Pi peer dependency that excludes releases lacking Pi's native MCP extension. The exact supported version range SHALL defer to `package.json`; the development dependency SHALL have the same lower bound. Normal npm peer resolution MUST reject an already-installed Pi release outside that range rather than postponing the incompatibility until launch.

#### Scenario: Unsupported Pi release

- **WHEN** a user installs pi-profile-switch alongside a Pi release without native MCP under normal npm peer resolution
- **THEN** the declared Pi peer range rejects that release

#### Scenario: Supported Pi release

- **WHEN** a user installs pi-profile-switch alongside a Pi release satisfying the declared supported range
- **THEN** the Pi peer constraint allows that installation

### Requirement: Sparse native subagent settings materialization

When a profile declares effective subagent overrides, its instance settings SHALL replace only explicitly declared shared fields and explicitly declared fields within named agent entries in the user's native subagent settings. Undeclared native fields and unmentioned role entries SHALL retain their original JSON values, including native fields outside the profile's supported subset.

Native false values SHALL be materialized as false, not removed. Each activation SHALL derive the result from the current real user settings, not the previous instance's overridden settings. Neither user settings nor agent definitions SHALL be modified or copied as a result of materializing overrides.

A native container that must be patched but is not an object SHALL fail activation before any managed runtime file is written. The error SHALL name the native settings file and nested path and explain how to correct the shape. Containers and entries that are not required for the declared patch MUST NOT acquire new validation requirements.

#### Scenario: Partial role override preserves native fields

- **WHEN** the user settings give reviewer a model, an inherited-context setting, and a child-tool setting, while the profile overrides only its model
- **THEN** the instance changes only the reviewer model and preserves the native context and child-tool JSON values

#### Scenario: Unrelated native subagent settings survive

- **WHEN** the user settings contain other role entries and provider-specific overrides that the profile does not declare
- **THEN** those entries and override objects remain unchanged in the instance

#### Scenario: Explicit false is written literally

- **WHEN** a profile clears a supported native role field with false or disables its advertisement with false
- **THEN** the instance settings contain the explicit false values

#### Scenario: Shared default does not rewrite role entries

- **WHEN** the profile declares only a shared child model default and the user has explicitly pinned some role models
- **THEN** materialization changes the shared default without modifying the pinned role entries

#### Scenario: Empty declaration preserves even uninspected native content

- **WHEN** the profile declares no effective child override and native subagent content has a shape outside the profile subset or an invalid nested shape
- **THEN** materialization preserves that content without introducing a new subagent-validation failure or diagnostic

#### Scenario: Required native container cannot be patched

- **WHEN** a nonempty profile role override needs to patch a native role entry that is not an object
- **THEN** activation fails before managed runtime writes, identifying the native settings file, role entry path, and object-shape remedy

#### Scenario: Untouched malformed native entry is not newly validated

- **WHEN** the profile changes only the shared child model default and an unrelated native role entry is malformed
- **THEN** the profile layer does not fail activation by inspecting that role entry, and native pi-subagents retains responsibility for its own diagnostics

#### Scenario: Real settings and agent definitions are unchanged

- **WHEN** a profile with subagent declarations launches
- **THEN** the real user settings and preexisting agent definition files have byte-identical content after activation, and no agent definition copy is created

### Requirement: Optional subagent integration and native precedence

A profile without effective subagent declarations SHALL remain usable when pi-subagents is absent and SHALL introduce no subagent-specific dependency or startup requirement. A declaration alone MUST NOT install or force-load pi-subagents; extension-reference failures SHALL continue to follow the existing extension contract.

Generated subagent settings SHALL occupy native user-level settings scope. The system MUST NOT merge project settings into the instance, rewrite native provider-specific overrides to make profile values win, or force a live role mapping over pi-subagents' own precedence. Child defaults SHALL NOT be represented as a model or tool permission ceiling.

#### Scenario: Optional extension is absent

- **WHEN** pi-subagents is not installed and the profile declares no effective subagent setting
- **THEN** launch succeeds under the existing profile rules without a subagent warning or package operation

#### Scenario: Declarations do not force a missing extension to load

- **WHEN** the profile declares child settings but pi-subagents is not otherwise loaded, and no explicit extension reference fails
- **THEN** the profile's launch is not rejected for the optional integration, no package is installed, and the runtime observation follows the in-session diagnostic contract

#### Scenario: Native project and provider precedence is preserved

- **WHEN** a native project or provider-specific role override competes with a profile-generated ordinary user-level override
- **THEN** the instance preserves both inputs and pi-subagents determines the winner through its native rules

#### Scenario: User-level extension exclusion remains effective

- **WHEN** the profile excludes the user-level pi-subagents extension through existing extension selection but declares child settings
- **THEN** the child settings do not re-add that extension or exempt it from filtering

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
