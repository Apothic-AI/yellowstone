# Proposal

## Why

A project profile replaces its same-named global profile in full. That is the documented, structural behavior:
filename indexing decides precedence before any definition is read, the project file becomes the only entry for
that name, and the global definition is never opened (`src/profile-catalog.ts`, `docs/prd.md` non-goal "no
profile inheritance or composition", ADR-0003).

The consequence is friction in the ordinary by-project case. A project wants everything its team-wide profile
already selects, plus one project-specific skill or extension. Today the only way to express that is to copy the
full global definition into the project file and keep the copy in sync by hand. When the global profile changes,
every project copy silently drifts, and a merged-in copy is indistinguishable from a deliberate narrowing.

A second consequence is that a project cannot extend a global allowlist at all. If the global half declares
`skills: [...]`, the project cannot add an eligible skill without restating the whole list.

This change adds one bounded composition mode to remove that duplication: a project file may declare that it
composes with its global namesake. It does not introduce inheritance chains, deep merging, or per-kind
strategies, and it does not change what an existing file does.

## What Changes

- Add an optional `promptStrategy` field. The accepted values are exactly two and are enumerated by the
  governing contract, not deferred to a schema that lands later: in a **project** definition `append` composes
  that definition with its same-named global definition, `replace` replaces it, and an omitted field means
  `replace`; in a **global** definition `append` is rejected and `replace` is accepted and inert. The schema entry
  added with the behavior mirrors this enumeration.
- Compose as one pure merge at the catalog boundary: raw list declarations concatenate global-then-project and
  expand **exactly once** per kind, deduplicating by the resolved identity the existing contracts already use.
- Enforce one governing rule: `append` may add to what the global half already allows and may never introduce a
  restriction the global half did not have. Narrowing stays with replacement and with the runtime overlay.
- Separate the two composition inputs. No global file at all is the standalone branch: the project definition's own
  lists, scalars, instructions, and child-role settings apply exactly as written, with no unapplied-reference
  diagnostic and only informational metadata. A global file that exists and omits a kind is the composed branch,
  where native visibility stands and the project's references for that kind are reported as unapplied.
- Preserve the three-state grammar. A kind the composite leaves undeclared stays undeclared; a project reference
  that cannot apply to an undeclared kind is reported as an unapplied, unvalidated reference instead of being
  silently dropped or falsely attributed to the native selection.
- Apply the same additive-only rule per MCP server: a project `mcp_tools` entry for a server the global half does
  not name is not applied and is diagnosed.
- Carry reference provenance into the activation plan: contributor scopes per resolved identity, with extension
  provenance keyed by resolved entry path (collision-safe), and tool provenance carrying three states — resolved at
  boot, pending session-start resolution in a separate list that is never keyed as a tool, and dropped in-process by
  the session-start expansion, where a literal miss keeps the existing `droppedLiterals` diagnostic, an MCP-only
  match keeps `legacyMcpReferences`, and a no-match glob keeps neither. Contributors are threaded through the
  existing session-start expansion and its caller; no new runtime reader or backend is added, the persisted plan
  keeps its boot snapshot so status labels a pending reference boot-snapshot pending with the current session
  outcome not recorded (UNKNOWN), and status claims no resolved per-tool contributor until an existing persistence
  surface carries one.
- Render composition in the status and list surfaces without adding definition reads, writes, or any approval
  step.
- Fail closed on three inputs only: a strategy value outside the accepted set, `append` in a global definition,
  and a `!`-prefixed glob in the project half of an `append` definition.
- Record, without implementing: project-scope skill and extension enforcement stay Pi's, the generic `!`-glob
  grammar question stays a separate follow-up, and source rollback is blocked while `append` consumers would be
  served by older replace-with-warning code.

Why this field cannot be replaced by discovery or a default value: discovery answers *which resources exist*, and
a default answers *what an undeclared field means*. Neither can express "this project file extends the global
selection instead of replacing it". The alternative — a project file that restates the global content — is
exactly the drift this change removes, and it is already expressible today, so nothing is gained by making users
keep doing it. The field is optional, defaults to today's behavior, and produces no side effect when absent.

## Capabilities

### New Capabilities

None. Every new requirement extends an existing capability domain.

### Modified Capabilities

- `profile-catalog`: adds "Profile composition strategy"; amends "Catalog file format validation" so a shadowed
  global definition is read only as an `append` base, and "Profile sources and project override" so replacement
  stays the default while a declared `append` composes.
- `resource-reference`: adds composed declaration expansion and contributor sets, composite declaration intent
  with unapplied-reference diagnostics, per-server MCP tool policy for composites, reference provenance in the
  activation plan, and the negated-glob guard for a composed project half.
- `in-session-switch`: adds composed activation observability.
- `launcher`: unchanged. The launcher's trust gate, argument parsing, instance generation, and initial-profile
  selection keep their contracts; the composed definition simply arrives through the existing catalog resolution.

## Impact

- New module: a pure composition surface with no filesystem or discovery access, plus its unit suite.
- Modified source: the catalog (index both halves per name; read a global base only for a trusted `append`
  winner; explicit strategy parse and assignment into the definition; the three fail-closed validations), the
  resolver and extension discovery (one origin-trace callback threaded through the single expansion, a contributor
  input, and provenance on the plan), the plan file, the generated-settings caller, status and list rendering.
  Tool provenance reuses the existing session-start expansion and its caller; no new runtime reader is added.
- Unchanged, with tests pinning it: project trust determination, the skill registry, the overlay, both
  project-scope skip loops in the settings generator, the launcher bin, and initial-profile selection.
- Schema: one optional field with an enumerated value. The schema addition itself belongs to the implementation
  stage; this proposal contains no schema edit, no source edit, and no runtime behavior.
- Compatibility: a catalog file that contains no `promptStrategy` behaves exactly as it does today in both
  catalogs. No `!`-grammar tightening ships for replacement profiles or global halves.

## Non-Goals

- No `extends` or parent chains, no deep or recursive merge, no per-kind strategy, no
  `replace_base`/`replace_final` vocabulary.
- No negative or exclusion grammar inside profile resource lists. The negated-glob rejection is a guard against an
  inverting reading, not a new grammar.
- No materialization, no cached merged definition, no state-file copy of a composed definition.
- No reapproval, digest, or drift gate. A project file composes under the existing trust decision.
- No Pi-side enforcement of project-scope resources, and no claim that this change restricts them. A trusted
  project's `.pi/skills/*` and `.pi/extensions/*` stay visible under every profile, `append` included, because
  exclusion entries are scoped to their own settings scope, generated settings are global scope, and Pi exposes
  no in-session API to remove discovered resources (ADR-0011). `append` adds *user-level* resources the global
  selection excludes; it does not close, restrict, or replace the project-scope route. The recorded capability
  gap — "a profile cannot restrict project-scope resources" — is owned outside this change and is not delegated
  to the implementation.
- No provider, model, or thinking probe; no reset of an existing session's model, thinking level, profile, or
  source.
- No mandatory restart, no fleet reload, and no publication.
- No present authorization to enumerate consumer catalog files or to delete/convert them. The rollback guard's
  consumer enumeration and conversion is a design obligation for a future, separately reviewed release scope with
  its own holds — not a broad filesystem-read or deletion grant implied by this change.

## Doc Impact

- `docs/prd.md`: **impact.** The non-goal stating "no profile inheritance or composition … a same-named profile is
  a complete replacement" becomes false once the bounded mode exists; it is rewritten to keep rejecting
  `extends`/parent chains/deep merge while naming the single additive composition mode and linking ADR-0022. The
  separate non-goal on project-level resource narrowing is **not** touched.
- `docs/architecture/overview.md`: **impact.** The resolution section gains the composition point and the
  provenance trace in the plan, and the filtering model gains the additive-only rule; the project-resource
  limitation stays as written. The implementation stage writes this, after the behavior exists, because the
  overview documents mechanism.
- `CONTEXT.md`: **impact.** One domain term is added for the composed definition, and the glossary's "Source
  scope" entry is clarified to say the composed result still reports the project source.
- `docs/adr/`: **impact.** New `docs/adr/0022-project-profile-append-composition.md` records the decision and the
  rejected alternatives; `docs/adr/0003-no-profile-inheritance.md` receives exactly one top line marking it
  superseded, with its body untouched. Number 0022 is the next available number in `docs/adr/` (the highest
  present is 0021); no intervening ADR is overwritten.
- `README.md` and `README.zh-CN.md`: **impact, implementation stage.** The file-locations paragraph, the field
  reference row, the omitted-versus-empty resource-selection rows, and one limitation paragraph in each edition.
  Both editions change together, because a documentation test compares their field rows. Deferred to the
  implementation stage on purpose: the READMEs explain *current* behavior, and the package rules require them to
  derive from the shipped schema and owning contracts, so they change in the same stage as the field and the
  behavior. The proposed wording for both editions is fixed in
  `bilingual-docs-proposal.md` so the review covers it now.
- `CHANGELOG.md`: release-please owns it; this change adds no entry by hand.
