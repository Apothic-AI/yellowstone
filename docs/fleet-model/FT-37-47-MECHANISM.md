# FT-37 / FT-47 — mechanism feasibility verdict

**Scope:** where in pi this defect would be fixed, and whether it can be. Evidence mining of
the sessions is `ft37-47-corpus`'s half; this document takes samples only to confirm claims
about parsing, and does not count.

All line numbers are against the installed package
`~/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/`
(pi **1.5.0**, `@earendil-works/pi-ai` **1.5.0**). Nothing was edited; the package was read
only.

---

## 1. Verdict

| Route | Fixes FT-37 render? | Fixes FT-37 *live stream*? | Fixes FT-47 render? | Fixes FT-47 *execution*? | Verdict |
|---|---|---|---|---|---|
| 1. Provider / `models.json` | no | no | no | no | **Not possible.** Exhaustively enumerated below. |
| 2a. `message_end` rewrite | yes | no | yes | **yes — dangerous** | **Recommended**, with hard gates. |
| 2b. `registerMarkdownTransformer` | yes (degrade, not reclassify) | **yes** | yes (strip only) | no, by construction | Companion, not the fix. |
| 2c. Provider extension wrapping `streamSimple` | yes | yes | yes | no, unless it builds toolCalls | Correct but heaviest. |
| 3. Existing extension | partial | no | no | yes (dangerous) | Closest is **`pi-aftc-toolset`/think-parser**, and it **would skip the FT-37 case**. |
| 4. Proxy | yes | yes | yes | no | Only if 2 is rejected. Prior art is a *disabled* unit whose script is gone. |

**One recommendation:** an extension using `message_end` to reclassify `<thinking>` into real
`thinking` blocks, **gated on content-block type, not on tag text**, plus a
`registerMarkdownTransformer` on `messageType === "assistant"` for the live-stream view. Do
**not** convert `<tool_call>` prose into `toolCall` blocks — for FT-47 the correct action is to
*render* those blocks as collapsed/inert, because in the live evidence the prose is a
**re-narration of a tool call the model also emitted natively**, and converting it would
execute the same tool twice.

---

## 2. The mechanism: why one session shows a parsed block *and* a raw tag

This is the whole puzzle, and it has a clean answer: **pi never parses these tags. It decides
by which JSON field carried the tokens, and that decision is made upstream of pi.**

### 2.1 pi's response path only builds a thinking block from a *structured field*

`@earendil-works/pi-ai/dist/api/openai-completions.js`:

- **:376** — `const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];`
  — the *only* three delta fields that produce a thinking block.
- **:381-396** — a non-empty value in one of those fields calls `ensureThinkingBlock(...)`
  (defined **:273**) and pushes a `thinking_delta`.
- **:418-420** — `const block = ensureTextBlock(); block.text += choice.delta.content;`
  — **`delta.content` is appended to a text block unconditionally.** No tag inspection, no
  splitting, no delimiter config. Whatever string arrives there is text forever.

So `<thinking>` inside `delta.content` is *not a tag pi failed to parse*. It is a text block
by the time pi sees it, and pi renders it as prose because that is what it is.

### 2.2 Exhaustive proof that no tag parser exists anywhere in the install

Searching the whole installed package (both the coding-agent `dist/` and every dependency
under `node_modules/`) for the literal tags under discussion:

```
grep -rEon '<thinking>|<tool_call>|<tool_answer>|<analysis>|<summary>|<antml' \
  dist/ node_modules/@earendil-works/pi-ai/dist/ node_modules/@earendil-works/pi-agent-core/dist/
```

Every hit is prose, not logic:

- `dist/core/messages.js:9,15` — the string `<summary>` appears in **system-prompt text**.
- `dist/core/model-resolver.js:312` — `<thinking>` inside a **prompt string**.
- `node_modules/@earendil-works/pi-ai/dist/providers/compat-schema.js:139` — the only
  remaining hit is the **description string** of `requiresThinkingAsText` (see §3.2).

`<tool_call>`, `<tool_answer>`, `<analysis>` match **nowhere** in executable code. There is no
`parseThinkingTags`, no delimiter option, no fallback parser. This is the strongest form of the
claim: the tags are not handled, they are *not looked for*.

