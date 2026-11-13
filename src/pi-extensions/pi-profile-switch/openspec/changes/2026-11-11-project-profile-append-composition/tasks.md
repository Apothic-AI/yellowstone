# Tasks

Stage 0 is this proposal-only change. Stages S1–S3 implement it; S4 is release action owned outside this change.
Every implementation task names the spec-delta scenarios it covers, a command, and a check with a real failure
path. Case numbers (`§1.6`, `§3.3`, …) refer to [test-plan.md](test-plan.md); table rows refer to
[matrices.md](matrices.md).

## 1. Stage 0 — proposal, decision and documentation plan (no code)

- [x] 1.1 Write the OpenSpec change `openspec/changes/2026-11-11-project-profile-append-composition/`:
  `proposal.md`, `design.md`, `specs/profile-catalog/spec.md`, `specs/resource-reference/spec.md`,
  `specs/in-session-switch/spec.md`, `matrices.md`, `test-plan.md`, `bilingual-docs-proposal.md`,
  `si-corrections-resolution.md`, `tasks.md`. Verification: structural review of the file list above, plus
  `openspec validate --strict` (see 1.4). Failure path: a missing delta for any of the three capabilities, or a
  correction with no normative artifact in `si-corrections-resolution.md`, fails review.

- [x] 1.2 Record the decision: add `docs/adr/0022-project-profile-append-composition.md` (next available number;
  highest existing is 0021), and add exactly one top line `**Superseded by ADR-0022.**` to
  `docs/adr/0003-no-profile-inheritance.md` without touching its body. Verification: `git diff` shows one added
  line in ADR-0003 and a new 0022 file; `grep -c 'Superseded by' docs/adr/0003-no-profile-inheritance.md` is `1`;
  no other file under `docs/adr/` changes (`git status --porcelain docs/adr/`). Failure path: a second line, a
  rewritten body, a reused number, or an intervening ADR edited.

- [x] 1.3 Rewrite the now-false product non-goal in `docs/prd.md`: keep the rejection of `extends`, parent
  chains, and deep merge, name the single additive composition mode, and link ADR-0022. The separate
  project-resource narrowing non-goal stays byte-identical. Verification: `git diff docs/prd.md` touches only the
  composition non-goal bullet; the project-resource bullet is unchanged (`git diff -U0 docs/prd.md` shows no
  hunk over it). Failure path: any edit that implies a profile can restrict project-scope resources.

- [x] 1.4 `openspec validate --strict` on the change. **Cleared on 2026-11-12 by the S3 verification stage.** The S0
  blocker was environmental, not a property of the change: the `openspec` CLI was absent from `PATH`
  (`command -v openspec` → exit 1, `openspec --version` → exit 127) and installing it was outside S0's
  authorization. The CLI is present on this machine in the pre-existing npx cache, so the gate was run against a
  **pinned** copy of it, offline (`OPENSPEC_TELEMETRY=0`, `DO_NOT_TRACK=1`):
  `~/.npm/_npx/20f2b75ddc8bce88/node_modules/.bin/openspec`, version `1.5.0`, upstream tarball pinned by the npx
  install lock (`https://registry.npmjs.org/@fission-ai/openspec/-/openspec-1.5.0.tgz`,
  `sha512-SLZkyF51gFYkISufZKaka0X04z4y/WCjPOcCB+EC7tALd0TC+7V76BOIzWOSIOhdhBWwh5EMIBhrgLnugIh1DA==`),
  package file manifest `sha256:1567891abb2352df2f025d26020d35d8d38a30d0d0523cbfe8833d792353c699` over 342 files.
  Commands and results, run in `src/pi-extensions/pi-profile-switch`:
  `openspec validate 2026-11-11-project-profile-append-composition --strict --type change` → "is valid", exit 0;
  `openspec validate --all --strict` → 5 passed, 0 failed, exit 0. OpenSpec 1.5.0 validates a change name against
  `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` before `status` and `instructions apply` resolve it, so those two commands
  reject this date-prefixed name while `list` and `validate` accept it; they were therefore run against the same
  artifacts under a temporary letter-prefixed alias (`d2026-11-11-project-profile-append-composition`) in a scratch
  copy of `openspec/` made outside the repository, the copy proven byte-identical to the source file for file
  (`diff -r` clean, 12 file hashes equal) and deleted afterwards. The source change keeps its name and is never
  renamed, moved or written. Verification: `validation-record.md` records the commands, the exit codes, the pin and
  the alias procedure. Failure path: any validation error is a blocker, not a bypass; a scratch copy that differs
  from the source in any file hash is not evidence and is discarded rather than reported.

