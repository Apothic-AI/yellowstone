# Spec Delta

## Purpose

Defines what a profile can reference, how those references resolve, and which resolution failures block activation versus only produce warnings. It is the shared resolution contract of both the launch and the switching paths.

## ADDED Requirements

### Requirement: Skill reference resolution

A skill reference's identity SHALL be Pi's skill name. Resolution SHALL take Pi's own complete discovery result in a read-only manner, MUST NOT implement directory scanning of its own, and MUST NOT execute any extension code or install any package because of resolving a profile.

Same-named skills SHALL be adjudicated by Pi's existing discovery precedence.

Discovery SHALL run again on every resolution, so added or removed skills take effect on the next launch or reload.

Project-scope skills SHALL participate only when the project is trusted. Skills provided by project-scope packages MUST NOT be referenceable.

#### Scenario: Skill not matched

- **WHEN** a profile declares a literal skill name absent from the discovery result
- **THEN** activation fails with an error identifying the name

#### Scenario: Untrusted project's skills do not participate

- **WHEN** the project is untrusted and skills exist under the project directory
- **THEN** those skills do not appear in the referenceable set and the discovery process does not scan that project

### Requirement: Extension reference resolution

The referenceable forms of an extension reference SHALL include: package name, `<package>:<relative path>` entry ID of multi-entry packages, package source alias, IDs of loose files under standard extension directories, globs, and absolute or `~/` paths.

A loose file's ID SHALL be its path relative to the extension directory minus the `.ts` or `.js` suffix; a directory-style extension's `index.<ext>` SHALL collapse to the directory name.

Discovery SHALL be read-only: it MUST NOT install packages, MUST NOT touch the network, MUST NOT modify the filesystem, and MUST NOT import extension modules.

#### Scenario: Package selected by package name or source alias

- **WHEN** an installed package has a single extension entry and the profile references its package name or its source alias
- **THEN** that package's entry is selected

#### Scenario: Multi-entry package selected by entry ID

- **WHEN** an installed package has multiple extension entries and the profile references `<package>:<relative path>`
- **THEN** only that entry is selected

#### Scenario: Loose file selected by ID

- **WHEN** the extension directory contains `conventions.ts`, or `sub/index.ts`
- **THEN** the former is referenceable as `conventions` and the latter as `sub`

### Requirement: Failure behavior of extension references

An unknown literal reference SHALL fail activation; the error SHALL list the discovered candidate names and provide near-miss hints when they exist.

A relative-path reference SHALL fail activation; the error SHALL explain that an absolute or `~/` path is required.

A path reference MUST point at an existing extension file; when the file does not exist it SHALL fail activation.

When none of a package's entries is usable it SHALL fail activation; the error SHALL explain that the package declares no usable extension entries.

A zero-match glob reference SHALL NOT block activation.

#### Scenario: Unknown literal reference

- **WHEN** a profile references a name that is neither a package name, nor a loose-file ID, nor an existing path
- **THEN** activation fails with an error listing the discovered candidates and providing near-miss hints

#### Scenario: Relative-path reference

- **WHEN** a profile references an extension as `./local.ts`
- **THEN** activation fails with an error explaining that an absolute or `~/` path is required

#### Scenario: Package has no usable extension entries

- **WHEN** a profile references a configured package whose entries are all missing or filtered out
- **THEN** activation fails with an error explaining that the package declares no usable extension entries

### Requirement: Extension ID collisions

When a loose file and a package name produce the same ID, the loose file SHALL win, the system SHALL log a warning, and the package SHALL remain selectable via its source alias.

#### Scenario: Loose file with the same name as a package

- **WHEN** the extension directory contains a loose extension with the same name as an installed package
- **THEN** referencing that name selects the loose file, produces a warning, and the package remains selectable via its source alias

### Requirement: MCP server reference resolution and the adapter dependency

An MCP server reference's identity SHALL be a server name discovered in `pi-mcp-adapter` configuration.

Discovery SHALL read the standard configuration locations recognized by the adapter; project-scope configuration SHALL be read only when the project is trusted. When configuration content is illegal the system SHALL report an error identifying the file path and MUST NOT silently read it as "no servers".

