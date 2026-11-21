# FT-92 — leaked harmony tool calls

A checkpoint can report a tool call twice: once as the structured call pi executes, and once as
plain assistant text in the openai-harmony recipient syntax. pi keeps both — `delta.content`
becomes a `text` block, `delta.tool_calls` becomes a `toolCall` block, and nothing reconciles them.

```
{"path":"/tmp/x","offset":55,"limit":90} to=functions.read
 to=functions.rooms_reply_all(team)
{"command":"grep -n -m 1 '...'"}   to=functions.bash
```

Measured on `gpt-6.2-sol` (provider `subrouter-gpt`, `usaeast.up.railway.app/v1`,
`api: openai-completions`): 9 of 95 assistant messages in that band carried a leaked block, 106 KB
of duplicated calls in total, one block 99 KB on its own; 0 of 4,610 assistant messages on every
other checkpoint in the same session. Recorded in `Fleet TODOs.md` FT-92 with the line numbers.

## What this package does

`src/harmony-duplicate-calls.ts` classifies and removes the leaked `text` block;
`src/harmony-duplicates.ts` registers the two hooks.

- `message_end` strips the block from the message just finalized, so it never enters the record or
  the next request. `message_end` replacements are applied before persistence and before tool
  dispatch; the strip only ever drops `text` blocks, so every native `toolCall` survives.
- `context_with_system` strips the same blocks from the outgoing transcript, which is the only way
  the leaks already stored stop costing context. The rewrite is deterministic and idempotent, so
  the outgoing prefix is stable rather than changing per turn.

No synthesis: the text never executed, so a parsed call without a native counterpart is stale
text, not a call to resurrect. (On DeepSeek the text is the only carrier and `pi-dsml` appends for
that reason; here the native call is the carrier.)

## Detection

Structural, and not gated on a model id — the marker is the discriminator, and it never occurs in
legitimate content on this machine (a whole-home search found it only in harmony parsers and
documents quoting them).

A `text` block is a leak when **all** hold:

1. it begins with `{` or `to=functions.` (`isCallShaped`) — a sentence begins with a sentence;
2. it contains a recipient marker `to=functions.<name>`;
3. after removing every JSON payload (string-aware brace scan) and every marker, at most
   `MAX_RESIDUE` (80) non-space characters remain.

Rule 3 is what keeps prose safe: a message that *discusses* the defect leaves its sentences behind
and is never touched. The rule tolerates the recorded variants — payload before or after the
marker, unbalanced braces (`to=functions.find(pattern:"*")}`), a repeated payload, stray wide
punctuation, and a marker with no payload at all.

Classification, for the counters: `duplicate` (restates a native call in the same message),
`stale` (parses as a call with no native counterpart), `fragment` (marker with no payload).

## Switches

| variable | effect |
|---|---|
| `PI_HARMONY_STRIP=off` | register nothing |
| `PI_HARMONY_HISTORY=off` | keep `message_end` stripping, do not rewrite the outgoing transcript |
| `PI_HARMONY_DEBUG=1` | one `[harmony] removed=… chars=… duplicate=… stale=… fragment=… tools=…` line per strip on stderr |

`harmonyStripCounters` in `src/harmony-duplicates.ts` carries the same numbers in-process. A
stripper whose removals are not counted is indistinguishable from one that never fired.

## Tests

`test/harmony-duplicate-calls.test.ts` — nine fixtures (the recorded messages, plus a synthetic
24 KB payload modelled on the 99 KB one), the prose negatives, input-immutability, both hooks'
wiring, the "clean message returns no replacement" path, and both switches.

```
npm test          # node --test test/*.test.ts
npm run typecheck
```