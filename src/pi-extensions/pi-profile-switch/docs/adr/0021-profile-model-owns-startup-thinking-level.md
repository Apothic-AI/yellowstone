# A declared profile model owns that model's startup thinking level

For the settings the launcher generates, see [ADR-0005](0005-subprocess-host-with-generated-settings.md). For the keys
that stay Pi's, see [ADR-0011](0011-project-scope-belongs-to-pi.md).

## Context

A profile may declare `defaultProvider` + `defaultModel` + `defaultThinkingLevel`. The launcher writes those into the
generated instance settings, which are a copy of the user's own settings with the profile's declarations applied on
top.

Pi has two startup thinking keys, and ranks them differently: `modelThinkingLevels["<provider>/<modelId>"]` — a
per-model pin set from the settings selector — outranks `defaultThinkingLevel` when a session is created
(`findInitialModel`, and the same order in `createAgentSession`). Pi's documented wording matches the implementation:
the pin is the *per-model* value, the default is the fallback.

Because the copy carries the user's pins into every instance, a profile's `defaultThinkingLevel` was reachable only
when the user had never pinned that same model. In this fleet all three role profiles declare the fleet's default
model, and that model is pinned, so `worker` (`high`) and `ask` (`medium`) lanes ran at the pinned `max` — at every
session start, `/new` included. The declaration looked honoured in the generated `settings.json` and was not.

## Decision

When a profile declares a model **and** a thinking level, the generated instance settings do not carry an inherited
`modelThinkingLevels` entry for **that one `provider/modelId`** when it disagrees with the declared level. A pin that
already agrees is left as it is, every other model's pin is preserved, and the user's own `settings.json` is never
written. A profile that declares a model without a level, and the `default` profile, inherit exactly as before.

This is not "re-applying the profile at session start" (rejected in ADR-0011): Pi's merge order still decides
everything Pi merges — project settings still win, `--thinking`/`--model` still win, and nothing is re-applied after a
session exists. The change is confined to which single inherited key the launcher writes into the file it generates.

Consequence, recorded plainly and asserted in `test/model-thinking-lifecycle.integration.test.ts`:

- a global pin for the model an explicit profile declares no longer governs that profile's startup level;
- because the pin is absent from *that instance's* settings for its whole life, it also does not come back when the
  lane switches to another model and returns — an instance that suppressed the pin re-selects the model at the
  profile's declared level (the `defaultThinkingLevel` in the same file), not at the user's pin;
- the user's own `settings.json` is unchanged, so every other profile, every lane whose profile does not declare
  that model, and every project, CLI or in-session selection keeps native precedence, and unrelated model pins keep
  applying inside this instance;
- an explicit in-session selection (`/thinking`, and a model switch to a different model) is a session choice and
  survives `/reload` and resume as it always has.

## Existing sessions

A session records its own model and thinking level, and resuming restores them (Pi's documented behaviour). A lane
that started at the pinned level before this change therefore resumes at that level; `/reload` re-reads settings and
resources but does not re-resolve a selection. Correcting a live lane takes a new session or an explicit `/thinking`.
This ADR does not reset resumed sessions to the profile's spec: the recorded session is the more specific state.
