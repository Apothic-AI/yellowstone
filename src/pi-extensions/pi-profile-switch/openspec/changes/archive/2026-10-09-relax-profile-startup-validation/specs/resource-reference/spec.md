# Spec Delta

## MODIFIED Requirements

### Requirement: Sparse skill and extension selection

A named profile SHALL distinguish an omitted `skills` or `extensions` field from an explicitly empty array. Each field SHALL control only its own resource kind. An omitted field SHALL preserve Pi's native visibility for that kind; an empty array SHALL select no referenceable user-level resources of that kind; a nonempty array SHALL follow the existing reference-resolution and failure-tiering contracts.

Native visibility SHALL include resources enabled through the user's native resource settings and package filters, not only resources expressible through a profile name or glob. Native exclusions MUST remain effective. Pi's native built-in extension enable/disable controls MUST retain their meaning under omitted and declared profile selections; their identities and control syntax SHALL defer to Pi's own settings and extension registry.

The existing "Narrowing boundary of project-level resources", "Tool reference resolution", "MCP server reference resolution", and "Per-server MCP tool selection" requirements SHALL remain applicable.

#### Scenario: Omitted skills preserve native visibility

- **WHEN** a named profile omits `skills` and Pi discovers enabled user-level skills from its ordinary discovery sources
- **THEN** activation leaves those skills visible, including enabled package skills, without creating an empty selection

#### Scenario: Omitted extensions preserve native visibility

- **WHEN** a named profile omits `extensions` and the user has enabled loose extensions, package extensions, and a native settings-only extension outside standard directories
- **THEN** activation preserves all of those extensions' native visibility

#### Scenario: Empty selections remain restrictive

- **WHEN** a named profile explicitly declares an empty `skills` or `extensions` array
- **THEN** no referenceable user-level resource of that kind is selected; omission is not substituted for the empty array

#### Scenario: Skill-only selection preserves extensions

- **WHEN** a named profile declares only a skill selection, including an empty one
- **THEN** user-level skills follow that selection while extensions retain native visibility

#### Scenario: Extension-only selection preserves skills

- **WHEN** a named profile declares only an extension selection, including an empty one
- **THEN** referenceable user-level extensions follow that selection while skills retain native visibility

#### Scenario: Declared references retain validation

- **WHEN** an explicit skill or extension selection contains an unmatched literal or a zero-match glob
- **THEN** unmatched literals and zero-match globs produce non-fatal diagnostics, retain successful matches, and do not change the explicit selection into native pass-through

#### Scenario: Native exclusions remain effective

- **WHEN** native settings or package filters disable a skill or extension and a profile omits that kind or selects it through a glob
- **THEN** activation does not make the disabled resource visible, and native force-inclusion exceptions retain their native precedence

#### Scenario: Native built-in extension controls remain effective

- **WHEN** native settings disable a Pi built-in extension, including through a broad exclusion with an explicit native inclusion exception, and a named profile omits `extensions` or declares a reference list
- **THEN** activation retains the resulting native built-in extension enable/disable state without requiring the profile to name those native extensions

#### Scenario: MCP and tool omission stays unchanged

- **WHEN** a named profile omits `mcps` and `tools` and declares no per-server MCP tool policy or tool overlay
- **THEN** no additional MCP server policy or active-tool selection is imposed by the profile; tools supplied only by an excluded extension follow that extension's loading

#### Scenario: Project resources retain their trust boundary

- **WHEN** a profile omits or explicitly empties either resource field in a trusted or untrusted project
- **THEN** project-level visibility continues to follow the existing project-trust boundary rather than the profile field

### Requirement: Subagent override resolution boundaries

Resolution SHALL preserve the profile's validated native subagent declaration without treating its role keys as selectable Resources, registering agents, expanding globs, or applying Resource-reference failure tiering to those keys. Effectively empty declarations SHALL contribute no subagent override to activation.

The declaration alone MUST NOT import pi-subagents, execute extension code, discover agent files, install packages, contact providers, or require child-model authentication. Parent-model declarations SHALL follow "Resolution and validation of profile-level settings fields"; that contract MUST NOT be reused to reinterpret child model strings. Final child-model selection, native clearing behavior, runner-specific model handling, and launch failures SHALL remain owned by pi-subagents.

Agent names and advertisement or description declarations MUST NOT enable delegation, alter child prompts directly, or filter unmentioned agents. Existing extension and tool selection SHALL remain the only profile-controlled loading and parent-tool mechanisms in this change.

#### Scenario: Omitted or empty child declarations remain absent from activation

