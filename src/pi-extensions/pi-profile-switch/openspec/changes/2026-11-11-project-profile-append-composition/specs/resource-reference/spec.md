# Spec Delta

## ADDED Requirements

### Requirement: Composed reference declarations

A definition produced by the `append` composition strategy SHALL treat each resource list as one merged
declaration: the global half's raw declarations followed by the project half's raw declarations. The merged
reference list SHALL be expanded exactly once per resource kind. Expanding each half separately and combining
the results MUST NOT be used, because it invents per-scope matches that the merged declaration does not imply.

This requirement applies when a same-named global base **exists and was read**. When no global base exists at
all, the definition is not a merge of two halves: "Standalone append declaration intent" governs, and the single
project declaration list is expanded unchanged.

Selection SHALL deduplicate by resolved identity — skill name, MCP server name, resolved extension entry path,
and expanded tool name — using the identities the existing resolution contracts already define. Raw `tools`
references SHALL additionally be deduplicated by exact string before expansion. Reference order SHALL be global
declarations then project declarations, so the merged order is deterministic.

Every selected identity produced by an applied declared reference SHALL carry the set of scopes whose raw
declarations contributed to it: `global`, `project`, or both. Contribution SHALL be recorded per raw declaration
that produced the identity, and contribution sets SHALL be unioned. An identical literal declared in both halves
SHALL report both scopes. A glob in one half and a literal in the other that resolve to the same identity SHALL
report both scopes. A package alias in one half and an entry name in the other that resolve to the same identity
SHALL report both scopes. First-contributor attribution MUST NOT be used.

This contributor claim is scoped to identities produced by applied declared references. An identity that is
selected only because its kind is unrestricted stays native: it SHALL NOT be given a `global`, `project`, or
`both` contributor, because no declaration produced it. The disjoint treatment of native selection is defined in
"Composite declaration intent and unapplied references" and "Reference provenance in the activation plan".

A resource that user-native settings or package filters exclude from discovery SHALL remain unselectable under a
composed definition; a diagnostic SHALL be produced instead of a selection. A resource that is eligible in
discovery but absent from the global half's allowlist SHALL remain selectable through the project half.

#### Scenario: Identical literal in both halves reports both scopes

- **WHEN** the global and project halves both declare skill `review`, which discovery provides
- **THEN** the skill is selected once and reports both scopes as contributors

#### Scenario: Overlapping glob and literal report both scopes

- **WHEN** the global half declares `internal-*` and the project half declares `internal-a`
- **THEN** `internal-a` is selected once and reports both scopes

#### Scenario: Overlapping extension alias and entry name report both scopes

- **WHEN** the global half declares an extension package alias and the project half declares one of that package's entry names
- **THEN** the entry is selected once and reports both scopes

#### Scenario: Each kind expands once

- **WHEN** a composed definition declares references for every supported resource kind
- **THEN** each kind is expanded once, and no selection is duplicated or attributed to a scope that did not declare it

#### Scenario: Native exclusion stays unselectable

- **WHEN** the user's own settings exclude a skill from discovery and the project half declares that skill
- **THEN** the skill is not selected and an actionable diagnostic names the reference

#### Scenario: Globally unselected but eligible resource is added

- **WHEN** an eligible skill exists in discovery and the global half's `skills` allowlist omits it while the project half declares it
- **THEN** the composed definition selects the skill

### Requirement: Standalone append declaration intent

Absence of the entire global base SHALL be a distinct composition branch from a global base that exists while
omitting a declaration. When no same-named global definition exists, the resolved definition SHALL be the
project definition's own standalone definition: each resource list SHALL be applied exactly as that project
declaration defines it, with no inheritance, no widening step, and no unrestricted-kind substitution.

For a standalone `append` definition:

- A declared project list SHALL be applied as declared, including a list of one or more references and a
  declared empty list.
- An omitted project list SHALL stay undeclared and carry native visibility, exactly as in a standalone
  definition today.
