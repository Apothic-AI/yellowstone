# Spec Delta

## MODIFIED Requirements

### Requirement: Narrowing boundary of project-level resources

A profile's skill and extension selection SHALL apply only to user-level resources: resources under the real agentDir and `~/.agents/skills`.

The visibility of project-level resources (project `.pi/skills`, project `.pi/extensions`, ancestor `.agents/skills`) SHALL be decided by Pi's project-trust determination: when the project is trusted they are visible under every profile; when untrusted, visible under none.

Project-level resources not selected by the profile MUST NOT be excluded, and project-level resources selected by the profile MUST NOT thereby be written as additional resource paths. A trusted project's project-level resources SHALL stay in the resolution vocabulary; referencing them MUST NOT fail activation as unmatched and MUST NOT produce zero-match warnings.

A named profile MUST NOT make visible a user-level skill that the user's own settings exclude. The user's `!pattern` and `-path` skill entries SHALL stay effective in a named profile's session, with the same meaning they have under plain Pi.

#### Scenario: Unselected project-level skills stay visible

- **WHEN** the project is trusted, the project contains skill A and skill B, and the active profile declares only A
- **THEN** both A and B are usable in the session

#### Scenario: Project-level references resolve successfully

- **WHEN** the project is trusted and the profile declares skill names, extension IDs, or their globs found in the project
- **THEN** resolution succeeds — neither failing on literals nor producing zero-match warnings

#### Scenario: Project-level resources do not participate when untrusted

- **WHEN** the project is untrusted and the project directory contains skills and extensions
- **THEN** neither appears in the referenceable set nor in the session

#### Scenario: User exclusions stay effective under a named profile

- **WHEN** the user's settings exclude an agentDir skill and a `~/.agents/skills` skill with `!skills/**`, force-include one agentDir skill with `+`, and a named profile declares `skills: ["*"]`
- **THEN** the session shows the force-included skill and neither excluded skill
