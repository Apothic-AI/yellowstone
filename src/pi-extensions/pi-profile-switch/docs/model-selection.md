# Model and thinking-level selection

A profile may declare a startup model and thinking level. This page states exactly what that does,
where the value takes effect, and what the profile layer does **not** control — based on the
pi-profile-switch 0.16.0 source in this repository and the installed Pi 1.5.0 build, plus an offline
fixture whose outputs are quoted below. It is a description of the current surface, not a promise
about future Pi versions: the resolution order quoted here is Pi's, and Pi may change it.

## What a profile can declare

| Field | Effect |
| --- | --- |
| `defaultProvider` + `defaultModel` | The model this profile starts on. Both must be declared; either alone sets no profile model (`src/profile-resolver.ts`, `extractModel`). |
| `defaultThinkingLevel` | Startup thinking level for that model. Validated against Pi's own accepted set; an unsupported value is reported and ignored, and the model declaration is kept (`src/profile-resolver.ts`). |
| `subagents.defaultModel` / `subagents.defaultThinking` / `subagents.agentOverrides.<role>.{model,thinking}` | Child-agent settings, passed to pi-subagents. They are not the parent session's model and are described under Child-agent configuration. |

The profile schema lists these keys and no other model-related key: there is no scope, price, cost
policy, provider-registration, or auth field (`schemas/profiles.schema.json`). Unknown top-level
fields are ignored with a warning rather than taking effect.

## Where the value lands: the generated instance settings

The launcher resolves the profile, generates a fresh per-launch instance directory, and hands that
directory to Pi as its agent directory (`PI_CODING_AGENT_DIR`; ADR-0010). The instance
`settings.json` is a **copy of your own settings** with three keys replaced — `defaultProvider`,
`defaultModel`, `defaultThinkingLevel` (`src/settings-generator.ts`) — and one inherited key removed
for the declared model (see "Explicit choices are preserved" below).

Consequences worth stating plainly:

* Your own `settings.json` is never written. The profile's values reach Pi only through the
  instance file, and only for that launch.
* Everything the profile does not declare is inherited unchanged from your settings — including
  `enabledModels` and the `modelThinkingLevels` pins, with the single FT-32 exception described
  below.
* Generated settings live as long as the instance does. An instance keeps the file it was launched
  with; a pre-existing instance is not retroactively corrected (ADR-0021).

## Three different things that can be "resolved"

These are often conflated. They happen at different times and have different effects.

| Layer | When | Effect on a running session |
| --- | --- | --- |
| Profile **definition** | Launch, and again on `/profile use` / `/profile reload` | None by itself; it is a file being read. |
| **Generated instance settings** | Written at launch; rewritten in place by `/profile use` / `/profile reload` | None on the current session; the next session in that instance starts from the file. |
| **Running session** | Records its own model and thinking level | Kept until a new session, a different recorded choice, or an explicit command changes it. |

So the practical rules are:

* **`/profile reload` re-resolves the definitions and rewrites the instance's managed files** —
  `settings.json` and the `pi-profile.json` launch plan among them — then asks Pi to reload
  (`src/switching/switch-profile.ts`). Pi re-reads settings for the reloaded process, but the
  session you are in keeps its model and thinking level; the **next** session in that instance
  starts from the rewritten file. If the reload cannot be verified, the previous files are restored.
* **Native `/reload` re-reads settings and re-executes extensions, skills, templates, themes, and
  context files.** It does not re-resolve the profile. The freshly executed pi-profile extension
  then runs its saved-plan handler on `session_start(reason: "reload")`: it reads
  `pi-profile.json` from the instance directory and re-applies **tools**, overlay tool disables,
  declared child-agent settings, MCP gateway entry points, and the one-shot change summary
  (`src/switching/apply-plan.ts`, `extensions/pi-profile/index.ts`). That handler touches no model
  or thinking key, so a native `/reload` alone cannot change the running session's model.