- Project `instructions`, scalar settings, native child-role settings, and `mcp_tools` SHALL keep their
  standalone meaning.
- No project reference SHALL be reported as unapplied, and the kind-level unapplied-reference diagnostic that
  belongs to a base which omits a kind SHALL NOT be produced, because there is no base whose declaration could
  be widened.
- The only composition output SHALL be informational metadata: the strategy, the fact that no base was read, and
  an `append-standalone` diagnostic naming the absent base.

The standalone result MUST NOT be attributed to a global contributor, MUST NOT be described as composed with an
empty base, and MUST NOT be treated as a widening of native visibility. An existing but malformed global base
remains a fail-closed error under the same-named global rules; only a wholly absent base takes this branch.

#### Scenario: Standalone append applies the project lists in full

- **WHEN** a trusted project definition declares `append`, no same-named global definition exists, and it declares `skills: ["a","b"]` and `tools: ["read","edit"]`
- **THEN** the selected skills are exactly `a` and `b`, and the selected tools are exactly what the unchanged expansion of `read` and `edit` yields, with no unapplied-reference diagnostic

#### Scenario: Standalone append keeps a declared empty list empty

- **WHEN** a standalone `append` definition declares `skills: []`
- **THEN** `skills` is a declared empty selection and nothing is selected in that kind

#### Scenario: Standalone append leaves an omitted kind native

- **WHEN** a standalone `append` definition omits `skills`
- **THEN** `skills` stays undeclared, native visibility applies, and no unapplied-reference diagnostic is produced

#### Scenario: Standalone append keeps scalars, instructions and child roles as declared

- **WHEN** a standalone `append` definition declares `instructions`, `defaultThinkingLevel`, and `subagents`
- **THEN** each keeps exactly its standalone meaning, with no concatenation step, no inheritance step, and no per-key merge

#### Scenario: Standalone result carries no global contributor

- **WHEN** a standalone `append` definition is resolved
- **THEN** no selected identity reports a `global` contributor, and only the missing-base diagnostic describes the composition

### Requirement: Composite declaration intent and unapplied references

A composed definition SHALL preserve the existing three-state declaration grammar per kind: a kind with no
effective declaration SHALL remain undeclared, never an explicitly empty selection. This requirement applies
when a same-named global base exists and is read; when no base exists, "Standalone append declaration intent"
governs and the derivation below does not apply. Declaration intent SHALL be derived from the composed halves as
follows.

- A project half that omits a list or declares it empty SHALL contribute nothing.
- A global half that declares an empty list SHALL remain a declared base, so project references widen it.
- A global half that omits a list SHALL keep that kind undeclared, so the composed definition carries native
  visibility; project references for that kind SHALL NOT be applied to the selection.

References that cannot be applied because their kind stays undeclared SHALL be reported as unapplied
references: a static, deterministic diagnostic that names the file and each unapplied reference verbatim. That
diagnostic SHALL state that the references were not validated against discovery. An unapplied reference MUST NOT
be reported as an unknown reference, MUST NOT produce a zero-match warning, and MUST NOT be attributed to any
selected resource. Native discovery MAY still select a resource with the same name as an unapplied reference; that
selection is native visibility, is reported as native, and MUST NOT be attributed to the unapplied reference. The
composed definition MUST NOT claim that a dropped reference contributed to native
selection, and a natively selected resource MUST NOT be reported as contributed by `global` or `project` —
native selection is recorded as a kind-level intent, not as a per-identity contributor.

Project-instructions text SHALL be appended to the global half's instructions without replacing it, dropping a
byte-identical duplicate. Scalar settings SHALL be overridden per field, with an undeclared project scalar
inheriting the global value. The model and thinking-level pair SHALL be validated exactly once through the
existing native validation path, with no provider probing, no default-model lookup, and no reset; a partial
declaration SHALL inherit the other half's field and SHALL produce a model only when both fields are present.
Native child-role settings SHALL remain a whole-field override: the project half replaces the global
declaration and its keys are not merged.

