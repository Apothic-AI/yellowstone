# Proposal

## Why

The user has accepted both simplified READMEs, but the project instructions still place installation and commands alone in the README and direct every behavior explanation to internal contracts. Codifying the agreed scope prevents later edits from restoring migration history, internal design material, or configuration guidance that consists only of links.

## What Changes

- Add a single `README authoring` section to `AGENTS.md` for both README editions.
- Limit README content to tool introduction, installation and usage, and detailed configuration guidance. Keep practical limits and diagnostics with the affected operation or field; exclude migration history, release history, architectural reasoning, implementation machinery, and internal-document link inventories.
- Require configuration guidance to explain supported top-level and nested fields, types, reference forms, omitted and empty values, and valid examples without requiring the reader to open internal specs.
- Require short, direct prose, field/reference tables, and fenced commands and JSON; explain each fact once within an edition.
- Require English in `README.md`, Chinese in `README.zh-CN.md`, and matching technical identifiers, configuration examples, command examples, behavior, and limitations. Preserve human edits when synchronizing.
- Derive field coverage from the shipped schema and verify operational facts against their owning sources. Reference native documentation for evolving native value inventories instead of copying them.
- Reconcile the language and fact-ownership guidance in `openspec/config.yaml` with the agreed README scope. Retain specs as behavior-contract owners and link to `AGENTS.md#readme-authoring` for detailed writing rules rather than duplicating them.
- Add lightweight scope and rule-reference regression checks to `test/resource-selection-docs.test.ts`; retain existing schema, JSON validity, bilingual synchronization, and local-link coverage. Tests must tolerate Markdown table alignment rather than pin exact wording or spacing.
- Leave the accepted README files unchanged, including the user's uncommitted Chinese edits.

## Capabilities

### New Capabilities

None. This change records documentation-authoring guidance and its checks.

### Modified Capabilities

None. Runtime behavior contracts remain unchanged; `.openspec.yaml` declares `skip_specs: true`.

## Impact

- Rules: `AGENTS.md` and `openspec/config.yaml`.
- Documentation checks: `test/resource-selection-docs.test.ts`.
- No README, runtime source, schema, dependency, API, or storage changes.
- `design.md` is conditionally omitted: no implementation architecture, dependency, data model, or unresolved technical choice changes.

## Doc Impact

- `docs/prd.md`: none: product intent, goals, and non-goals stay unchanged.
- `docs/architecture/overview.md`: none: runtime mechanisms stay unchanged.
- `CONTEXT.md`: none: terminology stays unchanged.
- `docs/adr/`: none: this records an accepted documentation scope, not a hard-to-reverse product or architectural choice.
