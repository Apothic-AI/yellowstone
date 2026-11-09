# Design

## Context

See [proposal.md](proposal.md) for motivation and scope.

`parseProfileDefinition` already preserves field absence. `resolveProfile` loses that distinction by defaulting both resource lists to empty arrays. `buildSelectionSettings` then rewrites both top-level resource arrays and both package filters unconditionally. The ordinary `default` path uses a separate native-settings branch; its overlay path currently invents wildcard declarations for both kinds.

Native settings-only extension paths are not all represented by `DiscoveredExtensions.list()`. Replacing omission with a wildcard would therefore still lose resources and native controls. Discovery ownership and the project boundary remain those of ADR-0008 and ADR-0011.

## Goals / Non-Goals

**Goals:** carry declaration intent across the resolver/generator boundary while retaining resolved arrays for overlays and existing status output. Keep native input as the base whenever a resource kind is undeclared.

**Non-Goals:** new discovery rules, native built-in reference identifiers, a new status format, catalog migration, or changes to MCP/tool policy. Resource behavior belongs in the delta specs; this document describes its encoding.

## Decisions

### D1. Separate declaration intent from resolved arrays

Add required per-kind declaration metadata to `ActivationPlan`. Keep `skills` and `extensions` as arrays, so an empty discovery result cannot be mistaken for an explicit deny policy and existing resolved-path consumers keep their shape.

For an omitted kind, the resolver uses the existing full referenceable discovery result as its overlay/status vocabulary. For a declared kind, it retains current reference expansion and validation. The metadata records whether the profile declared an allowlist, not whether an overlay later disabled an entry.

When an overlay narrows an omitted kind, also carry the concrete disabled entries. Its surviving discovery snapshot remains useful for status, but must not become the native kind's allowlist.

```text
profile field absent --> native base + optional resolved overlay exclusions
profile field present --> expanded allowlist - matching overlay entries
                           |
                           v
                per-kind settings materialization
```

**Alternatives rejected:** making both arrays optional would conflate reporting with control and force changes through array consumers. Defaulting to a wildcard would drop settings-only paths and freeze unresolved package contents into a discovery snapshot.

### D2. Materialize each kind against the real native input

The generator chooses its branch independently for skills and extensions:

- A declared kind uses the existing allowlist encoding, including an explicitly empty selection.
- An undeclared kind starts from current real user settings. Preserve native resource paths and override meaning. In a selection plan with undeclared extensions, manage `extensions` as a symlink to the real agentDir's extension directory so Pi auto-discovers it. Do not add that directory as a plain settings include. Skills continue to use the existing mirror.
- An overlay on an undeclared kind adds only concrete force-exclusions. Keep settings-only resources outside its reference vocabulary intact.

Resource paths and exact exclusions must be mapped to their actual discovery paths after the agent directory moves. Preserve relative-path meaning, basename-pattern matching, and native inclusion/exclusion precedence. Marker-less glob filters apply to native plain includes, not to auto-discovered directories. Absolute controls under a mirrored directory must match its runtime lexical paths; escaping relative paths retain their real-agentDir resolution root. Native built-in identifiers and native no-op `~` override targets stay literal rather than acquiring new semantics. In a declared kind, retaining native exclusions must not re-add unrelated native additive includes; selected resources with a native force-inclusion exception must still load.

Package handling follows the same split. Rewrite an allowlist only for a declared kind. Preserve an undeclared kind's original filter, or its absence, and other package properties. Native-base overlays append package-relative force-exclusions only for matched entries. An existing empty native filter remains empty. Packages unresolved during read-only discovery retain their native undeclared-kind input; discovery must not install or contact the network to complete an allowlist.

Keep configured package source identity for matching against discovery; preserve its original resolution root when a native local source is relative. Changes to source/path encoding must preserve the package's unrelated resource meanings as well.

Carry native extension override controls through both branches. Their authoritative syntax and identifiers come from Pi, not a package-maintained inventory or an exemption list. The ordinary `default` path remains a regression baseline.

**Alternatives rejected:** changing the entire profile to `filter: "none"` when one field is absent would ignore the other field's explicit selection. Rewriting every package kind together is the existing bug. A native-base overlay encoded as a positive whitelist would hide settings-only resources and unresolved package contents. Adding the real extension directory as a plain include subjects auto-discovered extensions to marker-less glob filters that are inert for native auto-discovery. Dropping those globs instead would discard their native filtering of explicit plain includes.

### D3. Use sparse declarations for the default-overlay path

Replace the synthetic wildcard definition in `resolveInitialProfile` with an empty definition. The shared resolver supplies native referenceable bases and concrete exclusions for the kinds the overlay actually narrows. Preserve the existing rejection of MCP disables on `default` and existing tool-overlay behavior.

Switching keeps its current resolve, snapshot, rewrite, reload, and rollback boundary. Each rewrite uses real user settings; no previous-instance selection is treated as the next activation's native input. D4 extends the snapshot to cover extension-directory representation.

**Alternative rejected:** retaining wildcard declarations for unrelated kinds makes a tool-only overlay accidentally change skill and extension visibility.

### D4. Keep the conditional extension mirror inside the activation boundary

`extensions` remains a profile-managed instance path. For a selection plan with `resourceSelection.extensions === false`, it is a symlink to the real agentDir's `extensions` path, including when the target is absent. Declared extension selections remove the generated link and retain the existing allowlist encoding. The ordinary `filter: "none"` path retains its existing additive encoding and has no conditional mirror.

Prepare settings and validate the extension-path transition before writes. Change only the instance link, never the linked directory or its contents. A pre-existing real directory or file at the instance extension path blocks activation with an actionable error; it is not deleted or adopted by the activation path. Keep `syncAgentSymlinks(agentDir, runtimeDir)` and its existing managed-path exclusions unchanged; handle this conditional managed link separately.

