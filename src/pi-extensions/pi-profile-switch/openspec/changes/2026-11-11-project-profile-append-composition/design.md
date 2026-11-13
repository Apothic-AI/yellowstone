# Design

## Context

See [proposal.md](proposal.md) for scope. Behavior is owned by the spec deltas in `specs/`; this document
records the mechanism, the export surface, the sequencing, and the decisions that carry judgment.

Current mechanism, read in the tree this change targets:

- `src/profile-catalog.ts` indexes filenames per catalog (`indexCatalogDirectory`) and keeps **one** entry per
  name — a project file overwrites the global entry in the index map — so today the global path is discarded
  before any read. `resolve()` reads only the winner, freshly per call.
- `parseProfileDefinition` builds the definition field by field (`readOptionalString`, `readStringArray`,
  `readMcpTools`, `parseSubagentSettings`). `supportedFields` is consumed **only** by the unknown-key warning
  loop, so a schema-only addition would make a new field known-but-unassigned: no warning, no value.
- `expandReferences` (`src/profile-resolver.ts`) expands one reference list into a `Map` keyed by `nameOf(item)`
  and has no record of which reference produced which identity. `DiscoveredExtensions.select(...)`
  (`src/extension-discovery.ts`) deduplicates by resolved entry path in a local map; identifiers come from the
  package name or are derived from the entry path, and a local file wins an identifier collision with a warning.
- `tools` splits across two moments: pre-spawn expansion against built-in names with `literalMustExist: false`
  (which passes unknown literals through), and session-start re-expansion of the raw `toolReferences` against the
  live registry (`src/switching/tool-references.ts`), which reports dropped literals.
- The plan file is what `/profile status` reads; a non-composed plan must not change shape.

## Goals / Non-Goals

**Goals**

- One pure composition function at the catalog boundary, with no filesystem, discovery, or clock access.
- One expansion per kind, so selection and provenance cannot diverge.
- Composition reachable through the existing resolution path, so the launcher and in-session switching inherit it
  without a second implementation.
- A non-composed plan byte-identical to today's.

**Non-Goals**

- No second resolver input for advisory diagnostics; no discovery validation of unapplied references.
- No per-scope expansion, no re-resolution during status, no caching, no state-file copy.
- No change to trust determination, overlay semantics, project-scope behavior, or the launcher.

## Export surface

Files, names, and signatures the implementation stage adds or changes. Error messages follow the existing
`CatalogError` / `ActivationError` shapes; no new error class is introduced.

New: `src/profile-composition.ts` — pure, no `node:fs` and no discovery import.

```ts
export type ContributorScope = "global" | "project";
export type ContributorSet = "global" | "project" | "both";
/** Disjoint kind for an identity selected because its kind is undeclared. */
export type ProvenanceKind = ContributorSet | "native";

export interface UnappliedReference {
  kind: "skills" | "extensions" | "mcps" | "tools" | "mcp_tools";
  reference: string;          // verbatim as declared
  scope: "project";           // only a project half can be unapplied
}

export interface CompositionDiagnostic {
  code: "append-unapplied-reference" | "append-cannot-narrow" | "append-standalone";
  reference?: string;         // verbatim reference or server key
  message: string;            // actionable, names the file and the fix
}

/** A raw tool reference the boot expansion could not resolve. Never keyed as a tool. */
export interface PendingToolReference {
  reference: string;          // verbatim as declared
  contributors: ContributorSet;
  resolvesAt: "session-start";
}

export interface CompositionResult {
  definition: ProfileDefinition;
  /** Per raw reference: the scopes that declared this exact literal. On the standalone branch, the
   *  project's own literals map to `project`. */
  referenceContributors: Record<kind, Record<string, ContributorSet>>;
  /** Always empty on the standalone branch: there is no base whose declaration could be widened. */
  unapplied: UnappliedReference[];
  diagnostics: CompositionDiagnostic[];
  /** `"standalone"` when no base was read; `"composed"` otherwise. */
  branch: "composed" | "standalone";
}

export function composeProfileDefinitions(
  global: ProfileDefinition | undefined,
  project: ProfileDefinition,
  options: { globalPath?: string; projectPath: string },
): CompositionResult;
```

