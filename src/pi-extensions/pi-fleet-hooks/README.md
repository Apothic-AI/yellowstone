# pi-fleet-hooks

Three hooks that make fleet rules structural instead of advisory. They enforce
contract clauses that otherwise live only as prose in an `AGENTS.md`, where a
model has to remember them under pressure, or repair a defect that no amount of
prose can fix.

## `nonblock` — deflect the blocking form of a wait

A single-conversational-intake orchestrator must be reachable at every instant: a
call that holds the turn queues the operator's next message behind it. The
blocking forms are the *diligent-sounding* ones — `jobs action='attach'` reads as
"I will wait for the report" — which is why they get used at all.

`tool_call` may mutate `event.input` in place, so the fix is a rewrite rather
than a lecture:

| Blocking form | Rewritten to |
| --- | --- |
| `jobs attach` | `jobs output` (read the tail, come back later) |

The one case that cannot be rewritten into something useful is refused outright.

## `transient-error-retry` — recover runs from unmapped stream drops

Pi auto-retries assistant errors its own classifier accepts, but some gateways
report transient stream drops with a code that matches nothing in Pi's patterns.
The run then settles immediately and the agent appears to die until a human
nudges it.

This hook reclassifies only that family of messages as `server_error:` — a code
Pi already retries — so the normal retry machinery handles it: configured
backoff, retry spinners, `auto_retry` events, and omission of failed attempts
from the model projection.

## Install

From a local checkout, so the source of truth is the working tree:

```sh
pi install /path/to/pi-fleet-hooks
```

Each hook loads independently. Both are best-effort: a failure to classify or
rewrite leaves the original call untouched rather than blocking the turn.

## Not here

`herdr-agent-state.ts` deliberately stays a loose file in the agent's
`extensions/` directory. It is installed and overwritten by herdr's own
integration, gated on `HERDR_INTEGRATION_VERSION`, so vendoring it here would
desynchronise it from the integration that owns it.
## `reasoning-recovery` — store model-emitted reasoning markup as reasoning

Some models emit their own harness's reasoning delimiters as literal text inside the visible
content field instead of a structured reasoning channel. Pi's stream parsers build a
`ThinkingContent` block only from a real reasoning field, so that text stays a `TextContent`
block: it renders as prose, and — the part that matters — it is replayed to the model on the
next turn as ordinary assistant text, which reinforces the pattern.

At `message_end` this hook finds delimited reasoning in assistant text blocks and rewrites the
message so the reasoning is stored distinctly and, where the target adapter can carry it,
replayed through the reasoning channel. Pi applies a `message_end` replacement through
`_replaceMessageInPlace`, so agent state, session persistence and the retry decision all see
the rewritten message. It is a durable change to the record, not a rendering trick.

### Detection is content-driven and ungated

There is no provider or model list anywhere in the detector. Detection runs for every
assistant message on every provider and model; only the *replay encoding* is API-aware, because
the serialisers genuinely differ. An unknown provider or model on a supported API is detected
and replayed exactly like a known one.

Recognised spellings are `<thinking>` and `<think>`. Everything else — `<tool_call>`,
`<tool_answer>`, `<analysis>`, `<summary>`, `<invoke>`, DeepSeek's DSML tokens — is left exactly
as it is. **This is not FT-47 fixed.** Tool-protocol prose is not reclassified (that would
misrepresent it) and is never turned into a tool call.

Refusal is the default. A tag inside a code fence (including ```xml / ```ts info strings) or an
inline code span is an example, not protocol. An opening tag must start its block. The whole tag
sequence must be a clean, strictly non-nested alternation of open/close pairs — any nesting,
mixed `<think>`/`<thinking>` nesting, or unterminated opener refuses every block in that text
rather than guess which close terminates which body. Surrounding text is preserved byte for
byte, in order, including the newlines around a removed marker.

### Support table — what actually happens on the wire

Verified against the installed `@earendil-works/pi-ai` serialisers by capturing real request
bodies in `test/chat-completions-payload.test.ts`. "Structured" means the reasoning travels in a
reasoning field; "text" means it survives as ordinary text and does **not** re-enter the
reasoning channel.