- **WHEN** a profile declares no effective subagent override
- **THEN** activation contains no additional child override and performs no subagent-specific dependency or discovery work

#### Scenario: Child model does not invoke parent-model validation

- **WHEN** a profile declares a child model but no parent model declaration
- **THEN** activation carries the child model string without invoking parent-model authentication or requiring a child-model registry

#### Scenario: Native model syntax is preserved

- **WHEN** a role model contains the native inheritance marker, a provider-qualified model with a thinking suffix, or an external runner's model alias
- **THEN** resolution preserves the nonempty string for pi-subagents rather than translating it into a parent-model declaration

#### Scenario: Unknown role keys are not missing Resource references

- **WHEN** a profile declares an exact role name that is not currently registered
- **THEN** activation retains its override without creating an agent or failing Resource-reference validation, and does not claim that the role exists

#### Scenario: A single role override does not narrow other roles

- **WHEN** a profile overrides only the reviewer and pi-subagents can discover additional roles
- **THEN** the override declaration introduces no availability restriction for the other roles

#### Scenario: Child declaration does not select the extension or tools

- **WHEN** a profile declares subagent overrides without selecting the user-level pi-subagents extension or delegation tools
- **THEN** resolution does not add the extension, grant tools, or alter the existing project-resource boundary

### Requirement: Skill reference resolution

A skill reference's identity SHALL be Pi's skill name. Resolution SHALL use Pi's complete read-only discovery result, MUST NOT implement independent skill directory scanning, and MUST NOT execute extensions or install packages. Pi's existing discovery precedence SHALL decide same-named skills.

Discovery SHALL run on every resolution. Project-scope skills SHALL participate only when trusted; skills provided by project-scope packages MUST NOT become referenceable. Trusted project-level visibility SHALL follow "Narrowing boundary of project-level resources" independently of profile selection.

A missing literal skill reference SHALL follow "Unified failure tiering for references".

#### Scenario: Skill not matched
- **WHEN** a profile names a skill absent from discovery
- **THEN** activation continues with a warning identifying the skipped reference

#### Scenario: Untrusted project's skills do not participate
- **WHEN** an untrusted project contains skills
- **THEN** its skills do not participate in resolution and discovery does not scan that project

### Requirement: Failure behavior of extension references

An unknown literal SHALL produce a non-fatal diagnostic with discovered candidates and near-miss hints when available. A relative path SHALL be skipped with a warning explaining the required absolute or home-relative form; resolution MUST NOT guess its base directory. A nonexistent path or a selected package with no usable entries SHALL be skipped with a warning stating the cause and correction.

These failures SHALL NOT discard other usable references. Zero-match globs SHALL remain non-blocking. No failure SHALL install a package or execute an extension during discovery.

#### Scenario: Unknown literal reference
- **WHEN** a reference matches no extension name, alias, or usable path
- **THEN** activation continues without that extension and warns with candidates and available near-miss hints

#### Scenario: Relative-path reference
- **WHEN** a profile supplies a relative extension path
- **THEN** activation continues, skips that reference, and warns that an absolute or home-relative path is required

#### Scenario: Package has no usable extension entries
- **WHEN** a selected package has no usable entries
- **THEN** activation continues and warns that the package contributes no extension

#### Scenario: Extension path does not exist
- **WHEN** a selected extension path is absent
- **THEN** activation continues with a warning naming the path and loads other usable selected extensions

### Requirement: MCP server reference resolution

MCP server identity SHALL be a name in the merged user-level configuration snapshot. Source precedence SHALL defer to `src/mcp-config.ts`; each later valid source definition SHALL replace an earlier same-named definition in full without inheriting its connection, credential, or exposure fields.

Trusted project configuration SHALL remain classification-only and outside the generated user-level snapshot. Untrusted project configuration MUST NOT be read.

Malformed user-level sources SHALL be diagnosed by path and skipped, with or without an explicit MCP policy. Valid sources SHALL still merge in precedence order. A malformed trusted-project classification source SHALL NOT block resolution; Pi SHALL retain ownership of its project-file diagnostics. Unexpected filesystem failures SHALL remain errors rather than being misreported as malformed JSON.

Missing names, project-owned names selected through user-level policy, and source-disabled names SHALL produce non-fatal warnings. They MUST NOT force-enable a disabled server or narrow a project-owned server. Explicit `mcps` selection SHALL retain its declaration intent even if no usable server remains. Transport usability SHALL be judged by Pi; the profile layer MUST NOT reject a selected server solely because of a launcher-maintained transport inventory.

