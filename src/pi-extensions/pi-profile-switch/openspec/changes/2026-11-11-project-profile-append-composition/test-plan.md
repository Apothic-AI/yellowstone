# Native test plan

Concrete suites and cases the implementation stage must add. Every case runs on native paths — real
`ProfileCatalog`, `resolveProfile`, `discoverSkills`, `DiscoveredExtensions`, `generateSettings`,
`buildStatusReport`, and the launcher through `test/helpers/launcher-runner.ts` (which closes child stdin; spawning
`pi` any other way hangs). No copied production logic, no hand-rolled resolver, no printed counts as assertions.

Commands are the package scripts (`package.json`): `npm run check` = `tsc --noEmit`; `npm test` = `vitest run`.
Per-suite commands below use `npx vitest run <paths>`.

## 1. Composition unit suite — new `test/profile-composition.test.ts`

Pure function, no I/O stubs needed beyond the module under test.

| # | Case | Pins |
| --- | --- | --- |
| 1.1 | every row of `matrices.md` §1 for `skills`; then the same table once per remaining kind | "Composite declaration intent and unapplied references", "Composed reference declarations" |
| 1.1b | every row of `matrices.md` §1b (no global file): project list applied in full, `[]` stays a declared empty selection, omitted kind stays native, no `append-unapplied-reference`, no `global` contributor, and the only diagnostic is `append-standalone` | "Standalone append declaration intent" (five scenarios) |
| 1.2 | unrestricted rows emit `undefined`, never `[]` | "Unrestricted rows never become empty selections" |
| 1.3 | `matrices.md` §2 rows 1–6, including "project key for a server the base does not name ⇒ no entry + diagnostic" | "Per-server MCP tool policy in a composed definition" (4 scenarios) |
| 1.4 | `matrices.md` §3 rows for the model pair, thinking level, `instructions` (incl. identical duplicate), `subagents` whole-field override, `label`/`description` | "Composite declaration intent…" scalar/instructions/subagent scenarios |
| 1.5 | exact diagnostic text and codes for `append-unapplied-reference`, `append-cannot-narrow`, `append-standalone`, including the file named in the message | "Unrestricted kind keeps native selection with an honest diagnostic", "Project key for an unnamed server is not applied" |
| 1.6 | contributor sets: identical literal ⇒ `both`; global glob + project literal ⇒ `both`; extension alias + entry name ⇒ `both`; the same identity selected twice reports one unioned set | "Composed reference declarations" (3 attribution scenarios) |
| 1.7 | `!foo*` in a project `append` half ⇒ error naming file, reference, reason; the same reference in a replacement definition and a global half is untouched | "Negated glob in an append project half fails closed", "Replacement definitions keep today's behavior" |
| 1.8 | an invalid strategy value, a global `append`, and a global replacement value (accepted, inert) | "Unsupported strategy value is a field error", "Append in a global definition is rejected", "Replacement value in a global definition is inert" |
| 1.10 | the accepted enumeration is exactly `append` and `replace`; project `replace` is identical to an omitted field; a third value such as `merge` is rejected — asserted from the contract, with no dependency on a schema that does not exist yet | "Only two strategy values are accepted", "Project replace value replaces explicitly" |
| 1.9 | static import assertion: the module imports no `node:fs`, `node:fs/promises`, discovery module, or clock | purity obligation in `design.md` |

`npx vitest run test/profile-composition.test.ts`

## 2. Catalog, trust, and parse retention

`test/profile-catalog.test.ts` (extend; this file is also touched by 2.2 and 2.3 — list it once in the task):

| # | Case | Pins |
| --- | --- | --- |
| 2.1 | `resolve()` on a project `append` returns the composed definition, `source: "project"`, and composition metadata; a replacement winner returns only the project half | "Project append composes with the global namesake", "Project entry completely replaces global entry" |
| 2.2 | parse retention: `parseProfileDefinition` **retains** a declared strategy; a schema-only addition fails this test (assert on the parsed value, not the schema) | "Profile composition strategy" (retention paragraph) |
| 2.3 | an invalid composed pair is listed as `available: false` with a path-bearing message; `composesGlobal` is true only for a project winner with a global namesake | "Invalid composition base does not fall back", "Invalid entry does not break listing" |
| 2.4 | invalid composed pair does not fall back to either half | "Invalid composition base does not fall back" |

