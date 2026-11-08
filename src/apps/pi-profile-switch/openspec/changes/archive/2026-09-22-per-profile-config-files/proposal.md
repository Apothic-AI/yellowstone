# Proposal

## Why

All profile definitions currently live in a single `profiles.json`: editing one profile means rewriting the whole file, concurrent editing needs re-read-on-write, one corrupt profile's content fails the entire catalog, and there is no way to view, copy, or delete a single profile's definition file on its own. With one file per profile, the write side degenerates to single-file reads and writes, and errors can be pinpointed to a file.

## What Changes

- **BREAKING** The global catalog changes from `~/.pi-profile-switch/profiles.json` (single file) to the `~/.pi-profile-switch/profiles/` directory, one `<name>.json` file per profile; the filename (minus `.json`) is the profile name.
- **BREAKING** The project catalog changes from `<projectDir>/.pi/profiles.json` to the `<projectDir>/.pi/profiles/` directory, likewise one file per profile; still read only when the project is trusted.
- **BREAKING** The legacy fallback path `<agentDir>/profiles.json` and all single-file `profiles.json` read/write code are deleted, with no migration provided.
- **BREAKING** File content becomes a bare profile definition without the `schemaVersion` envelope; the `schemaVersion` validation goes with it.
- Profile names gain a charset constraint: `^[A-Za-z0-9][A-Za-z0-9._-]*$`; illegal names are an error explaining the rule.
- Override semantics unchanged: a same-named file in the project directory completely shadows the global same-named profile; all other global profiles remain visible as usual.
- Write side simplified: create/edit = write one file, delete = remove one file; whole-file overwrite and re-read-on-write logic are removed.
- When one file in the directory has illegal content the whole catalog read fails, with the error identifying the file path; non-`.json` entries are ignored.
- Install seeding changes from "write a starter catalog file" to "write one starter profile file".
- No new user-visible configuration fields: the profiles directories are discovered at fixed locations and need no configuration.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `profile-catalog`: the catalog's storage form changes from a single file to a directory of one file per profile; affects the requirements "Catalog directory locations and discovery", "Catalog file format validation", "Profile definition fields" (name constraints), "Profile create, edit, and duplicate", "Profile deletion", "Catalog writes", and "Seeding the starter profile at install".
- `launcher`: in "Project trust gating", pi-profile's project file path changes from `.pi/profiles.json` to the `.pi/profiles/` directory.

## Impact

- Code: `src/profile-catalog.ts`, `src/profile-catalog-store.ts`, `src/workspace.ts` (`resolveGlobalProfilesPath` deleted), `bin/postinstall.js`, `examples/` (seed file shape change), `schemas/` (schema authority restated for the directory form).
- Tests: catalog read/write, seeding, launcher trust-gating cases.
- Docs: README.md's path table and examples description; see Doc Impact for details.
- No dependency changes.

## Doc Impact

- `docs/prd.md`: none — the storage form is an implementation detail and does not affect product positioning or non-goals.
- `docs/architecture/overview.md`: the module table, generated-artifact and schema-authority sections need their `profiles.json` paths and seeding descriptions changed to the directory form.
- `CONTEXT.md`: the Catalog term definition changes from "the `profiles.json` file" to "the profiles directory, one file per profile".
- `docs/adr/`: add ADR-0013 recording the "one file per profile" storage decision; the rejected alternative is keeping the single-file catalog (large edit-conflict surface, errors not attributable to a single profile).
