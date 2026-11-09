# Proposal

## Why

Both READMEs bury the commands and profile example under implementation detail and repetitive qualifiers. The Chinese README also describes the removed `pi-mcp-adapter` integration, which contradicts the current contract.

## What Changes

- Rewrite `README.md` and `README.zh-CN.md` around installation, creating a profile, field behavior, and session commands.
- Remove repetitive distribution/seeding caveats and internal implementation details from the getting-started narrative.
- Replace obsolete adapter-era guidance in the Chinese README with the current native MCP behavior. Keep the two examples and user-facing distinctions consistent with each other and with existing specs.
- Do not change behavior, code, schemas, or spec requirements; this is a documentation-only change with `skip_specs: true`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None; the existing contracts govern the corrected descriptions.

## Impact

`README.md` and `README.zh-CN.md` only. No runtime, API, dependency, or schema changes.

## Doc Impact

- `docs/prd.md`: none: the product goals and non-goals do not change.
- `docs/architecture/overview.md`: none: the implementation and its boundaries do not change.
- `CONTEXT.md`: none: terminology is reused, not redefined.
- `docs/adr/`: none: no new decision or reversal is proposed.
