# FT-37/47 — independent replay review (Worker B)

**Rev 2.** Rev 1 contained one overclaim. It is retracted in §9 with the fixture that disproved
it; the corrected constraint is stricter and easier to satisfy. All fixtures below are
identity-faithful: every assistant message keeps the `api`/`provider`/`model` that recorded it,
and the transition under test is a change of the *outgoing* model, not a relabelled message body.

Scope per the brief: provider/model-agnostic **detection**; faithful **same-model** replay where
the installed adapter supports it. Cross-model/provider/API thinking drop is Pi's intentional
policy (`transformMessages`) and is **not** circumvented. No user/system/assistant-text fallback.

---

## 1. How this was verified

No network, no model call, no credential, nothing written outside this directory.

**Method A — fetch injection through the real stream path.** Every adapter accepts
`options.fetch`; it is replaced with a recorder that captures URL + JSON body and throws.

```js
const p = getApiProvider('openai-completions');        // from compat.js
const s = p.stream(model, {systemPrompt, messages, tools},
                   {fetch: recorder, apiKey: 'sk-x'});  // recorder captures, throws
```

Captured URL `http://127.0.0.1:9/chat/completions` proves the payload was fully built before any
network step. Real `getCompat(model)` resolution runs, so this is the wire body.

**Method B — exported pure converters** where fetch injection is refused:
`google-shared.convertMessages`, `openai-responses-shared.convertResponsesMessages`. Google's
adapter rejects injection by design —
`errorMessage: "Custom fetch is not supported by the Google Generative AI adapter"`.

Sources: `/tmp/ft37r/harness.mjs`, `fixtures.mjs`, `transitions.mjs`. Durable captures:
`FT-37-47-REPLAY-FIXTURES.json` (18 base fixtures) and `FT-37-47-REPLAY-TRANSITIONS.json`
(9 identity-faithful transition fixtures). Markers `NATIVE_R` / `RECOVERED_R` / `ANSWER` make
every assertion a substring check on emitted JSON.

---

## 2. The replay contract as installed

### Gate 1 — identity gate, `api/transform-messages.js:90-96`, called by every adapter

```js
if (block.type === "thinking") {
    if (!isSameModel) return [];                                   // provider + api + model must all match
    if (block.redacted || block.thinkingSignature) return block;
    if (!block.thinking || block.thinking.trim() === "") return [];
    return block;
}
```

Call sites: `openai-completions.js:883`, `anthropic-messages.js:882`,
`openai-responses-shared.js:118`, `google-shared.js:156`, `bedrock-converse-stream.js:788`,
`mistral-conversations.js:31`.

This gate runs **before** the adapter serializes. That ordering is what makes cross-API transitions
safe (§3.1) and is why a field literal written by one adapter can never reach another adapter's
parser.

### Gate 2 — per-adapter handling of a *surviving* (same-model) thinking block

| adapter | unsigned block | block with a field-name literal | native signed block |
|---|---|---|---|
| `openai-completions` | omitted | replayed into that field name | replayed; **all** blocks joined by `\n` |
| `openai-responses` | omitted | `JSON.parse(signature)` → **throws on a non-JSON literal** | replayed when signature is a JSON item |
| `anthropic-messages` | downgraded to a `text` block | echoed verbatim as `signature` | replayed with signature |
| `google-generative-ai` | carried as `{thought:true,text}` | filtered out unless valid base64 (`google-shared.js:119-121`) | carried as thought part |

CC field selection (`openai-completions.js:988-999`): the field name comes from
`nonEmptyThinkingBlocks[0].thinkingSignature`, then **every** non-empty block is joined into that
one field — unless a `reasoning_details`-parseable signature exists **anywhere** in the content,
which takes precedence and suppresses the raw field entirely.

---

## 3. Acceptance matrix — exact captured payloads

### 3.1 Identity-faithful transitions (the cases that settle the design)

| # | Message recorded as | Sent to | Captured result | Verdict |
|---|---|---|---|---|
| TR-1 | `openai-completions` / `openai` / `gpt-x`, signed native + recovered | `openai-responses` / `openai` / `gpt-x` (same provider+model id, different api) | no throw; `reasoningItems: 0`; native **and** recovered both absent; `ANSWER` intact | **cross-API is safe** — Gate 1 strips thinking before the Responses parser runs |
| TR-2 | `openai-responses` / `openai` / `gpt-x`, recovered block carrying literal `reasoning_content` | same model | `SyntaxError: Unexpected token 'r', "reasoning_content" is not valid JSON` | **reachable crash**, same-api only |
| TR-3 | as TR-2, through the real stream path | same model | stream emits `{"type":"error"}` | **the turn fails** |
| AN-4 | `anthropic-messages` / `anthropic` / `claude-x`, recovered block carrying literal `reasoning_content` | same model | `[thinking(sig=SIG_ABC), thinking(thinking=RECOVERED_R, signature="reasoning_content"), text(ANSWER)]` | CC literal **echoed to the Anthropic API as an opaque signature** |
| AN-5 | `anthropic-messages` / `anthropic` / `claude-x` | `openai-completions` / `openai` / `gpt-x` | `{"content":"ANSWER"}` | all thinking dropped by Gate 1 (correct policy) |

TR-1 is the decisive correction to Rev 1: a CC-recorded message replayed by a Responses model
never reaches `JSON.parse`. Cross-API poisoning does not exist.

### 3.2 Chat Completions, same model

