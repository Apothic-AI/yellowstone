# Proposal

## Why

The overlay narrows the active profile at runtime, but its command grammar splits along resource category: skills, extensions, and MCP servers are manipulated with `disable|enable <name-or-glob>`, while tools alone use a replace-form (`overlay tools [ref...]`). The replace-form exists for historical reasons (tools lacked a defined base set to subtract from), not because users think about tools differently: the overlay's mental model is "temporarily enable or disable things in this session", and every category should answer that model with the same verbs. The split also made tool narrowing strictly weaker — replace-form literals were never validated at command time (unknown names surfaced only as post-reload warnings), while disable entries for the other three categories fail loudly on typos.

## What Changes

- **BREAKING**: Remove `/profile overlay tools [ref...]`. Tools join the uniform grammar: `/profile overlay disable|enable skill|extension|mcp|tool <name-or-glob>`.
- Tool disable entries follow the same semantics as the other three kinds: names or globs, stored verbatim, re-expanded at every resolution; an unmatched literal fails identifying the entry; a zero-match glob succeeds with a warning. `enable` removes a stored entry by exact string match and fails listing the current tool entries when nothing matches.
- Base set for tool narrowing: when the active profile declares `tools`, the base is the profile's resolved tool references; when it declares none (including the `default` profile), the base is the runtime's available tool set — narrowing then behaves like the other categories' "all minus disabled" semantics.
- The overlay state field `tools` (replace list) is replaced by `disabledTools`. No migration: stored overlays never cross a runtime boundary.
- Tool disable validation happens at command time against the live registry — an improvement over the replace-form, whose literals were only warned about after reload.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `in-session-switch`: the Runtime overlay requirement is rewritten (uniform disable/enable across all four resource kinds; replace-form removed; tool base-set semantics); the Plan application requirement is revised (session-start tool expansion subtracts the overlay's disabled tool entries).

## Impact

- **Code**: `src/runtime-state-store.ts` (overlay field swap), `src/profile-resolver.ts` (tool disable narrowing + base resolution; needs live tool names from in-session callers), `src/switching/overlay.ts` (grammar: `tool` kind added, `tools` action removed), `src/switching/apply-plan.ts` and `src/switching/tool-references.ts` (subtract disabled entries at session-start expansion), `src/switching/status.ts` (render `-tool:` entries), `extensions/pi-profile/index.ts` (usage text only). The launch path is structurally untouched: startup ignores overlays, so pre-spawn resolution never sees a tool disable entry.
- **Compatibility**: **BREAKING** for the `overlay tools [ref...]` form introduced one release earlier; no other surface changes. Profile file format, launch argument, and the non-overlay state shape are unchanged.
- **Docs**: README command table and migration mapping (see Doc Impact).

## Doc Impact

- `docs/prd.md`: none — positioning and non-goals are untouched; the PRD never documented the overlay grammar.
- `docs/architecture/overview.md`: the `switching/overlay.ts` and `runtime-state-store.ts` module rows and the filtering-model tools row describe the replace-form and must be updated to the disable/enable model.
- `CONTEXT.md`: the `RuntimeOverlay` glossary entry says "or replaces the tool reference set" — it must say tools are disabled like the other kinds.
- `docs/adr/`: none — no hard-to-reverse decision. The state-field swap needs no migration (overlays never survive a runtime), and the rejected alternatives (keeping both forms; rejecting tool disable on whitelist-less profiles) are recorded in this change's design.md.
