# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. The initial baseline and upstream integration scope are recorded in the proposal.

`ProfileCatalog.load` currently parses every file before lookup. `listProfiles` loads a second global catalog to infer shadowing, which also parses shadowed definitions. `resolveInitialProfile` constructs a standalone model validator and requests strict MCP discovery under declared policy. `writeRuntimeFiles` independently re-reads MCP sources, so changing only the launcher would leave a second fatal gate. Status currently derives missing MCP names from resolved selections, which loses references skipped during partial resolution.

## Goals / Non-Goals

**Goals:**
- Separate filename indexing, targeted definition parsing, and tolerant listing without introducing a second definition store.
- Keep diagnostics across resolution, generated plans, launch output, and in-session status.
- Treat declaration intent independently of successful matches so partial resolution cannot widen access.

**Non-Goals:**
- No live model-selection interception, replacement provider registry, preloading extension code, or automatic model substitution.
- No resource installation, filename migration, extension dependency graph, or profile-file rewrite.
- No change to overlay command validation: unmatched explicit disable mutations retain their current errors.
- No redesign of upstream sparse selection, native subagent overrides, extension-path safety, or rollback. Preserve native precedence and project-trust behavior.

## Decisions

### 1. Index filenames without parsing, then read the winner

Change catalog loading into an index of file locations and source metadata. Preserve current regular-file and symlink handling, ordering, and trust gating. Invalid or reserved filenames become listing diagnostics rather than poisoning the index. Store shadowing metadata from filename presence, not from a parsed second catalog.

Determine the initial selected name before loading the catalog. A normal `default` launch returns its native plan directly. For named activation, validate the name, identify the trusted-project winner, and parse only that file. A malformed project winner remains an error even when the global file is valid.

Listing reads winning definitions individually and captures only expected `CatalogError` failures as unavailable entries. Unexpected enumeration and filesystem errors propagate. Avoid memoizing parsed definitions across activations; edits are picked up on reload.

Rejected alternative: eagerly parsing everything and merely catching errors. It still reads unrelated files during startup and cannot prove error isolation or avoid parsing shadowed definitions.

### 2. Resolve what is usable and preserve explicit intent

Add diagnostics to reference selection results rather than catch all resolver exceptions. Each expected literal miss or invalid extension reference is handled locally; subsequent references continue. Skills and extensions retain explicit empty effective selections under the existing named-profile generation path. MCP keeps a defined `mcps` array when declared, even if no eligible user-level name remains.

Keep original policy server keys in `mcpTools`, including dormant missing or disabled keys, for status and future re-resolution. Instance generation applies a policy only to eligible user-owned server definitions; it never creates a placeholder connection, force-enables a server, or mutates project definitions. A server excluded by `mcps` stays disabled. No invalid key is reinterpreted as a global default policy.

Retain the current raw-tool expansion after native extension loading. Keep MCP tool selectors opaque and restrictive. Keep overlay validation separate rather than sharing a now-tolerant literal expansion mode accidentally.

Rejected alternatives: erase failing declarations, restore all resources, or use a blanket try/catch around activation. These can widen access or hide execution errors.

ADR required: tolerant-activation-with-restrictive-partial-resolution

The new ADR uses the next available number from `docs/adr/` during implementation and supersedes ADR-0009 and ADR-0016's launcher-side transport rejection. Prepend the required supersession line to both historical files without changing their bodies. The new ADR keeps ADR-0016's other MCP decisions in effect by reference. It records why startup availability no longer depends on strict literal existence while narrowing intent remains mandatory.

### 3. Let native Pi own model availability

Remove `ResolveInput.validateModel` and the launcher import/call of `checkDeclaredModel`. Retire `src/launcher/model-check.ts` and its standalone unit test rather than keep an unused authority. Preserve complete model declarations in `ActivationPlan.model` and native generated settings. Unsupported parent thinking strings warn and omit only the thinking contribution; field types remain fatal.