| # | Thinking blocks in content | Captured assistant message | Verdict |
|---|---|---|---|
| CC-1 | `[signed NATIVE_R "reasoning_content"]` + text | `{"content":"ANSWER","reasoning_content":"NATIVE_R"}` | baseline |
| CC-2 | `[unsigned RECOVERED_R]` + text | `{"content":"ANSWER"}` | omitted |
| CC-3 | `[signed NATIVE_R]`,`[unsigned RECOVERED_R]`,text | `{"content":"ANSWER","reasoning_content":"NATIVE_R\nRECOVERED_R"}` | **supported replay** |
| CC-4 | `[unsigned RECOVERED_R]`,`[signed NATIVE_R]`,text | `{"content":"ANSWER"}` | **both lost** — field name read from block 0 |
| CC-5 | `[signed as reasoning_details]`,`[unsigned RECOVERED_R]`,text | `{"content":"ANSWER","reasoning_details":[{"type":"reasoning.text","text":"NATIVE_R"}]}` | recovered dropped; details win |
| CC-6 | `[RECOVERED_R with literal "reasoning_text"]` + text | `{"content":"ANSWER","reasoning_text":"RECOVERED_R"}` | field literal is a **native discriminator**, not fabrication |
| CC-9 | `[RECOVERED_R with literal "reasoning_content"]` + text | `{"content":"ANSWER","reasoning_content":"RECOVERED_R"}` | **recovered-only replay works** — no native sibling needed |
| CC-10 | `[NATIVE "reasoning_content"]`,`[details "D"]`,`[RECOVERED_R]`,text | `{"content":"ANSWER","reasoning_details":[…NATIVE_DETAILS…]}` | **details later still override** the field literal |
| CC-11 | `[details "D"]`,`[NATIVE "reasoning_content"]`,`[RECOVERED_R]`,text | `{"content":"ANSWER","reasoning_details":[…NATIVE_DETAILS…]}` | details first also override — **order-independent** |
| CC-7 | `[signed NATIVE_R]` recorded under a **renamed provider**, same model | `{"content":"ANSWER"}` | dropped by Gate 1 |
| CC-8 | `[RECOVERED_R]` + text containing tool prose | `{"content":"<tool_call>…touch /tmp/PWNED…</tool_call>","reasoning_text":"RECOVERED_R"}` | prose stays **text**; no `tool_calls`; nothing executed |

CC-9 plus CC-3 means CC replay of recovered reasoning is achievable **without any fabrication**,
for both recovered-only and native-present messages, using the same literal native blocks carry.
CC-10/CC-11 mean a message that also contains native `reasoning_details` will drop the recovered
text **regardless of ordering** — see H4.

### 3.3 Responses, same model

| # | Input | Result | Verdict |
|---|---|---|---|
| RS-1 | `[signed {"type":"reasoning","id":"rs_1"}]` + text | `[user, {"type":"reasoning","id":"rs_1"}, assistant]` | OK |
| RS-2 | `[unsigned RECOVERED_R]` + text | `[user, assistant]` | omitted |
| RS-3 | `[signed rs_1]`,`[unsigned RECOVERED_R]`,text | `[user, {"type":"reasoning","id":"rs_1"}, assistant]` | recovered omitted even with a signed sibling |

### 3.4 Anthropic, same model

| # | Input | Captured content | Verdict |
|---|---|---|---|
| AN-1 | `[unsigned RECOVERED_R]` + text | `[text(RECOVERED_R), text(ANSWER)]` | downgraded to **answer text** |
| AN-2 | `[signed NATIVE_R "SIG_ABC"]`,`[unsigned RECOVERED_R]`,text | `[thinking(NATIVE_R, SIG_ABC), text(RECOVERED_R), text(ANSWER)]` | native intact; recovered becomes answer text |

### 3.5 Google, same model

| # | Input | Captured parts | Verdict |
|---|---|---|---|
| GG-1 | `[unsigned RECOVERED_R]` + text | `[{"thought":true,"text":"RECOVERED_R"},{"text":"ANSWER"}]` | **supported replay** |
| GG-2 | `[signed NATIVE_R]`,`[unsigned RECOVERED_R]`,text | `[{"thought":true,"text":"NATIVE_R"},{"thought":true,"text":"RECOVERED_R"},…]` | both replayed |
| GG-3 | `[unsigned RECOVERED_R]` recorded under a different model | `[{"text":"ANSWER"}]` | dropped by Gate 1 |
| GG-4 | `[RECOVERED_R with literal "reasoning_text"]` | `[{"thought":true,"text":"RECOVERED_R"}]` — no `thoughtSignature` | non-base64 literal filtered |

---

## 4. Binding constraints for the implementation

**H1 — scope the field literal to the message's own API.**
A field literal is native CC metadata and must be preserved/created only on messages whose
`api === "openai-completions"`. On `openai-responses` it is `JSON.parse`d and **fails the turn**
(TR-2, TR-3). On `anthropic-messages` it is echoed to the API as an opaque signature (AN-4). On
Google it is harmlessly filtered. This is API-aware serialization, which the brief permits, and it
is not a provider allowlist.

**H1b — do not rely on cross-API safety by accident, but do not defend against it either.**
TR-1 proves Gate 1 already prevents a foreign literal from reaching another adapter. No extra
guarding is required, and adding a workaround would violate clause 6.

**H2 — recovered blocks go after native thinking, never first.**
CC-4: an unsigned block at index 0 destroys native replay too, because the field name is read from
block 0. Order: native thinking (original order) → recovered → text → tool calls. This also keeps
AN-2's required `thinking`-before-`text` ordering.

**H3 — Chat Completions replay is achievable; use CC-3 and CC-9 as the acceptance targets.**
Rev 1 called this a blocker. It is not: with the native literal, recovered-only messages replay
(CC-9) and native+recovered replay (CC-3).

**H4 — `reasoning_details` anywhere in the content overrides the field literal.**
CC-10 and CC-11 prove it in both orders. A message that natively carries structured
`reasoning_details` cannot also replay recovered text through the raw field. Do **not** append
recovered text into a provider-issued details entry — document this as an unsupported-replay limit.

**H5 — Anthropic and Responses same-model are not reasoning replay.**
AN-1/AN-2: Anthropic surfaces unsigned recovered text as answer text. RS-2/RS-3: Responses omits
it. Per clause 6 these are the honest outcomes; document them, do not compensate with extra
system/user/answer messages.

