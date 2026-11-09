# Proposal

## Why

The `/profile` command family has grown to ten invocation forms, but two clusters no longer earn their surface area, and one name fights the glossary:

- **CRUD wizards** (`create`/`edit`/`delete`/`duplicate`) ask users to type comma-separated resource names from memory — the wizard offers no resource discovery, so anyone who can operate it already knows everything needed to edit the catalog file directly. The package already ships the stronger authoring path: the `profile-config` skill, through which the agent enumerates resources and writes catalog files, guarded by read-time validation. The wizard path is a strictly weaker duplicate that costs spec surface, the largest branch of the extension handler, and three test files.
- **`list`** duplicates bare `/profile`, which already degrades to printing the list when no interactive UI exists.
- The overlay feature is worth keeping, but its command word `customize` is the only link in the chain that avoids the glossary term: status output, notify messages, and specs all say "overlay", leaving users no lexical path from what they see to the command that changes it. Additionally, overlay `disable` accepts only literal names while profile definitions have long supported globs (ADR-0009), making the ephemeral narrowing harder to express than the permanent one.

## What Changes

- **BREAKING**: Remove `/profile create`, `/profile edit`, `/profile delete`, `/profile duplicate`. Authoring moves entirely to the `profile-config` skill plus direct file editing; catalog writes are no longer an operation the system performs.
- **BREAKING**: Remove `/profile list`. Bare `/profile` keeps the interactive selector; its non-TUI degradation to the list gains the structured `details` payload previously carried by `list`.
- **BREAKING**: Rename `/profile customize` to `/profile overlay` (grammar otherwise unchanged: `disable|enable skill|extension|mcp <name>`, `tools [ref...]`), and fold `/profile reset` into `/profile overlay clear`.
- Overlay `disable` accepts globs in addition to literal names for skills, extensions, and MCP servers. The overlay stores entries as patterns; the resolver expands them at every resolution, following the ADR-0009 tiering: an unmatched literal fails and identifies the entry, a zero-match glob succeeds with a warning. `enable` removes a stored entry by exact string match and, when there is no match, fails listing the current entries.
- Resulting surface: bare `/profile` (selector), `use`, `reload`, `status`, `overlay`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `in-session-switch`: the command-family requirement is rewritten (five forms, mode gating without CRUD); the runtime-overlay requirement is revised (command word, glob tiering, enable semantics, `clear`); the observability-surface requirement drops `list` in favor of the degraded bare invocation; the CRUD-effects requirement is removed.
- `profile-catalog`: the create/edit/duplicate, deletion, and catalog-writes requirements are removed — the system no longer mutates catalogs; authoring guidance lives in the `profile-config` skill, and read-time validation (already specified) remains the safety net.

## Impact

- **Code**: remove `src/switching/profile-wizard.ts`, `src/switching/profile-crud.ts`, and `src/profile-catalog-store.ts` (its only consumer is the CRUD path), plus the CRUD branch of `extensions/pi-profile/index.ts` (roughly half the handler); rework `src/switching/customize.ts` into the `overlay` subcommand; extend overlay narrowing in `src/profile-resolver.ts` from literal sets to pattern matching. Remove the wizard/CRUD/CRUD-integration test files; extend overlay tests. `src/switching/status.ts` and the launch path are structurally untouched.
- **Compatibility**: **BREAKING** for scripts or habits using the removed or renamed subcommands. Acceptable pre-1.0; the launch argument (`pi-profile <name>`), profile file format, and state file shape are unchanged.
- **Docs**: README command table; architecture module table (see Doc Impact).

## Doc Impact

- `docs/prd.md`: none — the PRD states positioning and non-goals and never documented the command surface.
- `docs/architecture/overview.md`: the module table loses `profile-wizard.ts`, `profile-crud.ts`, `profile-catalog-store.ts`; `customize.ts` is renamed; the extension entry description drops the CRUD wizards.
- `CONTEXT.md`: none — `RuntimeOverlay` is already the sanctioned term; this change aligns the command word with it and introduces no new terms.
- `docs/adr/`: none — no existing ADR is reversed; ADR-0009's failure tiering is extended, not contradicted. The decisions with attractive rejected alternatives (eager expansion vs stored patterns; enable semantics) are recorded in this change's `design.md`.
