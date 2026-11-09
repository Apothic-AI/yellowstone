# Proposal

## Why

A named profile can show user-level skills that plain Pi hides. When the user's own settings exclude skills (for example `"skills": ["!skills/**", "+skills/kept"]`), resolution correctly leaves the hidden skills out of the reference vocabulary. Because they are not in the vocabulary, the generator writes no `-<path>` entry for them either, and it then replaces the user's `skills` array, dropping the user's exclusions. The instance mirrors the real agentDir's `skills` directory and Pi always discovers `~/.agents/skills`, so every skill the user hid comes back in the named profile's session.

On one real setup this turned 109 visible skills under plain Pi into 240 under a profile declaring `"skills": ["*", "**"]`, roughly 65 KB of extra system prompt on every request.

## What Changes

- Carry the user's own skill exclusion entries (`!pattern` and `-path`) from the real agentDir's settings into a named profile's generated `skills` array.
- Rewrite an absolute or `~`-prefixed `-path` under the real agentDir to its runtime mirror path, matching how unselected agentDir skills are already excluded. Relative entries pass through unchanged because the instance mirrors the agentDir.
- Leave the default profile and every other settings key unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resource-reference`: A named profile MUST NOT reveal a user-level skill that the user's own settings exclude.

## Impact

`src/settings-generator.ts` (`buildSelectionSettings` and a new private `userSkillExclusions` helper), with tests in `test/settings-generator-selection.test.ts` and `test/named-profile.integration.test.ts`. It adds no field, command, or dependency. The user's positive `skills` entries are still replaced by the profile's selection, as before.

Out of scope: the default profile appends the real agentDir's absolute `skills` directory to the user's array, and Pi matches a relative `!pattern` against paths relative to the instance, so a relative exclusion does not cover that copy. That is a separate behavior of the default-profile path and is reported separately.

## Doc Impact

- `docs/prd.md`: none: the user-level narrowing goal is unchanged.
- `docs/architecture/overview.md`: correct the agentDir row of the filtering-model table. The instance mirrors `skills`, so unselected agentDir skills are force-excluded by runtime mirror path, and the user's own exclusions are carried over.
- `CONTEXT.md`: none: no term changes.
- `docs/adr/`: none: no hard-to-reverse decision.