---

## 5. Required tests for Worker A (payload assertions, not renderer)

Assert on the captured request body. `node /tmp/ft37r/fixtures.mjs` and
`node /tmp/ft37r/transitions.mjs` are reference implementations of the capture.

1. CC, native signed + recovered appended ⇒ `reasoning_content === "NATIVE_R\nRECOVERED_R"` (CC-3).
2. CC, recovered-only + native literal ⇒ `reasoning_content === "RECOVERED_R"` (CC-9).
3. CC, recovered placed first ⇒ native must still be present (a first-wins implementation fails this).
4. CC, content containing a native `reasoning_details` block ⇒ assert the documented
   drop of recovered text, in **both** orderings (CC-10, CC-11).
5. Responses, recovered-only and signed+recovered ⇒ no throw; reasoning items unchanged; answer intact.
6. Responses, message recorded by `openai-responses` ⇒ assert no non-JSON `thinkingSignature` is
   ever written (TR-2 must be unreachable by construction).
7. Anthropic, signed native ⇒ signature echoed **byte-identical**; recovered ⇒ documented downgrade;
   assert no CC literal is written on an `anthropic-messages` message (AN-4).
8. Google, same-model unsigned ⇒ `{thought:true}` part present (GG-1, GG-2); non-base64 literal filtered (GG-4).
9. Transition ⇒ recovered and native both absent, and the extension added nothing to reinstate them
   (TR-1, AN-5, GG-3).
10. `redacted:true` blocks pass through untouched in every adapter.
11. Idempotence ⇒ parsing a stored message twice yields byte-identical content.
12. No tool execution ⇒ text containing `<tool_call>` yields zero `tool_calls`, with and without a
    native call in the same message (CC-8).

---

## 6. Detection acceptance assertions (provider-agnostic)

1. `<thinking>…</thinking>` in a `text` block ⇒ recovered block; surrounding answer text preserved in order.
2. Fenced and inline-code examples ⇒ untouched.
3. Tag on its own line inside prose that merely discusses the tag ⇒ conservative; require a
   tag-delimited block plus a non-trivial body threshold, and test the threshold.
4. Malformed / unclosed / nested / ambiguous ⇒ no rewrite, or a rewrite that never shrinks visible
   text; assert visible-text length is monotonic.
5. Mixed native + leaked (the 45/45 corpus case) ⇒ native block byte-identical, recovered added;
   never skip a message because native thinking exists.
