# Subprocess host with generated settings

Supersedes ADR-0001. The handling of project-level resources is now decided by [ADR-0011](0011-project-scope-belongs-to-pi.md).

## Context

Resource filtering must happen before the first agent turn: exposing the full resource set to the model and then retracting it is unacceptable.

ADR-0001 asserted that Pi has no pre-start filtering seam and therefore chose to have pi-profile build its own runtime via the Pi SDK. Verification against Pi 0.85.1 refuted that premise: the seam exists, just not in the Extension API. Four facts were verified one by one:

- Settings resource arrays support exclusion patterns and attached absolute paths, enabling whitelists on top of Pi's auto-discovery.
- Project-level auto-discovery can be fully suppressed by `defaultProjectTrust: "never"`, and selected entries can then be restored via attached absolute paths.
- `PI_CODING_AGENT_DIR` can point Pi at pi-profile's own settings directory while session files stay in their real location.
- `ctx.reload()` re-reads the on-disk settings and rebuilds the runtime; the session's sessionId, session file, and message history all remain unchanged.

## Decision

`pi-profile` launches the real `pi` binary as a subprocess, passes user arguments through verbatim, and generates a profile-specific agent directory for it, in which `settings.json` encodes the profile's resource selection. The pi-profile extension inside pi performs in-session switching by rewriting that file and calling `ctx.reload()`.

User configuration files are never modified.

## Rejected alternatives

**ADR-0001's SDK host design**: the launcher builds its own runtime via the Pi SDK and hands the filtered resource graph to ResourceLoader. Rejected because the premise does not hold — the filtering seam exists, just not in the Extension API (see Context). The SDK host would additionally have to reimplement Pi's startup behavior: modes, changelog, updates, session resume.

## Consequences

- Coupling shifts from SDK host APIs to Pi's settings schema, pattern semantics, environment variables, and reload behavior. Integration tests with real Pi subprocesses guard against this drift.
- `pi install` and `pi config` write into the generated settings mid-session; the changes are lost on exit. Persistent changes go through `/profile edit` or native `pi`.
- The launcher must intercept two inputs: the positional profile name and `--approve` (the latter is reinterpreted as trust input, preventing Pi from auto-discovering unfiltered project resources).
