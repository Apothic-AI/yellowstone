# FT-37 — reasoning recovery and replay: acceptance and support

Committed with the code so the evidence travels with the package rather than living in an
external report. Scope is **FT-37 only**: the durable storage and replay of reasoning that a
model emits as markup inside its answer text.

**Out of scope here: FT-47.** Rendering or *executing* tool-protocol markup is a separate,
still-unresolved issue. This package deliberately never turns prose into a tool call, so the
tool-protocol family is untouched rather than implicitly addressed.

## What the hook does

`src/reasoning-recovery.ts` registers `message_end`. For an assistant message that is not an
error or an abort, the parser in `src/reasoning-tags.ts` finds model-emitted reasoning blocks in
the visible `text` and `src/reasoning-replay.ts` moves them into `thinking` blocks placed before
the answer, marking them for replay with the field name the Chat Completions adapter already
reads.

Detection is content-driven. There is no provider or model allowlist and no name is consulted to
decide whether to parse: a message from an unknown provider is handled the same way as one from a
known one. What *is* API-aware is only the replay decision, because a field literal means
different things to different adapters — that is serialization, not activation.

## Replay support on the wire (same provider, API and model)

| outgoing adapter | recovered reasoning | notes |
| --- | --- | --- |
| `openai-completions` | replayed in the reasoning field | native and recovered blocks are joined; order is native-first |
| `openai-responses` | **not** replayed | a provider-issued reasoning item cannot be fabricated |
| `anthropic-messages` | downgraded to answer text | an unsigned thinking block has no signature to send |
| `google-generative-ai` | carried as a thought part | converter-level claim only; server acceptance is untested |

Any change of provider, API or model drops thinking before serialization. That is pi's own
policy (`transformMessages`), it is intentionally preserved, and this package adds no
user/system/answer fallback to circumvent it.

## Deliberate refusals

Nothing is fabricated and nothing visible is destroyed:

- **No synthetic signatures or reasoning items.** Where authentic signed replay cannot be
  recovered, the limitation is documented instead of imitated.
- **No synthetic tool calls, and no execution of prose.** Tool-protocol markup stays text, with
  or without a native call in the same message.
- **Containers are literal.** Fenced, indented, blockquoted, list-continuation and multi-line
  inline code keep their tags: a quoted example is documentation, not a leak.
- **A turn whose only content is the tag keeps its text.** Chat Completions drops an assistant
  message with neither content nor tool calls, so reclassifying that shape would delete the turn
  and any native reasoning with it.
- **Errors and aborts are untouched**, and signed native blocks are passed through byte-identical.
- **Idempotent**: re-normalising a stored message is a no-op, because the output contains no tags.

## Acceptance evidence

Accepted source commit: `488c881fd8ed529ed58b9fe069cc79a8cfc6987c`
(`pi-fleet-hooks: name the SDK install override PI_SDK_ROOT, isolate config discovery`), accepted
on an independent review of exactly that SHA.

| check | result |
| --- | --- |
| `npm test` (`node --test test/*.test.ts`) | 113 tests, 113 pass, 0 fail, 0 skip |
| `npm run typecheck` (strict, two reasoning modules) | clean |
| code/container probe, 12 cases | 12 correct, 0 wrong |
| content-less-turn probe, 2 adapters × 4 shapes | 8/8 correct, no message dropped |
| real SDK session, positive + negative control | 3/3 — the extension persists a normalised message and the next request carries the recovered reasoning; without it the same pipeline persists the raw leaked text |

The payload suite calls the installed provider's real `stream()` with an injected `fetch`, so
pi's own transform, compat resolution, conversion and body building all run and only the HTTP
round trip is stubbed. No model is contacted; no credential is used.

Reproduce from this package:

```sh
npm test
npm run typecheck
```

The `pi-ai` location is resolved from `PI_AI_DIST` (package root or its `dist` directory) with a
fallback to common global-install layouts. If it cannot be found the payload suite **fails**
rather than skipping, because a green run whose only meaningful assertions were skipped is a
false verification.

## Known limits

- Streaming still shows the markers; replacement happens when the turn finalises, because
  `message_update` cannot replace a message and a Markdown transformer returns Markdown only.
- Chat Completions messages that natively carry structured `reasoning_details` cannot also
  replay recovered text — the structured entry wins in both orderings.
- `openai-responses` and unsigned `anthropic-messages` are the unsupported same-model replay
  paths above; a non-base64 signature is discarded by the Google adapter.
- Server acceptance of the Google thought part is not exercised; the claim stops at the
  converter's output.