#### Scenario: Untrusted project's MCP configuration does not participate
- **WHEN** an untrusted project contains MCP configuration
- **THEN** that file is not read and its servers do not participate in resolution

#### Scenario: Illegal MCP configuration content
- **WHEN** a profile declares `mcps` and a user-level MCP source has invalid JSON or an invalid required container shape
- **THEN** activation continues, warns with the source path, and uses valid sources without removing the selection restriction

#### Scenario: Invalid source without MCP policy
- **WHEN** no effective MCP policy is declared and one source is malformed while another is valid
- **THEN** activation continues with a path-bearing diagnostic and the valid server definition participates

#### Scenario: Malformed trusted-project classification without MCP policy
- **WHEN** a trusted project's classification source is malformed and no MCP policy is declared
- **THEN** profile activation continues without merging project content into the snapshot and Pi handles the native project diagnostic

#### Scenario: Malformed trusted-project classification with MCP policy
- **WHEN** a trusted project's classification source is malformed and a profile declares an MCP policy
- **THEN** profile activation continues and does not rewrite or claim control of that project file

#### Scenario: Empty tool policy does not demand valid configuration
- **WHEN** `mcp_tools` is empty, `mcps` is omitted, and a user-level source is malformed
- **THEN** activation continues with a diagnostic naming the malformed source

#### Scenario: Later user-level source overrides an earlier one per server name
- **WHEN** a later valid source changes a server URL and omits earlier authorization fields
- **THEN** the winning definition contains no inherited authorization fields

#### Scenario: Project-owned server cannot be selected
- **WHEN** a profile selects a project-owned server through `mcps`
- **THEN** activation continues with a boundary warning and that server remains governed by Pi's project read

#### Scenario: Unknown server name
- **WHEN** `mcps` names a server absent from valid user-level sources
- **THEN** activation continues with a warning and usable candidates without inventing a connection definition

#### Scenario: Explicitly selected server is disabled in source
- **WHEN** `mcps` selects a source-disabled server
- **THEN** activation continues, warns how to enable it at the source or remove the selection, and the server remains disabled

#### Scenario: Empty selection without any MCP extension
- **WHEN** a named profile explicitly selects no MCP servers
- **THEN** activation continues without requiring an MCP extension and the selection remains explicitly empty

#### Scenario: Selected server uses a transport Pi cannot use
- **WHEN** a selected server's transport cannot be used by Pi
- **THEN** the profile layer preserves its selected definition without a transport preflight rejection and Pi handles the native error

#### Scenario: Unselected server with a bad transport passes through
- **WHEN** `mcps` is omitted and a snapshot server uses a transport Pi cannot use
- **THEN** activation continues, preserves the definition, and Pi handles its native error

### Requirement: Resolution and validation of profile-level settings fields

Profile model, thinking, and instruction fields SHALL remain optional. Undeclared fields MUST NOT add overrides. Provider and model fields SHALL constitute a model declaration only when both are declared; otherwise a parent thinking declaration SHALL remain ignored as under the existing contract.

A complete model declaration SHALL be preserved for native Pi settings without launcher-side existence or authentication validation and without loading extensions in the launcher. Pi SHALL own model resolution, availability, credentials, native precedence, fallback, and actual request errors. The profile layer MUST NOT emit a model-missing warning solely because its pre-extension registry cannot see the declaration.

Accepted thinking values SHALL defer to Pi's authoritative thinking-level contract. An unsupported string in a complete parent model declaration SHALL warn and contribute no thinking override; the model declaration itself SHALL remain. Field-type errors SHALL follow the profile-catalog contract.

#### Scenario: Illegal thinkingLevel
- **WHEN** a complete model declaration includes an unsupported thinking-level string
- **THEN** activation continues with a warning and no profile thinking override while retaining provider and model

#### Scenario: Only thinkingLevel declared
- **WHEN** a profile declares parent thinking without a complete model declaration
- **THEN** thinking is neither validated nor applied and Pi's native input remains unchanged

#### Scenario: Declared model fails validation
- **WHEN** a declared model is not statically known or authenticated before extensions load
- **THEN** the profile layer does not reject activation and passes the model declaration to Pi

#### Scenario: Validation not skipped when no validation means
- **WHEN** model resolution has no launcher-side validation facility
- **THEN** activation still carries the declaration rather than requiring or fabricating a validation result

#### Scenario: Extension provider becomes available
- **WHEN** a selected extension registers the profile's declared provider during native loading
- **THEN** Pi can select that model without a profile-layer preflight rejection

### Requirement: Unified failure tiering for references

