# Proposal

## Why

Named profiles currently turn omitted `skills` and `extensions` into empty selections, contradicting the existing undeclared-field contract. Extension settings replacement also discards native exclusions, so an activation can both hide wanted extensions and re-enable extensions the user disabled.

## What Changes

- Distinguish omission, an explicit empty list, and a declared reference list independently for skills and extensions.
- Preserve native resource settings and package filters for an undeclared kind, including settings-only extension paths and Pi's native extension enable/disable controls.
- Keep explicit selections restrictive, retain native exclusions, and preserve the project-trust boundary.
- Apply overlays to the appropriate native or explicitly selected base without narrowing an unrelated kind.
- Restore these semantics on launch, profile switching, and reload, using current real user settings rather than the previous instance.
- Preserve native automatic extension discovery for omitted selections through a conditional instance link; include its representation in activation rollback and verify cleanup never touches the real resource directory.
- **BREAKING for profiles relying on the bug**: omission no longer hides a resource kind. Users requiring an empty selection must declare `[]`; catalog files are not migrated automatically.
- Keep `mcps`, `mcp_tools`, `tools`, commands, configuration fields, and runtime dependencies unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resource-reference`: define independent sparse skill/extension selection and preservation of native exclusions.
- `launcher`: constrain generated settings and package entries to preserve an undeclared resource kind.
- `in-session-switch`: restore native resource bases on switching/reload and narrow only the kind named by an overlay.
- `profile-catalog`: replace the conflicting assertion that `profile-config` requires an explicit reference in every named profile with a reference to the ordinary skill-selection contract.

## Impact

Resolution and instance generation change in `src/profile-resolver.ts`, `src/settings-generator.ts`, and the default-overlay branch of `src/launcher/initial-profile.ts`. The internal activation-plan interface must retain declaration intent across the resolver/generator boundary; its exact surface belongs in the design. `src/switching/switch-profile.ts` also extends rollback to the conditional extension-directory representation. `extensions/pi-profile/index.ts` presents activation failures through a reload-safe channel without storing a new failure marker. Existing sweep dispositions remain unchanged; cleanup safety is verified in `test/runtime-cleanup.test.ts`.

Regression coverage spans resolver and settings tests, named-profile launch, profile switching, overlays, and project trust. Existing MCP/tool omission tests remain compatibility guards. Resource discovery stays delegated to Pi; the change adds no registration layer, dependency graph, or resource copies.

## Doc Impact

- `docs/prd.md`: replace the unconditional resource-selection wording in success criterion 1 with a link to the sparse-selection and project-boundary contracts; product goals and non-goals remain unchanged.
- `docs/architecture/overview.md`: describe independent per-kind materialization, the conditional extension mirror, its activation/rollback boundary, and native-base overlay exclusions; correct the unconditional named-profile filtering description.
- `CONTEXT.md`: none: existing domain terms and resource identities remain unchanged.
- `docs/adr/`: none: the conditional managed link and internal plan are reversible and introduce no durable configuration format, process architecture, or external dependency commitment. Existing decisions, including ADR-0012's warning-only treatment of content in real instance extension directories, remain applicable.
- `README.md` and `README.zh-CN.md`: add concise upgrade guidance for profiles relying on implicit denial, and link the authoritative selection contract.
- `skills/profile-config/SKILL.md`: none: its existing omission and authoring guidance already matches the intended contract.
