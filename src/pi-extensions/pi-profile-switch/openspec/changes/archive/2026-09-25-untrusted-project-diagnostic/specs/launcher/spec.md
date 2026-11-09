# Spec Delta

## MODIFIED Requirements

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