- [x] 1.5 Fix the bilingual user-facing wording now, before code: `bilingual-docs-proposal.md` contains the exact
  English and Chinese text for the project-override paragraph, the field row, the omitted/empty guidance, and the
  project-scope limitation, with their insertion points in `README.md` and `README.zh-CN.md`. Verification:
  review of that file; the wording must not claim that `append` restricts project-scope resources, must not
  present an unapplied reference as an error or a typo report, and must not describe rollback as free.

- [x] 1.6 Apply SI review v1 corrections as a separate revision (no amend of the reviewed commit): explicit
  `append|replace` values in the governing spec/ADR/bilingual field row; a standalone no-global branch with its own
  matrix; the provenance agreement scoped to applied declared references with a disjoint `native` kind; tool
  provenance as explicit pending/resolved/dropped states held in a separate pending list and threaded through the
  existing caller; and the corrected documentary statements (source-only check rationale, old-code hazard scope,
  design-only consumer enumeration/conversion). Verification: the revision map in
  `si-corrections-resolution.md` names each new clause and test row, and `git log` shows the revision as a new
  commit on top of the reviewed one. Failure path: any correction resolved only by prose in `result.md` rather than
  by a normative clause or test row.

## 2. Stage S1 — composition core, parse, schema, and user docs

- [x] 2.1 Add `src/profile-composition.ts` (pure; no `node:fs`, no discovery import) exporting
  `composeProfileDefinitions(global, project, options)` → `{ definition, referenceContributors, unapplied,
  diagnostics, branch }` per `design.md` "Export surface", with the standalone branch taken when `global` is
  `undefined`. Verification: `npx vitest run test/profile-composition.test.ts`;
  cases §1.1–§1.1b, §1.2–§1.5, §1.8, §1.10, §1.9. Covers "Composite declaration intent and unapplied references",
  "Standalone append declaration intent", "Per-server MCP tool policy in a composed definition" (4 scenarios),
  "Unrestricted kind keeps native selection with an honest diagnostic", "Native child-role settings are not
  merged". Failure path: a matrix row from `matrices.md` §1–§3 that the module contradicts fails a named case; a
  standalone reference reported as unapplied fails §1.1b; the purity case fails if any import is added.

- [x] 2.2 Add explicit strategy parsing to `src/profile-catalog.ts`: `readPromptStrategy` validating against the
  accepted set, throwing `CatalogError` naming file, profile, and accepted values, and assignment into
  `ProfileDefinition`. Do not rely on `supportedFields`, which only drives the unknown-key warning. Verification:
  `npx vitest run test/profile-catalog.test.ts test/profile-composition.test.ts`; cases §2.2, §1.8. Covers
  "Unsupported strategy value is a field error" and the retention paragraph of "Profile composition strategy".
  Failure path: the parse-retention case must fail if only the schema is changed — that is the point of the case.

- [x] 2.3 Index both halves per name and compose at the catalog boundary: read the global entry **only** for a
  trusted `append` winner with a namesake; keep `source: "project"`; expose composition metadata and
  `composesGlobal`; do not cache or write the merged definition. Verification:
  `npx vitest run test/profile-catalog.test.ts test/initial-profile.test.ts`; cases §2.1, §2.3–§2.8. Covers
  "Project append composes with the global namesake", "Append without a namesake stands alone", "Invalid global
  base fails closed", "Composition base is read only for append", "Composition is never cached", "Untrusted
  project's catalog files are not read". Failure path: the fs-spy directions fail if a replacement winner reads
  the global file or an untrusted directory opens a project file.

- [x] 2.4 Enforce the two reference validations where the halves are merged: the append-project-half negated-glob
  error and nothing else. Verification: `npx vitest run test/profile-composition.test.ts`; cases §1.7. Covers
  "Negated glob in an append project half fails closed" and "Replacement definitions keep today's behavior".
  Failure path: the "did not tighten" case fails if a replacement definition starts rejecting `!`-prefixed globs.

- [x] 2.5 Add the optional `promptStrategy` field to `schemas/profiles.schema.json` (declared between
  `description` and `skills`), and update shipped examples if any profile example would now be misleading.
  Verification: `npx vitest run test/schemas.test.ts test/profile-validation-docs.test.ts`; the schema accepts the
  documented values and rejects an out-of-set value. Failure path: a schema that permits an arbitrary string fails
  the rejection case.

