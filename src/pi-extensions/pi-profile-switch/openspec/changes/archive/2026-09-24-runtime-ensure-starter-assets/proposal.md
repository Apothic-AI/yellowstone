# Proposal

## Why

The distribution of the starter profile (`ask`) and the `profile-config` skill depends entirely on the npm `postinstall` hook. Since npm v12, dependency lifecycle scripts are blocked by default (not executed unless `allowScripts` permits them, with only a warning printed), so users end up missing both artifacts after install, with no error pointing at the cause. As long as distribution depends on "code executing automatically at install time", execution is out of our control. The distribution guarantee must move to runtime: the launcher is the entry point every session passes through, and backfilling the artifacts at startup guarantees "in place before first use".

## What Changes

- Add a runtime ensure: on every launcher (`pi-profile`) startup, before resolving the initial profile, run backfill logic with the same rules as postinstall —
  - write the shipped starter profile `ask.json` when the global `profiles/` directory contains no `.json` file (never overwrite existing files);
  - overwrite the user agentDir's `skills/profile-config/SKILL.md` with the shipped version when its content differs.
- Ensure failures degrade to stderr warnings and MUST NOT block startup (consistent with the instance sweep's best-effort pattern).
- `bin/postinstall.js` is kept, its role demoted from the sole distribution channel to a best-effort early optimization; behavior rules unchanged.
- No new user-visible configuration fields: the ensure's timing and destinations are entirely decided by existing discovery mechanisms (`PI_PROFILE_SWITCH_DIR`, Pi's `getAgentDir()`); nothing configurable.
- No breaking change: install-time behavior is unchanged; only runtime backfill is added.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `profile-catalog`: modifies the two requirements "Seeding the starter profile at install" and "Distributing the profile-config skill at install" — the trigger timing expands from install-only to "best-effort at install + guaranteed at launcher startup", and the failure semantics expand from "must not fail the install" to "must not fail the install or the launch".

## Impact

- Code: new `src/starter-assets.ts` (ensure logic and export surface); `bin/pi-profile.ts` (invocation in the startup flow); `bin/postinstall.js` (file-header comment updates the role positioning, logic unchanged).
- Tests: new starter-assets unit tests; existing postinstall cases keep passing.
- Docs: the install sections of `README.md` and `README.zh-CN.md` (the skill distribution's "on install" wording); the `bin/` table row and new module description in `docs/architecture/overview.md`.
- Ordering assumption: this change's specs delta modifies "Distributing the profile-config skill at install", a requirement introduced by the then-unarchived `openspec/changes/profile-config-skill/`. Before this change enters apply, `profile-config-skill` should be archived (synced into the main spec), otherwise the delta lacks a base.

## Doc Impact

- `docs/prd.md`: none — the distribution-timing adjustment does not change product positioning or non-goals.
- `docs/architecture/overview.md`: the postinstall role description in the `bin/` table row; a new `src/starter-assets.ts` module description.
- `CONTEXT.md`: none — no new terms; the existing "seeding" and "distribution" wording is reused.
- `docs/adr/`: none — the decision is reversible (restoring postinstall-only distribution only requires deleting the runtime call) and locks no external dependency. Rejected alternatives recorded here: switching to a shell-script distribution (npm's blocking happens at the lifecycle-hook layer regardless of script language, and Windows portability would be sacrificed); documenting `--allow-scripts` for users to permit (pushing the guarantee onto a user action equals having no guarantee); a second ensure point in the extension's `session_start` (the extension early-returns outside the launcher anyway; the launcher is already the single entry point, and a second write point only adds divergence risk).
