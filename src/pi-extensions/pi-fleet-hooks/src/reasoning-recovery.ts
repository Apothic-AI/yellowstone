// reasoning-recovery — store model-emitted reasoning markup as reasoning, durably.
//
// The defect (FT-37): some models emit their reasoning delimiters as literal prose inside the
// visible content field instead of a structured reasoning channel. pi's stream parsers build a
// ThinkingContent block only from a real reasoning field, so that text stays a TextContent
// block, renders as prose, and — this is the part that matters — is replayed to the model on
// the next turn as ordinary assistant text. The model then sees its own reasoning wrapped in
// markup and keeps doing it.
//
// This hook rewrites the finished message so the recovered reasoning is stored distinctly and,
// where the target adapter can actually carry it, replayed through the reasoning channel. It
// runs at `message_end`, which pi applies through `_replaceMessageInPlace`: agent state,
// session persistence and the retry decision all see the rewritten message, so this is a
// durable change to the record rather than a rendering trick.
//
// What this hook deliberately does not do:
//
//   - It does not fabricate signatures. On an adapter that validates a provider-issued
//     signature, recovered reasoning is left as text. The one value written on Chat Completions
//     (`reasoning_content`) is a field-name discriminator — the same literal pi itself stores
//     for native reasoning on that API — not an opaque provider signature, and it is never set
//     on an adapter that treats it as authenticity. See `reasoning-replay.ts`.
//   - It does not create tool calls. FT-47's `<tool_call>` / `<tool_answer>` / `<invoke>` prose
//     is left exactly as it is. `message_end` runs *before* pi dispatches tools
//     (`agent-loop.js` emits `message_end`, then filters `content` for `toolCall` blocks), so
//     synthesising one from prose would execute it. In the observed corpus that prose
//     duplicates a native call the model already emitted, so synthesising would run the same
//     tool twice. Treating those tags as untouched is not the same as fixing FT-47; FT-47's
//     rendering is a separate cosmetic concern and this extension does not claim it.
//   - It does not override pi's cross-model portability rule. `transformMessages` drops
//     thinking blocks when provider, api or model differ, for native and recovered reasoning
//     alike. Nothing here reverse-routes recovered text into answer, user or system content to
//     get around that.
//   - It does not touch the live stream. `message_update` cannot replace a message and
//     `registerMarkdownTransformer` returns Markdown only, so a display transform cannot
//     reclassify a block. Worse, a display strip would disagree with the durable outcome on
//     the adapters where the rewrite is deliberately deferred, and it would hide the very
//     markers an operator needs when diagnosing that fallback. So the markers stay visible
//     while a turn streams and are reclassified when it finalises. That flicker is a stated
//     limitation, not a hidden behaviour.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { normalizeAssistantMessage, type AssistantLike } from "./reasoning-replay.ts";

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event) => {
    const replacement = normalizeAssistantMessage(event.message as unknown as AssistantLike);
    if (!replacement) return undefined;
    // pi requires the replacement to keep the original role; content is unconstrained.
    return { message: replacement as unknown as typeof event.message };
  });
}

/** Re-exported for tests and for callers that want the pure seams. */
export { normalizeAssistantMessage, normalizeContent, planReplay } from "./reasoning-replay.ts";
export { findReasoningBlocks, hasReasoningTags, splitReasoning } from "./reasoning-tags.ts";
