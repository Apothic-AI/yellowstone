# Tasks

## 1. Carry user skill exclusions

- [x] 1.1 In `src/settings-generator.ts`, append the user's `!pattern` entries unchanged, and their `-path` entries (rewriting an absolute or `~` path under the real agentDir to its runtime mirror path), to a named profile's generated `skills` array. Extend `test/settings-generator-selection.test.ts` with an exclusion mix (relative `!`, absolute and `~` `-` paths inside and outside the agentDir, relative `-`, dropped positive entries) and a `~` rewrite case. Verification: resource-reference scenario "User exclusions stay effective under a named profile"; `npx vitest run test/settings-generator-selection.test.ts`. Both new tests fail against the previous `src/settings-generator.ts`. Fact -> authoritative source: Pi's `!`/`+`/`-` semantics -> `applyPatterns` and `isEnabledByOverrides` in the installed `@earendil-works/pi-coding-agent` `dist/core/package-manager.js`.
- [x] 1.2 Extend `test/named-profile.integration.test.ts` with a launch where the user's settings hide an agentDir skill and a `~/.agents/skills` skill and force-include one agentDir skill, under a profile declaring `skills: ["*"]`. Verification: resource-reference scenario "User exclusions stay effective under a named profile"; `npx vitest run test/named-profile.integration.test.ts`. The test fails against the previous `src/settings-generator.ts` (the hidden skills appear). Fact -> authoritative source: launcher test process contract -> `test/helpers/launcher-runner.ts`.

## 2. Documentation and acceptance

- [x] 2.1 Correct the agentDir row of the filtering-model table in `docs/architecture/overview.md`. Verification: `rg -Fq 'runtime mirror path' docs/architecture/overview.md`. Fact -> authoritative source: mirroring of non-managed agentDir entries -> `src/settings-generator.ts` (`MANAGED_INSTANCE_FILES`).
- [x] 2.2 Validate the final tree. Verification: `npm run check && npm test`.