Do not add an automatic post-start model switch or an extra profile-layer authentication probe. Existing CLI, project settings, resume behavior, fallback, and provider registration order remain Pi-owned. Verify actual startup model selection using a local fixture extension that registers a deterministic provider and static authentication without making a provider request. For use/reload, compare with native reload behavior rather than require changed startup defaults to replace the running model: the inspected native reload path refreshes settings and resources without repeating initial model selection.

Rejected alternative: turn the old model check into a warning. It would repeatedly warn about valid extension providers and still consult an incomplete runtime.

### 4. Use diagnostic MCP discovery at every activation boundary

Use the existing `invalidSource: "diagnose"` path in launcher resolution, runtime preparation, and status. Preserve whole-definition source precedence and classification-only project reads. Content errors skip only the invalid source. Unexpected filesystem errors remain failures.

Remove explicit source-disabled and transport rejection gates in profile resolution/materialization. Source-disabled definitions remain disabled with an actionable warning. Selected transport definitions pass unchanged to Pi, which owns the supported transport contract and native diagnostics.

Runtime preparation must generate restrictions from the surviving definitions and original declaration intent, not replace the policy with omission after a warning. Merge discovery diagnostics into a deduplicated activation diagnostic set. Re-reading configuration during generation remains permitted; diagnostics reflect the final snapshot and the generator reapplies declared policies to its own snapshot.

Rejected alternative: relax only `resolveInitialProfile`. `writeRuntimeFiles` would still fail or materialize a different, unrestricted policy.

### 5. Add structured diagnostics without replacing existing warning surfaces

Reuse existing launcher stderr and in-session notifications. Add an optional structured diagnostic array to the generated plan and status payload. Keep `unmatched` for existing zero-match glob consumers; include those issues in the common diagnostic collection but emit each issue only once per activation.

Deduplicate by kind, reference, source path, and diagnostic code. The formatter includes profile name and the concrete effect, such as "not loaded", "remains disabled", or "source skipped". Candidate lists and near-miss hints come from actual discovery. Status reports diagnostics as declarations or skipped inputs, not active resources. Missing policy-server diagnostics do not claim that selectors were validated.

Normalize targeted catalog warnings into structured plan diagnostics as well as the existing launch warning strings, so unknown-field diagnostics survive into status. Persist diagnostics only in the per-instance plan. Readers accept older plans with no diagnostic field. No catalog or runtime-state storage migration is needed.

### Export surface

The implementation updates all callers and tests in one change. Existing domain types not listed below retain their signatures.

