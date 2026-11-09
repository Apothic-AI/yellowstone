# Proposal

## Why

Users cannot tell when their installed pi-profile-switch is behind the published stable release, and maintainers cannot notify older installed versions about urgent problems without releasing new code. Startup is the useful delivery point, but routine release details would interrupt users unnecessarily.

## What Changes

- Check the running package against npm's installable `latest` version and show a short upgrade reminder once per target version, without release notes or automatic upgrades.
- Retrieve maintainer-reviewed announcements from one repository-hosted `announcements.json`; show only applicable, unexpired, not-yet-shown notices with a concise action. An announcement calling for an upgrade replaces the ordinary upgrade reminder on that launch.
- Cache remote results and display history across launches, tolerate offline and invalid responses without blocking Pi, and render in the native TUI or stderr without changing Pi's structured output.
- Keep notification handling independent of profiles, project trust, Pi settings, and the agent's prompt. The feed requires machine-readable identity, applicability, expiry, and text; discovery cannot infer these from installed packages and defaults cannot distinguish affected versions. No profile configuration field or notification command is added.

## Capabilities

### New Capabilities

None. Startup notices belong to the existing launcher domain.

### Modified Capabilities

- `launcher`: add startup version and announcement notification behavior, delivery boundaries, persistence, and failure handling.

## Impact

Startup notification logic will use the npm registry and a fixed GitHub-hosted announcement file, a separate global cache/display record, and the existing pi-profile extension for TUI presentation. Launcher and extension startup integration and mode-specific integration tests will change. There are no new runtime dependencies planned, no automatic package installation, and no changes to catalog formats or Pi arguments.

## Doc Impact

- `docs/prd.md`: add the limited startup-notification product goal while keeping the package-manager non-goal intact.
- `docs/architecture/overview.md`: document notification ownership, cache location, and startup presentation boundary.
- `CONTEXT.md`: none: existing terms cover profiles and runtime state; notification records do not redefine either.
- `docs/adr/`: add a numbered decision for the long-lived remote announcement address and structured feed, including rejected release-bound and Markdown-only alternatives.
- `README.md` and `README.zh-CN.md`: document reminder behavior, network sources, and the global install upgrade command.