`global === undefined` is its own branch, not an empty base. On that branch the function returns the project
definition unchanged, maps each declared project literal to `project`, returns an empty `unapplied` list, and emits
`append-standalone` as its only diagnostic. Every rule below that mentions "the global half" is defined for an
existing base and is not evaluated on this branch — in particular the unrestricted-kind rule ("the base omits a
kind, so the project's references for it are unapplied") must not fire, because a non-existent base has no
declaration to widen.

`referenceContributors` is keyed by the raw literal so the *resolver* can attribute every identity it resolves,
including through globs and package aliases. It is not keyed by identity: the composer has no discovery and
cannot know which identity a glob yields.

Changed: `src/profile-resolver.ts`

```ts
export interface ResolveInput {
  // ...existing fields
  referenceContributors?: Partial<Record<Kind, Readonly<Record<string, ContributorSet>>>>;
}

export interface ActivationPlan {
  // ...existing fields
  origins?: Partial<Record<Kind, Record<string, ProvenanceKind>>>;   // skills, mcps; `native` only for an
                                                                   // identity selected through no declaration
  extensionOrigins?: Record<string, { id: string; contributors: ContributorSet }>;  // keyed by entry path
  /** Resolved tools only, keyed by live tool name. */
  toolOrigins?: Record<string, { contributors: ContributorSet; state: "resolved"; at: "boot" | "session-start" }>;
  /** Raw references the boot expansion could not resolve. A separate list, never a name key. */
  pendingToolReferences?: PendingToolReference[];
}

function expandReferences<T>(/* ...existing... */, options?: {
  // ...existing options
  /**
   * Called for every identity this expansion sets, with the raw reference that produced it.
   * MAY fire more than once for the same identity (overlapping refs); callers MUST union contributors
   * idempotently and MUST NOT use callback count as an expansion count.
   */
  onSelect?: (identity: string, reference: string) => void;
}): T[];
```

Changed: `src/extension-discovery.ts`

```ts
async select(
  references: string[],
  options?: {
    /** Called for every accepted entry with the reference that produced it. */
    onSelect?: (entryPath: string, id: string, reference: string) => void;
  },
): Promise<SelectExtensionsResult>;
```

Changed: `src/switching/tool-references.ts` — contributor propagation only, no new reader.

```ts
export type ToolState = "resolved" | "dropped";

export interface ToolExpansion {
  // ...existing fields (expanded, droppedLiterals, legacyMcpReferences)
  /** Per expanded live tool name: the union of reference contributors, from the plan's raw map. */
  contributors?: Record<string, ContributorSet>;
  /** In-process session-start outcomes for references that were pending at boot. A `dropped` entry may be a
   *  literal reported through `droppedLiterals`, an MCP-only match reported through `legacyMcpReferences`, or a
   *  no-match glob that those diagnostics never reported; no new warning path is added. Nothing stays pending
   *  in-process, and the persisted plan is not rewritten (see the status promise below). */
  outcomes?: Record<string, { state: ToolState; contributors: ContributorSet }>;
}

export function expandToolReferences(
  references: string[],
  liveToolNames: string[],
  mcpToolNames?: string[],
  referenceContributors?: Readonly<Record<string, ContributorSet>>,
): ToolExpansion;
```

The three states are exhaustive and each transition is defined: boot `resolved` (built-in name only), boot
`pending` (raw reference, in the separate list), then session start `resolved` or `dropped`. `droppedLiterals`
keeps its existing meaning and diagnostic, `legacyMcpReferences` keeps its own, and a no-match glob keeps its
existing zero-match accounting and gains neither warning; `outcomes` records the same facts per reference so the
caller can attribute them, and adds no new warning path. The caller is the existing `applyLaunchPlan` tool block;
no other module reads tool state.

Changed: `src/switching/apply-plan.ts` — `LaunchPlanFile` gains optional `composition`, the provenance maps, and
`pendingToolReferences`; nothing else in that module moves. `src/switching/status.ts` and
`src/switching/list-profiles.ts` read them. The plan file is written before session start, so it can carry only
declared/pending tool state; a resolved post-session-start per-tool map has no existing carrier and is therefore
not promised to status (see the status promise above). Because that file is the pre-session-start snapshot, status
SHALL label a pending reference **boot-snapshot pending / current session outcome not recorded (UNKNOWN)** and
SHALL NOT claim a current pending, resolved, or dropped outcome, and no extra plan write is introduced to settle it.

## Decisions

- **Compose at the catalog boundary, not in the resolver.** The resolver's input is one definition; giving it two
  would duplicate merge rules in every caller and make the launcher and in-session paths diverge.
- **Contribute raw literals, attribute identities in the resolver.** The composer is IO-free, so it cannot map a
  glob to identities. Threading a per-raw-reference map into the single expansion keeps one expansion and one
  truth: the expansion tells us which reference produced which identity.
- **`both` requires unioning contributor sets, not choosing one.** Decided because the user's question is "did my
  project file add this?", and first-contributor attribution answers it wrongly for an overlapping glob/literal
  or alias/name pair.
- **Extension provenance keyed by resolved entry path.** Identifier-only keys can merge distinct entries; the
  selection already deduplicates by entry path, so the key follows the identity. ADR required:
  `profile-composition-provenance-keys`.
- **Tools carry three states, and pending is a boot-only state.** Boot expansion passes unknown literals
  through, so presence in the boot plan proves nothing about a runtime tool; a raw unmatched reference is a
  separate pending entry, never a name key on the tool map. Session-start is the only moment a tool's existence
  is knowable, so it resolves or drops every pending reference in-process through the existing expansion; the
  persisted plan keeps its boot snapshot, so status labels such a reference boot-snapshot pending with the current
  session outcome not recorded (UNKNOWN) instead of claiming a current state. Resolved post-session-start
  provenance is in-process only until an existing persistence surface carries it, so status makes no resolved
  per-tool claim. ADR required: `tool-provenance-states`.
- **Standalone is a branch, not an empty base.** Decided because the two inputs are different questions: a
  non-existent base has no declaration to widen, so the project's own lists are the selection; a base that exists
  and omits a kind does have a declaration, and the project may not narrow native visibility. Collapsing the two
  would silently drop a standalone project's references as "unapplied". ADR required:
  `standalone-append-semantics`.
- **Accepted values are enumerated by the contract, not the schema.** The governing spec names exactly `append`
  and `replace`, the per-scope validity, and the omitted default. The schema mirrors the enumeration in the
  implementation stage; a design gate cannot cite a schema that does not exist yet. ADR required:
  `prompt-strategy-values`.
- **Provenance agreement is scoped to declared selection.** Decided because a universal "every selected identity
  has a contributor" rule is false for native selection: a resource selected because its kind is undeclared was
  produced by no declaration. Native identities therefore carry the disjoint kind `native` (or no entry), never a
  fabricated `global`/`project` contributor. ADR required: `native-selection-provenance`.
- **Repeated callbacks are not expansion counts.** An overlapping glob/literal fires the per-identity callback
  several times for one identity; the expansion-count test must instrument the expansion invocation itself, and
  contributor sets are unioned so repeats are idempotent.
- **Unapplied references are static and unvalidated.** Adding a second resolver input for an advisory would
  widen the resolver for a diagnostic; the honest alternative is a fixed diagnostic that states the references
  were not validated. Native discovery can still select a resource with the same name; that is native visibility,
  reported as native, and never attributed to the unapplied reference. ADR required:
  `append-unapplied-reference-diagnostic`.
- **Additive-only is the single governing rule**, applied per list kind and per MCP server key. It is what turns
  "project `mcp_tools` entry for an unnamed server" from a silent narrowing into a diagnosis.
- **Fail closed on exactly three inputs.** A strategy value outside the accepted set, `append` in a global
  definition, and a `!`-prefixed glob in the project half of an `append` definition. Everything else keeps today's
  behavior, including the pre-existing `!`-glob reading in replacement profiles.
- **Trust rows follow the existing gate.** An untrusted project's catalog is never opened and the ordinary global
  resolution still reads the global definition; a replacement winner never reads the global definition; only a
  trusted `append` winner reads both. Absence of a namesake is not malformedness.
- **No reapproval/digest gate.** The existing trust decision covers project files; a mode-style approval gate
  would add state and a second authority for the same decision.
- **Freshness over caching.** Composition happens per resolution, so an edited global half is observed on the
  next resolution and no merged artifact can go stale.
- **Doc-numbering decision.** ADR-0022 is allocated (highest existing is 0021); ADR-0003 gets one supersede line
  and keeps its body, including its rejection of `extends` and deep merge, which ADR-0022 restates as still in
  force.

## Sequencing

| Stage | Content | Gate |
| --- | --- | --- |
| S0 (this change) | proposal, design, spec deltas, tasks, matrices, test plan, bilingual docs proposal, ADR-0022, ADR-0003 supersede line, `docs/prd.md` non-goal rewrite | `openspec validate --strict` + SI review; no code, no schema, no publication |
| S1 core | `src/profile-composition.ts`; explicit strategy parse/validate/assign; schema field; composition wired into the catalog resolution with the trust rows; READMEs both editions | `npm run check`, new composition suite green, parse-retention test green |
| S2 trace | contributor input, `onSelect` on the single expansion and on extension selection, plan provenance, status/list rendering, tool-contributor propagation | resolver-freeze and byte-identity tests green |
| S3 prove | instrumented trust, `mcp_tools` table, provenance, source-disabled vs unselected, negation pinning, generator/baseline preservation, docs and schema tests, `/opsx-verify` | full `npm run check` + `npm test`; SI acceptance of the diff |
| S4 (not this change) | publication review, adoption per "Adoption and rollback truth", one-lane proof | SI / space-leader decisions |

## Adoption and rollback truth

Recorded here because it is deployment truth, not software behavior; the release record must repeat it.

Four distinct operations, never "restart/reload" as one instruction:

1. **Package install** changes the installed tree. Nothing running is affected.
2. **New launch** resolves the installed code only when the launch source actually resolves to that installation;
   a new launch is not adoption of anything already running.
3. **In-process re-execution** — Pi's reload re-executes extension modules, which is how a running lane picks up
   new extension code. A native Pi reload replays the saved launch plan and does not re-resolve catalog
   definitions; `/profile reload` re-resolves definitions, rewrites the managed runtime files, and then reloads;
   `/profile use` runs its own existing path. These are not interchangeable.
4. **Old extension code hazard.** Extension code already loaded in a lane cannot gain a new command
   implementation before re-import. A lane served by old code ignores an unknown `promptStrategy`, warns, and
   **replaces** — the destructive outcome this change removes. The hazard exists whenever an `append` file is
   resolved by older code, not only after an install: a pre-existing `append` file meeting an older build, a
   rollback, another installation or pin that lacks the field, and a lane whose loaded code predates the feature
   all reach the same replace-with-warning outcome. Install order does not make a file safe. No mandatory restart
   and no silent model, thinking, profile, or source switch is performed by this change.

Rollback is **blocked**, not routine: while affected `append` consumers would be served by old
replace-with-warning code, reverting the package silently converts composition into replacement. The prerequisite
is to enumerate the consumer catalog files carrying `"promptStrategy": "append"` and either remove/rename them or
convert them to replacement with their effective content materialized — an exact, separately reviewed operation.
It is not automatic destructive file cleanup, and nothing in the runtime state directory needs repair beyond the
per-instance directories that are rewritten at the next activation.

## Open follow-ups (recorded, not implemented)

1. **Project-scope resource enforcement.** A profile cannot restrict `.pi/skills/*` or `.pi/extensions/*`; the
   settings generator deliberately skips project scope in both its enable and disable loops, and Pi exposes no
   in-session removal API (ADR-0011). Owned by SI/overlord as a capability item, not by this change.
2. **Generic `!`-glob grammar.** A leading `!` reads as negation in any profile; a bare `!name` is a literal miss.
   Scope, migration, and approval are separate work.
3. **Safe consumer conversion.** The exact procedure and its review for converting a live `append` consumer during
   a rollback belongs to the release record owner.

## Verification design

Behavior is proven on native paths only: real catalog, real resolver, real discovery, real settings generation,
real status builder, and the launcher through `test/helpers/launcher-runner.ts`. Concrete cases, file paths, and
commands are in [test-plan.md](test-plan.md); the truth tables they pin are in [matrices.md](matrices.md).