Instrumented trust, four directions — `vi.mock("node:fs/promises", …)` with `importOriginal`, recording every
attempted `readFile`/`open`:

| # | Direction | Assertion |
| --- | --- | --- |
| 2.5 | untrusted project with `.pi/profiles/leader.json` present | no attempt under `<cwd>/.pi/profiles`, **and** the global definition was read (ordinary leader still resolves) |
| 2.6 | trusted project winning with replacement | no attempt on the global profile path |
| 2.7 | trusted project winning with `append` and a namesake | both paths attempted exactly once each |
| 2.8 | trusted project winning with `append`, no namesake: no global attempt, standalone result, informational diagnostic, **and the selected contents are asserted** — the selected skill set equals exactly the project's declared skills that discovery provides, the tool expansion equals the unchanged expansion of the declared tool references, and no reference is listed as unapplied | "Standalone append applies the project lists in full", "Standalone append keeps a declared empty list empty", "Standalone append leaves an omitted kind native" |

`npx vitest run test/profile-catalog.test.ts test/project-trust.test.ts test/initial-profile.test.ts`

## 3. Expansion, provenance, and the resolver freeze

`test/profile-resolver.test.ts` and `test/extension-discovery.test.ts` (both extended; also list them in the task):

| # | Case | Pins |
| --- | --- | --- |
| 3.1 | contributor scope per identity: global-only, project-only, both (literal+literal, glob+literal, alias+entry name) | "Composed reference declarations" |
| 3.2 | each kind expands once — count **expansion invocations** by instrumenting the expansion function per kind (and `DiscoveredExtensions.select`), never by counting `onSelect` callbacks, which can fire several times for one identity when refs overlap; separately assert an overlapping glob/literal fires the callback more than once for one identity and that the contributor union stays idempotent | "Each kind expands once" |
| 3.3 | extension provenance keyed by resolved entry path; two entries sharing an identifier keep distinct keys and distinct contributors | "Extension provenance is collision-safe" |
| 3.4 | tools: built-in ⇒ `state: "resolved"`, `at: "boot"`; package-extension tool ⇒ resolved at session start; unmatched raw literal ⇒ listed in the separate `pendingToolReferences` list with scope and `resolvesAt: "session-start"`, never keyed as a tool name, never `unknown`, never an existing tool | "Unresolved raw tool reference stays pending at boot", "Boot and session-start tools are distinguished" |
| 3.5 | tool reference forms: literal and glob, global/project overlap, zero matches, and preserved activation selection (the expanded tool set is unchanged by the trace) | "Reference provenance in the activation plan" |
| 3.6 | overlay disables a selected resource ⇒ absent from origins, present at most as a disabled entry; overlay glob removal likewise | "Overlay-removed resource is not currently selected" |
| 3.7 | provenance/selection agreement both ways for a composed definition, scoped to identities produced by applied declared references | "Provenance cannot disagree with selection for declared identities" |
| 3.10 | native selection is not a disagreement: existing global omits `skills`, project declares `skills: ["review"]`, discovery provides other skills ⇒ native skills carry no `global`/`project` contributor, `review` is unapplied, and the agreement invariant does not fire | "Native resources are not falsely attributed", "Native selection is not a disagreement" |
| 3.11 | session-start transition, in-process: a boot-pending reference resolves against a live extension tool in one case and drops in three others — a nonexistent literal reported through `droppedLiterals`, an MCP-only match reported through `legacyMcpReferences`, and a no-match glob reported through neither, because a zero-match glob is not an unknown literal and no `droppedLiterals` or `legacyMcpReferences` warning may be invented; exactly one outcome per reference, diagnostic text unchanged; the persisted plan is not rewritten, so status still labels the reference boot-snapshot pending with the current session outcome not recorded (UNKNOWN) | "Session start resolves or drops every pending reference" |
| 3.8 | resolver freeze: a replacement resolution's plan minus provenance fields is deep-equal to a recorded pre-change plan across skills/extensions/mcps/tools/overlay cases | non-composed byte-identity obligation |
| 3.9 | a non-composed plan serializes byte-identically (compare serialized JSON from both code paths) | "Non-composed plan is unchanged" |