- [x] 2.6 Sync both README editions with the wording fixed in 1.5: `README.md` and `README.zh-CN.md` — the
  project-override paragraph under `### File locations and names` / `### 文件位置与命名`, the new field row in
  `### Field reference` / `### 字段参考`, the composed-profile guidance in `### Resource selection` /
  `### 资源选择`, and the project-scope limitation paragraph. Verification:
  `npx vitest run test/resource-selection-docs.test.ts test/profile-validation-docs.test.ts`; field rows must
  compare equal across editions and cover every schema field including `promptStrategy`. Failure path: a
  one-sided edit fails the cross-edition comparison naming the missing field.

- [x] 2.7 Update `docs/architecture/overview.md` (resolution and filtering model) and `CONTEXT.md` (one term for
  the composed definition, plus the source-scope clarification that a composed result still reports the project
  source). Verification: doc tests above plus a link check on any added reference; the overview must not restate
  the spec tables. Failure path: a claim in the overview that contradicts a spec delta.

## 3. Stage S2 — the single origin trace

- [x] 3.1 Thread the trace through the one expansion: `onSelect` on `expandReferences`, `onSelect` on
  `DiscoveredExtensions.select`, `referenceContributors` input, provenance output on `ActivationPlan` keyed by
  resolved entry path for extensions, with `native` reserved for identities selected through no declaration.
  Nothing else in the resolver or discovery moves. Verification:
  `npx vitest run test/profile-resolver.test.ts test/extension-discovery.test.ts`; cases §3.1–§3.3, §3.7–§3.11.
  Covers "Composed reference declarations" (attribution scenarios), "Each kind expands once", "Extension
  provenance is collision-safe", "Provenance cannot disagree with selection for declared identities", "Native
  selection is not a disagreement", "Non-composed plan is unchanged". Failure path: the expansion-count case,
  which instruments expansion invocations rather than counting `onSelect` callbacks, fails on a per-scope
  expansion; the deep-equality case fails on any unrelated plan change.

- [x] 3.2 Resolve tool provenance through the existing session-start expansion: extend `ToolExpansion` and
  `expandToolReferences` with the optional contributor map and per-reference outcomes, keep the three states
  distinct (`resolved` at boot for built-in names, `pending` in the separate `pendingToolReferences` list, and
  `dropped` at session start, where a literal miss keeps `droppedLiterals`, an MCP-only match keeps
  `legacyMcpReferences`, and a no-match glob keeps neither and gains no invented warning), and add no new reader,
  backend, or runtime entry point. Verification: `npx vitest run test/profile-resolver.test.ts test/apply-plan.test.ts
  test/switch-profile.test.ts`; cases §3.4, §3.5, §3.11 and §4. Covers "Unresolved raw tool reference stays pending
  at boot", "Boot and session-start tools are distinguished", "Session start resolves or drops every pending
  reference". Failure path: a boot pass-through literal keyed as a tool fails §3.4; a reference left pending in the
  in-process outcome after session start fails §3.11; a no-match glob emitting `droppedLiterals` or an MCP-only
  match collapsed into `droppedLiterals` fails §3.11 and §4; a boot-snapshot status row claiming a current outcome
  without existing evidence fails §3.11 and §4; an added import of a runtime reader fails the import-surface
  assertion.

- [x] 3.3 Carry provenance into the plan file without disturbing the uncomposed shape: `src/switching/apply-plan.ts`
  gains optional `composition`, `extensionOrigins`, `toolOrigins`, `origins`; `src/settings-generator.ts` passes
  them through only. Verification: `npx vitest run test/apply-plan.test.ts test/settings-generator.test.ts`;
  serialized non-composed plans are byte-identical to the pre-change output. Failure path: any non-optional field
  or reordered key fails the byte-identity comparison.

- [x] 3.4 Render composition, contributors, unrestricted kinds, unapplied references, pending tool references, and
  overlay truth in `src/switching/status.ts` and `src/switching/list-profiles.ts`, reading only the active plan and
  claiming no resolved per-tool contributor without an existing persistence carrier. Verification:
  `npx vitest run test/status.test.ts test/list-profiles.test.ts test/observability.integration.test.ts`; cases §7.
  Covers "Status names the composition", "Status reports contributors", "Unrestricted kind is described
  honestly", "Standalone append is visible", "Pending and resolved tools are not conflated", "Status does not
  contradict the overlay", "Status reads no additional definitions". Failure path: an extra `readFile` during
  status fails the spy case; a resource attributed to a scope that did not declare it fails the contributor case.

