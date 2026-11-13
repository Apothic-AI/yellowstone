# Matrices

Decision tables the implementation must satisfy row for row. Each table names the spec requirement whose
scenarios pin it; the tables are implementation truth, the requirements are the contract. Notation: `G` = the
same-named global definition, `P` = the project definition declaring `append`, `—` = field absent.

## 1. Omitted and empty declarations (`skills`, `extensions`, `mcps`, `tools`)

Pinned by `profile-catalog` "Profile composition strategy" and `resource-reference` "Composite declaration intent
and unapplied references".

Every row in this table assumes `G` **exists and was read**. A row whose `G` column is `—` means a base that
exists and leaves that kind undeclared — not the absence of a global file, which is a different input with its
own table in §1b.

| `G` list | `P` list | Composite field | Effect | Diagnostic |
| --- | --- | --- | --- | --- |
| `—` | `—` | `—` | kind undeclared; native visibility | none |
| `—` | `[]` | `—` | kind undeclared; native visibility | none (nothing was requested) |
| `—` | refs | `—` | kind undeclared; native visibility; `P` refs **not** applied | `append-unapplied-reference`, naming file and each ref, stating "not validated against discovery" |
| `[]` | `—` | `[]` | declared empty selection; nothing selected | none |
| `[]` | `[]` | `[]` | declared empty selection; nothing selected | none |
| `[]` | refs | refs | refs expand; nothing inherited from `G` | none |
| refs | `—` | `G` refs | `P` contributes nothing | none |
| refs | `[]` | `G` refs | `P` contributes nothing | none |
| refs | refs | `G` refs ++ `P` refs | one expansion, dedupe by resolved identity | none |

Rules that fall out of the table, and must not be re-derived per kind: a composite never emits `[]` where neither
half declared the field; a project `[]` is never a narrowing of a declared global list; an unapplied reference is
never reported as `unknown-reference` and never produces a zero-match warning.

## 1b. Standalone `append` (no global file at all)

Pinned by `resource-reference` "Standalone append declaration intent" and `profile-catalog` "Profile composition
strategy". This table is the answer to "`G` does not exist": the project definition is the resolved definition, and
the unrestricted-kind rule of §1 does not apply because there is no base declaration.

| `P` list | Composite field | Applied refs | Diagnostics |
| --- | --- | --- | --- |
| `—` | `—` | none; native visibility | `append-standalone` only |
| `[]` | `[]` | declared empty selection; nothing selected | `append-standalone` only |
| refs | refs | refs expand once, unchanged | `append-standalone` only — never `append-unapplied-reference` |

Non-list fields keep their standalone meaning with no merge step: `instructions` as written (no concatenation),
scalars as written (no inheritance), `subagents` as written (no per-key merge), `mcp_tools` as written (no
`append-cannot-narrow`). Composition metadata is informational only: the strategy, "no base read", the project
path, and `append-standalone`. No selected identity carries a `global` contributor.

A malformed global file is **not** this branch: an existing-but-invalid namesake still fails closed per §4.

## 2. Per-server `mcp_tools`

Pinned by `resource-reference` "Per-server MCP tool policy in a composed definition".

| `G` has key for `s` | `P` has key for `s` | Composite | Diagnostic |
| --- | --- | --- | --- |
| no key | no key | no key | none |
| no key | refs | **no key** — base leaves `s` unrestricted | `append-cannot-narrow`, naming `s`, pointing at the replacement strategy or the overlay |
| `[a]` | no key / `[]` | `[a]` | none |
| `[]` | `[a]` | `[a]` | none |
| `[]` | `[]` | `[]` (deny-all preserved) | none |
| `[a,b]` | `[b,c]` | `[a,b,c]` (global order first, exact-string dedupe) | none |

A key present in `G` but empty for `s` counts as *named* (it is a declared deny-all base), so `P` may widen it.
`append` never creates a server, never enables a disabled server, never touches a project-owned server.

## 3. Scalar and non-list fields

Pinned by `resource-reference` "Composite declaration intent and unapplied references".

