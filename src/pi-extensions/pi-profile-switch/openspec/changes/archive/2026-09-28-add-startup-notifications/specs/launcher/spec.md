# Spec Delta

## ADDED Requirements

### Requirement: Startup upgrade reminder

On a pi-profile launch, the system SHALL compare the running pi-profile-switch package version with the npm registry's installable `latest` tag. It SHALL show a concise upgrade reminder with the installed and target versions and the global-install command only when the target is newer and that target has not already been shown. It MUST NOT automatically install a package, show release notes, or use an announcement as the authoritative latest version. A target that is not newer, including when the running package is a prerelease ahead of `latest`, MUST NOT trigger a reminder.

#### Scenario: New stable version
- **WHEN** npm's installable `latest` is newer than the running package and has not been shown
- **THEN** one concise upgrade reminder names both versions and the global-install command, without release details

#### Scenario: Already shown target
- **WHEN** a later launch sees the same target version after its upgrade reminder was displayed
- **THEN** the ordinary upgrade reminder is not displayed again, regardless of the selected profile or project

#### Scenario: No newer installable version
- **WHEN** the running package is at or ahead of npm's installable `latest`
- **THEN** no ordinary upgrade reminder is displayed

### Requirement: Applicable startup announcements

The system SHALL retrieve a single maintainer-published `announcements.json` feed. It SHALL display a concise announcement only if its identifier is unique, its content is valid and bounded, it applies to the running package version, it has not expired, and that identifier has not been displayed before. An announcement SHALL supply its own action text; a details document or link MUST NOT be required. An announcement explicitly requiring an upgrade SHALL replace the ordinary upgrade reminder in the same launch. The remote feed MUST NOT control execution, install packages, alter profile behavior, or add text to the agent's prompts.

#### Scenario: Applicable first-time announcement
- **WHEN** an unexpired, valid announcement applies to the installed version and its identifier has not been displayed
- **THEN** its concise message and action are displayed and the identifier is recorded for subsequent launches

#### Scenario: Wrong version or expired announcement
- **WHEN** an announcement does not apply to the installed version or has passed its expiry
- **THEN** it is not displayed, including when it came from a locally cached response

#### Scenario: Upgrade action takes precedence
- **WHEN** an applicable announcement explicitly requires an upgrade and a newer installable version is known
- **THEN** the announcement is displayed and the ordinary upgrade reminder is suppressed for that launch

#### Scenario: Untrusted instructions in announcement text
- **WHEN** an announcement body contains instructions to alter the agent's behavior
- **THEN** it remains notification text only and does not enter the agent's system prompt or command execution path

### Requirement: Best-effort remote checks and global history

Remote checks SHALL use a bounded duration and SHALL NOT delay Pi startup, change its exit code, or prevent profile activation. Remote results SHALL be refreshed no more often than once per day per source during normal operation; cache and displayed-history SHALL survive separate launches and SHALL be shared across profiles and projects, not stored in project content or a reclaimable instance directory. In offline operation or when a remote request fails, the system SHALL use previously validated cached results if available and SHALL otherwise omit the notification. Invalid remote content MUST NOT replace a valid cache and SHALL produce a bounded diagnostic identifying the failing source; expected offline or network failures MUST NOT spam users. A request still pending when Pi exits MUST NOT keep the process alive just to finish a check.

#### Scenario: Cache reuse
- **WHEN** a second launch happens before the refresh interval elapses
- **THEN** no new remote request is required and the locally cached data is used

#### Scenario: Offline launch
- **WHEN** the existing Pi offline mode is enabled or remote access is unavailable at launch
- **THEN** Pi starts normally, using previously validated cached results when available and otherwise showing no remote notice; explicit offline mode does not initiate remote requests

#### Scenario: Invalid announcement feed
- **WHEN** the remote announcement response is malformed or violates the announcement limits
- **THEN** previously valid cached announcements remain usable and the failure produces a bounded, actionable diagnostic without blocking startup

#### Scenario: Slow network and short-lived process
- **WHEN** a remote check has not completed by the time a non-interactive Pi process exits
- **THEN** the process exits without waiting for that check; a later launch can use successfully cached information

### Requirement: Startup-only mode-safe delivery

Startup notices SHALL be presented in Pi's interactive UI when available and on stderr in non-interactive modes. They MUST NOT be written to stdout, inserted into structured Pi output, or injected into the agent's prompts. The notice check SHALL run once per Pi process launch, not again on session reload, profile switching, new, resume, or fork. The notifier SHALL behave the same for the `default` and named profiles and MUST NOT change their resource selection, trust determination, Pi arguments, settings, or session behavior.

#### Scenario: Interactive launch
- **WHEN** an eligible notice is available during an interactive Pi launch
- **THEN** it appears as an in-session notification rather than only in pre-TUI launcher output

#### Scenario: Non-interactive launch
- **WHEN** an eligible notice is available in a non-interactive mode
- **THEN** it is printed only to stderr and stdout retains Pi's native output format

#### Scenario: Profile reload does not rerun notices
- **WHEN** a notice has been considered and the same Pi process reloads or switches profiles
- **THEN** no second startup notice check or display is triggered by that session event
