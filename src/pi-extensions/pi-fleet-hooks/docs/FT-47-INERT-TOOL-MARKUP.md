# FT-47 — inert rendering of model-emitted tool-protocol markup: scope and support

Committed with the code so the evidence travels with the package. Scope is **FT-47 only**: how a
model's `<tool_call>` / `<tool_answer>` / `<invoke>` / `<analysis>` / `<summary>` markup *looks* in
the terminal. It is a display change and nothing else.

**Out of scope here: changing what is stored or replayed.** The session payload, the model context
and the request built for the next turn keep this markup exactly as before. Nothing in this package
turns prose into a tool call, and nothing removes the prose from history.

## What the markup is

Some models emit their own harness's protocol delimiters as literal text instead of — or in
addition to — a structured tool call. Pi's stream parsers only build a `toolCall` block from a
structured channel (`choice.delta.tool_calls` on Chat Completions; `delta.content` always becomes a
text block), so that markup stays a `TextContent` block and renders as prose.

Bounded FT-47 corpus (94 session files, 28,319 assistant messages, assistant text blocks only, the
diagnosing lane's own session excluded): **202 tagged messages, all from one provider/model**
(`subrouter-deepseek-flash/deepseek-v4.1-flash-1017`) — 168 carrying `analysis`/`summary` markup
and 25 carrying tool-family markup. Of those 25:

- **18 also carried a native `toolCall` block in the same message.** Executing the prose would
  therefore have run the same action twice.
- **7 carried none**, and `stopReason` was `"stop"` ×5 and `"length"` ×2 — the model intended to
  act and pi recorded a completed text turn. That is the functional harm, and it is why the label
  says "not executed" rather than something decorative.
- 2 templated a tool name that matched the native call's name.

Structurally: 22 messages had an unclosed opener, 4 nested (max depth 3), none blockquoted; 144 tag
occurrences sat inside code constructs as examples. `<invoke>` was the dominant call-shaped form
(1,120 occurrences against 50 `<tool_call>`), which is why it is in the recognised set.

## What this package does

`src/tool-markup-inert.ts` registers **one** `pi.registerMarkdownTransformer` and nothing else:
no `on(...)`, no tool registration, no entry writes, no message mutation. The transformer acts on
`messageType === "assistant"`; `assistant-thinking` (FT-37's surface) and user text are returned
unchanged.

`src/inert-tool-markup.ts` is the classifier and renderer:

| recognised | family | label |
| --- | --- | --- |
| `tool_call`, `tool_answer`, `invoke`, `function_call`, `tool_result` | tool | "inert, not executed" |
| `analysis`, `summary` | reasoning | "inert, not replayed" |

An accepted span is replaced by a label line and a fenced block (info string `text`, fence longer
than any backtick run inside, body byte-identical). Everything outside spans is preserved in order,
byte for byte.

Acceptance rules, all conservative:

1. **Opener at line start** — at most three columns of indentation, no list marker, no blockquote
   marker. A list-marker line is refused rather than restructured, because this renderer inserts a
   fenced block and a fence cannot live mid-list.
2. **Containers are literal** — fenced blocks (including `> ``` `), indented blocks (four columns,
   tab-aware) and cross-line inline spans are examples, not protocol. The mask is `codeMask` from
   `reasoning-tags.ts`, imported rather than re-written, so FT-37 and FT-47 share one definition of
   "literal container".
3. **Same-name close at matching depth**, else no span. Nested markup collapses into the outermost
   span: a `<tool_answer>` wrapping a `<tool_call>` is one inert block, not three.
4. **Unclosed opener → byte-identical output.** This is what makes streaming safe; a partial turn
   cannot swallow the prose that follows it. Orphan closing tags are ignored rather than allowed to
   veto an otherwise well-formed span.
5. **Idempotent** — after rewriting, the tags sit inside a fence and are masked on the next pass.

## Why display-only, and why not more

`message_end` is *not* the place for this fix. In the deployed loop, `agent-loop.js` emits
`message_end` and only then filters `content` for `toolCall` blocks; `agent-session.js`'s
`_replaceMessageInPlace` mutates the message object in place on purpose so that agent state, events
and persistence stay aligned. A handler that appended a `toolCall` block there would be **executed**.
Given that the prose duplicates a native call in 18 of 25 corpus cases, that would double-run the
same action. So this package never touches messages.

Collapsing the block is also not available through the supported API: `registerMarkdownTransformer`
returns a Markdown *string*, and the custom renderers (`registerMessageRenderer`,
`registerEntryRenderer`) only apply to custom messages and entries, not to assistant text. The
deliverable is therefore "clearly fenced and labelled", not "collapsed".

## Honest limits

- **Display-only.** Payload, model context and replay are unchanged. Because the model keeps seeing
  its own markup in history, the self-conditioning loop that sustains the pattern is **not** broken
  by this change; only the operator's view changes. A durable fix is a separate release with its
  own behaviour review.
- **Markers are visible while streaming** until the closing tag arrives — inherent to a Markdown
  transformer, and the reason unclosed openers are left alone rather than wrapped optimistically.
- **Interactive TUI only.** Pi consumes markdown transformers in
  `dist/modes/interactive/components/{assistant,user}-message.js`; `print`, `json` and RPC output
  still show the raw markup.
- **Not a reasoning-replay change.** `analysis`/`summary` are labelled as inert markup, not promoted
  to thinking blocks; FT-37's detection, replay decisions and drop-on-model-change policy are
  untouched, and no signature is fabricated.
- **The entry is typed structurally, not against the SDK.** This package ships no SDK dependency, so
  a type-only import of `@earendil-works/pi-coding-agent` fails `tsc` (TS2307) — the same reason
  `src/reasoning-recovery.ts` is outside the `typecheck` list. The local
  `MarkdownTransformContext` / `MarkdownTransformer` / `MarkdownTransformerHost` declarations mirror
  the installed extension types exactly; drift is caught by
  `test/tool-markup-render.test.ts`, which drives pi's real `AssistantMessageComponent`, rather than
  by trusting the comment.
- **One model observed.** The corpus is single-provider. Detection is content-driven by design, so
  no provider gate is needed either way, but prevalence beyond that corpus is not measured.

## Verification

```sh
npm test          # 113 FT-37 tests unchanged, plus the FT-47 cases; 0 fail, 0 skip
npm run test:inert
npm run typecheck
```

`test/tool-markup-inert.test.ts` covers classification, containers, nesting, unclosed/streaming,
idempotence, the `<invoke>` decision (prose mention unchanged, matched wrapper treated as protocol),
FT-37 parser preservation, and the registration surface (a recording host proves only
`registerMarkdownTransformer` is called). `test/tool-markup-render.test.ts` loads the installed pi
build, renders a real `AssistantMessageComponent`, and asserts the label and fence appear, the
rendered output differs only because of the transformer, the message snapshot is unchanged, and the
dispatch list is identical. It resolves the SDK from `PI_SDK_ROOT` with an install-layout fallback
and **fails rather than skips** when the build cannot be found.