#### Scenario: Unrestricted kind keeps native selection with an honest diagnostic

- **WHEN** the global half omits `skills` and the project half declares `skills: ["review"]`
- **THEN** the composed definition leaves `skills` undeclared, native visibility applies, and a diagnostic names `review` as unapplied and unvalidated

#### Scenario: Native resources are not falsely attributed

- **WHEN** the global half omits `skills`, the project half declares `skills: ["review"]`, and discovery provides other skills natively
- **THEN** every natively selected skill reports no `global` or `project` contributor, `review` is listed as unapplied and unvalidated, a skill named `review` that discovery itself provides MAY appear as natively visible with no contributor attributed to the unapplied reference, and no provenance/selection invariant fails

#### Scenario: Declared empty base is widened

- **WHEN** the global half declares `skills: []` and the project half declares `skills: ["review"]`
- **THEN** the composed definition declares `skills` and selects `review`

#### Scenario: Empty project list contributes nothing

- **WHEN** the project half declares `skills: []` and the global half declares `skills: ["review"]`
- **THEN** the composed selection equals the global selection

#### Scenario: Unrestricted rows never become empty selections

- **WHEN** neither half declares a list kind
- **THEN** that kind stays undeclared in the composed definition and is never emitted as an empty array

#### Scenario: Instructions concatenate

- **WHEN** both halves declare `instructions`
- **THEN** the composed instructions contain the global text followed by the project text, and an identical duplicate is not repeated

#### Scenario: Scalars inherit without probing

- **WHEN** the project half declares only one field of the model pair and the global half declares both
- **THEN** the composed definition takes the project field and the inherited field, and no provider or default-model lookup occurs

#### Scenario: Native child-role settings are not merged

- **WHEN** the global half declares native child-role settings and the project half declares different ones
- **THEN** the composed definition contains the project declaration only

### Requirement: Per-server MCP tool policy in a composed definition

Per-server MCP tool policy SHALL follow the additive-only rule of a composed definition, evaluated per server
key against what the global half already allows. This requirement applies when a same-named global base exists
and is read; a standalone `append` definition applies its own `mcp_tools` with the standalone meaning of the
field, and no `append-cannot-narrow` diagnostic is produced for it because there is no base to narrow.

A project entry for a server that the global half does not name SHALL NOT be applied, and SHALL be reported as a
diagnostic naming the server and stating that a composed definition cannot introduce a restriction. A project
entry for a server the global half does name SHALL be unioned with the global selectors, in global-then-project
order with exact-string deduplication. An empty project list for a named server SHALL contribute nothing. A
global empty list SHALL remain a deny-all base that project selectors widen. Both halves empty SHALL stay an
explicit deny-all.

A retained project entry MUST NOT create a server, enable a disabled server, alter project-owned servers, or
turn a disabled policy into an unrestricted one.

#### Scenario: Project key for an unnamed server is not applied

- **WHEN** the global half omits `mcp_tools` for server `github` and the project half declares `github: ["search"]`
- **THEN** the composed definition has no entry for `github`, its tools keep native availability, and a diagnostic names `github` as unapplied

#### Scenario: Named server policy is unioned

- **WHEN** the global half declares `github: ["a","b"]` and the project half declares `github: ["b","c"]`
- **THEN** the composed policy for `github` is `["a","b","c"]`

#### Scenario: Deny-all base is widened

- **WHEN** the global half declares `github: []` and the project half declares `github: ["search"]`
- **THEN** the composed policy for `github` is `["search"]`

#### Scenario: Both halves deny all

- **WHEN** the global half declares `github: []` and the project half declares `github: []`
- **THEN** the composed policy keeps the empty list and denies all callable tools for that server

### Requirement: Negated glob reference guard in a composed project half

