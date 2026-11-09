# Spec Delta

## ADDED Requirements

### Requirement: Native MCP Pi version compatibility

The package SHALL declare a Pi peer dependency that excludes releases lacking Pi's native MCP extension. The exact supported version range SHALL defer to `package.json`; the development dependency SHALL have the same lower bound. Normal npm peer resolution MUST reject an already-installed Pi release outside that range rather than postponing the incompatibility until launch.

#### Scenario: Unsupported Pi release

- **WHEN** a user installs pi-profile-switch alongside a Pi release without native MCP under normal npm peer resolution
- **THEN** the declared Pi peer range rejects that release

#### Scenario: Supported Pi release

- **WHEN** a user installs pi-profile-switch alongside a Pi release satisfying the declared supported range
- **THEN** the Pi peer constraint allows that installation
