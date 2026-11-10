// reasoning-replay — decide whether recovered reasoning can be carried by the target adapter,
// and express it in the shape that adapter actually serialises.
//
// `reasoning-tags.ts` answers "what in this text is reasoning?". This module answers the
// harder, separate question: "if I store it as a ThinkingContent block, will it survive the
// next request?" A ThinkingContent block is not the same thing as an outbound reasoning
// payload, and conflating the two is how recovered text silently disappears.
//
// Verified against the installed `@earendil-works/pi-ai` serialisers: the payload assertions in
// `test/chat-completions-payload.test.ts` and `test/persist-replay.test.ts` capture real request
// bodies through each adapter, and the support table in `README.md` states the outcome per API.
//
//   openai-completions      a thinking block is replayed ONLY when the first non-empty one
//                           carries a recognised field name in `thinkingSignature`
//                           ("reasoning", "reasoning_content", "reasoning_text"), which pi
//                           then sends as that request field. If it carries a
//                           `reasoning_details` JSON signature instead, pi sends the stored
//                           details and OMITS all thinking text — so appending recovered
//                           text there would drop it. An unsigned block is omitted entirely.
//
//   anthropic-messages      a thinking block with no signature is downgraded to a plain text
//                           block. Content survives; it does not re-enter the reasoning
//                           channel, because Anthropic requires a provider-issued signature
//                           and we must not invent one.
//
//   bedrock-converse-stream no signature means `{ text }` for models that support reasoning
//                           signatures, and `reasoningContent.reasoningText` for models that
//                           do not. Both preserve the text.
//
//   mistral-conversations   replayed as a `thinking` content part. Preserved.
//
//   openai-responses        a thinking block with no signature is dropped; with a signature
//   (and the      JSON.parse is called on it unguarded. There is no safe shape for recovered
//    responses     reasoning here without fabricating a provider-issued reasoning item, which
//    family)      is forbidden. So this family is never reclassified.
//
//   google-*                a same-provider/same-model thinking block becomes an unsigned
//                           `{ thought: true, text }` part. That is the same native pathway pi
//                           already uses for its own unsigned blocks, and it is verified in
//                           `google-shared.js`'s converter, so Google takes the unsigned
//                           strategy. Server acceptance is not exercised by these tests.
//
// The default for any unrecognised API is `preserve`: detection still runs, nothing is
// rewritten, and no request changes shape. That direction of failure is deliberate — a new
// adapter shows the old cosmetic symptom instead of losing content.
//
// Cross-model policy is untouched. pi's `transformMessages` drops thinking blocks when
// provider, api or model differ, and that is a deliberate portability rule: signatures are
// only valid for the model that issued them, and replaying readable thinking into a different
// model makes it treat that reasoning as part of the visible reply. Recovered reasoning
// inherits that rule exactly like native reasoning. This module never injects recovered text
// into user, system or answer content to route around it.

import { splitReasoning, type Segment } from "./reasoning-tags.ts";

/** Shape of a text block, structurally compatible with pi-ai's `TextContent`. */
export interface TextLike {
  type: "text";
  text: string;
  textSignature?: string;
}

/** Shape of a thinking block, structurally compatible with pi-ai's `ThinkingContent`. */
export interface ThinkingLike {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

/** Any other content block — tool calls, images — passed through untouched. */
export interface OtherLike {
  type: string;
}

export type BlockLike = TextLike | ThinkingLike | OtherLike;

/**
 * The field name written onto recovered thinking blocks on Chat Completions.
 *
 * This is a *field-name discriminator*, not a signature: it tells pi which request field to
 * serialise the text into. It is not provider-issued, it is not opaque, it carries no
 * authenticity claim, and it must never be used where a provider validates a real signature
 * (Anthropic, Bedrock-with-signatures, Google) — which is why only the Chat Completions
 * strategy sets it.
 */
export const RECOVERED_FIELD = "reasoning_content";

/** Field names pi will serialise a thinking block into on Chat Completions. */
const FIELD_SIGNATURES: ReadonlySet<string> = new Set([
  "reasoning",
  "reasoning_content",
  "reasoning_text",
]);

/**
 * APIs where the serialiser keeps an unsigned thinking block.
 *
 * "Keeps" is not the same as "replays as reasoning", and the support table in README.md states
 * which is which. Google is included because its converter emits a native unsigned
 * `{ thought: true, text }` part for a same-provider/same-model block — the same pathway pi
 * already uses — and that is a converter property, verified locally, not a guess about what
 * the server accepts.
 */
const UNSIGNED_REPLAY_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "bedrock-converse-stream",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
]);

/** APIs where a field-name signature makes the text travel as reasoning. */
const FIELD_REPLAY_APIS: ReadonlySet<string> = new Set(["openai-completions"]);

