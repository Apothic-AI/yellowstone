# Proposal

## Why

The READMEs mix onboarding and configuration guidance with duplicated migration history, internal contracts, and design references. The Chinese edition also contains outdated activation and MCP guidance, while documentation tests require some of the material the user wants removed.

## What Changes

- Restrict both READMEs to tool introduction, installation and usage, and detailed configuration guidance.
- Rewrite `README.zh-CN.md` first and pause for the user's review before translating the accepted content into `README.md`.
- Keep configuration guidance self-contained: explain supported fields, nested subagent settings, reference forms, omitted versus empty selections, and the user actions needed to apply or diagnose edits.
- Remove migration history, architectural explanations, internal spec-link inventories, unrelated document indexes, and duplicated guidance from both READMEs.
- Adjust documentation assertions that require migration sections or internal contract links; retain configuration, native-subagent boundaries, schema validity, and link checks.
- Leave runtime behavior, schemas, product decisions, and project writing rules unchanged. Codifying README writing principles starts only after both READMEs are accepted, in a separate follow-up.

## Capabilities

### New Capabilities

None. This is a documentation-only change with documentation-test adjustments.

### Modified Capabilities

None. Existing behavior contracts remain unchanged; `.openspec.yaml` declares `skip_specs: true`.

## Impact

- Documentation: `README.zh-CN.md` and `README.md`.
- Documentation tests: `test/resource-selection-docs.test.ts`, `test/profile-validation-docs.test.ts`, and `test/subagent-docs.test.ts`.
- No runtime source, dependency, configuration-field, API, or storage changes.
- `design.md` is intentionally omitted: the schema makes it conditional, and this edit introduces no cross-module architecture, dependency, data model, or unresolved technical decision.
- The work proceeds in two reviewed stages; the English synchronization remains pending until the Chinese draft is accepted.

## Doc Impact

- `docs/prd.md`: none: product positioning, goals, and non-goals stay unchanged.
- `docs/architecture/overview.md`: none: the implementation mechanisms stay unchanged.
- `CONTEXT.md`: none: existing terminology stays unchanged.
- `docs/adr/`: none: no product or architectural decision changes.
