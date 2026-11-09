# Per-profile file storage; retiring the single-file catalog and its envelope

## Context

Previously, the global and project catalogs were each stored in a single `profiles.json` file containing `{ schemaVersion: 1, profiles: { <name>: <definition> } }`.

The cost in practice:

- Oversized write granularity: creating, editing, or deleting one profile required reading the whole file and rewriting it entirely; safe concurrent editing needed a re-read-on-write mechanism.
- Poor error isolation: any JSON corruption anywhere in the single file, or one illegal profile field, failed the entire catalog read and made every other healthy profile unusable.
- No use of native filesystem capabilities: users could not view, copy, symlink, or delete a specific profile's definition directly through the filesystem.
- Maintained a legacy fallback path (`<agentDir>/profiles.json`) and the single-file envelope structure (`schemaVersion`) that were no longer necessary.

## Decision

Change the catalog from a single JSON file to a directory of one file per profile:

1. **Directory locations and file enumeration**: global profiles live in the `profiles/` directory under the workspace root (default `~/.pi-profile-switch/profiles/`, overridable via `PI_PROFILE_SWITCH_DIR`); project profiles live in `<projectDir>/.pi/profiles/`. The system only enumerates regular files with the `.json` extension; the filename minus the `.json` suffix is the profile name. Other non-`.json` entries and subdirectories are ignored; a missing directory is treated as an empty catalog.
2. **Bare definitions, no envelope**: the top-level value of each `<name>.json` file is a bare `ProfileDefinition` JSON object — no `schemaVersion` or `profiles` envelope. The profile name is authoritatively decided by the filename and does not appear inside the file.
3. **Name charset constraint**: profile names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. On the read side, a `.json` file with an illegal name is an error identifying the file path; on the write side, create and edit validate the name beforehand and state the rule.
4. **Single-file write side with atomic writes**: write operations converge to single-file granularity — create and edit write the target `<name>.json` (after validation, write a temp file in the same directory, then atomically rename), delete unlinks the corresponding file. Whole-file rewriting and re-read-on-write logic are removed.
5. **Actionable errors**: when the file format is illegal or field validation fails, the error message precisely identifies the file path, profile name, and field name at fault.
6. **Install seeding and examples**: installing the package seeds a single starter file `ask.json`, written only when no `.json` file exists in the global `profiles/` directory.

## Rejected alternatives

**Keeping the single-file `profiles.json`.** Rejected for the four costs in Context: large conflict surface, no per-file isolation, file corruption implicating everything, and multi-process wizard editing needing complex locking or re-read-on-write.

**Filename encoding mapping (e.g. percent-encoding) to support arbitrary characters (CJK, spaces, etc.)**. Introduces two identities, name and filename, inviting a second source of truth and cross-platform escaping divergence; the gain is only allowing spaces and special characters, which is unfriendly for CLI/command interaction — not worth it.

**Automatic data migration (auto-splitting the old `profiles.json` at startup).** A one-time breaking migration can be clearly documented, and manual splitting is cheap for users; auto-migration adds probing, writing, and legacy-compatibility baggage, violating minimalism.

## Consequences

- Breaking change: the old `profiles.json` is no longer supported and there is no automatic migration. Existing users must manually split the profiles inside the old file into `profiles/<name>.json` bare definitions.
- On case-insensitive filesystems (macOS / Windows defaults), two profile names differing only in case map to the same file. The system does no extra detection for case conflicts.

## Related

Behavior contracts: `openspec/specs/profile-catalog/spec.md` and `openspec/specs/launcher/spec.md`; architecture description: `docs/architecture/overview.md`.