| API | Recovered reasoning is | Structured? | Notes |
| --- | --- | --- | --- |
| `openai-completions` | sent as `reasoning_content` (or the field native reasoning already uses) | **yes** | Requires a recognised field name in `thinkingSignature`. An unsigned block is *omitted* by pi. |
| `google-generative-ai`, `google-vertex` | native unsigned `{ thought: true, text }` part, same provider and model | **yes** | Converter-verified locally. Server acceptance is **not** exercised by these tests. |
| `mistral-conversations` | `thinking` content part | **yes** | Unsigned block replayed as a reasoning part. |
| `bedrock-converse-stream` | `reasoningContent.reasoningText` for models without reasoning signatures; plain text for models with them | depends on the model | pi decides; both preserve the text. |
| `anthropic-messages` | **plain text** | no | Anthropic requires a provider-issued signature. pi downgrades an unsigned block to text, so this is **not faithful reasoning replay** — it is lossless display plus history cleanup only. |
| `openai-responses`, `azure-openai-responses`, `openai-codex-responses` | left as text, unchanged | no | These expect a provider-issued reasoning item; manufacturing one is forbidden. Nothing is rewritten. |
| anything else | left as text, unchanged | no | Fail-safe default: an unknown adapter shows the old symptom instead of losing content. |

Deliberately **not** written, on any API: an opaque or cryptographic signature, an encrypted
reasoning blob, a JSON `reasoning_details` item, or anything that would present unverified
content as authenticated provider state. The one value this hook writes is the literal
`reasoning_content` field name on Chat Completions — the same string pi itself stores for native
reasoning there. It is a field-name discriminator, not a signature.

### The `reasoning_details` trap

On Chat Completions, pi collects `reasoning_details` from **every** thinking block in a message,
not just the first. If any block carries a JSON-backed signature, pi sends those details and
omits all thinking *text* — including a recovered block whose own field name is perfectly valid.
So the plan checks the whole content array and, when that shape is present, leaves the recovered
reasoning as text rather than letting it look correct in the session and vanish from the request.
A tool call carrying replay state (`thoughtSignature`) is treated the same way, because pi also
harvests legacy encrypted details from there.

### Cross-model turns are untouched

Pi's `transformMessages` drops thinking blocks when provider, api or model differ, for native and
recovered reasoning alike: signatures are only valid for the model that issued them. This hook
does not override that, and never reverse-routes recovered reasoning into answer, user or system
text to get around it. A model switch therefore loses recovered reasoning from the *request*
exactly as it already loses native reasoning; the text remains in the session record.

### A turn whose only text is the reasoning is left alone

Chat Completions drops an assistant message that has neither visible content nor tool calls, and
it does so *after* writing the reasoning field. So a turn whose only text was the tagged reasoning
would, if reclassified, disappear from the next request entirely — losing the reasoning along with
the markup. In that one shape the hook keeps the tagged source, because a turn that is still
present and still tagged is strictly better than a turn that is gone. It does not invent a
placeholder answer to make the shape convertible.

### Known limits

- **Streaming still shows the markers.** `message_update` cannot replace a message and a
  Markdown transformer returns Markdown only, so nothing can reclassify a block mid-stream. The
  markers are replaced when the turn finalises. A display-only strip was considered and
  rejected: it would disagree with the durable outcome on the adapters where the rewrite is
  deliberately deferred, and it would hide the markers an operator needs in order to diagnose
  that fallback.
- **`anthropic-messages` cannot do faithful reasoning replay** without inventing a signature.
  See the table.
- **Server acceptance of the Google thought part is not exercised** by these tests. The claim is
  limited to the converter's output.
- **A model switch loses recovered reasoning from the request**, by pi's own policy.

### Tests

```sh
npm test        # scope: the reasoning-recovery suite only (the nonblock and
                # transient-error-retry hooks have no tests in this package)
npm run test:reasoning   # same three files, excluding the session integration proof
```

`test/chat-completions-payload.test.ts` calls the installed provider's real `stream()` with an
injected `fetch`, so pi's own `transformMessages`, compat resolution, message conversion and body
building all run; only the HTTP round trip is stubbed and the outgoing JSON is captured. No model
is contacted. The `pi-ai` location is resolved from `PI_AI_DIST` (package root **or** its `dist`
directory) and falls back to common global-install paths; if it cannot be found, the payload suite
**fails** rather than skipping, because a green run with the only meaningful assertions skipped
would be a false verification.
