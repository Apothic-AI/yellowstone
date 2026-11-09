# Tasks

## 1. Read side: the directory-form catalog

- [x] 1.1 `src/workspace.ts`: replace `getGlobalProfilesPath`/`resolveGlobalProfilesPath` with `getGlobalProfilesDir()` (`profiles/` under the workspace root), deleting the agentDir legacy fallback; `npm run check` passes (callers with transient compile errors may be fixed together in 1.3)
- [x] 1.2 `src/profile-catalog.ts`: the read side now enumerates `*.json` regular files in the `profiles/` directory, basename as profile name; ignores non-`.json` entries and subdirectories; throws `CatalogError` identifying the file path when a single file is illegal JSON or has a non-object top level; errors when `default.json` exists; errors identifying the path for files with illegal names (not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`); override semantics stay per-name complete replacement. Verification: new/rewritten unit tests cover every scenario of "Catalog directory locations and discovery", "Catalog file format validation", "Built-in default profile", and "Profile name constraints" in the specs delta

## 2. Write side: single-file upsert / delete

- [x] 2.1 `src/profile-catalog-store.ts`: upsert writes `<dir>/<name>.json` (validated by `parseProfileDefinition` first, temp file then rename); delete removes the corresponding file; `writeDefinitions` and the re-read-on-write logic are deleted; illegal names fail the write with the rule explained. Verification: unit tests cover the write-side scenarios of "Catalog writes", "Profile create, edit, and duplicate", "Profile deletion", and "Profile name constraints"
- [x] 2.2 `src/switching/profile-crud.ts`: the store constructor now takes a directory path (global `getGlobalProfilesDir()`, project `<cwd>/.pi/profiles/`). Verification: `npm run check` passes, related unit tests pass

## 3. Seeding and schema

- [x] 3.1 `bin/postinstall.js`: the seeding target becomes the global `profiles/ask.json`, written only when the directory contains no `.json` file (still `COPYFILE_EXCL`, failure does not block install); legacy path detection deleted. Verification: postinstall unit tests cover both scenarios of "Seeding the starter profile at install"
- [x] 3.2 `examples/`: `profiles.json` split into the starter single file `ask.json` (bare definition); `example.json` stays the full-field demo but in bare-definition form. Verification: the postinstall tests referencing the new file pass
- [x] 3.3 `schemas/profiles.schema.json`: changed to the schema of a single profile file (bare `ProfileDefinition`, no `schemaVersion` envelope). Verification: schema validation tests pass

## 4. Overall regression

- [x] 4.1 Search the whole repo for leftover `profiles.json` references and clean them (source, tests); `npm run check` and `npm test` all pass

## 5. Documentation

- [x] 5.1 `CONTEXT.md`: the Catalog term definition becomes "the `profiles/` directory holding profile definitions: one global, one per project, one `<name>.json` file per profile"
- [x] 5.2 `docs/architecture/overview.md`: the module table, schema-authority section, and the `bin/` and `examples/` entries have their `profiles.json` paths and seeding descriptions changed to the directory form
- [x] 5.3 `README.md` and `README.zh-CN.md`: the path table becomes `~/.pi-profile-switch/profiles/<name>.json` and `<project>/.pi/profiles/<name>.json`, the legacy fallback note is deleted, and a manual-move paragraph for the old format is added
- [x] 5.4 Add `docs/adr/0013-per-profile-file-storage.md`: records the one-file-per-profile decision; the rejected alternative is keeping the single-file catalog; mark the tops of related old ADRs as needed
