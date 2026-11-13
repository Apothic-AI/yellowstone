# SI binding corrections — resolution map

The seven binding corrections from the SI decision (`si-approved-plan-and-s0-brief.md`) and where each one is
resolved. Read this first when reviewing the proposal: each row states the hazard, the resolution, and the
artifact that makes it normative.

## 1. A raw reference cannot be mapped to a single scope

**Hazard.** `referenceOrigins` as a literal → one scope map loses the second scope for an identical literal, and
glob/literal or alias/name overlaps get misattributed.

**Resolution.** Contributor **sets** are unioned, not chosen. The composer emits
`referenceContributors: raw literal → "global" | "project" | "both"`, and the resolver unions the contributor
scope of every reference that produced an identity while performing the single expansion. An exact literal in
both halves yields `both`; a global glob overlapping a project literal yields `both`; an extension alias in one
half overlapping an entry name in the other yields `both`.

**Normative.** `resource-reference` "Composed reference declarations" (requirement + six scenarios) and
"Reference provenance in the activation plan"; matrix 5 rows 1–6. **One native expansion per kind**, asserted by
the "Each kind expands once" scenario and by the expansion-count test in `test-plan.md` §3.

## 2. Extension provenance must be collision-safe

**Hazard.** An identifier-only map merges distinct entries: identifiers are package-derived or path-derived and a
local file wins an identifier collision with a warning, while selection deduplicates by resolved entry path.

**Resolution.** Provenance is keyed by **resolved entry path** — the selection's own dedupe identity — with the
resolved identifier carried as a value field (`extensionOrigins[entryPath] = { id, contributors }`). The design
states explicitly that an identifier-only key must not be used. Selection, naming, dedupe, and collision warning
semantics are unchanged.

**Normative.** `resource-reference` "Reference provenance in the activation plan" and its "Extension provenance
is collision-safe" scenario; `design.md` export surface (`extensionOrigins`); matrix 5 row 7.

## 3. Tool raw references are not resolved tool provenance

**Hazard.** Boot expansion passes unmatched literals through (`literalMustExist: false`), so presence in the boot
`tools` list proves nothing about a runtime tool. Reporting those as provenance invents tools.

**Resolution.** Two coordinates, kept distinct: `toolOrigins[name] = { contributors, at }` where `at: "boot"`
means the identity resolved against built-in names, and a raw reference that matched nothing stays a **pending
session-start reference** with its contributors and is never relabelled `unknown`. When per-tool provenance is
promised, contributors propagate through the **existing** session-start expansion
(`src/switching/tool-references.ts` + its existing caller) via an optional contributor map; no new runtime
reader, backend, or extension is added. If that propagation is dropped, status limits its claim to raw pending
references — the alternative is documented rather than silently weakened.

**Normative.** `resource-reference` "Reference provenance in the activation plan" (three tool scenarios);
`design.md` export surface (`ToolExpansion.contributors`, `expandToolReferences` signature); matrix 5 rows 8–10;
tests in `test-plan.md` §4 covering extension-tool literal and glob, global/project overlap, empty matches,
overlay removal, and preserved activation selection.

## 4. Unrestricted kinds must not be falsely attributed

**Hazard.** Project references dropped because their kind stays undeclared were described as if they contributed,
and overlay-removed resources could linger in an origin trace and look selected.

**Resolution.** Status shows the kind as **unrestricted with native selection**, and lists the project references
as **unapplied, unvalidated** references with the file that requested them. Nothing is attributed to them, no
`unknown-reference` or zero-match claim is made, and no discovery validation is promised (the composer is
IO-free; a second resolver input for an advisory was rejected). Provenance describes the **effective** selection,
so an overlay-removed identity is absent from origins and may appear only as a disabled entry.

**Normative.** `resource-reference` "Composite declaration intent and unapplied references" (unapplied-reference
paragraph + four scenarios) and "Reference provenance in the activation plan" (overlay scenario);
`in-session-switch` "Composed activation observability" (unrestricted and overlay scenarios); matrix 1 rows 1–3,
matrix 5 rows 11–12.

## 5. Launch, reload, adoption and rollback truth

**Hazard.** "Restart/reload" treated as one operation, and rollback described as free while `append` files exist.