* **`/new` starts a new session that reads the current instance settings.** In an instance whose
  generated file still describes the old profile state, `/new` reproduces that state — it is not a
  migration (ADR-0021).
* **`/resume` and `/fork` start from the session's recorded model and thinking level**, subject to
  Pi's own prerequisites (the recorded model still resolving, with configured credentials) and to
  any explicit launch inputs, which Pi retains for the life of the process — see the flag rules in
  the scope section below. A profile's declaration is a startup input, not an override.

## Scope decides whether the declared model is used at all

On a **new** session with no `--model`, Pi resolves the model **scope** first and the settings
default second (installed Pi 1.5.0, `buildSessionOptions`). The scope comes from `--models`, or from
the `enabledModels` setting, matched against the catalog; when no scope is configured every
available model is usable.

* If the settings default model is **inside** the resolved scope, it is the startup model.
* If it is **outside** it, and the resolved scope is **non-empty**, the first scoped model is used
  instead — silently, with no error. The declared default is simply not consulted.
* The scope itself is built from models Pi considers usable, not from the whole catalogue: the CLI
  path resolves the scope through the runtime's *available* models, which are the models whose
  provider has configured credentials (installed 1.5.0: `resolveModelScope` → `getAvailable()` →
  `snapshot.available`). A declared model with no credential therefore never appears in the scope.
  Whether the lane then starts on another model depends on whether anything else survived: the
  substitution branch is only taken when the resolved scope is non-empty (`scopedModels.length > 0`).
  If configured patterns resolve to **zero** models — for example every match lacks credentials —
  the scope branch is skipped entirely, Pi reports the no-match warnings, and the fallback below
  applies. That fallback can end with **no model at all**; it does not guarantee a credentialed
  substitute.

A profile cannot express that scope. The profile schema has no such field, and the generated
settings inherit `enabledModels` verbatim, so the launcher can declare a default model but cannot
make it take effect. The offline fixture shows both halves:

```text
# Pattern matching over the fixture catalogue (pure function; no credential is involved)
enabledModels ["synthetic-cheap/cheap-model"], profile declares synthetic-cheap/expensive-model
  generated settings: defaultModel "expensive-model", enabledModels ["synthetic-cheap/cheap-model"]  <- not narrowed
  matched scope:      ["synthetic-cheap/cheap-model"]
  declared model in that list? false

enabledModels ["synthetic-cheap/*"], same profile
  generated settings: defaultModel "expensive-model", enabledModels ["synthetic-cheap/*"]
  matched scope:      ["synthetic-cheap/cheap-model","synthetic-cheap/expensive-model"]
  declared model in that list? true

# The CLI path with the same catalogue and no credentials configured (auth.json = {})
resolveModelScope(["synthetic-cheap/*"], runtime) -> 0 models, warning 'No models match pattern …'
```

The first two blocks come from the pure matcher (`resolveModelScopeFromModels`); the third is the
function the CLI path actually calls (`resolveModelScope`, which resolves against the runtime's
available models). Both are asserted by the fixture. Turning "is the declared model in the scope
list" into "which model a new session starts on" is the `buildSessionOptions` branch read from the
installed source — the fixture does not start a Pi session, so that step is source inspection, not
an observation.

The same resolved scope is what the model picker and the cycling shortcut (`Ctrl+P`) walk, so in the
current versions "make the profile's declared model apply" and "make that model reachable in this
lane" are served by the **same** lever, and a non-empty scope cannot be escaped through those
routes. Narrowing a lane's scope is not something a profile can do today.

The explicit alternative that does not touch the scope at all is the command line. `pi-profile`
forwards your arguments to Pi verbatim (`src/launcher/spawn.ts`), and on that launch route Pi's
`--model` (optionally `provider/id:level`) is resolved into the session options before the scope is
consulted and before a recorded session model is restored (`dist/main.js`, `buildSessionOptions`;
`dist/core/sdk.js` restores a recorded model only when no model was supplied).

```bash
pi-profile worker -- --model provider/model-id:high
```

