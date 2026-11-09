# Design

## Context

The overlay module (`src/switching/overlay.ts`) parses `disable|enable skill|extension|mcp <name-or-glob>` plus a tools-only replace-form; `RuntimeOverlay` stores `disabledSkills/disabledExtensions/disabledMcps` and a replace list `tools`. The resolver narrows the three disabled kinds by matching entries against the profile's resolved sets with ADR-0009 tiering, while `overlay.tools` replaces `toolReferences` wholesale. Tool references resolve against Pi's live registry only after session start (extension- and MCP-contributed tools are unknowable earlier) — but overlay commands run exclusively in-session, where the live registry is available, and startup ignores stored overlays, so pre-spawn resolution never sees an overlay.

## Goals / Non-Goals

**Goals:**

- One grammar for all four resource kinds: `disable|enable skill|extension|mcp|tool <name-or-glob>`, with identical storage, tiering, and `enable` semantics.
- Tool disable validated at command time (unmatched literal fails identifying the entry) — the replace-form's warn-after-reload behavior disappears with it.
- No storage migration and no change to profile semantics: a profile that declares no `tools` still yields a plan without a tools field when no overlay disables tools.

**Non-Goals:**

- No hole-punching (re-enabling one member of a glob-disabled set) — unchanged from the existing design.
- No change to how profiles declare `tools`, or to pre-spawn tool expansion.
- No persistence of overlays across runtimes.

## Decisions

### 1. Tools join `disable|enable`; the replace-form is deleted

The base set for a tool disable entry is the profile's resolved tool references when the profile declares `tools`, and the runtime's available tool set when it does not. Both are enumerable in-session: the resolver gains the live registry as an input (below), so matching, literal validation, and glob zero-match warnings work exactly like the other three kinds. The `default` profile falls into the undeclared branch — its existing "all resources minus the disabled entries" sentence now covers tools through the same mechanism instead of through a special replace-form.

**Rejected: keep `overlay tools [ref...]` alongside disable/enable.** Two write paths for one category is the inconsistency this change exists to remove; anything the replace-form expressed is covered by disabling the complement (with globs), and narrow-to-a-fixed-set belongs in the profile definition.

**Rejected: reject tool disable when the profile declares no `tools`** (mirroring the MCP-on-default rule). The MCP rule exists because a whitelist-less profile has no MCP set at all; tools are different — every runtime has a live tool set, and the `default` profile's tools are already narrowable today via the replace-form. Rejecting would remove existing capability.

### 2. The resolver takes live tool names; the plan carries `disabledTools` verbatim

`ResolveInput` gains `liveToolNames?: string[]`, required when the overlay disables tools (the in-session switch path supplies it from Pi's live registry; the launcher never passes an overlay, so it never needs it). Matching uses the same helper and tiering as the other kinds, against the base set of Decision 1. The plan keeps `toolReferences` as the profile's declared refs (unchanged) and adds `disabledTools?: string[]` (overlay entries verbatim); the session-start application computes base-minus-disabled against the live registry at that moment, so registry drift between command time and a later reload re-expands correctly — the same "stored as written, re-expanded at every resolution" model as the other kinds.

**Rejected: resolver snapshots the live base into the plan** (e.g. materializing `toolReferences` as the current live names or a `["*"]` marker). That writes a compiled artifact into the plan file, stales between resolution and application, and breaks the invariant that a profile without declared `tools` produces no tools field.

For the declared-`tools` case, the plan's pre-computed `tools` baseline (built-in expansion used for generated settings) additionally subtracts the disabled matches, keeping the boot baseline consistent with the post-session-start set. For the undeclared case the baseline stays undefined and the session-start application does the narrowing, matching the existing boot-baseline-then-tighten pattern.

### 3. Storage swaps `tools` for `disabledTools` with no migration

`RuntimeOverlay.tools?: string[]` becomes `disabledTools?: string[]`. No migration is needed because overlays never cross a runtime boundary: startup ignores stored overlays, and within one runtime the state file is only ever read by the same version that wrote it. The state reader recognizes only known keys, so a stale `tools` key — writable only by an older binary mid-session, itself an upgrade edge — is ignored rather than failing.

### 4. `enable` and errors stay exactly the existing pattern

`enable tool <name>` removes a stored entry by exact string match; no match fails listing the current tool entries. Errors remain `SwitchError` at the command layer and `ActivationError` at resolution. No new error types.

## Export surface

- `src/runtime-state-store.ts` — `RuntimeOverlay`: `tools?: string[]` removed; `disabledTools?: string[]` added. `parseOverlay` recognizes `disabledTools` in place of `tools`.
- `src/profile-resolver.ts` — `ResolveInput` gains `liveToolNames?: string[]`; `ActivationPlan` gains `disabledTools?: string[]`; the overlay branch narrows tools via the shared disable-entry matcher with the `overlay tool:` unmatched prefix; `overlay.tools` replacement is deleted.
- `src/switching/overlay.ts` — `OVERLAY_USAGE` drops the `tools` form and adds the `tool` kind; `parseOverlayArgs` maps kind `tool` to `disabledTools` and rejects the `tools` action with the usage note; `applyOverlayMutation` / `clearOverlay` / `OverlayCommand` unchanged.
- `src/switching/apply-plan.ts` — session-start application runs when the plan carries tool references or disabled tool entries; the active set is the base expansion minus the disabled entries' matches.
- `src/switching/status.ts` — the overlay line renders `-tool:<entry>` entries; the `tools=[...]` form is removed.
- `extensions/pi-profile/index.ts` — no dispatch change; only strings that cite the overlay grammar follow `OVERLAY_USAGE`.
- In-session wiring: the switch path passes the live tool names into resolution (source: the same registry access the session-start application already uses).

## Risks / Trade-offs

- [Scripts using `overlay tools [ref...]` break] → One release old, pre-1.0; the usage note and README migration mapping name the replacement (disable the complement, or declare the set in the profile).
- [Undeclared-tools narrowing has no generated-settings boot baseline] → Accepted: the session-start application narrows before the first agent turn, same window the existing re-tighten pattern already has.
- [A disabled tool that vanishes from the registry before a reload] → The literal entry fails re-resolution like any other kind's unmatched literal; `enable` removes the entry regardless, since it matches stored strings, not live tools.

## Migration Plan

No file or state migration. User-facing migration is documentation: the README command table and migration mapping gain the `overlay tools [ref...]` → `overlay disable tool <name>` (or profile `tools` declaration) row.