| Field | `G` | `P` | Composite | Notes |
| --- | --- | --- | --- | --- |
| `defaultProvider` | `openai` | `—` | `openai` | inherit |
| `defaultProvider` | `—` | `anthropic` | `anthropic` | override |
| `defaultProvider` | `openai` | `anthropic` | `anthropic` | per-field override |
| `defaultModel` | `gpt-5.4` | `—` | `gpt-5.4` | inherit; pair may become partial |
| provider only in `G`, model only in `P` | partial | partial | both present ⇒ model resolved from the pair | exactly today's path; no probe, no default lookup, no reset |
| `defaultThinkingLevel` | `high` | `—` | `high` | validated once by the native predicate |
| `defaultThinkingLevel` | `high` | `medium` | `medium` | project wins; invalid value warns and drops, model retained |
| `instructions` | `A` | `B` | `A\n\nB` | concatenated, global first |
| `instructions` | `A` | `A` | `A` | byte-identical duplicate dropped |
| `instructions` | `A` | `—` | `A` | inherit |
| `subagents` | map | map | `P` map only | whole-field override, no `agentOverrides` key merge |
| `subagents` | map | `—` | `—` | replacement semantics, not inheritance of the global declaration |
| `label` / `description` | any | `—` | `G` value | pure presentation inheritance |

## 4. Trust

Pinned by `profile-catalog` "Profile composition strategy" and "Catalog file format validation"; instrumented in
both directions by the attempted-read test.

| Situation | Project catalog file | Global definition | Result |
| --- | --- | --- | --- |
| untrusted project, `.pi/profiles/leader.json` present (any strategy) | **never opened** (not indexed) | **read** by ordinary resolution | ordinary global leader; no strategy is consulted |
| trusted project, winner `replace` (or absent strategy) | read | **never read** | replacement, as today |
| trusted project, winner `append`, namesake exists and is valid | read | read once as base | composed, project source |
| trusted project, winner `append`, no namesake | read | nothing to read | standalone + informational diagnostic; not an error |
| trusted project, winner `append`, namesake exists but malformed | read | read and **fails closed** | activation error naming the global file; no half applied |
| trusted project, winner invalid (`append`, malformed project file) | read and rejected | **not read** | error naming the project file (existing rule) |

Two prohibitions with their own tests: no code path in an untrusted directory opens `<project>/.pi/profiles/*`,
and no code path for a `replace` winner opens the global profile path.

## 5. Provenance and contributors

Pinned by `resource-reference` "Composed reference declarations" and "Reference provenance in the activation
plan"; rendered by `in-session-switch` "Composed activation observability".

| Case | Selected identity | Reported contributors |
| --- | --- | --- |
| literal in `G` only | once | `global` |
| literal in `P` only | once | `project` |
| identical literal in both | once | `both` |
| `G` glob `internal-*`, `P` literal `internal-a` | `internal-a` once | `both` |
| `G` package alias, `P` one of that package's entry names | that entry once | `both` |
| `G` glob matches nothing, `P` declares nothing | none | zero-match diagnostic (unchanged), no origin entry |
| both halves name an extension whose entries share an identifier | each entry distinct | keyed by resolved entry path; no cross-merge |
| tool provided by a package extension, `P` only | resolved at session start | `project`, `state: "resolved"`, `at: "session-start"` |
| built-in tool named in both halves | once | `both`, `state: "resolved"`, `at: "boot"` |
| raw tool reference no built-in provides | not selected at boot | listed in the separate pending list with its scope and `resolvesAt: "session-start"`; never `unknown`, never keyed as a tool, never "existing tool" |
| pending reference a live tool provides at session start | resolved once | `state: "resolved"`, `at: "session-start"`, contributors unioned; no pending entry remains **in the in-process outcome**; the persisted pre-session-start plan is not rewritten |
| pending literal no live tool provides at session start | not selected | `state: "dropped"` through the existing `droppedLiterals` diagnostic; no `unknown` claim; in-process only, the persisted plan keeps its boot snapshot |
| pending reference matching only MCP-owned tools at session start | not selected | `state: "dropped"` through the existing `legacyMcpReferences` diagnostic; no `droppedLiterals` entry; no `unknown` claim |
| pending glob matching nothing in the live registry at session start | not selected | `state: "dropped"` with zero-match metadata only; neither `droppedLiterals` nor `legacyMcpReferences` is invented, because a zero-match glob is not an unknown literal |
| pending glob that matches nothing at boot but matches a live tool at session start | resolved at session start | `state: "resolved"`; the boot zero-match accounting is unchanged |
| `G` omits `skills`, `P` declares `skills: ["review"]`, discovery provides native skills | the project reference is **unapplied**; native skills are selected, and `review` itself MAY be natively visible when discovery provides it | no `global`/`project` contributor for any native skill, including a natively discovered `review`; `review` listed as unapplied and unvalidated with its file; kind intent is unrestricted/native |
| standalone `append`, `P` declares `skills: ["review"]` | `review` selected once | `project` |
| resource selected by the composite, then disabled by the overlay | not currently selected | absent from origins; at most a disabled entry |
| resource selected by the composite, then removed by an overlay glob | not currently selected | absent; overlay zero-match accounting unchanged |