export type ReplayMode = "field-signature" | "unsigned" | "preserve";

export interface ReplayPlan {
  mode: ReplayMode;
  /** Field name to write, only for `field-signature`. */
  signature?: string;
  /** Human-readable justification, surfaced in diagnostics and asserted in tests. */
  reason: string;
}

function isText(block: BlockLike): block is TextLike {
  return block.type === "text";
}

function isThinking(block: BlockLike): block is ThinkingLike {
  return block.type === "thinking";
}

/**
 * Thinking blocks pi will consider when choosing the replay field.
 *
 * This mirrors pi's own selector exactly — `thinkingBlocks.filter(block =>
 * block.thinking.trim().length > 0)` — including the fact that it does NOT exclude redacted
 * blocks. A redacted block normally has no visible text and so drops out on the trim test, but
 * if one ever carried text it WOULD participate in field selection, and a selector that
 * silently disagreed with pi's would plan a replay pi then refuses to write. Matching the
 * selector is cheaper than reasoning about when the difference could matter.
 */
function replayableThinking(content: readonly BlockLike[]): ThinkingLike[] {
  return content.filter(
    (block): block is ThinkingLike => isThinking(block) && block.thinking.trim().length > 0,
  );
}

/**
 * True when a signature is opaque JSON rather than a field-name discriminator.
 *
 * pi's Chat Completions serialiser collects `reasoning_details` from *every* thinking block in
 * the message (`.map(parseOpenAIReasoningDetails).find(...)`), not just the first, and sends
 * the details while omitting all thinking text. So one JSON-backed block anywhere in the
 * content silently suppresses the text of every other block, including a recovered one whose
 * own field name is perfectly valid.
 *
 * The test is deliberately shape-based rather than a JSON parse: a signature starting with
 * `[` or `{` is treated as opaque state we must not reason about. A parse would be a mirror of
 * pi's validator that could drift; this cannot.
 */
function isOpaqueJsonSignature(signature: string | undefined): boolean {
  if (signature === undefined) return false;
  const trimmed = signature.trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("{");
}

/** A tool call carrying provider replay state that may also become `reasoning_details`. */
function hasLegacyReasoningDetail(content: readonly BlockLike[]): boolean {
  return content.some((block) => {
    const thoughtSignature = (block as { thoughtSignature?: unknown }).thoughtSignature;
    return typeof thoughtSignature === "string" && thoughtSignature.length > 0;
  });
}

/**
 * Chooses how recovered reasoning should be stored for `api`, given the thinking blocks the
 * message already contains.
 *
 * The existing blocks matter because Chat Completions serialises the first non-empty
 * thinking block's signature and joins every thinking block into that one field, or — with a
 * `reasoning_details` signature — sends the details and drops the text. Appending a block
 * whose signature disagrees with the first one is therefore not harmless: it is either joined
 * (fine) or omitted (silent loss).
 */
export function planReplay(api: string, content: readonly BlockLike[]): ReplayPlan {
  const existing = replayableThinking(content);
  const firstSignature = existing[0]?.thinkingSignature;

  if (FIELD_REPLAY_APIS.has(api)) {
    // Check the WHOLE content, not just the first block. A JSON-backed block anywhere makes pi
    // send reasoning_details and omit all thinking text; appending recovered reasoning then
    // looks right in the session and never reaches the request.
    if (content.some((block) => isThinking(block) && isOpaqueJsonSignature(block.thinkingSignature))) {
      return {
        mode: "preserve",
        reason:
          "openai-completions: content carries a reasoning_details signature; pi sends those details " +
          "and omits all thinking text, so a recovered block would be dropped",
      };
    }
    if (hasLegacyReasoningDetail(content)) {
      return {
        mode: "preserve",
        reason:
          "openai-completions: a tool call carries replay state that pi may treat as reasoning_details, " +
          "which would suppress thinking text",
      };
    }
    if (existing.length === 0) {
      return {
        mode: "field-signature",
        signature: RECOVERED_FIELD,
        reason: "openai-completions: recovered block is the only reasoning, so it sets the replay field",
      };
    }
    if (firstSignature !== undefined && FIELD_SIGNATURES.has(firstSignature)) {
      return {
        mode: "field-signature",
        signature: firstSignature,
        reason:
          "openai-completions: reusing the field already carrying native reasoning, so all blocks join one field",
      };
    }
    return {
      mode: "preserve",
      reason:
        "openai-completions: the first native reasoning block has no recognised field name, so pi " +
        "writes no reasoning field and would drop every thinking block in the message",
    };
  }

  if (UNSIGNED_REPLAY_APIS.has(api)) {
    return {
      mode: "unsigned",
      reason: `${api}: serialiser preserves an unsigned thinking block, downgrading to text where a signature is required`,
    };
  }

  return {
    mode: "preserve",
    reason: `${api}: no verified lossless replay for recovered reasoning; leaving the block as text`,
  };
}

