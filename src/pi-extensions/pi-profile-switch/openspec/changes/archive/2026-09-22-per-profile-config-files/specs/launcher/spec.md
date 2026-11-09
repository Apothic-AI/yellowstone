# Spec Delta

## MODIFIED Requirements

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
