# Spec Delta

## REMOVED Requirements

### Requirement: Profile create, edit, and duplicate

**Reason**: The system no longer performs catalog mutations. The wizard offered no resource discovery over direct file editing — users had to know exact resource names either way — and the shipped `profile-config` skill is the stronger authoring path. Read-time validation (catalog file format validation, profile name constraints) remains the safety net for externally written files.

**Migration**: Create or modify `<name>.json` in the profiles directory directly, or ask the agent (guided by the `profile-config` skill). Illegal content is reported on read.

### Requirement: Profile deletion

**Reason**: Same removal of system-performed catalog mutations; deletion is a plain file removal. The replacement-guard existed only to keep the session consistent when the system itself deleted the active profile.

**Migration**: Delete `<name>.json` directly. When deleting the active profile, switch to another profile first; otherwise the next reload fails resolution and rolls back until a switch occurs.

### Requirement: Catalog writes

**Reason**: No component writes catalog files anymore, so single-file write isolation and concurrent-write semantics have no actor. The one remaining catalog write — starter-profile seeding — is governed by its own requirement.

**Migration**: Direct file edits affect exactly the file touched; one-file-per-profile storage provides the isolation this requirement guaranteed.