### 2.3 Which field you get is decided by the upstream route, not by pi

Confirmed on one live session sample (mechanism confirmation only; counts are the corpus
lane's):

`~/.pi/agent/sessions/--home-bitnom--/2026-10-12T00-04-16-912Z_01a12d6c-....jsonl`,
`provider=subrouter`, `model=mimo-v2.6-flash`:

- 113 assistant messages carry a real `thinking` block whose `thinkingSignature` is
  `"reasoning_content"` — pi parsed these correctly, they render collapsible.
- 3 assistant messages carry a `text` block containing literal `<thinking>`.
- **One message carries both**: a `thinking` block (`signature: "reasoning_content"`) *and*
  a `text` block containing `` the `<thinking>` markup is arriving **inside plain `text` blocks** ``.

A message cannot both "fail to be parsed" and "be parsed correctly", so the two forms cannot be
one parser behaving inconsistently. They are two different fields. The same model id returned
reasoning in `reasoning_content` on 113 turns and inside `content` on 3 — consistent with a
subrouter fronting backends that differ in whether a reasoning parser is enabled, which is
exactly what a prior lane recorded live in this same file ("which form you get depends on which
upstream channel answers the request").

External corroboration for that inference, and for the operator's reading of the tag origin:
the `<thinking>`-vs-`analysis`-channel split is a property of the **serving stack's reasoning
parser**, and grammar leakage into `content` is a documented failure mode when the tool-call
parser runs only on `content` after the reasoning parser yields, or when a start sentinel is
split across SSE chunks (`pi-tool-repair/docs/tool-call-grammar-leakage-survey.md`;
`deepseek-ai/deepseek-harness` discussions #3609 and #5521 — the harness the operator named).

### 2.4 Consequence: the tag is downstream-correct

Because the decision is made upstream, **stripping the tag text is treating a symptom.** The
model sees its own prior assistant turns; if `content` history contains literal
`<thinking>…</thinking>` prose, the pattern is reinforced. Reclassifying the block changes what
is replayed on the next request — which is the part that actually stops the imitation. A
display-only strip leaves the poisoned history in place.

---

## 3. Route 1 — Provider configuration

### 3.1 The complete field surface, enumerated

`docs/models-configuration.md` is generated from the TypeScript source
(*"Do not edit it manually; run npm run generate:references"*, :3), so its tables are the
authoritative schema. The full set is:

**Provider** (`docs/models-configuration.md:9-24`, 10 fields):
`name`, `baseUrl`, `apiKey`, `api`, `oauth`, `headers`, `compat`, `authHeader`, `models`,
`modelOverrides`.

**Model** (`:26-57`, 16 fields):
`id`, `name`, `api`, `baseUrl`, `reasoning`, `thinkingLevelMap`, `input`, `inputLimits`,
`cost`, `promptCache`, `contextWindow`, `maxTokens`, `samplingParams`,
`samplingParamsByThinkingLevel`, `headers`, `compat`.

**`modelOverrides`** (`:59-87`) exposes the same 16 model fields by built-in model id.

**`compat`** (`:105` onward) is the compatibility surface, and is exhaustively enumerated per
API. For `openai-completions` (`:113-141`) it is: `supportsStore`, `supportsDeveloperRole`,
`supportsReasoningEffort`, `supportsUsageInStreaming`, `supportsFinishReason`,
`maxTokensField`, `requiresToolResultName`, `requiresAssistantAfterToolResult`,
**`requiresThinkingAsText`** (`:121`), `requiresReasoningContentOnAssistantMessages`,
**`thinkingFormat`** (`:123`), `chatTemplateKwargs`, `chatTemplateArgs`, `openRouterRouting`,
`vercelGatewayRouting`, `zaiToolStream`, `thinkingTokenBudgetField`,
`supportsThinkingTokenBudget`, `supportsOpenAIGrammarTools`, `supportsMidConvoSystemMessages`,
`supportsMidConvoToolAdditions`, `supportsStrictMode`, `cacheControlFormat`,
`sendSessionAffinityHeaders`, `sessionAffinityFormat`, `supportsLongCacheRetention`,
`vllmPriority`.

That is the entire declaration surface. There is **no** field named for a reasoning delimiter,
a response transform, a message parser, a text postprocessor, or a tag map — in any of the
four tables — and `compat` is a closed list of named booleans/enums, not an extension point.

Two fields are the *only* ones that touch reasoning *shape*, and neither helps:

- **`reasoning: boolean`** (`:36`) — a capability flag for display/pricing. It does not
  change parsing.
- **`thinkingLevelMap`** (`:35`) — maps pi's thinking levels to provider request values.

Both are request-side. Neither is consulted when a response arrives.

### 3.2 `requiresThinkingAsText` is the near-miss, and it is a trap

It *sounds* like the knob ("converted to text blocks with `<thinking>` delimiters"), but three
facts disqualify it:

1. **It is request-side only.** Its single use site is
   `pi-ai/dist/api/openai-completions.js:974-980`, inside the code that builds the *outgoing*
   assistant message. There is no read of it anywhere in the stream parser (the parser at
   :265-420 never mentions it).
2. **It no longer emits tags, contradicting its own documentation.** `:975` reads
   `// Convert thinking blocks to plain text (no tags to avoid model mimicking them)`, and
   `:976-979` joins the thinking text with `\n\n` and **adds no delimiters at all**. The
   schema description at `compat-schema.js:139` and `models-configuration.md:121` still promise
   "`<thinking>` delimiters" and "auto-detected from URL". Both are stale: the implementation
   deliberately stopped adding tags *because of the exact mimicking behaviour FT-37 describes*.
3. **It is never auto-detected.** `detectCompat` hard-codes `requiresThinkingAsText: false` at
   `openai-completions.js:1267`; the "auto-detected from URL" text has no implementation behind
   it. `getCompat` then resolves
   `model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText` (`:1319`), so the
   only way to set it is a literal in your own config.

Setting it to `true` for the subrouter would therefore *send thinking as untagged plain text* —
it cannot cause a tag to appear, and cannot remove one.

**Route 1 answer: no.** There is no provider or `models.json` surface for this. The operator's
instinct to segregate subrouter providers into their own definitions is still useful, but for a
different reason than expected: a separate provider definition buys you an independent
`compat`/`samplingParams` namespace and an independent route, **not** a parser. Segregation is
the vehicle for pinning a route; it is not itself the fix.

---

## 4. Route 2 — Extension API

### 4.1 `message_end` — the only hook that can rewrite stored content

**Signature** (`docs/extensions.md:752-758`):

```ts
pi.on("message_end", async (event, ctx) => {
  // event.message — the finalized AgentMessage
  return { message };   // optional replacement; .role must be preserved
});
```

**It rewrites, it does not merely observe.** Mechanics, verified in source:

- `docs/extensions.md:758` — *"handlers can return `{ message }` to replace the finalized
  message. The replacement must keep the same `role`."*
- `dist/core/extensions/runner.js:861-897` (`emitMessageEnd`) — chains handler results; the
  role check is enforced at `:873-881` and a violation is reported as an extension error
  instead of applied. Only `role` is constrained; **`content` is not validated**, so block
  *types* may be changed freely.
- `dist/core/agent-session.js:948-966` — the replacement is applied via
  `_replaceMessageInPlace`.
- `dist/core/agent-session.js:896-901` — that helper mutates the finalized message object in
  place, with a comment stating why: agent-core already holds that object in state, and
  `SessionManager.appendMessage(event.message)` persists it *later*, so mutating in place keeps
  **agent state, later events, and session persistence in sync**.

Two consequences that matter for this defect:

- **It is durable.** The rewrite is what lands in the session file and what is replayed on the
  next request. This is the only route that heals the imitation loop (§2.4).
- **It fires *before* tool execution.** `dist/core/../pi-agent-core/dist/agent-loop.js:325`
  emits `message_end`, then returns the message; the caller immediately does
  `message.content.filter((c) => c.type === "toolCall")` (`:161`) and executes them (`:164-170`).
  So a handler that injects `toolCall` blocks **causes those tools to run**. This is not a
  rendering decision. (The published `pi-output-parser` extension documents the same ordering:
  *"pi has finished streaming the assistant turn but hasn't yet dispatched tool calls to the
  executor"*.)

**Costs:** `message_end` is post-hoc, so the TUI shows raw tags while streaming and collapses
them at finalize. There is no mid-stream replacement hook — `message_update` is
notification-only (`docs/extensions.md:756`, and it has no `{ message }` return).

### 4.2 `registerMarkdownTransformer` — display-only, and it carries the discriminator

**Signature** (`docs/extensions.md:1807-1827`; installed impl
`dist/core/extensions/loader.js:284-287` — note the installed 1.5.0 takes **one** argument; the
`messageTypes` filter option visible in newer upstream docs is not present here):

```ts
pi.registerMarkdownTransformer((markdown, { messageType, isStreaming, availableWidth,
                                             messageId, timestamp }) => string);
// messageType: "user" | "assistant" | "assistant-thinking"
```

- **Observe-and-substitute markdown, cannot restructure.** `docs/extensions.md:1827`:
  *"The hook is display-only: the original message remains unchanged in the session and model
  context."* It returns a string. It cannot turn a text block into a thinking block.
- **It runs during streaming.** Same line: *"It runs for new user messages, assistant streaming
  updates, restored session messages, and terminal width changes"*, and `isStreaming` is `true`
  for partial updates. This is the **only** hook that can hide the tags live.
- **The discriminator is built in.** `dist/modes/interactive/components/assistant-message.js:110`
  renders `content.type === "text"` with `createMarkdownTransform("assistant", …)`; `:142`
  renders `content.type === "thinking"` runs with `createMarkdownTransform("assistant-thinking",
  …)`. Because the messageType is derived from the **block type**, a transformer that acts only
  on `"assistant"` **can never touch a reasoning block pi already parsed**. This is the
  structural answer to the "hard part" — see §6.
- Transformer errors are swallowed and keep the prior markdown
  (`dist/modes/interactive/components/markdown-transform.js:8-18`), so it is a safe place to put
  a regex.

### 4.3 Provider extension wrapping `streamSimple` — the only *correct in-stream* fix

`docs/custom-provider.md` (`Implement custom streaming`, and `Reuse a supported streaming API`)
plus `docs/extensions.md:2068-2080` (`registerProvider` accepts a complete pi-ai `Provider`
including `stream` and `streamSimple`). `@earendil-works/pi-ai` publishes `./api/*` as an
export subpath (its `package.json` `exports`), so an extension can import the built-in
`openai-completions` stream function and wrap it, remapping `text` deltas into `thinking`
deltas with a cross-chunk state machine.

This is the *technically correct* fix for live streaming: it reclassifies at the source, so the
block type is right from the first token, the session is durable, and no display hacks are
needed. It is also the most expensive: a custom provider must satisfy the full stream contract
enumerated in `docs/custom-provider.md` (*one `start` event, balanced text/thinking/toolcall
events, valid parsed input by `toolcall_end`, exactly one terminal event, honour
`onPayload`/`onResponse`/`onProviderStreamEvent`, convert cancellation to an aborted result*).
That is a lot of surface to own for a cosmetic-plus-history bug.

### 4.4 Other hooks checked and excluded

| Hook | Why it does not help |
|---|---|
| `message_update` (:756) | Notification only; no message replacement. |
| `context` (:815) / `context_with_system` (:836) | Rewrites the **outgoing** request, not the render. Could scrub tag text from history — but it would also drop the reasoning content entirely and does nothing for the live display. Not recommended. |
| `before_provider_request` (:864) | Could inject a "do not emit `<thinking>` markup" system instruction. Cheap, but post-trained behaviour does not reliably obey it, and it costs prompt tokens every turn. Worth one experiment, not a fix. |
| `provider_stream_event` (:897) | Notification-only and *"not persisted"*; `event.data` is *"read-only because mutation can affect normalization"*. **Correct use: the diagnostic** (§8). |
| `registerMessageRenderer` (:1803) | Custom message types only — cannot intercept assistant messages. |
| `registerToolRenderer` (:2107) | Tool call/result presentation only. |

---

## 5. Route 3 — Existing extensions

Searched pi.dev packages, npm and GitHub. Nothing covers this defect as stated. The relevant
prior art, all of which I read and none of which I installed:

**1. `pi-aftc-toolset` → `extensions/aftc-toolset/think-parser.ts` v1.22.0 — closest match.**
Does exactly the `message_end` → `ThinkingContent` reclassification, in source order, with
sensible guards (skips `stopReason` `error`/`aborted`; skips text blocks carrying
`textSignature` to avoid invalidating provider replay signatures — `textSignature` exists in
`TextContent`, `pi-ai/dist/types.d.ts:252-256`).

**It would not fix FT-37, for two concrete reasons:**

- Its regex is `const THINK_RE = /<think>([\s\S]*?)<\/think>/g;` — it matches **`<think>`**
  only. FT-37's tags are **`<thinking>`**. It does not match the observed evidence at all.
- Its `transformContent` begins `for (const b of content) { if (isThinkingBlock(b)) return
  undefined; }` — *"Skip if the message already has a thinking block — the provider already
  produced proper structured thinking"*. But the live sample in §2.3 is **exactly a message
  with both**. That guard is a correct instinct (don't fight native reasoning providers)
  applied at the wrong granularity: it should be evaluated per **text block**, not per
  **message**. This is the single most valuable finding of this review — the nearest existing
  solution encodes the failure mode the operator is worried about, in the opposite direction:
  it under-fixes rather than mangles.

**2. `pi-output-parser` (vishn9893) — does the *executing* variant.** `message_end`, repairs
fenced/XML/JSON tool calls into real `tool_use` blocks and lets the loop execute them. It
carries two safety gates worth copying if anyone ever does want execution: fire only when the
message contains **no** native tool_use block, and require the extracted name to match a
registered tool. Correct, and deliberately a different product decision from "render it".

**3. `pi-tool-repair` / `monotykamary/pi-tool-repair`, `r3b1s/pi-repair-layer`,
`renatocaliari/pi-tool-repair-layer` — argument-schema repair, not tag normalisation.** Their
`docs/tool-call-grammar-leakage-survey.md` is excellent on *why* grammar leaks (and is cited in
§2.3), but they fix shapes inside a call, not prose that should never have been a call.

**4. `pi-reasonix` → `src/repair.ts`** — four repair passes for DeepSeek failure modes,
including "tool-call JSON emitted inside code blocks, missing from `tool_calls`". Executing, not
rendering.

**5. `pi-thinking-reformatter`** — repairs tokenization whitespace *inside* deepseek thinking
blocks. Adjacent (same model family), orthogonal problem.

**No published extension handles `<tool_answer>`, `<analysis>`, `<summary>` as prose.** The
tag set in FT-47 has no prior art at all.

---

## 6. The hard part, answered explicitly

### 6.1 Can the route distinguish "tag pi already understands" from "tag pi is passing through"?

**Yes — and the distinction is not textual, it is structural.** This is the key point, and it
is why a naive tag-stripper is dangerous and a block-type-gated one is not:

- A reasoning block pi parsed correctly is `{ type: "thinking", thinking, thinkingSignature }`.
  It **contains no `<thinking>` tag at all** — the upstream reasoning parser already removed
  the sentinel before it reached `reasoning_content`. Verified in the sample: the thinking
  blocks have `signature: "reasoning_content"` and their text begins with prose, not a tag.
- A tag pi is passing through is `{ type: "text", text: "<thinking>…</thinking>…" }`.

The two are therefore distinguishable by **block type alone**, before any regex runs. Every
route that gates on `content.type` is safe *by construction*:

- `message_end` handler: iterate `message.content`; only ever rewrite blocks with
  `type === "text"`. A `thinking` block is not a candidate, so it cannot be mangled. **Do not**
  copy the aftc guard that skips the whole message when any thinking block exists (§5.1) —
  gate per text block instead.
- `registerMarkdownTransformer`: act only when `messageType === "assistant"`; the parsed
  reasoning block is delivered as `"assistant-thinking"` and is structurally invisible to you
  (`assistant-message.js:110` vs `:142`).

So the recommended route **does** make this distinction, and it makes it more robustly than a
textual rule: it is a type check, and a type check cannot be fooled by a model that writes the
word `<thinking>` inside its actual reasoning, or by a `thinkingSignature` that pi needs
preserved for replay.

Two residual guards I would still carry, because they protect the *history* rather than the
render:

1. **Never touch a text block with a non-empty `textSignature`.** `TextContent.textSignature`
   exists (`pi-ai/dist/types.d.ts:252-256`) precisely so a provider can validate replay;
   rewriting the text invalidates it. This is aftc's guard and it is right.
2. **Never rewrite when `stopReason` is `"error"` or `"aborted"`.** Partial output has no
   closing tag; a greedy or non-greedy regex will either miss it or swallow the rest of the
   turn. Use a non-greedy regex that *requires* the closing tag, and leave unclosed tags as
   text.

One more honesty point: the reclassification changes what the provider receives next turn. A
`thinking` block with `signature: "reasoning_content"` will be replayed in that field
(`openai-completions.js:995-999`), whereas today the tagged text is replayed inside `content`.
That is the intended effect (§2.4) — but it means the fix silently alters request shape for any
provider whose `compat` differs, so it must be scoped to the providers that actually exhibit
the defect, not installed fleet-wide by default.

### 6.2 FT-47: rendering vs executing

**I am proposing rendering only.** The evidence says execution would be actively wrong:

The one live FT-47 sample I checked
(`~/.pi/agent/sessions/--home-bitnom-Documents-Fleet--/2026-11-08T22-47-52-177Z_...jsonl`,
`provider=subrouter-deepseek-flash`, `model=deepseek-v4.1-flash-1017`) is an assistant message
whose content is `['text', 'toolCall']`. The text block reads:

```
<tool_answer>
Understood — flat, named by what they carry. …
<tool_answer>
Checking the exact shape before moving anything.
<tool_call>
bash
{ "command": "cd /home/bitnom/Code/yellowstone && … " }
```

The model **also emitted a native `toolCall` block in the same message**. So the prose
`<tool_call>` is a *second narration of a call already made*, not a call that was lost. Turning
it into a real `toolCall` would run the same command twice — beyond appearance, this changes
what the agent does to the filesystem. `message_end` sits upstream of execution
(`agent-loop.js:325` then `:161-170`), so this is not hypothetical.

There is a second, independent reason to prefer rendering: a well-formed-looking `<tool_call>`
body is not a validated call. `pi-output-parser` has to match the extracted name against
`pi.getAllTools()` and gate on "no native tool_use present" *because* the naive version
misfires. Here, the "no native call present" gate would evaluate to **false** on the sample, so
even that extension would correctly decline it.

**Therefore for FT-47:** collapse or dim `<tool_answer>` / `<analysis>` / `<summary>` prose, and
for `<tool_call>` prose a transformer can at most demote it to an inert, visibly-labelled
block (or drop it, since the real call is present). Never synthesise `toolCall` blocks.
If the corpus lane finds FT-47 cases where the prose is the *only* call — no native `toolCall`
in the message — that is a separate defect with a real behaviour question ("should pi execute
salvaged calls?"), and it deserves its own decision, not a silent default in this fix.

---

## 7. Route 4 — Proxy

**Prior art on this machine: real, and dead.** `~/.config/systemd/user/subrouter-proxy.service.disabled`:

```
Description=Subrouter Thin Proxy for Codex
ExecStart=/usr/bin/env node /home/bitnom/.codex/tools/subrouter-proxy.mjs
Environment=SUBROUTER_PROXY_PORT=3485
Environment=SUBROUTER_TARGET_HOST=ai.orbitlink.me
```

The unit is disabled, and **`/home/bitnom/.codex/tools/subrouter-proxy.mjs` no longer exists** —
so the prior art is a design, not reusable assets. There is a *live* adjacent service:
`cliproxyapi.service` is `active`, listening on `127.0.0.1:8317`, config at
`~/Code/CLIProxyAPI/config.yaml`. That is a home for a rewrite stage if one is ever wanted, but
it is a general proxy, not a tag normaliser.

**What a proxy must rewrite, exactly** — and why it is harder than it looks:

1. It must operate on the **SSE stream**, per `choices[].delta`, not on a buffered response.
   `delta.content` chunks that belong inside `<thinking>` must be re-emitted as
   `delta.reasoning_content` (or `delta.reasoning`) — the two fields pi reads
   (`openai-completions.js:376`).
2. It needs a **cross-chunk state machine**. Tags straddle chunk boundaries: `<thin` /
   `king>` and long sentinels get split. This is a documented failure mode
   (`pi-tool-repair/docs/tool-call-grammar-leakage-survey.md`: *"Split start-marker across
   stream chunks"*). A per-chunk regex is broken by construction.
3. It must **not** touch the case the upstream already handled. If a chunk arrives with
   `reasoning_content` populated, the reasoning parser upstream already ran; the proxy must
   pass it through untouched, or it will double-count or reorder.
4. It must rewrite **only the response stream**, and it must keep `usage`, `finish_reason`,
   tool-call deltas, and every non-`content` field byte-identical, or pi's stop-reason and cost
   accounting shift (`openai-completions.js:358-370`).

**Verdict on Route 4:** strictly dominated. It needs the same state machine as
`registerMarkdownTransformer`/`message_end` (points 1-3), it adds a process to operate, a port
to secure, and a systemd unit to keep alive, and it fixes the problem only for traffic that
routes through it — while `message_end` fixes it inside pi with no new daemon. Its one genuine
advantage is that it fixes the *upstream* problem for every client, not just pi. If the
operator ever wants a non-pi client cured too, that advantage is what would justify it.

---

## 8. Recommendation

**Build a small in-fleet extension, and keep it deliberately narrow.**

**Route: `message_end` reclassification (FT-37) + `registerMarkdownTransformer` (live view and
FT-47 prose), gated on content-block type.**

Shape:

```ts
// message_end — durable, heals history, fixes the render
pi.on("message_end", async (event) => {
  const m = event.message;
  if (m.role !== "assistant") return;
  if (m.stopReason === "error" || m.stopReason === "aborted") return;
  if (!Array.isArray(m.content)) return;

  const next = [];
  let changed = false;
  for (const b of m.content) {
    // NEVER a thinking block: `type` is the discriminator (§6.1)
    if (b.type !== "text" || b.textSignature) { next.push(b); continue; }
    const parts = splitThinking(b.text);   // needs the CLOSING tag; non-greedy
    if (parts.length === 1 && parts[0] === b) { next.push(b); continue; }
    changed = true;
    next.push(...parts);                   // {type:"thinking"} + {type:"text"} in source order
  }
  return changed ? { message: { ...m, content: next } } : undefined;
});

// registerMarkdownTransformer — live stream + FT-47 prose, display only
pi.registerMarkdownTransformer((md, { messageType }) => {
  if (messageType !== "assistant") return md;   // never "assistant-thinking"
  return renderInert(md);                       // collapse/dim <tool_answer>/<analysis>/<summary>
                                                // demote <tool_call> to an inert labelled block
});
```

Scope it to the subrouter providers that exhibit the defect (a `provider` check on
`event.message.provider`), because §6.1 shows the rewrite changes replay shape.

### Why this excludes the others

- **Provider config is excluded by proof, not by search failure.** 10 provider fields, 16 model
  fields, and a closed `compat` enum (§3.1). The one field that reads like a fit is request-side
  and, since it stopped emitting tags, is the *documented-in-code reason* FT-37 exists (§3.2).
  Nothing to configure.
- **Existing extension is excluded on evidence.** The closest one matches `<think>` not
  `<thinking>`, and its "skip the message if it already has a thinking block" guard skips
  precisely the observed both-forms message (§5.1). Using it would leave FT-37 unfixed and give
  a false sense that it was handled.
- **Proxy is excluded as strictly dominated.** Same state machine, plus a daemon, plus a port,
  plus a unit, and it only fixes traffic that goes through it (§7). Its one edge — curing
  non-pi clients — is not the ask.
- **Wrapping `streamSimple` is excluded on cost, not feasibility.** It is the only route that
  gets the stream *correct* from the first token (§4.3), and if the live-stream flicker turns
  out to be unacceptable it becomes the right answer. But it means owning the full stream
  contract from `docs/custom-provider.md`, and the transformer already covers the live view for
  free. *If two routes work, the cheaper-to-maintain one is the extension pair*: no stream
  contract, no auth, no model catalog, ~60 lines, and each half fails independently.
- **`context_with_system` / `before_provider_request` prompt-scrubbing is excluded** because it
  deletes the reasoning from history instead of reclassifying it — it would make the agent
  dumber to fix a display bug.

### What I did not verify

- **That the subrouter's two forms are caused by per-backend reasoning-parser config.** That is
  an inference from the two-field split plus the external survey. It is falsifiable and should
  be falsified before anyone pins a route on the strength of it.
- **That reclassification actually stops the model emitting the tags.** Predicted by §2.4, not
  observed. This is the one thing that decides whether the fix is durable or cosmetic.
- **FT-47 prevalence per tag.** `<tool_answer>` and `<analysis>` were seen; I did not establish
  whether `<tool_call>` prose ever appears *without* a native `toolCall` in the same message.
  That distinction decides whether FT-47 is purely cosmetic (§6.2) or a second, real bug.

### The cheap experiment that settles the first two

No proxy needed, no code written — `provider_stream_event` (`docs/extensions.md:897`) receives
every parsed provider stream event, and `after_provider_response` (`:883`) fires before the body
is consumed. Load `examples/extensions/debug-provider.ts` (the documented opt-in raw-event
viewer, listed at `docs/extensions.md:3289`) on one subrouter lane, run N identical prompts, and
read which field each delta arrives in. Or bypass pi entirely with one `curl -N` against
`https://usaeast.up.railway.app/v1/chat/completions` with `stream: true` and diff the SSE frames
for `reasoning_content` vs tag-in-`content`. That answers "is this upstream routing?" in one
command, and it is the fact the operator's segregation decision actually rests on.

---

## Appendix — citations used

Installed package root: `~/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/`

- `docs/models-configuration.md:3` (generated), `:9-24` (provider fields), `:26-57` (model
  fields), `:59-87` (modelOverrides), `:105-141` (`openai-completions` compat, incl.
  `requiresThinkingAsText` `:121`, `thinkingFormat` `:123`)
- `docs/extensions.md:752-758` (`message_end`), `:756` (`message_update`), `:815` (`context`),
  `:836` (`context_with_system`), `:864` (`before_provider_request`), `:883`
  (`after_provider_response`), `:897-908` (`provider_stream_event`), `:1807-1827`
  (`registerMarkdownTransformer`), `:2068-2080` (`registerProvider` `stream`/`streamSimple`),
  `:3289` (`debug-provider.ts`)
- `docs/custom-provider.md` — "Reuse a supported streaming API", "Implement custom streaming"
- `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:265` (`ensureTextBlock`),
  `:273` (`ensureThinkingBlock`), `:376` (reasoning fields), `:381-396`, `:418-420` (content →
  text, unconditional), `:974-980` (thinking → untagged text; comment at `:975`),
  `:995-999` (replay signature), `:1267` (`requiresThinkingAsText: false` hard-coded),
  `:1319` (compat resolution)
- `node_modules/@earendil-works/pi-ai/dist/providers/compat-schema.js:139` (stale description)
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts:252-256` (`TextContent.textSignature`)
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:161-170` (toolCall extraction and
  execution), `:325` (`message_end` emit before return)
- `dist/core/extensions/runner.js:861-897` (`emitMessageEnd`, role check `:873-881`)
- `dist/core/extensions/loader.js:284-287` (`registerMarkdownTransformer`, 1-arg in 1.5.0)
- `dist/core/agent-session.js:896-901` (`_replaceMessageInPlace` and its in-sync comment),
  `:948-966` (message_end application)
- `dist/modes/interactive/components/assistant-message.js:110` (text → `"assistant"`),
  `:142` (thinking → `"assistant-thinking"`)
- `dist/modes/interactive/components/markdown-transform.js:2,8-18` (transform chain,
  error swallowing)
- External: `pi-tool-repair/docs/tool-call-grammar-leakage-survey.md` (parser ordering, split
  sentinels); `deepseek-ai/deepseek-harness` discussions #3609, #5521;
  `pi-aftc-toolset@1.22.0` `think-parser.ts`; `vishn9893/pi-output-parser` README
- Machine state: `~/.config/systemd/user/subrouter-proxy.service.disabled` (target script absent);
  `cliproxyapi.service` active on `127.0.0.1:8317`; `~/.pi/agent/models.json` (12 providers, 5
  `subrouter-*`, all `api: openai-completions`, all `baseUrl:
  https://usaeast.up.railway.app/v1`)