What that does and does not mean:

* It is a retained launch input, not a one-session decoration. In the inspected 1.5.0 build the
  parsed CLI flags are captured when the runtime is created, and `buildSessionOptions` runs again
  whenever that runtime recreates a session, so a native new session or a fork **re-applies the
  launch model and thinking level** over a recorded or in-session choice
  (`dist/core/agent-session-runtime.js`; the factory in `dist/main.js` does not clear the parsed
  flags). A launch that continues, resumes or forks an existing session is the same case: the flag
  is applied before the recorded model would be.
* **Native `/reload` is the exception**: it reloads the current session in place and keeps that
  session's current model and thinking level.
* It does **not** re-assert itself on every turn, and it is not a policy. A model change made after a
  session is created persists until Pi recreates the session; a profile cannot prevent or revert it.
* It is per-launch, visible in the launch line, and not persisted as a default. On the launch route
  it is the documented way to name a model outside the configured scope — but not the only way, and
  the other ways differ:
  * the native **UI** routes are scope-limited: with a non-empty scope, `/model` searches the scoped
    models rather than the whole catalogue, and the picker and `Ctrl+P` cycling walk that scoped
    list (installed 1.5.0, `dist/modes/interactive/interactive-mode.js` and
    `dist/core/agent-session.js`), so they cannot reach past a non-empty scope;
  * the session API setter `pi.setModel()`, used by extensions, is **not** checked against the
    startup scope; it is subject to auth and records the choice on the session
    (`dist/core/agent-session.js`).
  Both are outside what this page documents.

The evidence for the ordering is source inspection of the installed 1.5.0 build plus the offline
resolver fixture. The fixture in this page does **not** start a Pi process, so the `--model` rows
below are source-read behaviour, not an observed CLI run.

## What actually happens when the declared model is unusable

Fallback is permissive. It is not a safety or spending control, and it should not be read as one.

| Situation | What Pi does (inspected behaviour) |
| --- | --- |
| `--model` is given at launch | Resolved before the scope is consulted and before a recorded session model is restored, and retained as a launch input: it is the starting model for the launch's first session and is re-applied when Pi recreates a session in that process (native new session, fork). It does not re-assert itself on every turn, and native `/reload` keeps the current session's choice. |
| `--model` names an id that is not registered under a known provider | Pi still builds a custom-model descriptor and warns (`Using custom model id`); the launch proceeds with that id. |
| `--model` names an unknown provider | Pi reports an error diagnostic and exits non-zero instead of starting a session. This one input is strict; the scope substitution below is not. |
| New session, no `--model`, resolved scope non-empty, declared default **inside** it | The declared default is the startup model. |
| New session, no `--model`, resolved scope non-empty, declared default **outside** it | The first scoped model starts. No error; the profile's declared model is not used and is not reported. |
| New session, no `--model`, patterns configured but the **resolved scope is empty** (for example no match has configured credentials) | The substitution branch is not taken at all. Pi reports the no-match warnings and falls through to the SDK path below, which may end with **no model**. |
| New session, no `--model`, no scope configured | Pi's SDK path: the settings default **only if** its provider has configured credentials; else the first available model with an API key; else no model. In non-interactive mode, no model exits with `no models available`. |
| Continued / resumed / forked session, no `--model` | The recorded session model if it still resolves **and** has configured credentials; else the same fallback chain, with the scope step skipped while continuing. |
| Any of the above | Price is not inspected anywhere in this path. Selection never depends on cost metadata, and absence of price data does not block or allow a model. |

The offline fixture records the relevant parts directly:

```text
zero-auth catalogue: hasConfiguredAuth false · available 0
resolveModelScopeFromModels(narrow / broad)  -> ["cheap-model"] / ["cheap-model","expensive-model"]   (pure matcher)
resolveModelScope(narrow / broad, runtime)   -> 0 / 0, warning 'No models match pattern …'           (CLI path, credential-filtered)
findInitialModel(scopedModels: [])           -> model null           (settings default not used without credentials)
findInitialModel(scopedModels: [cheap])      -> cheap-model          (scope first)
findInitialModel(isContinuing: true, scopedModels: [cheap]) -> model null   (scope step skipped while continuing)
resolveCliModel("synthetic-cheap/not-registered") -> custom model descriptor + warning
resolveCliModel("not-a-provider/x")              -> model null, error '… not found.'
```

