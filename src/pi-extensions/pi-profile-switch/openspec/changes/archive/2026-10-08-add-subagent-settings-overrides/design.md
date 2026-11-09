# Design

## Context

See [proposal.md](proposal.md) for scope and motivation.

Observed integration points:

- `src/profile-catalog.ts` parses a fixed optional field set and ignores unknown top-level fields. A trusted-project profile replaces its global namesake in full.
- `src/profile-resolver.ts` produces an `ActivationPlan`. Its parent-model validation expects a provider/model pair and must not be applied to native child-model syntax.
- `src/settings-generator.ts` reads real user settings, prepares runtime content before writes, and preserves unmanaged settings. Project settings are not merged into generated user settings.
- `src/switching/switch-profile.ts` already snapshots settings and the launch plan and restores both on write/reload failure.
- `src/switching/apply-plan.ts` and `src/switching/status.ts` expose dependency-injected application/reporting surfaces. Pi supplies registration ownership through `getAllTools()` and `getCommands()`.
- pi-subagents reads overrides from native settings. Its ordinary/project/provider precedence differs across agent sources; runtime-registered roles accept only native model-related overrides. Delegation tools can be registered but inactive.

Authoritative external behavior: [agent overrides](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md), [models](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md), [runtime-agent ownership](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md), and [dynamic tool activation](https://github.com/nicobailon/pi-subagents/blob/main/docs/configuration.md). Fixture versions defer to `package.json` and `package-lock.json`.

## Goals / Non-Goals

**Goals:**

- Keep catalog parsing, activation data, native settings generation, and runtime observation separate.
- Preserve the distinction between an absent field, an empty declaration, and an explicit native false value.
- Make new failures occur before runtime writes, except non-fatal runtime ownership observations.
- Prove native consumption with the real optional extension without depending on user credentials or live providers.

**Non-Goals:**

- No agent-registry abstraction, generic extension-settings framework, or private pi-subagents module import in production.
- No child policy derived from parent `tools`, role-map membership, or role descriptions.
- No profile-managed child-task lifecycle or changes to legacy pi-subagents private configuration/state locations.

## Decisions

### D1. Use a bounded native-shaped declaration

ADR required: native-subagent-settings-overrides

`schemas/profiles.schema.json` owns the supported profile surface. The internal type mirrors that surface rather than accepting an arbitrary native settings object:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NativeThinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export interface SubagentRoleOverride {
  model?: string | false;
  thinking?: NativeThinking | false;
  description?: string;
  advertise?: boolean;
}

export interface ProfileSubagentSettings {
  defaultModel?: string;
  defaultThinking?: NativeThinking;
  agentOverrides?: Record<string, SubagentRoleOverride>;
}
```

Text fields must be nonempty after trimming. Defaults and model/description strings are stored trimmed. Thinking values defer to the native Pi contract; the accepted-value table is exhaustive against `NativeThinking`, with schema parity covered by tests. The documentation links to the schema and native thinking reference instead of duplicating an enum inventory.

Role names remain exact and case-sensitive. Reject blank, surrounding-whitespace, and glob-pattern names, but do not check whether the role currently exists. Preserve special-looking own keys as JSON data. Normalize empty role entries away; a declaration with no remaining field becomes `undefined`.

Retain native `false` for supported role-model and role-thinking clearing and for false advertisement. Do not turn these values into omitted fields. Whether a cleared native field subsequently inherits a default remains pi-subagents' decision.

Unknown fields inside this managed namespace fail with candidates. Unknown top-level profile fields retain the existing ignore-on-read behavior. The same unsupported field can remain untouched in real native settings because the profile subset is not a validator for the whole extension.

Alternatives: accepting every upstream override field creates an unbounded configuration contract; renaming native fields adds translation and a separate vocabulary. Both are rejected.

### D2. Patch only touched native containers

Add a pure shared module, `src/subagent-settings.ts`, with no extension loading, agent discovery, model registry, or filesystem dependency. The catalog converts its validation error into `CatalogError`; settings generation converts a native-container error into `ActivationError` so an invalid declared patch follows existing pre-launch failure handling.

```ts
export class SubagentSettingsError extends Error {}

export function parseSubagentSettings(
  value: unknown,
  context: { profile: string; filePath?: string },
): ProfileSubagentSettings | undefined;

export function applySubagentSettings(
  settings: Readonly<Record<string, unknown>>,
  declaration: ProfileSubagentSettings | undefined,
  context: { profile: string; settingsPath: string },
): Record<string, unknown>;
```

`parseSubagentSettings` accepts omission, validates the managed subset, and normalizes effective emptiness. Its errors carry the profile file/name, full nested field path, and remedy.

`applySubagentSettings` returns a result without mutating its inputs. With no declaration, it does not inspect native subagent content. With a declaration, it clones the settings object, the native subagent object, and only the override-map/role containers it actually patches. Use own-property checks and data-property construction rather than inherited lookups or assignment through prototype setters.

A missing required native container is created. A present non-object required container raises a path-bearing `SubagentSettingsError`. Unneeded containers and unrelated malformed native entries remain uninspected. Shared defaults do not require a valid role map. Changing one role does not require inspecting another role.

This is a specific sparse settings patch, not profile inheritance: catalog replacement remains complete. Whole-namespace or whole-role replacement is rejected because omitted fields would then gain side effects.

### D3. Carry declarations through existing generated files

Extend `ProfileDefinition`, `ActivationPlan`, and `LaunchPlanFile` with optional `subagents?: ProfileSubagentSettings`. Only normalized nonempty declarations enter activation and the launch-plan JSON. Add no state-file field or managed artifact.

`resolveProfile` carries the validated declaration without calling the parent-model validator or looking up role identities. Unknown role/model strings are inputs for native consumption, not Resource references.

In `writeRuntimeFiles`, apply the declaration to the computed settings during the existing preparation phase, before the first managed file write. Include only the profile declaration in the launch plan; do not copy the merged native namespace there. `computeSettings` continues to read the real user settings on every activation.

```text
Catalog --> parseSubagentSettings --> ProfileDefinition
                                       |
                                       v
                                  ActivationPlan
                                       |
                    +------------------+------------------+
                    v                                     v
          Real-user settings patch                  Launch-plan declaration
                    |                                     |
                    v                                     v
          Native instance settings                  Application/status
```

Switch/reload consequently removes deleted contributions and incorporates real-settings edits. Existing settings/plan snapshots cover rollback; no new rollback channel or independent persistence is added. No native project settings are merged or rewritten to override their precedence.

Changing stored defaults supplies inputs to later native discovery/launches. The integration never enumerates active child runs to modify, restart, or cancel them. Native reload lifecycle remains authoritative.

### D4. Observe extension ownership without activating tools

Add `src/switching/subagent-observation.ts` for runtime-only ownership inspection:

```ts
export type SubagentExtensionObservation = "detected" | "unconfirmed";

export interface SubagentRegistrationSource {
  sourceInfo?: {
    path?: string;
    source?: string;
    origin?: string;
    baseDir?: string;
  };
}

export function observeSubagentExtension(
  registrations: readonly SubagentRegistrationSource[],
): Promise<SubagentExtensionObservation>;
```

Use Pi's registered tool and command sources, including inactive registrations. Prefer an unambiguous package identity present in native source metadata. Otherwise resolve the registration path, using `baseDir` for relative paths and following symlink metadata, and find its nearest owning package manifest. If no file path is available, a package-root manifest at `baseDir` can supply ownership. Stop at the first owning manifest: a nested foreign package is not attributed to an enclosing pi-subagents package. Read path metadata and manifests only; never import modules, invoke package-manager discovery, or scan agent files. Skip synthetic paths. Cache repeated owner lookups within one observation and bound enclosing-directory traversal.

A positively identified pi-subagents owner yields `detected`. Missing metadata, inaccessible manifests, foreign ownership, or no matching registration yields `unconfirmed`; these are not proof of unload. A registration name by itself is insufficient. There is no production package import and no hard dependency on its version or private filenames.

The identity check is diagnostic attribution, not code authenticity or a permission boundary. Ownership does not prove that every declared role exists or that every declared field is accepted by the installed extension version.

Extend `PlanApplicationSurface` with optional `observeSubagents(): Promise<SubagentExtensionObservation>` and `notifySubagentWarning(message: string): void` callbacks. The production extension supplies the observation using Pi's tools and commands and routes the new warning through the existing mode-safe notice surface; tests inject both callbacks. `applyLaunchPlan` observes only when the plan has a declaration. Observation failures degrade to `unconfirmed`, not activation errors. Show one actionable warning per activation/reload when ownership is unconfirmed, with UI delivery where appropriate and stderr otherwise; the new warning does not enter the agent prompt or structured stdout. Keep existing non-subagent warning delivery unchanged.

Do not base the observation on active tool names or selected extension IDs: those miss lazy activation, CLI loading, and project loading. Do not automatically add delegation tools to the active set.

### D5. Report declarations, not a recomputed live mapping

Extend `StatusReport` with:

```ts
subagents?: {
  declared: ProfileSubagentSettings;
  extension: SubagentExtensionObservation;
};
```

`buildStatusReport` accepts optional `subagentObservation` and adds this field only when `plan.subagents` exists. A missing observation defaults to `unconfirmed`. `formatStatusMarkdown` uses a heading that says these are declared overrides and points to native model inspection. It never labels any field as applied, enabled, or validated against a discovered role.

The extension computes the observation on session start/reload and explicit status requests only. It does not poll or call pi-subagents tools. Status remains based on the active launch plan rather than a newly edited catalog definition. Existing structured payloads are unchanged for profiles without declarations.

Reimplementing live role mapping is rejected because native precedence, runtime registration, parent-provider changes, and per-run values would make the result misleading. The native inspection command remains the live-mapping authority.

### D6. Verify the adapter against the actual optional extension

Add a development-only, pinned pi-subagents dependency and an isolated compatibility fixture. The installed package version is recorded only by package metadata and the lockfile. Do not add a production/peer dependency, runtime version probe, or optional-package auto-install.

New one-shot integration tests use `runLauncher`; interactive RPC cases use its sanctioned `runLauncherRpc` counterpart. The fixture owns HOME, agentDir, project, and state, and is closed in `finally`. The real package loads only through explicit fixture extension/package configuration. Tests that require it must fail if the fixture is missing, not silently skip.

The fixture provides deterministic local provider/model registrations when a resolved mapping or prompt turn is needed. Use native model inspection, native role-list results, and captured advertised prompt sections to assert consumption. Do not assert success solely from generated JSON or a handwritten imitation of upstream merging. No provider network request, vendor CLI probe, external runner, or user credential is required.

Acceptance covers the native inheritance marker, shared defaults versus pinned frontmatter, project/provider precedence, description and advertisement on file-discovered roles, model-only behavior for runtime-registered roles, and refresh after profile switching. Unit tests cover pass-through model suffixes/aliases without executing external runners.

## Export Surface

| File | Addition/change | Error boundary |
| --- | --- | --- |
| `src/subagent-settings.ts` | Types and parser/patch functions in D1-D2 | `SubagentSettingsError`; no IO |
| `src/profile-catalog.ts` | `ProfileDefinition.subagents`; integrate parser in existing `parseProfileDefinition` | Wrap as `CatalogError` |
| `src/profile-resolver.ts` | `ActivationPlan.subagents`; preserve declaration without new validator input | Existing parent-model errors unchanged |
| `src/settings-generator.ts` | Apply patch before writes; serialize optional declaration | Wrap patch error as `ActivationError` |
| `src/switching/apply-plan.ts` | `LaunchPlanFile.subagents`; optional observation and warning callbacks in `PlanApplicationSurface`; declaration-gated warning | Observation is non-fatal |
| `src/switching/subagent-observation.ts` | Runtime observation function/type in D4 | Catch attribution/IO failures as `unconfirmed` |
| `src/switching/status.ts` | `StatusReport.subagents`; optional `subagentObservation` argument to `buildStatusReport` | Pure formatting/reporting |
| `extensions/pi-profile/index.ts` | Supply observation callbacks and mode-safe warning delivery; include observation in status input | Existing activation and notice boundaries |

`src/switching/switch-profile.ts` needs no new orchestration API. Its existing settings/plan snapshots must pass the new rollback cases. Production code never imports pi-subagents.

## Risks / Trade-offs

- A stored override can be superseded by native project/provider/per-run settings. Keep those inputs intact and label profile status as declarations; verify native mappings in compatibility tests.
- An installed pi-subagents release can have a narrower override surface or runtime-role restrictions. Preserve upstream ownership and avoid an applied-value claim; validate the documented supported behavior against the pinned development fixture.
- Anonymous/copied extensions can lack attributable ownership. Report `unconfirmed`, explain the inspection route, and never fail activation or execute code to resolve it.
- Profile switching already reloads extensions and can affect native child lifecycle. Add no child-specific mutation path and make no uninterrupted-run guarantee beyond native behavior.
- A previous release ignores the new top-level field. Documentation must identify the optional integration and advise using a release that recognizes the schema; downgrading preserves other profile fields but drops this feature.

## Migration Plan

1. Implement the parser/schema and sparse native patch, then wire activation and reporting and add the pinned compatibility fixture.
2. Add the new ADR and complete the concrete documentation obligations in the proposal. Leave starter assets and existing ADRs unchanged except normal shipped skill distribution of the updated authoring guidance.
3. Run focused scenario tests, full project checks, and `/opsx-verify` against the final tree before suggesting archive.
4. Existing profiles need no migration. Users opt in by editing a profile and reloading it. Removing the declaration restores real-user native inputs on the next activation.
