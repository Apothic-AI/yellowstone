# Spec Delta

## ADDED Requirements

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