When a profile declares MCP servers while the adapter's discovery result is unavailable, activation SHALL fail: this covers both the adapter being inactive and no usable server discovery result.

A profile that declares no MCP servers MUST NOT depend on the adapter because of that.

#### Scenario: Untrusted project's MCP configuration does not participate

- **WHEN** the project is untrusted and an MCP configuration file exists under the project directory
- **THEN** the servers in that file do not appear in the referenceable set and the file is not read

#### Scenario: Illegal MCP configuration content

- **WHEN** an MCP configuration at a standard location is not legal JSON, or is not an object
- **THEN** an error is reported identifying the file path, instead of reading it as "no servers"

#### Scenario: MCP servers declared but adapter unavailable

- **WHEN** a profile declares `mcps` while `pi-mcp-adapter` is not active
- **THEN** activation fails with an error explaining that the adapter must be selected in the profile's extensions, or the `mcps` declaration must be removed

#### Scenario: Unknown server name

- **WHEN** a profile declares a server name the adapter has not discovered
- **THEN** activation fails with an error identifying the name

### Requirement: Tool reference resolution

A tool reference's identity SHALL be Pi's tool name. References SHALL be expanded against Pi's tool registry at that moment.

Before spawn, resolution SHALL expand only against built-in tool names, because tools contributed by extensions are unknowable until extension code runs. After session start, the extension SHALL re-expand the original references against the live registry that includes extension and MCP tools.

When `tools` is undeclared, the resolution result MUST NOT contain a tools field and Pi's current available tool set SHALL remain unchanged.

Literal tool references SHALL NOT be validated or recorded at resolution time; literals for which no tool is provided SHALL be reported by the post-session-start expansion and MUST NOT be silently dropped.

#### Scenario: Only built-in tools expanded before spawn

- **WHEN** a profile declares a glob that only matches extension-contributed tools
- **THEN** the pre-spawn resolution contains no results for that glob and does not fail because of it

#### Scenario: Live registry expansion after session start

- **WHEN** the session starts and the extension expands the original references against the live registry
- **THEN** globs cover tools provided by extensions and MCP, and literals without a corresponding tool are reported

#### Scenario: tools undeclared

- **WHEN** a profile does not declare `tools`
- **THEN** the resolution result contains no tools field and Pi's current available tool set is not modified

### Requirement: Resolution and validation of profile-level settings fields

`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `instructions` SHALL all be optional. Undeclared fields MUST NOT enter the resolution result.

`defaultProvider` and `defaultModel` constitute a model declaration only when declared together. When only one is declared, the model declaration does not hold and `defaultThinkingLevel` is ignored along with it.

When the model declaration holds, `defaultThinkingLevel` SHALL come from a fixed set; a value outside the set SHALL fail activation. The model SHALL be validated to exist and be authenticated; failed validation, or the absence of any usable validation means, SHALL fail activation and MUST NOT be skipped.

#### Scenario: Illegal thinkingLevel

- **WHEN** a profile declares `defaultProvider`, `defaultModel`, and a `defaultThinkingLevel` outside the allowed set
- **THEN** activation fails with an error identifying the value

#### Scenario: Only thinkingLevel declared

- **WHEN** a profile declares `defaultThinkingLevel` without `defaultProvider` and `defaultModel`
- **THEN** the thinking level is ignored — neither validated nor effective — and Pi's current thinking level remains unchanged

#### Scenario: Declared model fails validation

- **WHEN** the model declared by the profile does not exist or is not authenticated
- **THEN** activation fails with an error identifying the model and the failure reason

#### Scenario: Validation not skipped when no validation means

- **WHEN** a profile declares a model and the caller provides no model-validation capability
- **THEN** activation fails instead of being treated as passed

### Requirement: Unified failure tiering for references

Reference resolution SHALL be tiered by error certainty and MUST NOT silently drop any reference.

An unmatched literal SHALL fail activation. A zero-match glob SHALL be collected as a warning item, visible in launch output and status queries, without blocking activation.

Tools are the only exception: their references are unknowable before spawn, so they neither fail on a miss nor get recorded as warning items.

#### Scenario: Different outcomes for literals and globs

- **WHEN** a profile references both a nonexistent literal skill name and a zero-match skill glob
- **THEN** activation fails because of the literal, while the glob itself only produces a warning item