Unmatched literals and zero-match globs in profile resource selections SHALL produce non-fatal diagnostics. Each skipped literal diagnostic SHALL identify the profile, kind, reference, effect, and available correction or candidates. Successful references SHALL remain effective. Diagnostics SHALL be visible at activation and in status without modifying source definitions.

An explicit selection MUST NOT become omission or unrestricted access when its references fail. When all references fail, its user-level selection SHALL be empty. Missing references SHALL be re-evaluated from the unchanged definition on subsequent launch or reload.

Pi tool references SHALL retain their deferred live-registry validation. Literal `mcp_tools` selectors SHALL remain restrictive policy inputs without missing-tool-name validation. Runtime overlay mutation errors SHALL retain their separate in-session contract.

#### Scenario: Different outcomes for literals and globs
- **WHEN** a profile references a missing literal skill and a zero-match skill glob
- **THEN** activation continues and both misses are diagnosed rather than either aborting activation

#### Scenario: Partial selection stays restrictive
- **WHEN** a declared resource selection contains one usable reference and one missing reference
- **THEN** only the usable selected user-level resource is made available and the miss is diagnosed

#### Scenario: All missing references retain an empty selection
- **WHEN** every reference in a declared resource selection is missing
- **THEN** activation continues with an explicitly empty user-level selection instead of restoring the native full selection

#### Scenario: Previously missing resource becomes available
- **WHEN** a skipped resource is installed and the profile is activated again
- **THEN** the original reference resolves without any profile-file rewrite

### Requirement: Per-server MCP tool selection

`mcp_tools` SHALL narrow each named eligible user-level server independently of `tools`, exposing only literal tool selectors matched by Pi's built-in MCP extension. Selector spellings SHALL follow Pi's authoritative registered-name contract rather than adapter-era aliases. A server not named in `mcp_tools` SHALL retain its configured tool availability. Empty objects SHALL change nothing; empty server lists SHALL deny all callable tools while leaving server non-tool functions intact. A nonempty policy SHALL replace the server's merged tool exposure wholesale.

A missing, disabled, or project-owned server key SHALL produce an actionable non-fatal warning instead of aborting activation. Policy input SHALL be retained for diagnostics and re-resolution without creating a server, force-enabling it, changing project-owned resources, or treating a disabled policy as unrestricted. If a named user-level server is enabled, its declared policy MUST be materialized before it becomes callable.

Selectors SHALL NOT be checked against a server's tool catalog or produce missing-tool-name diagnostics. An unmatched selector SHALL remain restrictive across direct and indirect invocation, including tools discovered later. Empty or absent policy SHALL add no MCP discovery requirement.

#### Scenario: Missing server key defaults to all tools
- **WHEN** an enabled server is not named in `mcp_tools`
- **THEN** its tools retain native availability independently of `tools`

#### Scenario: Explicit per-server whitelist
- **WHEN** a server offers selected and unselected tools
- **THEN** only tools matching its selectors are callable through direct and indirect routes

#### Scenario: Prefixed adapter alias no longer matches
- **WHEN** a selector uses an adapter-era alias rather than a registered tool name
- **THEN** unmatched tools remain hidden without a selector-validity warning

#### Scenario: Empty server list denies all tools
- **WHEN** a server is assigned an empty selector list
- **THEN** it exposes no callable MCP tools while retaining its enabled non-tool functions

#### Scenario: Server name typo fails before activation
- **WHEN** a policy names a server absent from the merged snapshot
- **THEN** activation continues with a server-name warning and usable candidates, without creating an unrestricted server

#### Scenario: Special-looking unknown server is not discovered
- **WHEN** a policy names a special-looking property absent from the snapshot's own server entries
- **THEN** activation warns and does not treat an inherited property as a discovered server

#### Scenario: Unmatched literal selector stays restrictive without a diagnosis
- **WHEN** a literal selector matches no registered tool on an eligible server
- **THEN** all unselected tools remain unavailable and no selector-validity diagnostic is produced

#### Scenario: Profile policy replaces merged tool exposure
- **WHEN** a declared selector names a tool hidden in the merged source exposure
- **THEN** that tool follows the profile's replacement policy and every unlisted tool remains hidden

#### Scenario: Project-only server is outside the narrowing boundary
- **WHEN** a policy names a project-only server
- **THEN** activation continues with a boundary warning and the project server remains unchanged

#### Scenario: Disabled server policy stays non-enabling
- **WHEN** a named policy server is source-disabled or excluded by `mcps`
- **THEN** activation continues with a warning and does not enable the server or remove its declared restriction