A reference in the project half of a composed definition that is both a glob and prefixed with `!` SHALL be a
field error naming the file, the reference, and the reason: the current glob semantics read a leading `!` as a
negation gate, so such a reference would select every resource except its own pattern instead of adding to the
selection.

The guard SHALL apply to a project half that declares `append`, whether or not a same-named global base exists:
the inversion is a property of the project declaration's own glob, so a standalone `append` definition carries the
same rejection. The same reference in a global half, and in any definition using complete replacement, SHALL keep
exactly today's behavior: not rejected, not reinterpreted, not repaired. The generic leading-`!` grammar question
SHALL remain outside this change.

#### Scenario: Negated glob in an append project half fails closed

- **WHEN** the project half of an `append` definition declares `!internal-*` in `skills`
- **THEN** the profile is rejected with an error naming the file, the reference, and the selection-inverting reason

#### Scenario: Replacement definitions keep today's behavior

- **WHEN** a definition using complete replacement, or a global definition, declares the same `!`-prefixed glob
- **THEN** resolution behaves exactly as before this change, with no new rejection

### Requirement: Reference provenance in the activation plan

The activation plan SHALL expose reference provenance for a composed definition, keyed by the same resolved
identities the selection uses: skill name, MCP server name, resolved extension entry path, and tool name. Each
entry SHALL report its contributor scopes.

Extension provenance SHALL be keyed by the resolved entry path, which is the identity the existing selection
deduplicates on, and MAY carry the resolved extension identifier as an additional value. An identifier-only
key MUST NOT be used, because distinct entries can share an identifier.

Tool provenance SHALL be a state record, not an existence flag, and it SHALL separate the two moments at which a
tool becomes knowable. Exactly three states are defined:

- **`resolved`** — the raw reference matched a live tool name. For a tool resolved before session start the state
  is `resolved` at the boot stage, limited to built-in names, which is all the pre-spawn registry can know. At
  session start it covers built-in, extension-provided, and MCP-provided names.
- **`pending`** — a raw declared reference the boot expansion did not resolve. Pending is a **boot-stage state
  only**, and it SHALL NOT be keyed by a name on the tool map: a name key would present a raw reference as if it
  were a tool. Pending references SHALL live in a separate declarative list carrying the verbatim reference, its
  contributor scopes, and the stage at which it becomes knowable (`session-start`).
- **`dropped`** — a reference the session-start expansion confirmed matches nothing in the live registry, or one
  that matched only MCP-owned tools. Dropped SHALL NOT remain pending after the in-process session-start expansion
  and SHALL NOT be presented as an existing tool. Its existing diagnostics SHALL be kept distinct and none SHALL be
  invented: a literal miss SHALL retain `droppedLiterals`; a reference matching only MCP-owned tools SHALL retain
  `legacyMcpReferences`; a glob matching nothing MAY carry its existing zero-match/dropped metadata but MUST NOT
  produce a `droppedLiterals` or `legacyMcpReferences` warning, because a zero-match glob is not an unknown literal
  and the existing expansion reports neither for it. No new warning path SHALL be added.

At session start, within the in-process expansion, every pending reference SHALL transition to exactly one of
`resolved` or `dropped`, and the transition MUST NOT suppress, broaden, or replace the existing diagnostics. That
settlement is in-process only: the plan file is written before session start and no additional plan write, reader,
backend, or result carrier SHALL be introduced, so a plan read later still carries its pre-session-start state.
Under that snapshot, status SHALL NOT claim a current `pending`, `resolved`, or `dropped` outcome that no existing
evidence carries; a pending reference SHALL be labelled **boot-snapshot pending / current session outcome not
recorded (UNKNOWN)** and MUST NOT be described as currently pending, as currently resolved, or as currently
dropped. A reference that resolves to a real extension tool, a literal that matches nothing, a glob that matches
nothing, and a reference removed by the overlay are four different outcomes and SHALL be reported as such, each on
its own existing path.

