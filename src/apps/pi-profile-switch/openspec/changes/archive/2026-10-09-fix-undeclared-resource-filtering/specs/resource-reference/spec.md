# Spec Delta

## ADDED Requirements

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
- **THEN** the literal fails activation and the glob produces the existing non-fatal warning rather than changing the selection into native pass-through

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
