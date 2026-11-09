# Tasks

This change produces no code. Each task below checks a specification item back against the implementation, confirming no unimplemented behavior was written and no implemented behavior was missed.

## 1. Specification-to-implementation consistency check

- [x] 1.1 Check "Catalog file locations and discovery": read `getProfileSwitchDir`, `getGlobalProfilesPath`, `resolveGlobalProfilesPath` in `src/workspace.ts`; confirm the preferred path, `PI_PROFILE_SWITCH_DIR` override, legacy fallback, and "missing file means empty catalog" all match the specification
- [x] 1.2 Check "Catalog file format validation" and "Profile definition fields": read `loadCatalogFile` and `parseProfileDefinition` in `src/profile-catalog.ts`; confirm the four error paths (invalid JSON, non-object top level, schemaVersion mismatch, non-object profiles) and the field-type validation error content match the specification
- [x] 1.3 Check "Built-in default profile": read the three `DEFAULT_PROFILE_NAME` handling sites in `src/profile-catalog.ts` (throw when defined in a catalog, return builtin on resolution, `resolve` short-circuit); confirm consistency with the specification
- [x] 1.4 Check "Profile sources and project override" and "Profile list ordering": read `load` and `list` in `src/profile-catalog.ts`; confirm project entries override global ones, the override order, and `default` at the front of the list
- [x] 1.5 Check "Project trust gate": read `requireScope` and `readCatalogScope` in `src/switching/profile-crud.ts`; confirm reads return empty and writes error when untrusted, and the read path does not touch files
- [x] 1.6 Check "Profile create, edit, and duplicate" and "Profile deletion": read `createProfile`, `editProfile`, `deleteProfile`, `duplicateProfile` in `src/switching/profile-crud.ts`; confirm the six failure conditions and message contents item by item
- [x] 1.7 Check "Catalog writes": read `writeDefinitions` and `upsert` in `src/profile-catalog-store.ts`; confirm whole-file overwrite, only declared fields written, and validation before hitting disk
- [x] 1.8 Check "Seeding the starter profile at install": read `bin/postinstall.js`; confirm the four cases: first-time write, no overwrite when present, skip when legacy exists, failure does not block install

## 2. Specification quality validation

- [x] 2.1 `openspec validate spec-baseline-profile-catalog --strict` passes; confirm no requirement lacks scenarios and no scenario-marker count errors
- [x] 2.2 Compare `openspec/changes/spec-baseline-profile-catalog/specs/profile-catalog/spec.md` item by item against `docs/architecture/overview.md`, `docs/adr/0003-no-profile-inheritance.md`, and `docs/adr/0004-profiles-reference-shared-resources.md`; confirm the specification restates no mechanism descriptions or decision reasoning
- [x] 2.3 Check the specification's wording against `CONTEXT.md` item by item; confirm no avoid-words are used (`preset`, `config`, `bundle`, `capability`, `session profile`, `temporary profile`, `built-in`)
- [x] 2.4 Confirm no implementation class names or file-internal symbols (module class names, internal function names) appear in the specification — only user-visible file paths and field names

## 3. Documentation sync check

- [x] 3.1 Check `docs/prd.md`: confirmed no change to positioning, goals, or non-goals; no edit needed
- [x] 3.2 Check `CONTEXT.md`: confirmed no new terms and no changed meanings; no edit needed
- [x] 3.3 Check `docs/architecture/overview.md`: confirmed no change to module boundaries, data flow, or known limitations; no edit needed
- [x] 3.4 Check `docs/adr/`: confirmed no hard-to-reverse decision introduced; no new ADR needed
