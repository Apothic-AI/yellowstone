/**
 * Replay-strategy tests.
 *
 * These assert *policy*, not payload: which APIs are allowed to reclassify, and what happens
 * to a message that already carries native reasoning. The payload itself is asserted against
 * the real adapter in `chat-completions-payload.test.ts`, because a policy test that never
 * touches a serialiser can be wrong in the same direction as the code it is testing.
 *
 * The mixed-reasoning cases get the most attention. 45 of 45 leaking provider/model groups in
 * the corpus contain both a correctly parsed thinking block and leaked markup, so "the message
 * already has reasoning, skip it" — the guard a published extension uses — would skip exactly
 * the population this fix exists for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECOVERED_FIELD,
  normalizeAssistantMessage,
  normalizeContent,
  planReplay,
  type BlockLike,
} from "../src/reasoning-replay.ts";

const LEAK = "<thinking>I should read the fixture first.</thinking>\nHere is the answer.";

const assistant = (content: BlockLike[], overrides: Record<string, unknown> = {}) => ({
  role: "assistant",
  api: "openai-completions",
  provider: "some-provider",
  model: "some-model",
  stopReason: "stop",
  content,
  ...overrides,
});

test("chat completions with no native reasoning writes the replay field name", () => {
  const plan = planReplay("openai-completions", []);
  assert.equal(plan.mode, "field-signature");
  assert.equal(plan.signature, RECOVERED_FIELD);
  // A field name, not a signature: it must not look like opaque provider data.
  assert.equal(RECOVERED_FIELD, "reasoning_content");
});

test("chat completions reuses the field already carrying native reasoning", () => {
  for (const signature of ["reasoning", "reasoning_content", "reasoning_text"]) {
    const plan = planReplay("openai-completions", [
      { type: "thinking", thinking: "native", thinkingSignature: signature },
    ]);
    assert.equal(plan.mode, "field-signature", signature);
    assert.equal(plan.signature, signature);
  }
});

test("chat completions refuses when native reasoning uses a reasoning_details signature", () => {
  // pi serialises the stored details and OMITS all thinking text in this case. Appending a
  // recovered block would look correct in the session and vanish from the request.
  const plan = planReplay("openai-completions", [
    {
      type: "thinking",
      thinking: "native",
      thinkingSignature: '[{"type":"reasoning.text","text":"native"}]',
    },
  ]);
  assert.equal(plan.mode, "preserve");
  assert.match(plan.reason, /reasoning_details/);
});

test("a reasoning_details signature on a LATER block still suppresses the first block's field", () => {
  // pi collects reasoning_details from every thinking block in the content, not just the
  // first, and then omits all thinking text. Checking only block[0] would wrongly allow this.
  const plan = planReplay("openai-completions", [
    { type: "thinking", thinking: "first", thinkingSignature: "reasoning_content" },
    { type: "thinking", thinking: "second", thinkingSignature: '[{"type":"reasoning.text"}]' },
  ]);
  assert.equal(plan.mode, "preserve");
  assert.match(plan.reason, /reasoning_details/);
});

test("an opaque JSON object signature is treated as reasoning_details too", () => {
  const plan = planReplay("openai-completions", [
    { type: "thinking", thinking: "first", thinkingSignature: "reasoning_content" },
    { type: "thinking", thinking: "second", thinkingSignature: '{"encrypted_content":"..."}' },
  ]);
  assert.equal(plan.mode, "preserve");
});

test("a tool call carrying replay state forces preserve", () => {
  // pi also harvests legacy encrypted reasoning details from toolCall.thoughtSignature, which
  // would set the same suppression. Conservatively refuse rather than guess.
  const plan = planReplay("openai-completions", [
    {
      type: "toolCall",
      id: "c1",
      name: "read",
      arguments: {},
      thoughtSignature: '[{"type":"reasoning.encrypted"}]',
    },
  ] as BlockLike[]);
  assert.equal(plan.mode, "preserve");
});

test("a tool call without replay state does not block the field strategy", () => {
  const plan = planReplay("openai-completions", [
    { type: "toolCall", id: "c1", name: "read", arguments: {} },
  ] as BlockLike[]);
  assert.equal(plan.mode, "field-signature");
});

test("an unsigned LATER block is harmless — pi joins every block into the first field", () => {
  const plan = planReplay("openai-completions", [
    { type: "thinking", thinking: "first", thinkingSignature: "reasoning" },
    { type: "thinking", thinking: "later unsigned" },
  ]);
  assert.equal(plan.mode, "field-signature");
  assert.equal(plan.signature, "reasoning");
});

test("chat completions refuses when the first native block is unsigned", () => {
  // pi reads the FIRST non-empty thinking block's signature. An unsigned one means no field
  // is written at all, so every thinking block in the message is dropped from the request.
  const plan = planReplay("openai-completions", [{ type: "thinking", thinking: "native" }]);
  assert.equal(plan.mode, "preserve");
});

test("an empty native thinking block does not count as the first block", () => {
  // replayableThinking filters empties, matching pi's nonEmptyThinkingBlocks filter.
  const plan = planReplay("openai-completions", [
    { type: "thinking", thinking: "   " },
    { type: "thinking", thinking: "native", thinkingSignature: "reasoning_content" },
  ]);
  assert.equal(plan.mode, "field-signature");
  assert.equal(plan.signature, "reasoning_content");
});

test("a redacted block with no visible text does not participate in field selection", () => {
  const plan = planReplay("openai-completions", [
    { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
  ]);
  assert.equal(plan.mode, "field-signature");
});

test("R1: a redacted block that DOES carry text participates, exactly as in pi", () => {
  // pi's selector is `filter(block => block.thinking.trim().length > 0)` with no redaction
  // test, so such a block decides the field. Planning a different field than pi would write
  // would silently drop the recovered reasoning.
  const plan = planReplay("openai-completions", [
    { type: "thinking", thinking: "ciphertext-as-text", thinkingSignature: "opaque-base64", redacted: true },
  ]);
  assert.equal(plan.mode, "preserve");

  const withField = planReplay("openai-completions", [
    { type: "thinking", thinking: "text with field", thinkingSignature: "reasoning", redacted: true },
  ]);
  assert.equal(withField.mode, "field-signature");
  assert.equal(withField.signature, "reasoning");
});

test("APIs with a verified unsigned pathway keep an unsigned block", () => {
  // Google belongs here on converter evidence, not on server-acceptance evidence: its
  // converter emits a native unsigned { thought: true } part (see the payload suite).
  for (const api of [
    "anthropic-messages",
    "bedrock-converse-stream",
    "mistral-conversations",
    "google-generative-ai",
    "google-vertex",
  ]) {
    const plan = planReplay(api, []);
    assert.equal(plan.mode, "unsigned", api);
    assert.equal(plan.signature, undefined, api);
  }
});

test("APIs requiring an opaque signed item keep the original text", () => {
  // The Responses family drops an unsigned thinking block and JSON.parses a signature, and it
  // expects a provider-issued reasoning item we must never manufacture. An unknown API is
  // treated the same way: fail safe, show the old symptom rather than lose content.
  for (const api of [
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "pi-messages",
    "some-future-api",
  ]) {
    const plan = planReplay(api, []);
    assert.equal(plan.mode, "preserve", api);
    assert.equal(plan.signature, undefined, api);
  }
});

test("a thinking block is created with the planning signature and the body preserved", () => {
  const result = normalizeContent([{ type: "text", text: LEAK }], "openai-completions");
  assert.equal(result.changed, true);
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "I should read the fixture first.", thinkingSignature: "reasoning_content" },
    { type: "text", text: "\nHere is the answer." },
  ]);
});

test("unsigned APIs create a thinking block with no signature at all", () => {
  const result = normalizeContent([{ type: "text", text: LEAK }], "anthropic-messages");
  const thinking = result.content[0];
  assert.equal(thinking.type, "thinking");
  assert.equal("thinkingSignature" in thinking, false);
  assert.equal((thinking as { thinking: string }).thinking, "I should read the fixture first.");
});

test("a message with native reasoning AND leaked text is still fixed", () => {
  // The 45-group case. Fixing this is the whole point; skipping it is the published
  // extension's bug.
  const result = normalizeContent(
    [
      { type: "thinking", thinking: "native reasoning", thinkingSignature: "reasoning_content" },
      { type: "text", text: "Visible preamble.\n<thinking>leaked reasoning</thinking>\nAnswer." },
    ],
    "openai-completions",
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "native reasoning", thinkingSignature: "reasoning_content" },
    { type: "text", text: "Visible preamble.\n" },
    { type: "thinking", thinking: "leaked reasoning", thinkingSignature: "reasoning_content" },
    { type: "text", text: "\nAnswer." },
  ]);
});

test("that mixed case keeps every thinking block on one replay field so all join the request", () => {
  const result = normalizeContent(
    [
      { type: "thinking", thinking: "native", thinkingSignature: "reasoning" },
      { type: "text", text: "<thinking>recovered</thinking>\nand a visible answer" },
    ],
    "openai-completions",
  );
  const signatures = result.content
    .filter((block) => block.type === "thinking")
    .map((block) => (block as { thinkingSignature?: string }).thinkingSignature);
  assert.deepEqual(signatures, ["reasoning", "reasoning"]);
});

// --- The content-less-turn gate (openai-completions.js:1040-1055) ---------------------------
//
// Chat Completions drops an assistant message that has neither visible content nor tool calls,
// and it does so AFTER writing reasoning_content. A turn whose only text was the tagged
// reasoning would therefore vanish from the next request entirely — losing the reasoning as
// well as the markup. Keeping the tagged source is strictly better than deleting the turn, and
// inventing a placeholder answer would be worse than both.

test("a tag-only turn is preserved rather than made content-less", () => {
  const result = normalizeContent(
    [{ type: "text", text: "<thinking>RECOVERED</thinking>" }],
    "openai-completions",
  );
  assert.equal(result.changed, false);
  assert.equal(result.deferred, true);
  assert.equal(result.plan.mode, "preserve");
  assert.match(result.plan.reason, /no content and no tool calls/);
  // The tagged source is what stays; nothing is invented.
  assert.deepEqual(result.content, [{ type: "text", text: "<thinking>RECOVERED</thinking>" }]);
});

test("mixed native reasoning plus a tag-only text block is also preserved", () => {
  const native = { type: "thinking", thinking: "native", thinkingSignature: "reasoning_content" };
  const tagged = { type: "text", text: "<thinking>RECOVERED</thinking>" };
  const result = normalizeContent([native, tagged], "openai-completions");

  assert.equal(result.changed, false);
  assert.equal(result.content[0], native, "native reasoning is untouched");
  assert.equal(result.content[1], tagged, "the tagged text is untouched");
});

test("a tag-only turn WITH a native tool call is converted normally", () => {
  // A tool call is visible content as far as the adapter's drop rule is concerned, so the
  // message survives and reclassification is safe.
  const result = normalizeContent(
    [
      { type: "text", text: "<thinking>RECOVERED</thinking>" },
      { type: "toolCall", id: "c1", name: "read", arguments: {} },
    ] as BlockLike[],
    "openai-completions",
  );

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["thinking", "toolCall"],
  );
});

test("a tag-only turn with a whitespace-only answer is still preserved", () => {
  // Whitespace does not count as content: the adapter's check is `content.length > 0` on the
  // joined text, and a blank answer is not something to send.
  const result = normalizeContent(
    [{ type: "text", text: "<thinking>RECOVERED</thinking>\n   " }],
    "openai-completions",
  );
  assert.equal(result.changed, false);
  assert.equal(result.deferred, true);
});

test("the content-less guard does not apply where the serialiser emits text", () => {
  // Anthropic downgrades an unsigned thinking block to a text block, so visibility survives
  // and there is no reason to withhold the fix.
  const result = normalizeContent(
    [{ type: "text", text: "<thinking>RECOVERED</thinking>" }],
    "anthropic-messages",
  );
  assert.equal(result.changed, true);
  assert.equal(result.plan.mode, "unsigned");
});

test("promotion never emits an empty text block", () => {
  // A zero-length text block must not be produced: it would satisfy the adapter's content check
  // for the wrong reason, and it is not something to send.
  const result = normalizeContent(
    [{ type: "text", text: "visible answer\n<thinking>R</thinking>" }],
    "openai-completions",
  );
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["text", "thinking"],
  );
  for (const block of result.content) {
    if (block.type === "text") assert.notEqual((block as { text: string }).text, "");
  }
});

test("a second adjacent opener is not block-initial, so it stays visible text", () => {
  // Documents the interaction the guard depends on: only the first of two adjacent blocks is
  // promoted, so the remainder is visible content and the turn is not made content-less.
  const result = normalizeContent(
    [{ type: "text", text: "<thinking>A</thinking><thinking>B</thinking>" }],
    "openai-completions",
  );
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["thinking", "text"],
  );
});

test("native reasoning is never modified", () => {
  const native = { type: "thinking", thinking: "native", thinkingSignature: "opaque-json" };
  const result = normalizeContent(
    [native, { type: "text", text: "<thinking>x</thinking>" }],
    "openai-completions",
  );
  // Preserved mode, and the original object is passed through by reference.
  assert.equal(result.changed, false);
  assert.equal(result.content[0], native);
  assert.deepEqual(result.content[1], { type: "text", text: "<thinking>x</thinking>" });
});

test("a redacted thinking block is never touched", () => {
  const redacted = { type: "thinking", thinking: "", thinkingSignature: "ciphertext", redacted: true };
  const result = normalizeContent(
    [redacted, { type: "text", text: "<thinking>x</thinking>" }],
    "anthropic-messages",
  );
  assert.equal(result.content[0], redacted);
});

test("a text block carrying textSignature is never rewritten", () => {
  const signed = { type: "text", text: "<thinking>signed</thinking>", textSignature: "provider-state" };
  const result = normalizeContent([signed], "openai-completions");
  assert.equal(result.changed, false);
  assert.equal(result.content[0], signed);
});

test("no toolCall block is ever produced from tool-protocol prose", () => {
  const prose = [
    "<tool_call>",
    "bash",
    '{"command":"rm -rf /tmp/example"}',
    "</tool_call>",
    "<tool_answer>done</tool_answer>",
  ].join("\n");

  for (const api of ["openai-completions", "anthropic-messages", "openai-responses"]) {
    const result = normalizeContent([{ type: "text", text: prose }], api);
    assert.equal(result.changed, false, api);
    assert.equal(
      result.content.some((block) => block.type === "toolCall"),
      false,
      api,
    );
  }
});

test("reasoning prose cannot smuggle a tool call in either", () => {
  const payload = '<thinking>I will run bash</thinking>\n<tool_call>bash</tool_call>';
  const result = normalizeContent([{ type: "text", text: payload }], "openai-completions");
  assert.equal(result.content.some((block) => block.type === "toolCall"), false);
});

test("an already-clean message is returned by identity", () => {
  const content: BlockLike[] = [{ type: "text", text: "no tags here" }];
  const result = normalizeContent(content, "openai-completions");
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
});

test("normalising twice is a no-op", () => {
  const once = normalizeContent([{ type: "text", text: LEAK }], "openai-completions");
  const twice = normalizeContent(once.content, "openai-completions");
  assert.equal(twice.changed, false);
});

test("error messages are skipped — partial output has no reliable close tag", () => {
  assert.equal(
    normalizeAssistantMessage(assistant([{ type: "text", text: LEAK }], { stopReason: "error" })),
    undefined,
  );
});

test("aborted messages are skipped", () => {
  assert.equal(
    normalizeAssistantMessage(assistant([{ type: "text", text: LEAK }], { stopReason: "aborted" })),
    undefined,
  );
});

test("non-assistant messages are skipped", () => {
  assert.equal(
    normalizeAssistantMessage({ ...assistant([{ type: "text", text: LEAK }]), role: "user" }),
    undefined,
  );
});

test("a message with no content array is skipped rather than throwing", () => {
  assert.equal(normalizeAssistantMessage({ ...assistant([]), content: null }), undefined);
});

test("normalisation keeps every message field and only replaces content", () => {
  const message = assistant([{ type: "text", text: LEAK }], { responseId: "r-1", providerThinkingLevel: "high" });
  const result = normalizeAssistantMessage(message);
  assert.ok(result);
  assert.equal(result.responseId, "r-1");
  assert.equal(result.providerThinkingLevel, "high");
  assert.equal(result.api, "openai-completions");
  assert.equal(result.role, "assistant");
});

test("preserve mode reports that it deferred so the caller can log it", () => {
  const result = normalizeContent([{ type: "text", text: LEAK }], "openai-responses");
  assert.equal(result.changed, false);
  assert.equal(result.deferred, true);
  assert.match(result.plan.reason, /openai-responses/);
});

test("total text content is conserved across promotion", () => {
  // Nothing may be dropped: the reasoning body plus the remaining text must equal the input
  // minus the four marker strings.
  const result = normalizeContent([{ type: "text", text: LEAK }], "openai-completions");
  const rejoined = result.content
    .map((block) =>
      block.type === "thinking"
        ? (block as { thinking: string }).thinking
        : (block as { text: string }).text,
    )
    .join("");
  assert.equal(rejoined, LEAK.replace("<thinking>", "").replace("</thinking>", ""));
});