Invariants: every provenance identity is present in the selection; every identity selected through an **applied
declared reference** has a provenance entry; an identity selected only natively carries `native` or no entry and
is never attributed to `global` or `project`; disagreement on those terms is a test failure, never a runtime
fallback. A non-composed plan carries no provenance and is byte-identical to today's output.

## 6. Adoption, reload and rollback

Pinned as behavior by `in-session-switch` "Composed activation observability" (status truth) and recorded as
deployment truth in `design.md`; release-note obligation in `tasks.md`.

| Operation | What changes | Effect on a lane with an `append` consumer |
| --- | --- | --- |
| package install / source pin movement | installed tree | none while the lane runs; **not** loaded-runtime adoption |
| new launch | a new process resolves the installed code | composes, provided the launch source resolves to that installation |
| native Pi reload | re-reads settings/context, replays the saved launch plan | no re-resolution of definitions; a changed catalog file is not picked up |
| `/profile reload` | re-resolves definitions, rewrites managed runtime files, then reloads | picks up an edited `append` file |
| `/profile use` | existing switch path, writes plan/state, reloads | picks up the new composed result |
| extension module re-execution | loaded extension code | required before a lane's in-process commands know `promptStrategy` |
| old code meets an `append` file (older build, other installation or pin, or already-loaded module — install order is irrelevant) | no tree change | warns and **replaces**: the hazard is a property of the file meeting old code, not of an install having happened |
| revert to a build without the field, `append` consumers present | installed tree | **BLOCKED**: that build warns and replaces |
| revert after consumers were removed/converted | installed tree | safe; runtime-state needs no repair |

No mandatory restart, no fleet reload, no silent model/thinking/profile/source switch is part of this change.
Rollback guard: enumerate consumer files with `"promptStrategy": "append"`, then either remove/rename them or
convert them to replacement with their effective content materialized — an exact, separately reviewed operation,
never automatic file deletion.

## 7. Fail-closed inputs and unchanged inputs

| Input | Result | Scope of the rule |
| --- | --- | --- |
| `promptStrategy` accepted set | exactly `append` and `replace`, enumerated by `profile-catalog` "Profile composition strategy"; the schema mirrors it | any definition |
| `promptStrategy` outside that set | field error: file, profile, accepted values | any definition |
| `promptStrategy` omitted | `replace` | any definition |
| `promptStrategy: "replace"` in a project definition | accepted; identical to absent | project catalog |
| `promptStrategy: "append"` in a **global** definition | field error: a global definition has no base | global catalog |
| `promptStrategy` replacement value in a global definition | accepted, inert (`docs/prd.md`); no behavior change | global catalog |
| `!`-prefixed **glob** in the project half of `append` | field error: inverting selection | the append project half only |
| `!`-prefixed glob in a global half or any replacement definition | unchanged behavior, no new rejection | everywhere else |
| bare `!name` (no glob characters) anywhere | unchanged: literal miss, existing error | everywhere |
| any catalog file without `promptStrategy` | unchanged in both catalogs | everywhere |

Recorded follow-ups, not rows of this change: generic leading-`!` grammar, project-scope resource enforcement,
safe live-consumer conversion procedure.
