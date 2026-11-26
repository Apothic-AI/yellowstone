# pi-modes: same-key project modes compose instead of replacing

**Spec before patch.** Target: `tryingET/pi-extensions`, `packages/pi-modes` 0.6.0. Fork: `Apothic-AI/pi-extensions-1`, clone `~/Code/apothic-pi-extensions`.

## The problem, measured

Discovery walks filesystem root → cwd, and for two definitions with the same key **the deeper one wins outright**. `loadModes` (`src/mode-definitions.ts:366`) does exactly that: the project mode replaces the `byKey` entry and records `shadows`/`shadowedPath` as a diagnostic.

Proven on 2026-11-01 with a scratch `.pi/modes/leader.json` (`key: "leader"`, `promptStrategy: "append"`) launched `PI_MODE=leader`: the transcript contained the project marker **1** and the global `leader` contract **0**. The strategy was ignored at resolution time — the global definition was never even loaded — so an operator who wanted "the fleet contract plus a little for this space" got "a little", silently.

## The rule

> When a project definition and a shallower (global or built-in) definition share a key, and the project definition's `promptStrategy` is `append`, the two **compose**: the resolved prompt is the shallower prompt followed by the project prompt, and the result inherits the shallower definition's `promptStrategy`. In every other case the deeper definition shadows the shallower one, exactly as today.

Why `append` and not a new strategy name: it already means "add my text to what is there". At the host level that is "add to the host base prompt"; at resolution level the same sentence reads "add to the definition I am overriding". One word, one meaning, two places it applies.

Why not change the default: `promptStrategy` is absent in most project modes and parses as `replace_base`. Repositories that carry a project copy of a built-in (`review.json` overriding `review`) mean **replace**; composing them by default would append the override's text to the thing it was written to replace. Composition must be opted into.

### Explicit replace

`promptStrategy: "replace"` is added and means "shadow the shallower definition; do not compose". It is the current behaviour made sayable. It exists so that a `append`-shaped definition that must *not* compose has somewhere to say so, and so the two intents are distinguishable in a definition rather than by omission.

Note the two axes, kept separate in the docs: `append`/`replace_base`/`replace_final` describe how a definition composes **with the host system prompt**; `replace` selects **shadowing rather than composition against a shallower definition**. A same-key project `append` composes and the *result* keeps the shallower strategy (`replace_base` for `leader`), so the composed prompt replaces the host base exactly as the fleet contract did.

## Behaviour matrix

| Shallower definition | Deeper definition (project) | Result |
|---|---|---|
| global `leader`, `replace_base` | same key, `append` | **compose**: global text + project text, strategy `replace_base`, scope `project` |
| global `leader`, `replace_base` | same key, `replace` | shadow (today) |
| global `leader`, `replace_base` | same key, no strategy (→ `replace_base`) | shadow (today, unchanged) |
| global `leader`, `replace_base` | same key, `replace_final` | shadow (today) |
| builtin `review` | same key, `append` | **compose**: builtin text + project text |
| no definition of that key | project, `append` | standalone project mode appending to the host base — **unchanged** (see decision 2) |
| two ancestors + global, all same key, both `append` | — | compose all three, discovery order root → cwd (decision 1) |
| global `leader` | same key, `append`, **unconfirmed** | global still active alone, project text dropped, one warning (condition 3) |
| global `leader` | same key, `append`, **malformed file** | global still active alone, parse diagnostic, no composition (condition 3) |
| composed `leader` selected as `baseKey` | overlays in `overlayKeys` | overlays append onto the composed text (decision 3) |

## The four conditions, as places in the code

1. **Explicit replace** — `promptStrategy: "replace"` added to the strategy enum and schema; resolution treats it as "shadow". Unknown strategies keep failing validation.
2. **The confirmation gate stays** — the composed mode is `scope: "project"` and carries the project definition's `path`, so `unconfirmedProjectModes` sees it and the approval fingerprint covers both texts. Key matching is not consent: a composed mode is exactly as gated as the project file it came from.
3. **Fail partial, never total** — when the project side of a composition is unusable (unconfirmed, malformed, drifted), resolution keeps the **shallower definition alone** and reports it. This is the one place behaviour must change beyond composition: today an unusable project definition blocks the whole selection and the run falls back to the native base prompt, which loses the fleet contract — the failure mode of 2026-11-01.
4. **Observable** — one line at launch naming what composed, e.g.
   `[pi-modes] leader: global ~/.pi/agent/modes/leader.json + project /home/…/.pi/modes/leader.json (append)`
   so verification is reading one line, not grepping a transcript.

