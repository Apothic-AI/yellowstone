# Design

## Context

The `/profile` handler today dispatches ten forms; the overlay narrowing in `src/profile-resolver.ts` matches literal names against resolved sets and hard-fails unknowns, while profile references one call away already expand globs with tiered failures (ADR-0009). The resolver already has a warning channel (`plan.unmatched`, fed by `onZeroMatch` callbacks) that launch output and `/profile status` render. See proposal.md → Why for motivation.

## Goals / Non-Goals

**Goals:**

- Command surface of five forms: bare selector, `use`, `reload`, `status`, `overlay`.
- One authoring path: the `profile-config` skill plus direct file editing; the system performs no catalog mutations.
- Overlay disable entries reach parity with profile references: names or globs, stored as written, expanded at resolution.
- No storage-format migration.

**Non-Goals:**

- No changes to the profile file format, the launch argument, the state file shape, or the switch/rollback machinery.
- No negation or per-item re-enable within a glob disable ("hole-punching").
- `overlay tools` reference semantics are unchanged — tool references already expand at apply time via the existing tool-reference path.

## Decisions

### 1. The overlay stores patterns; expansion happens at resolution

Entries like `git-*` are stored verbatim in the state file and re-expanded at every resolution (switch, reload), reusing the same matcher as profile references. The overlay is a temporary narrowing of the profile; giving it the same reference semantics keeps one mental model and one matching mechanism.

The storage fields (`disabledSkills?: string[]`, etc.) are reinterpreted, not restructured — strings that may now contain globs. No migration is needed because a stored overlay never survives a runtime: a stale pre-change overlay is ignored at the next startup, and within a runtime the worst case is one hard failure on a now-unknown literal, which is pre-existing behavior.

**Rejected: eager expansion at command time** (expand the glob against the currently resolved set, store concrete names). Simpler storage, but the result freezes at command time while the overlay lives across reloads — a resource appearing later (edited profile, newly discovered MCP server) silently escapes the narrowing. It also breaks when a stored concrete name leaves the profile: reload hits the existing unknown-entry hard failure and rolls back. Stored patterns degrade to a warning in exactly that situation.

### 2. `enable` removes a stored entry by exact string match

`/profile overlay enable skill git-*` removes the stored entry `git-*`. There is no hole-punching: re-enabling one member of a glob-disabled set means `overlay clear` plus narrower globs. This keeps the overlay a single list of patterns with set semantics, and makes status self-describing — the entries it prints are exactly the strings `enable` accepts. A no-match `enable` fails and lists the current entries of that kind, keeping the error actionable.

**Rejected: negation entries** (a re-enable list layered over the disable list). Ordering and union semantics would complicate the resolver, the status rendering, and the user's model for an ephemeral convenience feature; it can be added later without changing the storage shape if real demand appears.

### 3. Glob failures reuse the ADR-0009 tiering and warning channel

An unmatched literal disable fails and identifies the entry (unchanged from today — typo protection). A zero-match glob succeeds with a warning: overlay commands are interactive and feedback-hungry, but a glob is a dynamic reference whose zero match may be transient. Warnings ride the plan's existing `unmatched` channel, prefixed to distinguish overlay entries from profile references (e.g. `overlay skill:git-*`), so both the command's notify and `/profile status` surface them without a new reporting mechanism.

**Rejected: hard-failing zero-match globs.** Defensible for an interactive command (immediate typo feedback), but inconsistent with profile references and punishing a legitimate pattern: disabling a glob that matches only after the profile is edited mid-runtime.

### 4. The command word is `overlay`; `reset` folds into `overlay clear`

`overlay` is the glossary term (CONTEXT.md) and the word status, notifies, and specs already use — the command becomes guessable from its own output. `clear` joins `disable|enable|tools` as an overlay operation instead of occupying a top-level slot, shrinking the surface to five forms.

**Rejected:** `narrow` (no natural inverse for `enable`), `temp`/`session`/`try` (the glossary's avoid list bans the "temporary profile" direction, and `try` implies the overlay might not stick — it persists across reloads within the runtime).

### 5. CRUD removal relies on read-time validation as the safety net

Deleting the wizard path removes write-time validation with it. That is acceptable because catalog files were always user-editable: format validation and name constraints on read are already specified, and the `profile-config` skill teaches the format to the agent. The failure mode of a bad hand-edit is a readable error at the next activation, not corruption.

**Rejected: keeping the wizards as a second path.** They provide no resource discovery (free-text prompts for names the user must already know), so they cannot serve users who could not edit the file directly.

## Export surface

**Removed modules:**

- `src/switching/profile-wizard.ts` — `runProfileCreateWizard`, `runProfileEditWizard`, `runProfileDuplicateWizard`, `ProfileWizardUi`, `ProfileWizardResult`
- `src/switching/profile-crud.ts` — `createProfile`, `editProfile`, `deleteProfile`, `duplicateProfile`, `readCatalogScope`, `CatalogScope`
- `src/profile-catalog-store.ts` — `ProfileCatalogStore` (its only consumer is the CRUD path)

**Renamed module** `src/switching/customize.ts` → `src/switching/overlay.ts`:

- `OVERLAY_USAGE: string` — replaces `CUSTOMIZE_USAGE`
- `parseOverlayArgs(args: string): OverlayCommand` — replaces `parseCustomizeArgs`; `type OverlayCommand = { kind: "mutate"; mutate: (overlay: RuntimeOverlay) => RuntimeOverlay } | { kind: "clear" }`, absorbing `clear`
- `applyOverlayMutation(deps: SwitchDeps, mutate: (overlay: RuntimeOverlay) => RuntimeOverlay): Promise<SwitchResult>` — renames `customizeOverlay`; ordering invariant unchanged (re-resolve → switch+reload → persist)
- `clearOverlay(deps: SwitchDeps): Promise<SwitchResult>` — renames `resetOverlay`
- Errors remain `SwitchError`

**Modified, signatures unchanged:**

- `src/profile-resolver.ts` — overlay narrowing matches entries as name-or-glob; zero-match glob entries join `plan.unmatched` with an `overlay ` prefix
- `extensions/pi-profile/index.ts` — dispatch table shrinks to the five forms; the CRUD and `list` branches are deleted; the bare invocation's non-UI degradation gains the structured `details` payload (`{ kind: "list", profiles }`); usage and notify strings adopt the `overlay` vocabulary

## Risks / Trade-offs

- [Scripts or habits using `customize`/`reset`/CRUD subcommands break] → Pre-1.0 clean break; unknown subcommands get a usage note naming the new set; README documents the mapping (including the file-editing path for CRUD).
- [A typo'd glob narrows nothing and only warns] → The warning is immediate (command notify) and persistent (`/profile status`); this matches the ADR-0009 stance that zero-match globs must not block.
- [Hole-punching is unavailable] → Escape hatch is `overlay clear` plus narrower globs; the storage shape already permits a future negation model.
- [Externally edited catalog files bypass write-time validation] → Read-time validation is specified and pre-existing; the worst case is an actionable error at next activation.

## Migration Plan

Single release. No file or state migrations: profile files, the state file, and generated settings are untouched, and stored overlays never cross a runtime boundary. User-facing migration is documentation: the README command table and release notes map removed/renamed subcommands to their replacements.