**Resolution.** Four distinct operations are recorded: package install ≠ loaded runtime; a new launch reads
installed code only when the real launch source resolves to that installation; a native Pi reload replays the
saved launch plan while `/profile reload` re-resolves definitions and rewrites managed runtime files; `/profile
use` runs its existing path. Extension code already imported cannot gain a new command implementation before
re-import, so a lane served by old code warns and **replaces** — the hazard this change removes. No mandatory
restart, and no silent model/thinking/profile/source switch. **Rollback is BLOCKED** while affected `append`
consumers would be served by old replace-with-warning code; the fixed consumer conversion (remove/rename, or
convert to replacement with effective content materialized) is a separately reviewed operation, never automatic
destructive cleanup.

**Normative.** `design.md` "Adoption and rollback truth" (deployment truth); `in-session-switch` "Composed
activation observability" (status must not imply adoption); matrix 6; a release-note task in `tasks.md` §5 with a
mechanical check.

## 6. Package ancestry is not a divergence

**Hazard.** A pin difference read as rollback/divergence, then escalated into an operator publication decision.

**Resolution.** Recorded fact: package commit `cee2d72b595ab966339472f3f7d897d92d2b1dc5` (pinned by yellowstone
root `4a47e457`) is the reviewed forward child of `369481704a52bdd22a7fe7cfe57aec392861737d` in the isolated
combined publication repo. Absence of those objects from another Git object store proves only local absence — not
absence of a clone, and not divergence. This change binds the then-current verified base (`4a47e457` /
tree `83fe68ec64db8ffbedd979e9b553685a5e08c43d`), preserves FT39 docs and every unrelated pin/source change, and
performs no fast-forward of an older base, no repin, no fetch, no push. Publication stays SI's reviewed forward
commit.

**Normative.** `result.md` base/pin record; `tasks.md` base-verification task; this file. No spec change: the
package pin is not behavior.

## 7. Project-scope enforcement and `!`-glob grammar stay owned follow-ups

**Hazard.** Framing the composition feature as closing the unguarded project-resource route, or shipping an
unrelated grammar tightening under this change's name.

**Resolution.** Both are recorded and neither is implemented. A trusted project's `.pi/skills/*` and
`.pi/extensions/*` stay visible under every profile, `append` included (ADR-0011: exclusion entries are scoped to
their own settings scope, generated settings are global scope, no in-session removal API), and the proposal says
so as an explicit non-goal. The only new rejection is a `!`-prefixed **glob** in the append project half, where
the reading would invert the selection; global halves and every replacement definition keep today's behavior,
pinned by a test that asserts we did not tighten them. The empty project-resource gap and the generic grammar bug
are named as follow-ups with owners (SI/overlord, and a separate change), not as worker approvals.

**Normative.** `proposal.md` "Non-Goals"; `resource-reference` "Negated glob reference guard in a composed
project half" (two scenarios); matrix 7 rows 4–6; `docs/prd.md` non-goal on project-resource narrowing left
untouched.

## Additional SI decisions applied without a numbered row

- **Explicit parser retention, not schema-only.** The strategy is parsed, validated, and assigned field by field;
  the schema entry is documentation, editor, and example support. A schema-only change makes the field
  known-but-unassigned, so a project file saying `append` would silently replace. Pinned by a parse-retention
  test that a schema-only change fails.
- **No mode-style authorisation or digest gate.** The existing trust decision covers project files; adding a
  reapproval surface would introduce a second authority and drift state for the same decision.
- **Global `replace` accepted and inert**, global `append` rejected, justified by "a strategy value must be true
  in the scope that carries it" rather than by symmetry.
- **Source value unchanged.** A composed definition reports the existing project source; no fourth source value,
  because five persistence sites key off the current three.

## Revision 1 — SI review v1 corrections (append commit, no amend)

SI reviewed the submitted candidate `c42fa18a9` and required a bounded semantic revision. The seven rows above
are preserved as the record of that review; the rows below state what the revision changed. Where a revision row
and an earlier row disagree, the revision row governs.