Two conclusions follow, and they are the reason this page exists:

1. **A profile's declared model is a request, not a guarantee.** The scope decides whether it is
   honoured. An out-of-scope default is silently replaced **only when the resolved scope is
   non-empty**; when the configured patterns resolve to nothing usable there is no substitute and
   the lane may start with no model. Fallback is permissive in that branch, not a rule for every
   branch: an unknown `--model` *provider* stops the launch, and an unregistered id under a known
   provider proceeds on a custom descriptor with a warning.
2. **None of this is authorization.** Selecting a model, naming a profile, or passing a flag does
   not establish that spending on it is approved; conversely, nothing here prevents a later manual
   model change in the session.

## Cost

pi-profile-switch carries no price data and has no cost policy: there is no cost field in the
profile schema, no comparison between profiles, no routing decision, and no approval gate. A
search of `src/`, `bin/`, `extensions/`, and `schemas/` for `cost` or `price` finds one unrelated
comment about deletion logic and nothing that acts on spending.

Price data, where it exists at all, belongs to Pi's model configuration: a model entry in
`models.json` may carry `cost.{input,output,cacheRead,cacheWrite}`. When an entry omits cost, Pi
resolves **zero-valued** cost fields rather than an "unknown" marker — the fixture shows
`{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}` for an entry with no `cost` key. That is
absence of price data, not evidence that a model is free, and it means a cost-based check cannot be
derived from the catalog as-is.

What this means for a profile that declares an expensive model:

* The declaration is a reviewable edit to a file, not an ambient capability. Launching with a
  profile is the same act as choosing that profile.
* It does not make the cheap default safe by construction: the cheap default stays in force only
  while the profile (and the scope) still name it, and any launch line may override it.
* It does not stop an operator or an extension from changing the model in-session, and it does not
  record what a run cost.

Where price metadata is configured (which provider block, whether to populate `cost` at all) is a
reversible configuration decision. Establishing what a model actually costs, and consenting to pay
for it, are separate matters: they are not performed or represented by this package, and nothing in
a profile file or launch line substitutes for them.

## Explicit choices are preserved (FT-32)

The accepted FT-32 behaviour is part of this surface, and nothing in a documentation-level
description should suggest otherwise:

* A **recorded** session model and thinking level are not reset. Resuming restores them, including
  a choice that differs from the profile — subject to Pi's own prerequisites: the recorded model
  must still resolve and its provider must have configured credentials, otherwise Pi falls through
  to the startup rules above. An explicit launch `--model`/`--thinking` (or an explicit in-session
  change) wins over the recorded choice; that is native Pi precedence, not a regression of the
  property below.
* An **in-session** model or thinking-level change survives `/reload` and `/resume`.
* The property that matters here is narrower and is fully retained: **pi-profile never resets a
  session's model or thinking level**. Nothing in the package calls `pi.setModel` or
  `pi.setThinkingLevel` at activation, on profile switch, or on session start, so a profile cannot
  overwrite a recorded or in-session choice.
* When a profile declares **both** a model and a level, exactly one inherited key is dropped from
  that instance's generated settings: `modelThinkingLevels["<declared provider>/<declared model>"]`,
  and only when it disagrees with the declared level. Every other pin is preserved, the user's own
  `settings.json` is untouched, and the suppression lasts for the instance's life (ADR-0021).
* A profile that declares only a model, or only a level, changes nothing about pin precedence.

The fixture records that single-key behaviour (all four values below are asserted, not printed
alone):