## 4. Stage S3 — prove, and finish the paper trail

- [x] 4.1 Discovery boundary proof with a real `SettingsManager` and real `discoverSkills`: extend
  `test/sparse-resource-selection.integration.test.ts` and `test/settings-generator-selection.test.ts`. Verification:
  `npx vitest run test/sparse-resource-selection.integration.test.ts test/settings-generator-selection.test.ts`;
  case §5. Covers "Native exclusion stays unselectable" and "Globally unselected but eligible resource is added".
  Failure path: an excluded skill that becomes selectable, or a project-scope skill that disappears, fails the run.

- [x] 4.2 Generator preservation and the 13-skill fixture: extend `test/settings-generator.test.ts` and
  `test/settings-generator-selection.test.ts`; the fixture declares exactly 13 skills and all assertions beyond
  that are dynamic. Verification: `npx vitest run test/settings-generator.test.ts test/settings-generator-selection.test.ts`;
  case §6. Covers "Declared empty base is widened" and "Empty project list contributes nothing" end to end.
  Failure path: a narrowed `tools` allowlist or a duplicated added skill fails the assertion.

- [x] 4.3 Launcher proof through `test/helpers/launcher-runner.ts` only: extend
  `test/project-scope.integration.test.ts` and `test/named-profile.integration.test.ts`. Verification:
  `npx vitest run test/project-scope.integration.test.ts test/named-profile.integration.test.ts`; case §8. Covers
  "Project append composes with the global namesake", "Absent strategy keeps complete replacement", "Invalid
  global base fails closed". Failure path: a hung child (stdin not closed by the helper) or a non-zero exit on the
  valid composed case fails the run.

- [x] 4.4 Full gates on the final tree: `npm run check`, `npm test`, `/opsx-verify`, and `openspec validate
  --strict`. Verification: all four exit successfully on the final tree; `/opsx-verify` is completed and its
  result recorded — `openspec validate --strict` alone does not replace it. Failure path: any non-zero exit blocks
  archive. Task checkboxes are progress, not acceptance.

## 5. Stage S4 — release obligations (outside this change; recorded here so the text does not get lost)

- [ ] 5.1 Publish a release note carrying the adoption and rollback truth from `design.md`: package install is
  not loaded-runtime adoption; a new launch resolves installed code only when the launch source resolves to that
  installation; native reload versus `/profile reload` differ; old extension code warns and replaces whenever an
  `append` file meets it, not only after an install; no mandatory restart; rollback is blocked while `append`
  consumers would be served by old code, and the consumer conversion is a separately reviewed operation with its
  own scope and holds. Verification: `grep -c 'promptStrategy' <release
  note>` and a read of the note against `design.md` "Adoption and rollback truth" — every one of those seven
  statements must be present. Failure path: a note that says "nothing needs repair" or recommends a blanket
  reload fails review.

- [ ] 5.2 **Design obligation only, not authorized action.** Before any revert, a future release scope must
  enumerate the project catalog files carrying `"promptStrategy": "append"` and remove, rename, or convert them
  first. This change records the obligation and its shape; it grants no filesystem enumeration, read, deletion, or
  conversion, and the exact eligible-consumer scope, holds, and procedure belong to that separately reviewed
  release plan. Verification (of the future scope, not of this change): a recorded enumeration output restricted to
  the approved consumer scope, and a post-conversion run showing none remain. Failure path: a revert performed with
  consumers present, or an enumeration read outside the approved scope treated as authorized by this task.

## Readiness reconciliation

- Required outputs: proposal, design, three capability deltas, tasks, matrices, test plan, bilingual proposal,
  ADR-0022, ADR-0003 line, `docs/prd.md` non-goal — all present in this change or recorded as S1 work with paths.
- Declared checks reject nothing required: no check asserts the absence of a required row, and the byte-identity
  checks are scoped to non-composed plans only.
- Unresolved conflict: none. Blocked item: none — 1.4 was blocked in the S0 environment by the CLI's absence from
  `PATH` and was cleared on 2026-11-12 with a pinned, offline copy of that CLI
  (`openspec validate 2026-11-11-project-profile-append-composition --strict --type change` → "is valid", exit 0;
  `openspec validate --all --strict` → 5 passed, 0 failed, exit 0), and `/opsx-verify` was completed against the
  CLI's own artifact map; see `validation-record.md`. Stage S4 (5.1, 5.2) stays open: it is release scope owned
  outside this change.