| # | Correction | Hazard it removes | Resolution in this revision | Normative artifact |
| --- | --- | --- | --- | --- |
| R1 | Strategy values must be explicit before implementation | The governing contract deferred the accepted set to a schema deliberately not written until S1, leaving `replace` unnamed and the inventory circular at a design gate | The contract now enumerates exactly `append` and `replace`: in a project definition `append` composes, `replace` replaces, an omitted field means `replace`; in a global definition `append` is a field error and `replace` is accepted and inert. The schema entry mirrors the contract and is not its source | `specs/profile-catalog/spec.md` "Profile composition strategy" (enumeration paragraph, "Only two strategy values are accepted", "Project replace value replaces explicitly"); `docs/adr/0022…` Decision §1; `bilingual-docs-proposal.md` §2 field rows in both editions; `matrices.md` §7; `test-plan.md` §1.10, §11 |
| R2 | Standalone append needs its own composition branch | The composer accepted `global: undefined` while the matrix treated a base that omits a kind as unrestricted, so a no-global project's own references would be discarded as unapplied and described as a widening of nothing | Absence of the whole base is a distinct branch: the project definition's own lists, empty lists, scalars, instructions, child-role settings, and `mcp_tools` apply exactly as written, `unapplied` is empty, and the only diagnostic is `append-standalone`. A base that exists and omits a kind keeps the restricted rule. Malformed existing global still fails closed. The negated-glob guard also covers the standalone project half | `specs/resource-reference/spec.md` "Standalone append declaration intent" (requirement + five scenarios), scoping sentences in "Composed reference declarations", "Composite declaration intent…", "Per-server MCP tool policy…", "Negated glob…"; `specs/profile-catalog/spec.md` standalone paragraph; `design.md` `branch` discriminant and the standalone-branch paragraph; `matrices.md` §1 preamble + §1b; `test-plan.md` §1.1b, §2.8 |
| R3 | Universal every-selected-identity contributor bijection contradicts native selection | The requirement said every selected identity must have contributor provenance while the accepted requirement is that native/unrestricted resources have no false global/project contributor, so a native selection could either be misattributed or fail a spurious invariant | The agreement is scoped to identities produced by **applied declared references**. Native identities carry the disjoint kind `native` (or no per-identity entry) and never `global`/`project`/`both`; the invariant no longer fires on them. Added the exact case: global omits skills + project skill (unapplied) + native discovered resources ⇒ no false attribution, no invariant failure. Overlay-removed stays disabled/not selected | `specs/resource-reference/spec.md` "Composed reference declarations" (scoping paragraph), "Composite declaration intent…" ("Native resources are not falsely attributed"), "Reference provenance…" (agreement paragraph + "Native selection is not a disagreement"); `specs/in-session-switch/spec.md` "Unrestricted kind is described honestly"; `design.md` `ProvenanceKind`, `native-selection-provenance`; `matrices.md` §5; `test-plan.md` §3.7, §3.10 |
| R4 | Tools need explicit pending/resolved/dropped state through the real caller; callbacks are not expansion counts | `toolOrigins[name] = {contributors, at}` had no state discriminant, so a raw unmatched reference could read as a tool; and counting `onSelect` callbacks overcounts an overlapping reference set, so it could not prove one expansion | Three exhaustive states: `resolved` (boot, built-in names only; session start for any live tool), `pending` (boot only, held in a **separate** `pendingToolReferences` list with verbatim reference, contributors and `resolvesAt: "session-start"` — never a name key), `dropped` (session start, reported through the existing dropped-literal and legacy-MCP diagnostics, never left pending, never claimed as a tool). Contributors are threaded through the existing `expandToolReferences` and its existing `applyLaunchPlan` caller; no new reader/backend. Resolved post-session-start per-tool status is not promised unless an existing persistence surface carries it, so status reports pending/declared state only. Expansion invocations are measured by instrumenting the expansion, and contributor sets are unioned per identity so repeated callbacks are idempotent | `specs/resource-reference/spec.md` "Reference provenance…" (three-state paragraph, transition paragraph, callback paragraph) and its tool scenarios; `specs/in-session-switch/spec.md` "Pending and resolved tools are not conflated"; `design.md` `PendingToolReference`, `ToolExpansion.outcomes`, three-state decision, status-promise paragraph; `matrices.md` §5; `test-plan.md` §3.2, §3.4, §3.11, §4, §7, §10 |
| R5 | Documentary statements were wrong or over-broad | "A source-only check would be a no-op" made a docs-only change sound inherently exempt from a source check; the old-code append hazard was tied to "after install" even though it is a property of append files meeting old code; release tasks read like a present broad enumeration/deletion grant | Rationale corrected: dependencies/`node_modules` are absent and no source changed, which explains why the check was not run in this bounded stage, not why it is irrelevant. The old-code hazard is stated for any append file meeting older code — pre-existing file, rollback, other installation or pin, already-loaded module — with install order explicitly irrelevant. Consumer enumeration/conversion is a **design obligation** under a future approved release scope with its own holds, and is not a filesystem-read or deletion authorization | `design.md` "Adoption and rollback truth" §4; `docs/adr/0022…` Consequences rollback bullet; `matrices.md` §6; `specs/in-session-switch…` unaffected; `tasks.md` 5.2; `proposal.md` "Non-Goals"; revised `result.md` §3 |
| R6 | Validation facts must stay separate and no gate may be claimed cleared | The PATH `openspec` 127 and the cached 1.5.0 exact-cwd success are different facts; a PATH alias absence is not a structural validation failure, and the cached CLI has not been selected or pinned as the required environment | Both facts are recorded side by side with exact binary, version, command, cwd, and raw exit codes. The gate remains **BLOCKED**; the cached 1.5.0 run is supplementary structural evidence only and is explicitly not the required gate. A repository-root invocation's `Unknown item` result is recorded as a wrong-root invocation, not a defect of the proposal, and is not quoted as this change's result | Revised `result.md` §3 (and `result.json`); `tasks.md` 1.4 and the readiness reconciliation |