/**
 * Whether a message would still have something for the adapter to send.
 *
 * Chat Completions drops an assistant message that has neither visible content nor tool calls
 * (`openai-completions.js:1040-1055`), and it does so *after* writing `reasoning_content` — so a
 * turn whose only text was the tagged reasoning would vanish from the next request entirely,
 * losing the reasoning as well as the markup. Keeping the tagged source is strictly better than
 * deleting the turn, and inventing a placeholder answer would be worse than both.
 */
function hasVisibleContent(content: readonly BlockLike[]): boolean {
  return content.some((block) => {
    if (block.type === "toolCall") return true;
    if (block.type === "text") return (block as TextLike).text.trim().length > 0;
    return false;
  });
}

export interface NormalizeResult {
  /** False when the content array is unchanged and can be reused by identity. */
  changed: boolean;
  content: BlockLike[];
  /** True when reasoning was found but deliberately left as text. */
  deferred: boolean;
  plan: ReplayPlan;
}

/**
 * Promotes delimited reasoning found in text blocks into thinking blocks, for `api`.
 *
 * Guarantees, each covered by a test:
 *
 *   - Text blocks carrying a `textSignature` are never touched. The signature validates the
 *     text on replay, so rewriting it would invalidate provider state.
 *   - Native thinking blocks are never modified, reordered or merged away.
 *   - No `toolCall` block is ever created, from `<tool_call>` prose or anything else.
 *   - Relative order is preserved, and a message that already contains native thinking is
 *     still processed — a message having reasoning does not mean its text is clean. That
 *     mixed case is 45 provider/model groups in the corpus, not a corner case.
 *   - Idempotent: the output contains no reasoning tags, so a second pass is a no-op.
 */
export function normalizeContent(content: readonly BlockLike[], api: string): NormalizeResult {
  const plan = planReplay(api, content);

  const candidates = content.some(
    (block) => isText(block) && !block.textSignature && block.text.includes("<"),
  );

  if (plan.mode === "preserve" || !candidates) {
    return { changed: false, content: content as BlockLike[], deferred: candidates, plan };
  }

  const next: BlockLike[] = [];
  let changed = false;

  for (const block of content) {
    if (!isText(block) || block.textSignature || !block.text.includes("<")) {
      next.push(block);
      continue;
    }

    const segments: Segment[] = splitReasoning(block.text);
    if (!segments.some((segment) => segment.kind === "reasoning")) {
      next.push(block);
      continue;
    }

    changed = true;
    for (const segment of segments) {
      if (segment.kind === "text") {
        if (segment.text.length > 0) next.push({ type: "text", text: segment.text });
        continue;
      }
      const thinking: ThinkingLike = { type: "thinking", thinking: segment.text };
      if (plan.mode === "field-signature" && plan.signature !== undefined) {
        thinking.thinkingSignature = plan.signature;
      }
      next.push(thinking);
    }
  }

  if (!changed) {
    return { changed: false, content: content as BlockLike[], deferred: false, plan };
  }

  // Field-signature replay writes the reasoning into a separate request field, which leaves a
  // tag-only turn with no visible content at all. The adapter then drops the whole message. On
  // the unsigned strategies the serialiser emits the reasoning as text, so visibility survives
  // and this guard does not apply.
  if (plan.mode === "field-signature" && !hasVisibleContent(next)) {
    return {
      changed: false,
      content: content as BlockLike[],
      deferred: true,
      plan: {
        ...plan,
        mode: "preserve",
        reason:
          "the only visible content in this message is the tagged reasoning; reclassifying it " +
          "would leave a turn with no content and no tool calls, which openai-completions drops " +
          "outright — keeping the tagged source preserves the message",
      },
    };
  }

  return { changed, content: next, deferred: false, plan };
}

export interface AssistantLike {
  role: string;
  api: string;
  stopReason?: string;
  content: unknown;
}

/**
 * Message-level entry point: returns a replacement message, or undefined when nothing should
 * change.
 *
 * Error and aborted messages are skipped outright. Their output is partial by definition, so
 * a close tag is frequently missing, and a truncation that happened to leave valid markup
 * would be reclassified on the strength of an incomplete turn.
 */
export function normalizeAssistantMessage<T extends AssistantLike>(
  message: T,
): (T & { content: BlockLike[] }) | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
  if (!Array.isArray(message.content)) return undefined;

  const result = normalizeContent(message.content as BlockLike[], message.api);
  if (!result.changed) return undefined;

  return { ...message, content: result.content };
}

export { FIELD_SIGNATURES, FIELD_REPLAY_APIS, UNSIGNED_REPLAY_APIS };
