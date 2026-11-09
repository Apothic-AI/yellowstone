# Proposal

## Why

The published announcement still tells users to keep an obsolete MCP adapter, and the package metadata accepts Pi releases that cannot run the native MCP integration. Both now contradict the shipped implementation.

## What Changes

- Replace the obsolete announcement with an English notice that native MCP is supported from pi-profile-switch v0.13.0, the adapter is no longer supported, and users should upgrade both Pi and pi-profile-switch. Give the changed advice a new ID and mark the upgrade action explicitly.
- **BREAKING** Set the Pi peer dependency and development dependency to a minimum supporting native MCP, and refresh the lockfile. Older Pi versions will no longer satisfy normal npm peer resolution.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `launcher`: declare the supported Pi peer compatibility boundary for native MCP installation.

## Impact

`announcements.json`, `package.json`, `package-lock.json`, two integration tests that use Pi's old `print` mode, and the corresponding launcher spec delta. No launcher runtime code changes. The separate `simplify-bilingual-readmes` change owns the README rewrite.

## Doc Impact

- `docs/prd.md`: none: neither product goals nor non-goals change.
- `docs/architecture/overview.md`: none: no implementation mechanism changes.
- `CONTEXT.md`: none: the existing native MCP terminology is unchanged.
- `docs/adr/`: none: ADR-0016 already records native MCP as the only backend; ADR-0014 owns the announcement feed contract.