Include the instance extension path in the switch snapshot as absent or symlink, recording the raw target. Restore that representation before rollback reload after any write, link-transition, or reload failure. No change to the real resource directory is part of rollback. The sweep continues to skip symlinks without traversing their targets and keeps the existing warning-only treatment of content in real instance extension directories under ADR-0012.

Report the rollback failure cause through an optional `SwitchDeps.reportFailure(message)` callback before the rollback reload. The extension owns presentation: use the current UI when available and fall back to stderr if the UI is unavailable or the context is already stale. A reporting failure must not interrupt restoration or reload. Callers without the callback retain the rejected `SwitchError` result. No persisted failure marker is introduced.

This is a reversible internal representation change. It introduces no durable settings format, new process architecture, dependency, or new sweep disposition; no ADR is required.

### Export surface

The additional internal fields in `src/profile-resolver.ts` are:

```ts
// Additions to ActivationPlan; existing fields remain.
resourceSelection: { skills: boolean; extensions: boolean };
disabledSkills?: SkillEntry[];
disabledExtensions?: ActivationPlan["extensions"];
```

`resourceSelection` is true for a kind exactly when its profile field is declared, including an empty array. `disabledSkills` and `disabledExtensions` contain resolved overlay exclusions only for an undeclared kind. Stored `RuntimeOverlay` entries remain strings and retain their existing lifecycle.

| File | Export / signature | Change and errors |
| --- | --- | --- |
| `src/profile-resolver.ts` | `defaultPlan(): ActivationPlan` | Populate both declaration flags as false; keep the ordinary default plan's existing resolved-array shape. |
| `src/profile-resolver.ts` | `resolveProfile(input: ResolveInput): Promise<ActivationPlan>` | Populate metadata, native referenceable snapshots, and native-base overlay exclusions. Existing `ActivationError` behavior remains. |
| `src/settings-generator.ts` | `generateRuntimeDir(plan: ActivationPlan, options: GenerateOptions): Promise<GeneratedRuntime>` | Consume per-kind control; signature and existing error propagation remain. |
| `src/settings-generator.ts` | `writeRuntimeFiles(runtimeDir: string, plan: ActivationPlan, options: RuntimeFileOptions): Promise<{ warnings: string[] }>` | Consume per-kind control and transition the conditional extension mirror; prepare content and validate the transition before writes. Unsafe pre-existing extension-path content raises the existing `ActivationError` with its path and a fix. |
| `src/switching/switch-profile.ts` | `switchProfile(name: string \| undefined, deps: SwitchDeps, options?: { reloadCurrent?: boolean; overlay?: RuntimeOverlay \| null; clearOverlay?: boolean }): Promise<SwitchResult>` | Signature unchanged; snapshot and restore extension-path absence or raw symlink target within the existing `SwitchError` rollback boundary. |
| `src/switching/switch-profile.ts` | `SwitchDeps.reportFailure?: (message: string) => void` | Optional presentation callback for the actionable rollback cause before reloading. Reporting failures cannot prevent rollback; `SwitchError` still rejects activation. |
| `extensions/pi-profile/index.ts` | existing profile command handler | Supply the failure callback and retain an error fallback that survives stale command contexts; no new command or exported API. |
| `src/launcher/initial-profile.ts` | `resolveInitialProfile(name: string \| undefined, context: LauncherContext, options?: { overlay?: RuntimeOverlay; liveToolNames?: string[] }): Promise<InitialProfile>` | Change only the synthetic default-overlay definition; existing activation errors remain. |

Declaration metadata and concrete exclusions are internal resolver-to-generator data. They need not be serialized into `pi-profile.json`; retain its existing resolved snapshots, tool fields, and switch markers. No durable format or new error class is introduced.

## Risks / Trade-offs

- Existing profiles can expose more resources after the fix --> publish explicit-empty upgrade guidance in both READMEs; do not silently rewrite catalogs.
- Native override precedence differs between ordinary resource lists and package filters --> compare actual loaded resources with native Pi, including broad exclusions, force-inclusion exceptions, empty package filters, and relative paths.
- Conditional extension mirrors and native additive resource paths have different lexical paths --> test relative, absolute, basename, and marker-less patterns against true native Pi, including symlinked resources and explicit plain includes.
- Switching can change extension-directory representation --> test both transition directions, link-write and reload failure rollback, absent source directories, and cleanup that never traverses the real directory.
- Native-base overlays can unintentionally become global allowlists --> exercise settings-only extension paths, unresolved package declarations, and unrelated kinds under tool-only overlays.
- A skill's native plain include can use the real agentDir path while automatic discovery uses the mirror path --> concrete overlay exclusions must cover both lexical routes without excluding unrelated skills.
- Rollback reload invalidates the command context --> assert the actionable failure cause at the real Pi notification or stderr boundary, not only as a unit-level rejected error.
- A required internal field affects hand-built test plans --> update `selectionPlan` in `test/settings-generator-selection.test.ts` and let TypeScript identify any other constructors; never infer declaration intent from array length.
- Project resources or sibling native settings can be affected by path/source changes --> retain the existing trust boundary and verify unmanaged settings and real source files are unchanged.

## Migration Plan

1. Implement and verify the artifact tasks before release.
2. Publish README guidance alongside the fix. Profiles that depended on accidental denial can explicitly declare empty arrays before upgrading.
3. Do not migrate catalogs, rewrite native settings, or change dependencies.
4. Activation failures continue to use the existing runtime rollback. Reverting the package version restores the former implementation without a persisted-format migration.
