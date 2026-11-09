# Spec Delta

## MODIFIED Requirements

### Requirement: Skill reference resolution

A skill reference's identity SHALL be Pi's skill name. Resolution SHALL take Pi's own complete discovery result in a read-only manner, MUST NOT implement directory scanning of its own, and MUST NOT execute any extension code or install any package because of resolving a profile.

Same-named skills SHALL be adjudicated by Pi's existing discovery precedence.

Discovery SHALL run again on every resolution, so added or removed skills take effect on the next launch or reload.

Project-scope skills SHALL participate only when the project is trusted. Skills provided by project-scope packages MUST NOT be referenceable. Project-level skills provided by a trusted project stay in the resolution vocabulary, but their visibility does not change with the profile's selection; the narrowing boundary is in "Narrowing boundary of project-level resources".

#### Scenario: Skill not matched

- **WHEN** a profile declares a literal skill name absent from the discovery result
- **THEN** activation fails with an error identifying the name

#### Scenario: Untrusted project's skills do not participate

- **WHEN** the project is untrusted and skills exist under the project directory
- **THEN** those skills do not appear in the referenceable set and the discovery process does not scan that project

## ADDED Requirements

### Requirement: Narrowing boundary of project-level resources

A profile's skill and extension selection SHALL apply only to user-level resources: resources under the real agentDir and `~/.agents/skills`.

The visibility of project-level resources (project `.pi/skills`, project `.pi/extensions`, ancestor `.agents/skills`) SHALL be decided by Pi's project-trust determination: when the project is trusted they are visible under every profile; when untrusted, visible under none.

Project-level resources not selected by the profile MUST NOT be excluded, and project-level resources selected by the profile MUST NOT thereby be written as additional resource paths. A trusted project's project-level resources SHALL stay in the resolution vocabulary; referencing them MUST NOT fail activation as unmatched and MUST NOT produce zero-match warnings.

#### Scenario: Unselected project-level skills stay visible

- **WHEN** the project is trusted, the project contains skill A and skill B, and the active profile declares only A
- **THEN** both A and B are usable in the session

#### Scenario: Project-level references resolve successfully

- **WHEN** the project is trusted and the profile declares skill names, extension IDs, or their globs found in the project
- **THEN** resolution succeeds — neither failing on literals nor producing zero-match warnings

#### Scenario: Project-level resources do not participate when untrusted

- **WHEN** the project is untrusted and the project directory contains skills and extensions
- **THEN** neither appears in the referenceable set nor in the session
