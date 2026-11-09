# Spec Delta

## MODIFIED Requirements

### Requirement: Best-effort remote checks and global history

Remote checks SHALL use a bounded duration and SHALL NOT delay Pi startup, change its exit code, or prevent profile activation. Remote results SHALL be refreshed no more often than once per day per source during normal operation; cache and displayed-history SHALL survive separate launches and SHALL be shared across profiles and projects, not stored in project content or a reclaimable instance directory. Within one launch, a notice MUST NOT be displayed twice. Displayed history SHALL be consulted when a launch evaluates its candidates and is not synchronized across Pi processes that overlap in time; two overlapping launches are not required to display a given notice only once overall. In offline operation or when a remote request fails, the system SHALL use previously validated cached results if available and SHALL otherwise omit the notification. Invalid remote content MUST NOT replace a valid cache and SHALL produce a bounded diagnostic identifying the failing source; expected offline or network failures MUST NOT spam users. A request still pending when Pi exits MUST NOT keep the process alive just to finish a check.

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

#### Scenario: Overlapping launches

- **WHEN** two launches evaluate the same not-yet-recorded notice before either records it
- **THEN** each launch displays the notice at most once, and neither launch is required to suppress it because of the other; a launch that evaluates after either recorded the notice does not display it again
