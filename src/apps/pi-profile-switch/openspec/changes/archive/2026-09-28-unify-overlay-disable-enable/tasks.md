# Tasks

The uniform overlay grammar and base-set semantics are defined by the delta `specs/in-session-switch/spec.md` (Requirement: Runtime overlay; Requirement: Plan application and change summary at session start) — defer to it rather than restating it here.

## 1. State store: swap the overlay tools field

- [x] 1.1 In `src/runtime-state-store.ts`, remove `RuntimeOverlay.tools` and add `disabledTools?: string[]`; update `parseOverlay`'s known-key list accordingly. Update `test/runtime-state-store.test.ts`: replace any `tools` overlay assertions with `disabledTools`, and add a case that a stored `tools` key is ignored (no parse failure). Verification: `npx vitest run test/runtime-state-store.test.ts` — covers the storage half of the delta's Runtime overlay requirement ("stored as written").

## 2. Resolver: uniform tool narrowing

- [x] 2.1 In `src/profile-resolver.ts`: `ResolveInput` gains `liveToolNames?: string[]`; `ActivationPlan` gains `disabledTools?: string[]`. Delete the `overlay.tools` replacement branch; instead narrow tools via the shared disable-entry matcher against the base set (profile's resolved tool references when declared, else `liveToolNames`), with unmatched literal → `ActivationError` identifying the entry and zero-match glob → `unmatched` entry with the `overlay tool:` prefix; the plan carries the entries verbatim. When the profile declares `tools`, the pre-computed `tools` baseline additionally subtracts the disabled matches; when it declares none, the plan's `tools` field stays absent. A tool disable without `liveToolNames` fails (launcher never passes an overlay). Extend `test/profile-resolver.test.ts` with cases: tool disable removes a matching tool (declared and undeclared base), unmatched literal tool throws, zero-match tool glob lands in `unmatched` and does not throw, declared baseline subtracts, undeclared profile still yields no `tools` field when the overlay disables nothing. Verification: `npx vitest run test/profile-resolver.test.ts` — covers delta scenarios "Disabling a tool narrows the active tool set", "Tool disable on a profile without declared tools", "Disabling an unresolved resource" (tool kind), and "Zero-match glob succeeds with a warning" (tool kind).

## 3. Overlay command grammar

- [x] 3.1 In `src/switching/overlay.ts`: add kind `tool` (mapped to `disabledTools`) to `disable|enable`; remove the `tools` action so it falls through to the usage error; update `OVERLAY_USAGE`. Update `test/overlay.test.ts` (this task modifies its assertions): replace the `tools`-form parsing and mutation cases with `tool` disable/enable cases, and add a case that `/profile overlay tools read grep` is rejected with the usage note and writes nothing. Verification: `npx vitest run test/overlay.test.ts` — covers delta scenarios "Removed tools replace-form is rejected", "Enable removes a stored entry" (tool kind), and "Enable without a matching stored entry" (tool kind).

## 4. Session-start application and status rendering

- [x] 4.1 In `src/switching/apply-plan.ts`: run tool application when the plan carries tool references OR disabled tool entries; the active set is the base expansion (profile references, or the live registry when the plan declares none) minus the disabled entries' live matches. In `src/switching/status.ts`, render `disabledTools` as `-tool:<entry>` entries and remove the `tools=[...]` form. Thread the live tool names from `extensions/pi-profile/index.ts` (`pi.getAllTools()`) through `SwitchDeps` and `switchProfile` into `resolveInitialProfile`/`resolveProfile`. Update `test/apply-plan.test.ts` and `test/status.test.ts` accordingly. Verification: `npx vitest run test/apply-plan.test.ts test/status.test.ts test/switch-profile.test.ts` — covers delta scenarios "Disabled tools stay disabled across reload" and "Tools whitelist re-applied after reload" (with disabled entries).

## 5. Integration coverage

- [x] 5.1 Update `test/overlay.integration.test.ts` (this task modifies its assertions): remove the `overlay tools` replace-form cases; add a tool disable→enable round trip asserting the active tool set, and a non-TUI (rpc) `overlay disable tool` case if the suite's driver supports tool assertions — otherwise cover the non-TUI tool form in `test/extension.test.ts`. Verification: `npx vitest run test/overlay.integration.test.ts` — covers delta scenarios "Disabling a tool narrows the active tool set" end-to-end and "Non-TUI availability" for the tool kind.

## 6. Documentation sync

- [x] 6.1 Update `README.md`: the overlay row's grammar (uniform `disable|enable skill|extension|mcp|tool`), and the migration-mapping table gains `overlay tools [ref...]` → `overlay disable tool <name-or-glob>` (or a profile `tools` declaration). Update `README.zh-CN.md` to match — note it still carries the pre-`simplify-profile-commands` table and must be brought fully current, not just patched for this change. Verification: `rg -n "overlay tools|customize|/profile reset|/profile list" README.md README.zh-CN.md` returns nothing, and both files show the five-form table with the uniform grammar. Fact checklist: grammar → `openspec/changes/unify-overlay-disable-enable/specs/in-session-switch/spec.md`; migration rows → the delta's Runtime overlay requirement + `OVERLAY_USAGE` in `src/switching/overlay.ts`.
- [x] 6.2 Update `docs/architecture/overview.md`: the `switching/overlay.ts` row (uniform disable/enable grammar), the `runtime-state-store.ts` row (overlay holds four disabled-entry lists), and the filtering-model tools row (session-start application subtracts disabled entries). Update `CONTEXT.md`: the `RuntimeOverlay` entry — tools are disabled like the other kinds, no replace-form. Verification: `rg -n "replace the tool|tools=\[|overlay tools" docs/architecture/overview.md CONTEXT.md` returns nothing.

## 7. Gate

- [x] 7.1 Run `npm run check`, `npm test`, and `openspec validate unify-overlay-disable-enable --strict`; all three pass. Verification: exit codes 0; the full suite runs with no reference to the removed `overlay tools` form (`rg -n "overlay tools|overlay\.tools" src/ extensions/ test/` returns nothing).
