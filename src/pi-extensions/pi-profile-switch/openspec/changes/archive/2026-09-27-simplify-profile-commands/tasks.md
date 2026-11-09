# Tasks

The accepted `/profile` subcommand set and overlay grammar are defined by the delta `specs/in-session-switch/spec.md` (Requirement: /profile command family; Requirement: Runtime overlay) — defer to it rather than restating it here.

## 1. Resolver: pattern-based overlay narrowing

- [x] 1.1 In `src/profile-resolver.ts`, treat overlay disable entries (skills, extensions, MCP servers) as names or globs using the same matcher as profile references: unmatched literal → `ActivationError` identifying the entry; zero-match glob → append to the plan's `unmatched` channel with an `overlay ` prefix instead of failing. Extend `test/profile-resolver.test.ts` with cases: glob disable narrows the matching set, unmatched literal throws, zero-match glob lands in `unmatched` and does not throw. Verification: `npx vitest run test/profile-resolver.test.ts` — covers delta scenarios "Disabling an unresolved resource" and "Zero-match glob succeeds with a warning".

## 2. Overlay module rename and new argument semantics

- [x] 2.1 Rename `src/switching/customize.ts` to `src/switching/overlay.ts` per design.md → Export surface: `CUSTOMIZE_USAGE`→`OVERLAY_USAGE`, `parseCustomizeArgs`→`parseOverlayArgs` returning the `OverlayCommand` union (absorbing `clear`), `customizeOverlay`→`applyOverlayMutation`, `resetOverlay`→`clearOverlay`; errors remain `SwitchError`. `enable` now fails when no stored entry equals the given string, listing the current entries of that kind. Rename `test/customize.test.ts` to `test/overlay.test.ts` and update assertions to the new names and grammar, adding cases for `clear` parsing and the enable-no-match error. Verification: `npx vitest run test/overlay.test.ts` — covers delta scenarios "Enable removes a stored entry", "Enable without a matching stored entry", and (ordering) "Reset restores the definition".

## 3. Extension handler surgery

- [x] 3.1 In `extensions/pi-profile/index.ts`: delete the CRUD dispatch branch and its imports (`profile-crud.ts`, `profile-wizard.ts`), delete the `list` branch, dispatch `overlay` (including `clear`) through the module from task 2.1, drop `reset`, and shrink the usage string and command description to the accepted set (defer to the delta). Update `test/extension.test.ts` assertions for the reduced surface. Verification: `npx vitest run test/extension.test.ts` — covers delta scenarios "Unknown subcommand" and "use without a name" (removed subcommands now read as unknown).
- [x] 3.2 In the bare-`/profile` non-UI degradation path of `extensions/pi-profile/index.ts`, attach the structured `details` payload (`{ kind: "list", profiles }`) previously carried by `list`. Update `test/observability.integration.test.ts`: remove `list`-subcommand assertions, assert the degraded bare invocation prints the list and carries the payload. Verification: `npx vitest run test/observability.integration.test.ts` — covers the delta's Observability surface requirement (scenarios "Untrusted project's profiles are invisible" and "Same-named project definition shadows the global one" stay green).

## 4. Overlay integration coverage

- [x] 4.1 Update `test/overlay.integration.test.ts`: rename all `customize`/`reset` invocations to `overlay`/`overlay clear`; add an integration case where a stored glob disable is re-expanded on `/profile reload` and narrows a newly resolved resource; add a non-TUI case running an `overlay` form. Verification: `npx vitest run test/overlay.integration.test.ts` — covers delta scenarios "Stored glob is re-expanded on reload", "Non-TUI availability", and the renamed survivors "Overlay does not touch the catalog", "MCP disabling on the default profile is rejected".

## 5. Remove the CRUD modules

- [x] 5.1 Delete `src/switching/profile-wizard.ts`, `src/switching/profile-crud.ts`, `src/profile-catalog-store.ts`, and the tests `test/profile-wizard.test.ts`, `test/profile-crud.test.ts`, `test/profile-crud.integration.test.ts`, `test/profile-catalog-store.test.ts`; clean the stale comment referencing `profile-catalog-store.ts` in `src/profile-catalog.ts`. Verification: `npm run check` compiles, and `rg -n "profile-wizard|profile-crud|profile-catalog-store|ProfileCatalogStore|CatalogScope" src/ extensions/ bin/ test/` returns no references — mechanically covers the profile-catalog delta's REMOVED requirements (create/edit/duplicate, deletion, catalog writes have no remaining actor).

## 6. Documentation sync

- [x] 6.1 Rewrite the command table and its surrounding notes in `README.md` (the rows listing CRUD and `customize`/`reset`, and the "CRUD wizards are TUI-only" note): five forms per the delta, overlay glob support, and the migration mapping (removed subcommand → replacement). Verification: `rg -n "customize|/profile reset|/profile list|create\\\\|edit\\\\|delete\\\\|duplicate" README.md` returns nothing, and the new table rows are present.
- [x] 6.2 Update `docs/architecture/overview.md`: remove the module-table rows for `profile-wizard.ts`, `profile-crud.ts`, `profile-catalog-store.ts`; rename the `customize.ts` row to `overlay.ts` with updated exports; fix the `extensions/pi-profile/index.ts` row (no CRUD wizards) and the `src/switching/` group description. Verification: `rg -n "profile-wizard|profile-crud|profile-catalog-store|customize" docs/architecture/overview.md` returns nothing.

## 7. Gate

- [x] 7.1 Run `npm run check`, `npm test`, and `openspec validate simplify-profile-commands`; all three pass. Verification: exit codes 0; the full suite runs with no file from task 5.1 referenced.