## Decisions asked for

1. **Several ancestors define the same key.** Compose all of them, in discovery order root → cwd, so the deepest and most specific text comes last. Rationale: it is the only order that matches how a reader would nest the scopes, and any other rule needs a ranking nobody can predict. A non-`append` definition at any depth stops composition at that point and shadows everything shallower, so an explicit override still wins in one step.
2. **A project `append` with no shallower definition of that key.** It stands alone, appending to the host base prompt — today's behaviour, unchanged. Rationale: skipping it would silently discard text an operator wrote, and warning would fire on a legitimate, self-consistent definition. Composition is about resolving a collision; with no collision there is nothing to resolve.
3. **Interaction with `overlayKeys`.** Composition happens at load; overlays compose at selection. A composed definition can therefore be the `baseKey` or an overlay like any other, and overlays append to the composed text in their own `before`/`after` order. No new interaction, and the composed definition reports `shadows: []` because it shadows nothing.

## Tests

- `loadModes`: same-key append composes text in shallower-then-deeper order and takes the shallower strategy; `replace` shadows; absent strategy shadows; builtin + project composes; two ancestors compose in order; no shallower definition stands alone.
- Resolution/gate: an unconfirmed composed project definition leaves the shallower definition active and emits the warning (condition 3).
- Observability: the launch line names both paths.
- Existing suite: no change to any test that does not involve a same-key `append` project definition.

## Delivery

Spec → implementation with the tests above → `cargo`-equivalent validation (`npm run check` / package tests) → PR to `tryingET/pi-extensions` from `Apothic-AI/pi-extensions-1`, one rule changed, test-bearing. If declined or unanswered after a reasonable wait, the fork carries it and the fleet runs the fork; the fork stays a clean superset so we can move back.

**Fleet adoption waits.** Nothing changes in `~/Documents/Assistant` until the behaviour is merged or the fork is installed there: the space keeps its invented `assistant-leader` key until then.
---

## Implementation state at 2026-11-01T18:49Z — spec done, code untouched, nothing installed

**Fork**: `Apothic-AI/pi-extensions-1` (monorepo; `packages/pi-modes` is 0.6.0, same as installed). Clone `~/Code/apothic-pi-extensions`, `upstream` wired to `tryingET/pi-extensions`, no branch created yet, **no file modified**.

**Seams located, so the patch starts at the right lines:**

| Purpose | Where |
|---|---|
| The shadowing rule to change | `src/mode-definitions.ts:366–400` (`loadModes`), project loop sets `shadows`/`shadowedPath` |
| Strategy enum + validation | `src/mode-definitions.ts:25`, `isPromptStrategy` ~`:208`, error text ~`:175` |
| `ResolvedMode` fields (add `composedFrom`) | `src/mode-definitions.ts:41–58` |
| Fingerprint (must see composed text) | `modeDefinitionFingerprint` ~`:216` |
| Host-prompt fallbacks to native | `src/prompt-composition.ts:89`, `:94`, `:223` |
| Confirmation blocking of project text | `src/prompt-composition.ts:151`, `unconfirmedProjectModes` (`project-mode-approvals.ts:285`) |
| Startup degradation path | the resolver that emits "Startup project mode(s) not confirmed" before falling back |

**Condition 3 (fail partial) is the only piece that is not a local edit**: the composed mode is `scope: "project"`, so an unconfirmed project half blocks the whole selection and the run drops to the native host prompt — losing the global contract. The fix is at the blocking seam, not in `loadModes`: when a blocked mode carries `composedFrom`, substitute a synthesized shallower-only mode instead of dropping the selection.

**Why nothing is installed yet**: pi-modes is load-bearing for every lane's role contract, and a partial build would reach all 23 leader lanes at their next launch. The install is deliberately gated behind the isolated A/B described above, which has not been run.

**Order for whoever continues**: patch `loadModes` + `replace` + `composedFrom` → tests for the matrix → package `npm run check` → condition 3 at the blocking seam → condition 4 launch line → prove in a scratch `PI_CODING_AGENT_DIR` (no fleet impact) → `pi install` the package dir → Assistant A/B with `leader`/`worker` keys → only then report "installed" and "active after next launch" separately.