| File | Planned surface | Errors / compatibility |
| --- | --- | --- |
| `src/profile-catalog.ts` | `ProfileCatalog.load(agentDir: string, options?: { projectDir?: string }): Promise<ProfileCatalog>` becomes index-only; `resolve(name: string): Promise<ResolvedProfile | undefined>` reads one winner; `list(): Promise<CatalogListItem[]>`; `hasGlobal(name: string): boolean`; `diagnostics(): string[]` for invalid/reserved filenames | `CatalogError` remains fatal for selected malformed definitions; list isolates expected definition errors; filesystem failures propagate |
| `src/profile-catalog.ts` | `CatalogListItem { name: string; source: ProfileSource; shadowsGlobal: boolean; available: boolean; definition?: ProfileDefinition; error?: string; warnings?: string[] }`; `ResolvedProfile.warnings?: string[]`; `parseProfileDefinition(name: string, raw: unknown, filePath?: string, onWarning?: (message: string) => void): ProfileDefinition` | Preserve the parser return type; unknown top-level keys warn rather than become native settings |
| `src/profile-catalog.ts` | Retire exported `loadCatalogDirectory` if no caller remains after indexing replaces it | It is not a second eager path left in activation |
| `src/profile-resolver.ts` | Export `ResolutionDiagnostic { kind: string; code: string; message: string; reference?: string; filePath?: string }`; add `ActivationPlan.diagnostics?: ResolutionDiagnostic[]`; retain declared `mcpTools`; remove `ResolveInput.validateModel` | `ActivationError` remains for structural/invariant and overlay failures, not expected selection misses; upstream `ActivationPlan.resourceSelection` and `subagents` members retain their signatures and ownership |
| `src/profile-resolver.ts` | `mergeResolutionDiagnostics(...groups: Array<readonly ResolutionDiagnostic[] \| undefined>): ResolutionDiagnostic[]`; `mcpSourceDiagnostics(profile: string, messages?: readonly string[]): ResolutionDiagnostic[]`; `resolutionDiagnostics(plan: Pick<ActivationPlan, "profile" \| "diagnostics" \| "unmatched">): ResolutionDiagnostic[]`; `mcpReferenceDiagnostics(profile: string, discovery: MergedMcpResult, mcps?: readonly string[], mcpTools?: Record<string, string[]>): ResolutionDiagnostic[]` | Shared keyed deduplication, legacy-glob normalization, and MCP snapshot diagnostics; selectors remain opaque and discovery errors propagate |
| `src/extension-discovery.ts` | Keep `select(references: string[]): Promise<SelectExtensionsResult>`; add `SelectExtensionsResult.diagnostics?: ResolutionDiagnostic[]` using a type-only import | Expected reference issues become result data; unexpected IO and discovery failures are not swallowed |
| `src/launcher/initial-profile.ts` | Preserve `resolveInitialProfile` and `InitialProfile` signatures; merge targeted-parser and resolver diagnostics into existing warnings | Preserve `UnknownProfileError` and saved-name fallback only for absent profiles |
| `src/mcp-config.ts` | Preserve `loadMergedMcpServers` and options signatures; activation callers select existing diagnostic mode | Existing strict option can remain for callers outside activation; diagnostics never convert permission errors into success |
| `src/launcher/model-check.ts` | Remove `checkDeclaredModel` with the module | Update tests and architecture references; no replacement model-validation API |
| `src/settings-generator.ts`, `src/switching/apply-plan.ts` | Add optional `LaunchPlanFile.diagnostics?: ResolutionDiagnostic[]`; serialize/parse the same additive field | Older plans remain readable; preserve existing warning return surfaces |
| `src/switching/list-profiles.ts` | Add `ProfileListEntry.available: boolean`, `error?: string`, `warnings?: string[]`; add optional `onDiagnostic?: (message: string) => void` to the `listProfiles` input; use catalog metadata instead of a second load | Keep the array return, existing callers, formatter signature, ordering, and structured payload fields; catalog filename diagnostics use the callback and optional message `details.diagnostics`, not unrelated profile entries |
| `src/switching/status.ts` | Add `StatusReport.diagnostics?: ResolutionDiagnostic[]` and optional `McpServerToolStatus.state` (type defined in this module); distinguish retained declarations from applied policies | Skipped names cannot appear in enabled or active-resource sets; existing enabled-policy fields remain compatible |

## Risks / Trade-offs

- A session can start with fewer resources than requested → show skipped references at activation and in status; keep the original definition for re-resolution.
- Missing a policy-only MCP key does not mean the user declared a server whitelist → preserve native availability for unmentioned servers while retaining restrictions on actual named eligible servers.
- A malformed later source can reveal an earlier valid same-named definition → preserve native source precedence among valid sources, report the skipped source, and apply the profile's original restriction to the surviving definition.
- Pi may reject or fall back from a genuinely unavailable model or transport → forward native diagnostics and exits; tests must assert behavior parity, not unconditional session success or a forced model.
- Catalog asynchronous lookup changes many tests → update every catalog caller, including schema tests, and exercise targeted-read counts rather than only checking successful output.
- Baseline filtering already has unrelated limitations → restrict tests to this change's declared-selection invariants; do not quietly fold another change into this branch.

## Migration Plan

1. Implement index/diagnostic interfaces and update consumers before changing error outcomes.
2. Add partial-reference and MCP behavior, then remove standalone model preflight.
3. Exercise real native extension-provider loading on launch, switch, and reload; retain rollback tests with genuine fatal definition/write/reload failures rather than missing references.
4. Update architecture, usage links, editing guidance, and the new ADR. Existing profile JSON and runtime state require no migration.
5. Complete final project checks and `/opsx-verify` before archive. Reverting the code restores strict behavior without rewriting user files; older plan readers ignore additive diagnostics.