Earlier rows refined but not withdrawn: row 3 is now superseded on the state model by R4 (three states, separate
pending list, no resolved-status promise without an existing carrier); row 5's old-code condition is superseded by
R5 (hazard whenever append files meet old code, not only after install); rows 1, 2, 4, 6, 7 stand as written.

## Revision 2 — SI review v2 finite corrections (append commit, no amend)

SI review v2 verified the Revision 1 candidate and required three bounded clause corrections. Rows 1–7 and R1–R6
are preserved as the record of what each review changed; the rows below state what this finite revision changed.
Where a Revision 2 row and an earlier row disagree, the Revision 2 row governs.

| # | Correction | Hazard it removes | Resolution in this revision | Normative artifact |
| --- | --- | --- | --- | --- |
| R7 | Snapshot state must not be promised as current state | R4 and the tool requirements promised that nothing reads as pending after a session-start expansion, while the chosen design writes no extra plan and keeps the pre-session-start snapshot, so a persisted read cannot know the transition and the promise was unfulfillable | The transition is scoped to the **in-process** expansion, which settles `resolved`/`dropped` and rewrites nothing. A persisted boot snapshot labels a pending reference **boot-snapshot pending / current session outcome not recorded (UNKNOWN)** and status claims no current pending, resolved, or dropped outcome without existing evidence. No new backend, reader, plan write, or result carrier | `specs/resource-reference/spec.md` "Reference provenance in the activation plan" (transition paragraph + "Session start resolves or drops every pending reference"); `specs/in-session-switch/spec.md` "Composed activation observability" (status paragraph + "Pending and resolved tools are not conflated"); `design.md` `ToolExpansion.outcomes` comment, status-promise paragraph, three-state decision; `matrices.md` §5; `test-plan.md` §3.11, §4, §10; `tasks.md` 3.2; `docs/adr/0022…` Decision §3 |
| R8 | Existing no-match-glob behaviour was overstated into a dropped-literal warning | The revised text said every dropped reference goes through the existing dropped-literal/legacy-MCP diagnostics, but the actual `expandToolReferences` emits neither for a glob that matches nothing; asserting it would have invented a warning or forced a native-behavior change | The three `dropped` cases are kept distinct and none is invented: literal miss retains `droppedLiterals`, MCP-only match retains `legacyMcpReferences`, a no-match glob may carry dropped/zero-match metadata but gains no `droppedLiterals` or `legacyMcpReferences` warning because it is not an unknown literal. Test design asserts all three separately. `tool-references.ts` remains read-only reference, no behavior change | `specs/resource-reference/spec.md` (dropped bullet, transition paragraph, tool scenario); `design.md` `ToolExpansion.outcomes` comment + three-state paragraph; `matrices.md` §5 (two added outcome rows); `test-plan.md` §3.11, §4, §10; `tasks.md` 3.2; `docs/adr/0022…` Decision §3 |
| R9 | The native matrix row read as a selection denial | "`review` is not selected" implied native discovery cannot select `review` at all; native discovery may well select it, and the real rule is that the reference is unapplied and no native selection may be attributed to it | The row now states that the project reference is **unapplied**, that `review` itself may be natively visible when discovery provides it, and that no contributor is attributed to the unapplied reference. This is a wording fix to the existing native-attribution rule, not a new feature | `matrices.md` §5; `specs/resource-reference/spec.md` "Composite declaration intent…" (unapplied paragraph + "Native resources are not falsely attributed"); `design.md` unapplied-reference decision |