6. `<analysis>` / `<summary>` ⇒ **not** reasoning (Pi's own replay wrapper uses `<summary>`).
7. Tool-protocol tags (`<tool_call>`, `<invoke>`, `<parameter>`, DSML tokens) ⇒ never converted to
   `toolCall` blocks; text preserved verbatim.
8. `stopReason: "error" | "aborted"` ⇒ unchanged.
9. Idempotence ⇒ second application is a no-op.

---

## 7. Unsupported-replay limits to document (clause 4 / clause 6)

- `openai-responses`, same model: recovered reasoning is omitted (RS-2, RS-3). Supported path is
  native signed reasoning only.
- `reasoning_details`-carrying messages on Chat Completions: recovered text cannot be replayed
  (CC-5, CC-10, CC-11).
- `anthropic-messages`, same model: unsigned recovered reasoning is delivered as assistant answer
  text by Pi's own downgrade (AN-1, AN-2).
- Any provider/API/model change: all thinking is dropped by Gate 1 (TR-1, AN-5, GG-3, CC-7).
- Google: any non-base64 `thinkingSignature` is silently discarded (GG-4).

---

## 8. What I could not verify

- **The implementation.** No extension code was present in the worktree at review time; §5/§7 are
  the acceptance contract, not a verdict on A's code. I will re-run once A reports a commit.
- **One-lane live proof** (persisted normalized message + next request payload). Needs A's extension.
- **Google through the HTTP layer** — the adapter refuses fetch injection; GG-* assert the converter
  the stream path calls (`google-shared.js:156`).
- **Real provider acceptance** of a replayed field literal. All results are local serialization.
- **Bedrock and Mistral.** Both call Gate 1; neither was exercised.

---

## 9. Correction to Rev 1 (method error and retraction)

Rev 1's RS-4/RS-5 fixtures set `api: "openai-responses"` on a message while placing a
Chat-Completions field literal in it, and Rev 1 then concluded that a CC field literal
"poisons the session permanently for any later Responses replay". **That conclusion is withdrawn.**

Why it was wrong: a message recorded by Chat Completions carries `api: "openai-completions"`. When
the outgoing model is a Responses model, `isSameModel` is false and Gate 1 removes the block before
the Responses adapter runs. TR-1 captures exactly that: no throw, no reasoning item, answer intact.
The mixed-origin message Rev 1 constructed cannot arise from a real session transition.

What survives, correctly scoped: TR-2/TR-3 show the crash is real for a message **whose own
recorded api is a JSON-signature adapter**. That is a same-API hazard, avoided by H1 (never write a
CC literal on a Responses message).

The methodological rule this produced, now applied throughout: **fixtures must keep the identity
that produced the message and vary only the outgoing model.** Rev 2's transition fixtures do that,
and every row in §3.1 states both sides of the transition explicitly.

---

## 10. Provenance

- `@earendil-works/pi-ai@1.5.0` under
  `~/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`.
- Source: `api/transform-messages.js:90-96`; `api/openai-completions.js:988-999`;
  `api/openai-responses-shared.js:118,235-239`; `api/anthropic-messages.js:1128-1155`;
  `api/google-shared.js:119-121,203-230`; `docs/extensions.md:864-875`.
- Fixtures: `FT-37-47-REPLAY-FIXTURES.json`, `FT-37-47-REPLAY-TRANSITIONS.json` (this directory);
  generators `/tmp/ft37r/{harness,fixtures,transitions}.mjs`.
- No file under `~/.pi/agent/`, the Pi install, or any implementation tree was modified.

---

## 11. Implementation review — `ft-37/reasoning-recovery` worktree

Reviewed at `8b24b407b` + uncommitted working tree:
`src/pi-extensions/pi-fleet-hooks/{src/reasoning-tags.ts,src/reasoning-recovery.ts,src/reasoning-replay.ts,test/}`.

Test runs (`node --test`, no network):

| suite | tests | pass | fail |
|---|---:|---:|---:|
| `test/reasoning-tags.test.ts` | 32 | 32 | 0 |
| `test/reasoning-replay.test.ts` | 31 | 31 | 0 |
| `test/chat-completions-payload.test.ts` | 10 | 7 | **3** |

Note the runner: the package uses `node --test`; `npx vitest` reports "No test suite found" for these
files, so a vitest invocation is not evidence either way.

### 11.1 The design matches the measured contract

Read against §3, the implementation gets the hard parts right and its own comments name the
hazards:

- `RECOVERED_FIELD = "reasoning_content"` is documented as a **field-name discriminator, not a
  signature** — correct, and consistent with native CC blocks that store exactly these literals
  (CC-6, CC-9).
- `planReplay` scans the **whole** content for an opaque JSON signature
  (`isOpaqueJsonSignature`) and refuses to append in that case. That is the correct handling of
  CC-5/CC-10/CC-11, independently derived.
- It also detects legacy `thoughtSignature` on tool calls, which feeds pi's
  `parseLegacyEncryptedReasoningDetail` → `reasoning_details` path. I had not covered that; it is a
  genuine additional case.
- `existing.length > 0 && firstSignature === undefined` → `preserve`, correctly matching CC-4's
  block-0 rule.
- Setting the field literal on the recovered block means the recovered block is never an
  unsigned block-0, so **CC-4 is avoided by construction**.
- `normalizeAssistantMessage` skips `error`/`aborted`, preserves `textSignature` blocks, never
  creates a `toolCall`, and is idempotent by construction (output contains no tags).

### 11.2 The three failing payload tests are two test bugs and one real nit

**`chat-completions-payload.test.ts:315` "across a model switch…" — test bug.**
`captureRequestBody` stamps `api`, `provider: target.provider`, `model: target.id` onto the message
it builds (`test/chat-completions-payload.test.ts:118-121`). The message identity therefore *always*
equals the target, so no switch occurs and the block is legitimately replayed. The test asserts the
opposite. Fix: give the message its **origin** identity and vary only the target — that is exactly
what `FT-37-47-REPLAY-TRANSITIONS.json` TR-1/AN-5/GG-3 do, and TR-1 shows the real transition
behaves as asserted (reasoning absent, answer intact).

**`…:257` "a reasoning_details signature makes pi omit thinking text" — test bug.**
The fixture supplies a details-backed thinking block and **no text block**. Pi drops an assistant
message that has neither text nor tool calls:

```
thinking-only (field literal), no text, no tool  -> MESSAGE DROPPED
thinking-only (unsigned),      no text, no tool  -> MESSAGE DROPPED
thinking + empty text block                      -> MESSAGE DROPPED
thinking + toolCall,           no text           -> {"content":null,"reasoning_content":"…","tool_calls":[…]}
```

So `messages.find(role==='assistant')` is `undefined` and `Array.isArray(undefined) === false`. The
hazard the test intends is real and already proven by CC-5/CC-10/CC-11; the test just needs answer
text in the fixture.

**`…:189` "wrong field name" — real, minor: promoted text keeps the separator newline.**
Actual `content` is `"\nvisible answer"` vs expected `"visible answer"`. Content is not lost, but
the visible answer changes byte-for-byte, which matters for prompt caching and for any
"byte-identical" claim. Recommend trimming the single newline that followed the closing tag, and
asserting the trimmed form; do not blanket-`trim()` the segment, which would eat intentional
leading whitespace.

### 11.3 One defensive gap I found independently (R1): redacted blocks vs pi's block-0 selector

`replayableThinking()` excludes blocks with `redacted === true`
(`src/reasoning-replay.ts`), so `planReplay` treats a message whose only prior block is redacted as
having no existing reasoning and returns `field-signature`. But pi's field-name selection uses
`nonEmptyThinkingBlocks` = *all* thinking blocks with non-empty `thinking`, which **includes**
redacted blocks — the Anthropic adapter sets `thinking: "[Reasoning redacted]"` with
`redacted: true` (`anthropic-messages.js:530`). So for a CC message whose first non-empty block is
redacted, `planReplay` says the recovered block will set the field while pi reads block 0, finds no
recognised field name, and writes **no** reasoning field: the recovered text is silently dropped.

Reproduced (`/tmp/ft37r/redacted.mjs`):

```
[redacted("[Reasoning redacted]", sig=base64), recovered(sig="reasoning_content"), text]  -> {"content":"ANSWER"}
recovered carried? false
[redacted(no sig), recovered(sig="reasoning_content"), text]                              -> {"content":"ANSWER"}
```

Reachability is low — it needs a redacted block on an `openai-completions` message — so I record it
as a correctness gap, not a live defect. The minimal fix is to count redacted-but-non-empty blocks
in `replayableThinking` so the `firstSignature === undefined` branch correctly returns `preserve`.

### 11.4 Where I agree with the implementation against my own Rev 1

- Google left as `preserve`: my GG-1/GG-2 prove the converter carries unsigned thinking as
  `{thought:true}` **same provider+model**, so this path is available and could be enabled. The
  implementation's caution is defensible (converter proof ≠ HTTP acceptance), but the evidence is
  now stronger than "very likely" and the leader may want it enabled with a narrow rollout.
- Responses left as `preserve`: correct, and TR-1 confirms cross-API is already safe.
- Anthropic as `unsigned`: AN-1/AN-2 show this downgrades to assistant text — identical to what a
  preserved text block would send, minus the tag noise. Net-neutral on the wire, better locally.

---

## 12. Re-review of commit `13f387508` (supersedes §11)

**§11 above is superseded and must not be read as a verdict on this commit.** It described an
unfinished working tree (3 failing payload tests, pre-R1 redacted handling). At `13f387508` those
specific items are resolved or re-characterised below.

### 12.1 Verification performed

Isolated copy of the committed tree, so the dirty working directory could not influence the result:

```bash
rm -rf /tmp/ft37rev && mkdir -p /tmp/ft37rev
cd ~/Code/yellowstone-wt/ft37-reasoning
git archive 13f387508 src/pi-extensions/pi-fleet-hooks | tar -x -C /tmp/ft37rev
cd /tmp/ft37rev/src/pi-extensions/pi-fleet-hooks && npm test
```

| check | result |
|---|---|
| `npm test` (`node --test test/*.test.ts`) at `13f387508` | **83 pass / 0 fail / 0 skip** — independently reproduced |
| `npx tsc --noEmit --strict …` on the two reasoning modules | green (leader's result; `tsc` is not vendored in the subrepo, so this was not re-run in my copy) |
| working tree at review time | dirty: `M src/reasoning-replay.ts`, `M README.md`, `?? test/session-integration.test.ts` — reviewed separately, not part of this verdict |

Proof artifacts (this directory, re-runnable): `FT-37-47-REPLAY-PROBE-code-context.mjs`
(12 code/container cases) and `FT-37-47-REPLAY-PROBE-tag-only.mjs` (tag-only loss, drives the real
committed `normalizeAssistantMessage` plus the installed adapter). Both run with plain `node`, no
network:

```bash
cd <isolated archive copy>/src/pi-extensions/pi-fleet-hooks
node probe-code-context.mjs   # expect destructive=0 after B1 is fixed
node tag-only.mjs             # expect no 'MESSAGE DROPPED' after B2 is fixed
```

### 12.2 Status of my earlier findings

| §11 item | status at `13f387508` |
|---|---|
| "model switch" payload test failing (`:315`) | **resolved** — suite is green; the test now constructs the transition correctly |
| "reasoning_details" payload test failing (`:257`) | **resolved** |
| leading-newline nit (`:189`) | **not fixed, now codified** — `test/chat-completions-payload.test.ts:308` asserts `"\nvisible answer"`. Content is preserved; the visible answer still changes by one leading newline on the wire. Non-blocking; record it as accepted-by-test, not fixed |
| **R1** redacted block excluded from `replayableThinking` | **fixed** — `replayableThinking` now selects on non-empty `thinking` only, matching Pi's `nonEmptyThinkingBlocks` selector exactly. R1 is closed |
| Google left as `preserve` | changed at this commit to the unsigned strategy, with the comment citing the converter evidence. Consistent with my GG-1/GG-2 |

Verdict on the replay contract: **PASS** for the shapes covered by the suite, including
native+recovered joining, `reasoning_details` refusal, cross-identity drop, Anthropic downgrade and
`textSignature` preservation. Two blocking findings follow, both newly confirmed on this commit.

---

## 13. Blocking findings on `13f387508`

### B1 — Parser promotes code/container contexts and destroys visible text (blocker)

`codeMask` is line-local and CommonMark-incomplete in two specific ways, and `startsBlock`
accepts unlimited indentation and blockquote markers:

- `codeMask` fence open: `/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/` — anchored at line start, so a
  **blockquote-prefixed fence** never opens, and **indented code** is not modelled at all.
- inline-code spans: `body.indexOf(run, …)` searches **within one line**, so a span crossing a
  newline is invisible to the mask.
- `startsBlock`: `/^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]?)*[ \t]*$/` — `[ \t]*` is
  unbounded, and `> ` is an accepted prefix.

Reproduced against the committed tree (`/tmp/ft37rev/…/probe-code-context.mjs`, 12 cases,
**10 destructive**):

```
DESTRUCTIVE 1 four-space indented code        reasoning="literal indented code example"  visible="    "
DESTRUCTIVE 2 multiline inline-code span      reasoning="example"     visible="see `multiline code\n\n` end"
DESTRUCTIVE 3 blockquote fenced code          reasoning="quoted fenced example"        visible="> ```xml\n> \n> ```"
DESTRUCTIVE 4 tab-indented code               reasoning="tab indented example"         visible="\t"
DESTRUCTIVE 5 plain (non-fenced) blockquote   reasoning="quoted prose example"         visible="> "
DESTRUCTIVE 6 list item + 6-space indent      reasoning="indented under list"          visible="- item\n      "
DESTRUCTIVE 7 4-space-indented fence          reasoning="indented fence"               visible="    ```\n    \n    ```"
ok          8 top-level fenced block         preserved, tags intact
ok          9 same-line inline code          preserved, tags intact
ok         11 blockquote fence w/ info       (DESTRUCTIVE — promoted)
ok         12 double-nested blockquote fence (DESTRUCTIVE — promoted)
```

Note `test/reasoning-tags.test.ts:146` ("block-initial recognises list markers and blockquotes")
**asserts the blockquote prefix is a valid block start**, so case 5 is currently intended
behaviour rather than an oversight. The leader's three probes are cases 1, 2 and 3; cases 4–7 and
11–12 are additional instances of the same root cause.

Conservative refusal is sufficient and is what I recommend: treat any tag inside a line whose
prefix is not plain paragraph whitespace (indented ≥4 columns, blockquote, list continuation at
code indent) as literal, and close the multi-line inline-span hole. That fixes all of the above
without a Markdown parser.

### B2 — Tag-only reclassification deletes the whole assistant message (blocker, CC only)

Pi's Chat Completions converter drops an assistant message with no visible content and no
`tool_calls`, regardless of `reasoning_content` (`openai-completions.js:1042-1055`):

```js
const hasContent = content !== null && content !== undefined &&
    (typeof content === "string" ? content.length > 0 : content.length > 0);
if (!hasContent && !assistantMsg.tool_calls) continue;
```

Proved end-to-end with the committed `normalizeAssistantMessage` and the real adapter:

| case | before the fix | after the fix |
|---|---|---|
| A. `text = "<thinking>RECOVERED</thinking>"` (tag-only) | `{"content":"<thinking>RECOVERED</thinking>"}` — message present | **`assistantMsgs=0` — MESSAGE DROPPED** |
| B. native thinking `NATIVE` + tag-only visible text | `{"content":"<thinking>RECOVERED</thinking>","reasoning_content":"NATIVE"}` | **`assistantMsgs=0` — MESSAGE DROPPED, native reasoning lost too** |
| C. tag-only + native `toolCall` | present | present, `{"content":null,"reasoning_content":"RECOVERED","tool_calls":[…]}` — **ok** |
| D. tag + visible answer | present | present, `{"content":"\nThe answer.","reasoning_content":"RECOVERED"}` — **ok** |

Anthropic is unaffected (tag-only becomes `[{"type":"text","text":"RECOVERED"}]`, message kept),
so this is CC-specific.

This is a **new accidental loss path introduced by the fix**, distinct from the intentional
model-switch drop: before reclassification the text was visible content and the turn survived; after
reclassification the turn disappears, and in case B it takes native reasoning with it.

Required guard: if reclassifying a message would leave **no** non-empty text block and **no**
`toolCall`, keep the tagged source as text (conservative refusal) rather than promoting. That
changes nothing for cases C and D, and does not fake visible text to satisfy the adapter.

### 13.1 Tests to add with the fixes

- `reasoning-tags`: the leader's three cases plus tab-indent, list-continuation indent, blockquote
  fence with info string, and nested blockquote fence — asserting the tag stays in visible text
  **and** that visible text is unchanged byte-for-byte.
- `chat-completions-payload`: tag-only and mixed native+tag-only ⇒ assert the assistant message is
  still present and no native reasoning is lost; tag-only+toolCall and tag+answer ⇒ assert
  `reasoning_content` carries the recovered text.
- A monotonicity assertion for the parser: for every accepted case, visible text must not shrink
  except by the promoted reasoning body itself.

Neither blocker requires touching the replay strategy, the field literal, the identity policy, or
any provider/model gate — the replay contract itself passed.

---

## 14. FINAL VERDICT — commit `b196ca3df`

**Supersedes §11, §12 and §13.** Those describe earlier commits and unfinished trees; every finding
raised in them is either fixed here or explicitly closed below.

Commit chain: `13f387508` → `88ad27ba7` (container-code fixes, content-less-turn gate, real SDK
proof) → **`b196ca3df`** ("never promote reasoning tags inside a quoted container"). Tree clean,
working directory empty of modifications at review time.

### 14.1 Gates, all re-run against this SHA

| gate | command | result |
|---|---|---|
| focused suite | `npm test` (`node --test test/*.test.ts`) in `src/pi-extensions/pi-fleet-hooks` | **113 tests, 113 pass, 0 fail, 0 skip** |
| typecheck | `tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions src/reasoning-tags.ts src/reasoning-replay.ts` | **exit 0** |
| B1 parser | `node FT-37-47-REPLAY-PROBE-code-context.mjs` | **PASS — 12/12, `wrong=0`** (11 literal contexts preserved + protocol control promoted) |
| B2 tag-only | `node FT-37-47-REPLAY-PROBE-tag-only.mjs` | **PASS — 8/8 `=> ok`, 0 `MESSAGE DROPPED`** |
| SDK session proof | `node --test test/session-integration.test.ts` | **PASS — 3/3, 0 skipped** |

### 14.2 B1 — PASS (was blocker at §13)

All eleven literal/code contexts now stay in visible text **byte-for-byte**, and the genuine
top-level protocol control is still promoted:

```
ok [literal]  1 four-space indented code               ok [literal]  7 4-space-indented fence
ok [literal]  2 multiline inline-code span             ok [literal]  8 proper top-level fence
ok [literal]  3 blockquote fenced code                 ok [literal]  9 same-line inline code
ok [literal]  4 tab-indented code                      ok [literal] 11 blockquote fence w/ info string
ok [literal]  5 plain (non-fenced) blockquote          ok [literal] 12 double-nested blockquote fence
ok [literal]  6 list item + 6-space indent             ok [protocol] 10 plain paragraph tag → PROMOTED
cases=12 wrong=0
```

The plain-blockquote residual I reported at `88ad27ba7` is **fixed by `b196ca3df`** (cases 5, 11,
12). Probe labels were corrected so a promoted top-level protocol block counts as the expected
outcome, not as destructive: `wrong` now means "literal context promoted" or "protocol not
promoted", and both are zero.

### 14.3 B2 — PASS (was blocker at §13)

`tag-only` and `mixed native + tag-only` no longer delete the assistant message; both are preserved
verbatim as visible text, while the two shapes that can carry reasoning still reclassify:

| case | outcome at `b196ca3df` |
|---|---|
| A. `text = "<thinking>RECOVERED</thinking>"` (tag-only) | preserved: `{"content":"<thinking>RECOVERED</thinking>"}` — message present |
| B. native `NATIVE` + tag-only visible text | preserved: `{"content":"<thinking>…</thinking>","reasoning_content":"NATIVE"}` — nothing lost |
| C. tag-only + native `toolCall` | reclassified: `{"content":null,"reasoning_content":"RECOVERED","tool_calls":[…]}` |
| D. tag + visible answer | reclassified: `{"content":"\nThe answer.","reasoning_content":"RECOVERED"}` |

Same eight-case check passed on both `openai-completions` and `anthropic-messages` (8/8 `=> ok`,
zero `MESSAGE DROPPED`).

### 14.4 SDK session proof — PASS, and it is a real proof

`test/session-integration.test.ts` (382 lines) is not a seam test. Verified by reading it:

- **Extension loaded from disk by path** — `DefaultResourceLoader({ additionalExtensionPaths: [EXTENSION_PATH] })`
  with `EXTENSION_PATH = ../src/reasoning-recovery.ts`, `noExtensions: false`, so Pi's own loader
  loads the shipped file, not an inlined copy.
- **Real `createAgentSession`** with a real `ModelRuntime.create({agentDir})` and a registered
  native provider whose `stream`/`streamSimple` delegate to the **installed** `openai-completions`
  adapter with an injected `fetch` — so `transformMessages`, `convertMessages` and body building
  all run.
- **Real `session.bindExtensions({})`**, so `message_end` is registered by Pi's runtime.
- **File-backed `SessionManager.create(cwd, sessions)`**, and assertions read the JSONL Pi actually
  wrote.
- **Persisted normalised entry asserted**: block kinds `["thinking","thinking","text"]`, native
  `thinking==="NATIVE CHANNEL"` with signature `reasoning_content`, recovered
  `thinking==="RECOVERED FROM TEXT"` with signature `reasoning_content`, visible
  `text==="\nThe answer is four."`, and `<thinking>` absent from the record.
- **Next request asserted**: `assistantOut.reasoning_content` matches both `NATIVE CHANNEL` and
  `RECOVERED FROM TEXT`; `content` unmangled; no `<thinking>` anywhere in the body.
- **Negative control present and passing**: same pipeline with `additionalExtensionPaths: []`
  persists `["thinking","text"]` with the raw markup still in the text block, and the next request
  carries `<thinking>` as prose. That attributes the positive result to the extension rather than to
  the harness or to Pi normalising on its own.

No network: `baseUrl` is unroutable, `fetch` is injected and returns fixed SSE frames, `agentDir` is
a throwaway temp dir. Sibling suite `persist-replay.test.ts` adds the file-backed persistence
assertions.

### 14.5 Rollout recommendation

**GO for integration and the one-lane live proof.**

- No blocking findings remain on `b196ca3df` within my scope: B1 PASS, B2 PASS, SDK proof PASS.
- The replay contract itself has been PASS since §12/§13 (native+recovered joining, whole-content
  `reasoning_details` refusal, `identity`-based drop left intact, Anthropic downgrade, Google
  unsigned, `textSignature` preservation, no `toolCall` synthesis, idempotence).
- Constraints that must survive integration, restated from §13: field literal only on
  `openai-completions` messages; recovered blocks appended after native thinking; no fabricated
  opaque signatures; no new cross-model policy.
- Still outstanding before this closes, and none of it mine: the one-lane live proof (load,
  persisted entry, next request payload) and the leader's SDK discovery-env naming accuracy
  (`PI_CODING_AGENT_DIR` is Pi's runtime/config agent dir, not a package root — a test-discovery
  concern only; normal isolated `agentDir` must stay the mechanism).

### 14.6 Known non-blocking residuals

1. Leading-newline on the promoted answer text (`"\nThe answer is four."`) — content preserved, one
   byte of visible text changes; now asserted as expected by the suite. Cosmetic/caching note only.
2. Plain-blockquote promotion is fixed; any *future* container construct (e.g. nested HTML `<pre>`,
   setext headings carrying tags) is unmodelled. The current refusal behaviour is conservative, and
   the probe file is the place to add a case before rollout of any parser change.

### 14.7 Artifacts

- This review: `FT-37-47-REPLAY-REVIEW.md` (this file).
- Probes (re-runnable, no network, no deps):
  `FT-37-47-REPLAY-PROBE-code-context.mjs` (B1, 12 cases with `literal`/`protocol` expectations),
  `FT-37-47-REPLAY-PROBE-tag-only.mjs` (B2, 8 cases across CC and Anthropic).
- Captured payload fixtures: `FT-37-47-REPLAY-FIXTURES.json`,
  `FT-37-47-REPLAY-TRANSITIONS.json`.
- No file in the implementation tree was modified by me at any point; all probe runs used the
  worktree source read-only or a `git archive` copy.

### 14.8 Acceptance state and the one pending delta

**Core implementation accepted at `b196ca3df`** (all gates in §14.1 re-run against that exact SHA).

A test-only delta was in the working tree at final review, uncommitted:

```
M src/pi-extensions/pi-fleet-hooks/test/session-integration.test.ts   (HEAD still b196ca3df)
```

It is the SDK discovery-env naming correction the leader asked for, and I pre-verified it read-only:

- `PI_SDK_ROOT` is now the install-location override; `PI_CODING_AGENT_DIR` is no longer
  repurposed. The comment records why: `getAgentDir()` in `dist/config.js` reads
  `PI_CODING_AGENT_DIR` for `models.json` / `auth.json` / themes, so pointing it at the package
  would point config discovery at the install.
- An explicit `PI_SDK_ROOT` that does not resolve now **throws** instead of silently falling back,
  which is the truthful gate assertion the earlier report described but the old function did not
  implement.
- Session isolation is unchanged: `agentDir = path.join(dir, "agent")`, a throwaway temp dir, passed
  explicitly to `ModelRuntime.create` and `createAgentSession`.

Working-tree preview (not a commit verdict):

| run | result |
|---|---|
| `npm test` on the dirty tree | 113 pass / 0 fail / 0 skip |
| `PI_SDK_ROOT=/nonexistent node --test test/session-integration.test.ts` | fails loudly — `Error: PI_SDK_ROOT is set to "/nonexistent" but no dist/index.js was found there` |
| default discovery, `session-integration` | 3/3 pass |
| explicit valid `PI_SDK_ROOT`, `session-integration` | 3/3 pass |

**Status: awaiting the commit carrying this delta.** The exact final SHA cannot be named until it
exists; acceptance of that SHA is a re-run of §14.1 (suite + typecheck + B1 + B2) plus a diff check
that the delta touches only this test file. Nothing exploratory remains.

### 14.9 Integration evidence the leader still requires (not mine to produce)

1. Loader check in **one real affected lane** before fleet rollout (extension loads, `message_end`
   registers, no session breakage).
2. Exact-pin tests/gates at the accepted SHA.
3. Safe no-abort reload with remote receipts.
4. The paid-call gate is already satisfied by the real `createAgentSession` proof; no paid model
   call is required for acceptance.

#### Mechanical acceptance block (run once A's commit exists)

```bash
# 0. confirm the SHA and that the delta is test-only
cd ~/Code/yellowstone-wt/ft37-reasoning
git log --oneline -1
git show --stat <SHA> -- src/pi-extensions/pi-fleet-hooks   # expect only test/session-integration.test.ts

# 1. suite + typecheck at the exact SHA (clean tree)
cd src/pi-extensions/pi-fleet-hooks
npm test                                                   # expect 113 pass / 0 fail / 0 skip
/home/bitnom/.local/share/pnpm/tsc --noEmit --strict --target es2022 \
  --module nodenext --moduleResolution nodenext --allowImportingTsExtensions \
  src/reasoning-tags.ts src/reasoning-replay.ts            # expect exit 0

# 2. behaviour probes unchanged (they import the worktree source directly)
node ~/Documents/Fleet/pi-fleet-model/FT-37-47-REPLAY-PROBE-code-context.mjs   # wrong=0
node ~/Documents/Fleet/pi-fleet-model/FT-37-47-REPLAY-PROBE-tag-only.mjs       # 8/8 ok, 0 DROPPED

# 3. discovery-env semantics
PI_SDK_ROOT=/nonexistent node --test test/session-integration.test.ts          # must FAIL loudly
node --test test/session-integration.test.ts                                   # 3/3 pass (default)
PI_SDK_ROOT=<installed pi-coding-agent> node --test test/session-integration.test.ts  # 3/3 pass
```

Acceptance = steps 1–3 as stated, plus the step-0 diff check. Any deviation is a blocker, not a
rounding error.

---

## 15. FINAL ACCEPTANCE RECEIPT — commit `488c881fd`

**Result: PASS on every step of the mechanical acceptance block. `488c881fd` is the accepted final
SHA for the FT-37 reasoning-recovery implementation, and this is the integration release.**

Reviewed commit: `488c881fd` ("name the SDK install override PI_SDK_ROOT, isolate config
discovery"), parent `b196ca3df`. Working tree clean at review time. Reviewer: independent replay
review (Worker B).

### Step 0 — SHA and diff scope: PASS

```
488c881fd pi-fleet-hooks: name the SDK install override PI_SDK_ROOT, isolate config discovery
b196ca3df pi-fleet-hooks: never promote reasoning tags inside a quoted container

git show --stat 488c881fd -- src/pi-extensions/pi-fleet-hooks
  .../test/session-integration.test.ts | 49 ++++++++++++++----
  1 file changed, 42 insertions(+), 7 deletions(-)
git status --porcelain  → empty (clean)
```

Delta from `b196ca3df` is **test-only**, exactly as bounded: one file,
`test/session-integration.test.ts`. No production module touched after `b196ca3df`, so the accepted
core implementation reviewed in §14 is unchanged.

### Step 1 — suite and typecheck: PASS

```
npm test  →  # tests 113   # pass 113   # fail 0   # cancelled 0   # skipped 0   # todo 0
tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext \
    --allowImportingTsExtensions src/reasoning-tags.ts src/reasoning-replay.ts   →  exit 0
```

### Step 2 — behaviour probes: PASS

```
FT-37-47-REPLAY-PROBE-code-context.mjs  →  cases=12 wrong=0
   (11 literal contexts preserved: 4-space indent, multi-line inline span, blockquote fence,
    tab indent, plain blockquote, list+6-space indent, 4-space-indented fence, top-level fence,
    same-line inline code, blockquote fence w/ info string, double-nested blockquote fence;
    protocol positive control promoted as expected)
FT-37-47-REPLAY-PROBE-tag-only.mjs      →  8/8 "=> ok",  0 MESSAGE DROPPED / LOST / NOT CARRIED
```

Both blockers raised in §13 remain closed at this SHA.

### Step 3 — discovery-env and isolation semantics: PASS

| run | expected | observed |
|---|---|---|
| `PI_SDK_ROOT=/nonexistent` | fail loudly | `Error: PI_SDK_ROOT is set to "/nonexistent" but no dist/index.js was found there`; 1 test, 0 pass, 1 fail |
| `PI_AI_DIST=/nonexistent` | fail loudly | 1 test, 0 pass, 1 fail |
| default discovery | pass | 3 tests, 3 pass, 0 fail, 0 skipped |
| explicit valid `PI_SDK_ROOT` | pass | 3 tests, 3 pass, 0 fail, 0 skipped |

`PI_CODING_AGENT_DIR` is no longer repurposed as an install-location override, and sessions still
pass an explicit throwaway `agentDir`, so config discovery is never pointed at the package directory.

### Accepted scope

- Provider/model-independent content detection: unchanged and green (parser suite + B1 probe).
- Faithful supported same-model replay: unchanged and green (payload + persist suites, B2 probe,
  real SDK session proof with negative control).
- Native signatures, signed text and native tool calls preserved; no synthetic `toolCall`; no
  fabricated opaque or JSON replay items; no new cross-model/provider policy (`transformMessages`
  drop behaviour intact).
- Actual SDK session proof satisfies the one-isolated-session gate; no paid model call was made.

### Not covered by this receipt (stays with `yellowstone-worker`)

1. One real-lane loader check on an affected lane before fleet rollout.
2. Exact-pin checks at `488c881fd` and publication receipts.
3. Safe no-abort consumer reload, working lanes queued, self deferred.
4. FT-47 remains open; next issue waits on the overlord's explicit post-FT-37 compaction
   confirmation.

No file in the implementation tree was modified by this reviewer at any point.