```text
case A  user pins {"synthetic-cheap/cheap-model":"high","synthetic-cheap/expensive-model":"low"}
        profile declares synthetic-cheap/expensive-model at max
        generated pins {"synthetic-cheap/cheap-model":"high"}      <- only the conflicting own-model pin removed
case B  profile declares synthetic-cheap/cheap-model at high (pin agrees)
        generated pins {"synthetic-cheap/cheap-model":"high","synthetic-cheap/expensive-model":"low"}  <- nothing removed
both    user settings sha256 before == after                        <- settings.json byte-identical
```

## Per-mode model settings

In the inspected versions, `pi-modes` has no model or thinking-level surface. Its mode schema is
version 2 with `additionalProperties: false` and carries only `schemaVersion`, `key`, `label`,
`description`, `promptStrategy`, `systemPrompt`, `requires`, `conflictsWith`, `before`, `after`; the
mode extension applies `PI_MODE` on `startup` and `new` and replays the selected branch on
`/resume`, `/reload`, and `/fork`; and no path in the package calls `pi.setModel` or
`pi.setThinkingLevel` (repository source, package version pinned by `pi-modes`).

That describes the schema and runtime surface inspected here. It is not a claim that no future
design could introduce an opt-in model association safely; it is a claim that the current surface
has no such field and no such code path, and that Pi's session-scoped, recorded
`setModel`/`setThinkingLevel` would make an activation-time switch indistinguishable from an
operator choice on every later resume — which is the FT-32 property this page documents.

If per-mode model authority is ever wanted, it needs its own reviewed design; it is not a small
additive change to the schema.

## How this page's evidence was produced

* **Config fixture** — the launcher's own `resolveInitialProfile` and `generateRuntimeDir` were run
  against a synthetic private home and profile catalogue: **4 assertions per case, 3 cases, 12
  total** (declared provider/model/level written; `enabledModels` inherited verbatim; the resulting
  pin map deep-equal to the expected map, which is what covers pin removal *and* other-pin
  preservation; the user's `settings.json` sha256 unchanged). All three cases exited 0.
* **Resolver fixture** — **13 assertions** against the installed 1.5.0 exported functions: catalogue
  resolution; `hasConfiguredAuth` false and `getAvailableSnapshot()` empty; absent `cost` resolving
  to zero-valued fields; the pure matcher for narrow and broad patterns; the CLI scope path empty
  without credentials plus its `no-match` diagnostic; the three `findInitialModel` outcomes; and the
  two `resolveCliModel` outcomes. Exit 0.
* **What the fixtures are not.** They run product code with no credential configured and with the
  runtime's network refresh disabled (`refreshOnCreate:false`, `allowModelNetwork:false`,
  `PI_OFFLINE=1`, empty `auth.json`) inside a cleaned environment. Those are application-level
  controls, **not an OS-level sandbox**; the claim is limited to what the invoked functions return,
  not to an observation that no network activity occurred anywhere.
* **What was read rather than run.** The `buildSessionOptions` decision itself is read from the
  installed source; no CLI session is started by this page's evidence, so the scope-to-startup step
  is source inspection and is labelled as such above.

## What is not covered here

Not measured for this page, and therefore not claimed:

* how Pi renders a model whose catalog entry has no price data, in the footer or `/model` list;
* whether any particular third-party model authenticates through a given provider;
* the wall-clock effect of a profile's model change in a live lane (the fixture is offline and
  resolver-only; it starts no session and makes no provider request);
* whether a project-level `.pi/settings.json` in a specific repository pins a model that would
  override the instance (Pi's own merge order is unchanged by this package).

For the settings keys themselves, see Pi's own `docs/settings.md` (`enabledModels`, `modelThinkingLevels`,
`defaultThinkingLevel`) and `docs/models.md` (model selection, recorded session choices) in the installed Pi
package.
For why the single inherited pin is dropped, see
[ADR-0021](adr/0021-profile-model-owns-startup-thinking-level.md); for the instance lifecycle, see
[ADR-0010](adr/0010-per-launch-instance-lifecycle.md).