Contributors SHALL be threaded through the **existing** session-start expansion and its existing caller, which
receive the composer's per-reference contributor map, union contributors per expanded identity, and return the
three states. No new runtime reader, backend, extension, or status path SHALL be introduced. Resolved
post-session-start per-tool provenance SHALL be claimed only where an existing persistence surface actually
carries it; until such a carrier exists, status SHALL describe the plan's pending and declared tool references
and MUST NOT claim a resolved per-tool contributor.

A callback that fires per selected identity SHALL NOT be counted as proof that expansion ran once: overlapping
references can fire it several times for the same identity. Expansion invocations SHALL be measured separately,
and contributor sets SHALL be unioned per identity so repeated callbacks are idempotent.

Provenance agreement SHALL be scoped to identities produced by applied declared references. Every identity
selected through an applied declared reference SHALL have a provenance entry, and every provenance entry SHALL
name an identity present in the effective selection. An identity selected only because its kind is unrestricted
SHALL be reported as native: it MAY have no per-identity entry, or an entry carrying the disjoint provenance kind
`native`, and it MUST NOT carry `global`, `project`, or `both`. A native identity entered this way SHALL NOT be a
provenance/selection disagreement.

Provenance SHALL be presentation only: it MUST NOT influence selection, and a disagreement between provenance
and selection SHALL be treated as a defect rather than a runtime fallback. A plan produced without composition
SHALL be unchanged, byte-identical to the plan the same inputs produce today.

Provenance SHALL describe the resource selection that is currently effective. An identity removed by the runtime
overlay SHALL NOT be reported as currently selected, regardless of which scope originally contributed it; an
overlay-removed identity MAY appear only as a disabled entry.

#### Scenario: Provenance cannot disagree with selection for declared identities

- **WHEN** a composed definition is resolved
- **THEN** every identity in the provenance map is present in the selection, and every identity selected through an applied declared reference has a provenance entry

#### Scenario: Native selection is not a disagreement

- **WHEN** a composed definition selects a skill natively because its kind is undeclared
- **THEN** the skill is reported as native, carries no `global`, `project`, or `both` contributor, and does not fail the provenance/selection agreement

#### Scenario: Extension provenance is collision-safe

- **WHEN** two distinct extension entries would share an identifier
- **THEN** provenance keeps them distinct by resolved entry path, and neither entry's scopes are merged into the other

#### Scenario: Unresolved raw tool reference stays pending at boot

- **WHEN** a composed definition declares a tool reference no built-in tool provides
- **THEN** it is listed once in the separate pending list with its scopes and the session-start stage, is not keyed as a tool name, and is not reported as an existing tool

#### Scenario: Boot and session-start tools are distinguished

- **WHEN** a composed definition declares one built-in tool and one extension-provided tool
- **THEN** the built-in tool reports `resolved` at the boot stage and the extension tool reports `resolved` at session start

#### Scenario: Session start resolves or drops every pending reference

- **WHEN** the session-start expansion runs in-process for a plan carrying a pending reference
- **THEN** the reference's in-process outcome is `resolved` if a live tool provides it and `dropped` otherwise, exactly one outcome is recorded per reference, each `dropped` case keeps its own existing diagnostic (a literal miss in `droppedLiterals`, an MCP-only match in `legacyMcpReferences`, a no-match glob in neither), and the persisted pre-session-start plan is unchanged, so status labels the reference boot-snapshot pending with the current session outcome not recorded (UNKNOWN) rather than claiming a current outcome

#### Scenario: Non-composed plan is unchanged

- **WHEN** a profile is resolved without composition
- **THEN** its plan contains no composition or provenance data and is byte-identical to the pre-change output

#### Scenario: Overlay-removed resource is not currently selected

- **WHEN** the overlay disables a resource that a composed definition selected
- **THEN** status does not report it as currently selected and reports it, if at all, as disabled