`npx vitest run test/profile-resolver.test.ts test/extension-discovery.test.ts test/overlay.test.ts`

## 4. Session-start tool expansion and its caller

`test/switch-profile.test.ts` and `test/apply-plan.test.ts` (extended):

- contributors received from the plan survive the session-start re-expansion; per-tool contributors are reported
  for live tools; `droppedLiterals` and `legacyMcpReferences` behavior is unchanged; no new reader or backend is
  introduced (assert the module's import surface);
- a boot-pending reference becomes `resolved` for a valid extension tool, and `dropped` for a nonexistent literal,
  an MCP-only match, and a no-match glob, with exactly one outcome per reference and nothing left pending
  in-process; the three `dropped` cases stay diagnostic-distinct (nonexistent literal ⇒ `droppedLiterals`, MCP-only
  ⇒ `legacyMcpReferences`, no-match glob ⇒ neither, with no invented warning);
- the persisted plan keeps its boot-snapshot state, so status labels the reference boot-snapshot pending with the
  current session outcome not recorded (UNKNOWN) and claims no current pending/resolved/dropped outcome;
- the resolved per-tool map is returned in-process by the existing caller and is not claimed by status, because the
  plan file that status reads is written before session start (assert that no extra plan write is introduced);
- the plan file for a composed activation carries `composition`, the provenance maps, and
  `pendingToolReferences`; the plan file for an uncomposed activation carries none of them.
- the plan file for a composed activation carries `composition` and the provenance maps; the plan file for an
  uncomposed activation does not.

`npx vitest run test/apply-plan.test.ts test/switch-profile.test.ts`

## 5. Discovery boundary — source-disabled versus globally unselected

`test/sparse-resource-selection.integration.test.ts` (extend) or a sibling `test/composed-selection.integration.test.ts`:

- drive a real `SettingsManager` + real `discoverSkills` with a genuine `!pattern` exclusion and a `+`
  force-include; assert the excluded skill **cannot** be selected by any composed reference (diagnostic, not
  selection) and the force-included skill is present even when derived from the other scope;
- assert an eligible-but-unselected skill **can** be added by the project half;
- assert project-scope skills and loose project extensions stay visible under a composed profile (no new
  narrowing), which is the N7 limitation being exercised rather than claimed.

`npx vitest run test/sparse-resource-selection.integration.test.ts test/settings-generator-selection.test.ts`

## 6. Generator preservation and the 13-skill baseline

`test/settings-generator.test.ts` / `test/settings-generator-selection.test.ts` (extended):

- a project half that adds exactly one skill and omits `tools` yields the **global `tools` allowlist verbatim**,
  all global skills still selected, and the added skill present exactly once;
- an omitted `mcp_tools` in the global half is not narrowed by a project entry (already covered by §1.3, exercised
  here end to end);
- baseline fixture: a **fixture** global profile declaring exactly 13 skills (the operator's stated baseline,
  encoded in the fixture, not read from live state) plus **dynamic** assertions derived from what the resolver
  actually produced (selected set equals the discovered eligible skills the profile names; the added skill appears
  once; the tools allowlist is unchanged). The live count is not read by any test here; confirming "13" against a
  live `leader` profile is a later SI-authorised canary, and the number is neither deleted nor redefined.

`npx vitest run test/settings-generator.test.ts test/settings-generator-selection.test.ts`

## 7. Status and list rendering

`test/status.test.ts` and `test/list-profiles.test.ts` (extended):

- status names strategy, base path, project path, per-kind intent; reports `both` contributors; describes an
  unrestricted kind as native with the unapplied references and their file; reports a standalone `append` as
  informational, not as a failure, with the project's own per-kind intent and no unapplied list;
- status reports a boot-pending tool reference as **boot-snapshot pending with the current session outcome not
  recorded (UNKNOWN)** and never as currently pending, selected, or existing, and claims no current resolved/dropped
  outcome and no resolved per-tool contributor;
- status performs no additional definition read (spy on `readFile`), no write, and no reapproval call;
- list marks a composing winner without reading unrelated definitions;
- an activation without composition produces byte-equivalent status output to today's.

`npx vitest run test/status.test.ts test/list-profiles.test.ts test/observability.integration.test.ts`

## 8. Launcher end-to-end

`test/project-scope.integration.test.ts` / `test/named-profile.integration.test.ts` (extend) via
`runLauncher` only:

- a trusted project `append` file composes at launch: the generated settings select the union, the plan file
  records the composition, and the process exits cleanly (exit code asserted, stdin closed by the helper);
- an untrusted project with the same file behaves as a plain global launch and the project file is not read;
- a malformed global base under `append` fails the launch with a non-zero exit and a message naming the file;
- no restart, reload, install, or network operation is performed by these cases.

`npx vitest run test/project-scope.integration.test.ts test/named-profile.integration.test.ts`

## 9. Schema, docs, and bilingual agreement

- `test/schemas.test.ts`: the new optional field validates, an out-of-set value is rejected by the schema, and the
  shipped example profiles remain valid.
- `test/resource-selection-docs.test.ts`: derived field coverage now includes `promptStrategy` in both editions;
  field rows compare equal across editions.
- `test/profile-validation-docs.test.ts`: limitation prose exists and no migration/restart claim appears.
- `test/packaging.test.ts`: unchanged shipped file list.

`npx vitest run test/schemas.test.ts test/resource-selection-docs.test.ts test/profile-validation-docs.test.ts test/packaging.test.ts`

## 10. Failure paths (each case must fail when the guard is removed)

| Guard removed | Test that fails |
| --- | --- |
| contributor union replaced by first-writer | §1.6, §3.1 |
| standalone branch collapsed into "empty base" (refs reported unapplied) | §1.1b, §2.8 |
| universal per-identity contributor rule applied to native selection | §3.7, §3.10 |
| boot-pending reference keyed as a tool name or left pending in-process after session start | §3.4, §3.11, §4 |
| no-match glob made to emit `droppedLiterals` / `legacyMcpReferences`, or an MCP-only match collapsed into `droppedLiterals` | §3.11, §4 |
| persisted boot snapshot reported as a current pending/resolved/dropped outcome without existing evidence | §3.11, §4, §7 |
| resolved per-tool status claimed without an existing persistence carrier | §4, §7 |
| extension provenance keyed by identifier | §3.3 |
| boot pass-through treated as a resolved tool | §3.4 |
| overlay-removal filter dropped from origins | §3.6 |
| unapplied references validated or reported as unknown | §1.5, §5 |
| `mcp_tools` added without the base test | §1.3 |
| per-scope expansion reintroduced | §3.2 (`onSelect` counts) |
| global read added to the replacement path | §2.6 |
| `!`-glob guard applied globally | §1.7 |
| schema-only field addition | §2.2 |
| `tools` allowlist narrowed by a skills-only addition | §6 |

## 11. Fact → authoritative source

| Fact used by artifacts | Source |
| --- | --- |
| accepted strategy values | `openspec/changes/2026-11-11-project-profile-append-composition/specs/profile-catalog/spec.md` "Profile composition strategy" (the contract itself; `schemas/profiles.schema.json` mirrors it in the implementation stage) |
| existing supported fields and shapes | `schemas/profiles.schema.json` |
| catalog indexing, winner selection, parse loop, `supportedFields` use | `src/profile-catalog.ts` |
| expansion, dedupe identity, three-state intent, boot tool pass-through | `src/profile-resolver.ts` |
| extension identifiers, entry paths, identifier-collision warning | `src/extension-discovery.ts` |
| session-start tool expansion and dropped literals | `src/switching/tool-references.ts` |
| plan file shape and status input | `src/switching/apply-plan.ts`, `src/switching/status.ts` |
| project-scope skip loops | `src/settings-generator.ts` |
| trust decision and gated project directory | `src/project-trust.ts`, `src/launcher/initial-profile.ts` |
| behavioral contracts | `openspec/specs/{profile-catalog,resource-reference,in-session-switch}/spec.md` |
| project-scope limitation rationale | `docs/adr/0011-project-scope-belongs-to-pi.md` |
| 13-skill baseline number | test fixture in the implementation stage, sourced from the operator's stated baseline; live value is a later canary |
| package scripts | `package.json` |
