# Spec Delta

## MODIFIED Requirements

### Requirement: Startup upgrade reminder

On a pi-profile launch, the system SHALL compare the running pi-profile-switch package version with the npm registry's installable `latest` tag. It SHALL obtain the tag without requiring the registry's full package-metadata response to fit within the remote-response limit. It SHALL show a concise upgrade reminder with the installed and target versions and the global-install command only when the target is newer and that target has not already been shown. It MUST NOT automatically install a package, show release notes, or use an announcement as the authoritative latest version. A target that is not newer, including when the running package is a prerelease ahead of `latest`, MUST NOT trigger a reminder.

#### Scenario: New stable version
- **WHEN** npm's installable `latest` is newer than the running package and has not been shown
- **THEN** one concise upgrade reminder names both versions and the global-install command, without release details

#### Scenario: Already shown target
- **WHEN** a later launch sees the same target version after its upgrade reminder was displayed
- **THEN** the ordinary upgrade reminder is not displayed again, regardless of the selected profile or project

#### Scenario: No newer installable version
- **WHEN** the running package is at or ahead of npm's installable `latest`
- **THEN** no ordinary upgrade reminder is displayed

#### Scenario: Large package metadata with a bounded latest tag
- **WHEN** the registry's full package-metadata response exceeds the notifier's remote-response limit, but an installable `latest` tag newer than the running package is available in a bounded response and has not been shown
- **THEN** the ordinary upgrade reminder is displayed without requiring the full package-metadata response
