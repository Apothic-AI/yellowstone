# Tasks

## 1. trust.json link and trust-flag forwarding

- [x] 1.1 Change `writeRuntimeFiles` in `src/settings-generator.ts`: establish the `trust.json` link to the real agentDir under every profile (established when the path is missing, and also when the target file does not exist yet); delete the `plan.filter === "none"` check and the link-removal branch. Verification: new cases in `test/settings-generator.test.ts` and `test/settings-generator-selection.test.ts` (named profiles get the link too; a dangling link is still established when the target is missing) pass.
- [x] 1.2 Change `bin/pi-profile.ts`: the trust flag is no longer filtered by `plan.filter === "none"`; every profile forwards the recorded one-shot input. Verification: the `--approve` case in `test/project-scope.integration.test.ts` (project-level resources visible after a named profile receives the flag) and `test/launcher-spawn.test.ts` pass.
- [x] 1.3 Confirm the link does not break sweeping and lifecycle: `trust.json` is already in the managed file set, no new whitelist entry needed. Verification: `test/runtime-cleanup.test.ts` and `test/instance-lifecycle.integration.test.ts` pass.

## 2. Stop project-level narrowing

- [x] 2.1 Change `buildSelectionSettings` in `src/settings-generator.ts`: skills with project scope get neither exclusions nor attached paths. Verification: new cases in `test/settings-generator-selection.test.ts` (project-level skills and ancestor `.agents/skills` produce no entries) pass.
- [x] 2.2 Same function: extension entries under project `.pi/extensions` are not written into generated settings. Verification: new cases in the same file pass.
- [x] 2.3 Delete project settings merging and `packages` stripping: `readTrustInputs` in `src/launcher/initial-profile.ts` no longer reads project settings; `InitialProfile`/`GenerateOptions`/`RuntimeFileOptions` lose the `projectSettings` field; `bin/pi-profile.ts` and `src/switching/switch-profile.ts` adjusted accordingly. Verification: updated cases in `test/initial-profile.test.ts`, `test/settings-generator.test.ts`, `test/switch-profile.test.ts` pass, and `rg -n "projectSettings" src/ bin/` hits only tests or nothing.
- [x] 2.4 Change `src/mcp-config.ts`: MCP configuration sources mark project origin, and the merge result returns the project-sourced server set; the MCP filtering in `src/settings-generator.ts` no longer disables those servers. Verification: the `projectServers` cases in `test/mcp-config.test.ts` and the "project-sourced MCP servers are not disabled" case in `test/settings-generator-selection.test.ts` pass.

## 3. Integration behavior verification

- [x] 3.1 Rewrite the trusted-project assertions in `test/project-scope.integration.test.ts` to the new semantics: unselected project-level skills/extensions are visible too, and project `.pi/settings.json` is no longer merged into generated settings. Verification: the file passes.
- [x] 3.2 Add a case in `test/project-scope.integration.test.ts` or `test/switch.integration.test.ts`: under a trusted project, switching after launching with a named profile (`/profile use default`) does not change project-level visibility and needs no restart. Verification: the case passes.
- [x] 3.3 Add a case in `test/project-scope.integration.test.ts`: when the project is untrusted, project-level skills/extensions do not appear in the session, and a single `--approve` run admits both the project catalog and project-level resources. Verification: the case passes.

## 4. Documentation sync

- [x] 4.1 Change `docs/architecture/overview.md`: the "Project level" row becomes "decided natively by Pi, profiles do not participate"; the `packages (project)` row becomes native install; the `trust.json` row becomes linked under every profile; the settings row drops project settings merging; rewrite the two "Known limitations" entries "trust determination of project resources is only performed by the launcher" and "project-scope package skills are not referenceable". Verification: `rg -n "suppress all project auto-discovery|named profiles do not link" docs/architecture/overview.md` has zero hits (checked against the pre-update Chinese wording).
- [x] 4.2 Change `docs/prd.md`: write the boundary into the non-goals section — a profile's isolation surface is user-level resources; project-level resources are decided by Pi's trust determination. Verification: the boundary item appears in the file, and mechanism details remain only in the architecture document.
- [x] 4.3 Add `docs/adr/0011-project-scope-belongs-to-pi.md`: records the decision, the rejected alternatives (keep isolating via the trust gate, add exclusions for project-level resources), and the consequences (profiles lose project-level control; project settings behavior keys override profile declarations). Verification: the file exists with the next available number, and the "ADR required: project-scope-belongs-to-pi" mark in `design.md` has landed.
- [x] 4.4 Check whether `README.md` and `README.zh-CN.md` claim project-level isolation capability; `rg -n -i "unselected|hide|hidden|filter|narrow|project" README.md README.zh-CN.md` shows no stale description; unchanged.

## 5. Wrap-up

- [x] 5.1 Run `npm run check` and `npm test`; all pass.
- [x] 5.2 Run `openspec validate delegate-project-scope-to-pi`; passes with tasks and specs consistent.
