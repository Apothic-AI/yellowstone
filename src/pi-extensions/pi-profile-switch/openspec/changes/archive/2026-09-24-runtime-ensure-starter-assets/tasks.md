# Tasks

## 1. Ordering prerequisite

- [x] 1.1 Archive `profile-config-skill` (`/opsx-archive`) so that "Distributing the profile-config skill at install" enters the main spec `openspec/specs/profile-catalog/spec.md`. Verification: running `openspec validate runtime-ensure-starter-assets` after archiving no longer shows the "RENAMED failed … source not found" INFO note

## 2. Runtime ensure module

- [x] 2.1 Add `src/starter-assets.ts`: implement `ensureStarterAssets()` per design.md D1's export surface. Seeding rule: write the starter profile with `COPYFILE_EXCL` semantics when the target directory has no `.json` at all; skill rule: overwrite only when the target is missing or its content differs, no write when identical; the two assets succeed or fail independently, and IO failures become `warnings` without throwing. Verification: covers six scenarios — "Backfill at startup", "No overwrite at startup", "Startup seeding failure degrades to a warning" from "Seeding the starter profile", and "Backfill or sync at startup", "Content already in sync at startup", "Startup distribution failure degrades to a warning" from "Distributing the profile-config skill" in the specs delta; `npx vitest run test/starter-assets.test.ts` passes. Fact → authoritative source: asset relative paths `examples/ask.json`, `skills/profile-config/SKILL.md` → the actual files in the repo and the `files` array of `package.json`; agentDir default resolution → `getAgentDir()` exported by `@earendil-works/pi-coding-agent` (source under `node_modules/@earendil-works/pi-coding-agent`)
- [x] 2.2 `bin/pi-profile.ts`: call `ensureStarterAssets()` after `parseLauncherArgs` and before `resolveInitialProfile`; `warnings` printed via `console.error` and startup continues. Verification: end-to-end visibility covering the "Backfill at startup" scenario (the seeded result is visible to initial profile resolution); `npx vitest run test/launcher.integration.test.ts` passes. Fact → authoritative source: the warning output prefix `pi-profile: warning:` → the existing sweep warning output in `bin/pi-profile.ts`

## 3. postinstall role update

- [x] 3.1 `bin/postinstall.js`: only the file-header comment is updated — the role changes from sole distribution channel to best-effort early optimization, with the authoritative behavior contract pointing at "Seeding the starter profile" and "Distributing the profile-config skill" in `openspec/specs/profile-catalog/spec.md`; distribution logic unchanged. Verification: existing cases of `npx vitest run test/postinstall.test.ts` (covering the "First install", "Existing catalog", "Upgrade overwrite", and "Distribution failure degrades to a warning" scenarios) all pass

## 4. Documentation sync

- [x] 4.1 `README.md` and `README.zh-CN.md`: change the `profile-config` skill's "distributed on install" wording to "distributed best-effort at install, guaranteed in place at launcher startup". Verification: grep shows neither README still contains distribution wording attributed to install alone. Fact → authoritative source: distribution-timing semantics → this change's specs delta
- [x] 4.2 `docs/architecture/overview.md`: update the `postinstall.js` role description in the `bin/` table row; add a `starter-assets.ts` row to the `src/` module table. Verification: the table descriptions match design.md D1/D5 and do not restate the spec behavior contract (links used instead). Fact → authoritative source: module export surface → design.md D1

## 5. Regression

- [x] 5.1 `npm run check` and `npm test` all pass. Verification: both commands exit with code 0
