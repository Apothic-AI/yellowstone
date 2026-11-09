# Design

## Context

Status quo: the global and project catalogs are each a single `profiles.json` containing `{ schemaVersion, profiles: { <name>: <definition> } }`. The read side `ProfileCatalog` (`src/profile-catalog.ts`) parses the whole file; the write side `ProfileCatalogStore` (`src/profile-catalog-store.ts`) rewrites the whole file with re-read-on-write; `bin/postinstall.js` seeds from `examples/profiles.json`; `resolveGlobalProfilesPath` in `src/workspace.ts` maintains the legacy fallback. Motivation in proposal.md "Why".

## Goals / Non-Goals

**Goals:**

- One file per profile: global `<workspaceRoot>/profiles/<name>.json`, project `<projectDir>/.pi/profiles/<name>.json`.
- Write-side operation granularity shrinks to the single file; errors pinpoint the concrete file.
- Delete the three code paths: legacy fallback, single-file read/write, and the `schemaVersion` envelope.

**Non-Goals:**

- No old-format data migration (the user has confirmed compatibility is not needed; old files are ignored).
- No change to existing semantics such as per-name override, the project trust gate, or the built-in default profile.
- No directory watching, hot reload, or nested directory organization.

## Decisions

### Directory discovery and file enumeration

The profiles directory locations are fixed: global under the workspace root (`PI_PROFILE_SWITCH_DIR` overrides the root), project under `<projectDir>/.pi/`. A missing directory is an empty catalog. Enumeration recognizes only regular files with the `.json` suffix, ignoring other entries (`.DS_Store`, README, subdirectories). The basename (minus `.json`) is the profile name.

ADR required: per-profile-file-storage

### File content: bare definitions, no envelope

Each file is one `ProfileDefinition` JSON object. The name no longer appears inside the file, avoiding a second source of truth that could disagree with the filename. `schemaVersion` is deleted: in directory form, version evolution happens by adding optional fields (parsing already recognizes only known fields and ignores unknown keys).

### Name charset constraint

`^[A-Za-z0-9][A-Za-z0-9._-]*$`. On the read side, a `.json` file with an illegal basename is an error identifying the file path; on the write side, upsert validates the name beforehand with the same rule explanation. Known boundary: on case-insensitive filesystems (macOS/Windows defaults), two names differing only in case are the same file — no extra validation; the spec records this in one sentence. Rejected alternative: a name→filename encoding mapping (e.g. percent-encoding) — it introduces a second naming rule, and the gain is only keeping spaces/CJK names; not worth it.

### Read-side failure tiering

A single file with illegal JSON or illegal definition fields → the whole catalog read fails with a `CatalogError` identifying the file path. The existing fail-loudly invariant is kept; silently skipping would make users think a profile was lost, violating the actionable-error principle.

### Write side: single-file upsert / delete

- upsert: the definition is validated by `parseProfileDefinition` first, then `<dir>/<name>.json` is written (`default` remains unwritable).
- delete: removes the corresponding file; a missing file means "profile does not exist".
- Writes use a temp file + rename, so a crash cannot leave half a JSON behind that would fail the entire next read.
- Whole-file overwrite, `writeDefinitions`, and re-read-on-write logic are deleted. The concurrent-conflict surface shrinks from the whole catalog to same-named single files, keeping last-write-wins.

### Seeding

postinstall now writes the shipped starter into the global `profiles/` (`examples/` provides the single-file form). Skipped when any `.json` file already exists in the directory; still uses `COPYFILE_EXCL` against concurrency, and seeding failure does not fail the install. The legacy-path detection code is deleted.

### Module placement

- `src/workspace.ts`: `getGlobalProfilesPath`/`resolveGlobalProfilesPath` → `getGlobalProfilesDir`; with the agentDir fallback deleted, `resolve*` loses its reason to exist.
- `src/profile-catalog.ts`: the read side becomes directory enumeration + per-file parsing.
- `src/profile-catalog-store.ts`: the write side becomes single-file upsert/delete.
- `src/switching/profile-crud.ts`: the store constructor now takes a directory path.
- `bin/postinstall.js`: the seeding target becomes the directory form; legacy detection deleted.
- `examples/`: `profiles.json` split into the starter single file; `example.json` remains the full-field demo.
- `schemas/profiles.schema.json`: from "catalog file schema" to "single profile file schema".

## Risks / Trade-offs

- Definitions in an existing user `profiles.json` are silently ignored (no migration) → the user has explicitly accepted this; README and CHANGELOG document the breaking change and the manual move (split each key into `profiles/<name>.json`).
- Names differing only in case overwrite each other on case-insensitive filesystems → not validated; documented as a known boundary.
- A bad file mixed into the directory makes the whole catalog unusable → the error identifies the file path; the user deletes or fixes that file to recover. Consistent with existing fail-loudly semantics.

## Migration Plan

Switch at release: the code does not read the old format. Users manually split each profile in the old `profiles.json` into `profiles/<name>.json` (bare definitions, without the `schemaVersion` envelope). Rollback means switching back to the old package version and restoring the original file.
