/**
 * Inert tool-protocol markup — classifier and renderer tests.
 *
 * The invariant under test is the one the issue names: zero extra executable calls, native call
 * count and content unchanged, and FT-37's behaviour preserved. Almost every case is a false
 * positive defence, because a false positive here restyles a sentence, corrupts a quoted example
 * or — worst — makes markup look like a call.
 *
 * The extension entry is exercised through a host that records every registration, so "registers
 * nothing durable" is asserted rather than assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fenceFor,
  findInertSpans,
  isRenderableMessageType,
  renderInertMarkdown,
  startsBlock,
} from "../src/inert-tool-markup.ts";
import toolMarkupInert, {
  transformAssistantMarkdown,
  type MarkdownTransformContext,
} from "../src/tool-markup-inert.ts";
import {
  findReasoningBlocks,
  hasReasoningTags,
  splitReasoning,
} from "../src/reasoning-tags.ts";

/** Synthetic, modelled on the documented shape — no incident content. */
const TOOL_SHAPE = `<tool_answer>
 Understood — flat, named by what they carry.

 <tool_call>
 bash
 {
   "command": "echo hi",
   "description": "demo"
 }
 </tool_call>
</tool_answer>`;

const ANALYSIS_SHAPE = `<analysis>
 Weighing two options here.
</analysis>

<summary>
 Chose the second.
</summary>`;

/** The dispatch step `agent-loop.js` performs after `message_end`. */
function simulateDispatch(message: { content: Array<{ type: string }> }) {
  return message.content.filter((c) => c.type === "toolCall");
}

const context = (messageType: MarkdownTransformContext["messageType"]): MarkdownTransformContext => ({
  messageType,
  isStreaming: false,
  availableWidth: 80,
});

// ---------------------------------------------------------------------------------------------
// Classification and rendering
// ---------------------------------------------------------------------------------------------

test("text-only tool markup becomes one clearly labelled inert block", () => {
  const spans = findInertSpans(TOOL_SHAPE);
  assert.equal(spans.length, 1, "the outer <tool_answer> collapses to a single span");
  assert.equal(spans[0].family, "tool");
  assert.equal(spans[0].name, "tool_answer");

  const out = renderInertMarkdown(TOOL_SHAPE);
  assert.match(out, /inert, not executed/);
  assert.match(out, /```text\n/);

  // The payload inside the block is preserved verbatim: display must not rewrite it.
  const body = TOOL_SHAPE.slice(spans[0].bodyStart, spans[0].bodyEnd);
  assert.ok(out.includes(body), "body copied byte for byte into the fence");
  assert.ok(out.startsWith("⏸ model-emitted tool-protocol markup"), "label leads the block");
});

test("text + native call in one message: call count and content unchanged", () => {
  const message = {
    role: "assistant",
    provider: "subrouter-deepseek-flash",
    model: "deepseek-v4.1-flash-1017",
    content: [
      { type: "text", text: TOOL_SHAPE },
      {
        type: "toolCall",
        id: "call_1",
        name: "bash",
        arguments: { command: "echo hi", description: "demo" },
      },
    ],
  };
  const before = JSON.stringify(message);
  const dispatchBefore = simulateDispatch(message);

  // The transformer takes a Markdown string only; it has no way to touch the message.
  const rendered = renderInertMarkdown(message.content[0].text);

  assert.equal(JSON.stringify(message), before, "message object untouched");
  const dispatchAfter = simulateDispatch(message);
  assert.equal(dispatchAfter.length, 1, "exactly one executable call");
  assert.equal(dispatchAfter.length, dispatchBefore.length);
  assert.deepEqual(dispatchAfter[0], dispatchBefore[0]);
  assert.equal(dispatchAfter[0].id, "call_1");
  assert.deepEqual(dispatchAfter[0].arguments, { command: "echo hi", description: "demo" });

  // Nothing in the rendered Markdown can be read as a synthesised call.
  assert.ok(!rendered.includes("toolCall"));
  assert.ok(!rendered.includes('"type":"toolCall"'));
});

test("classification is content-driven across providers, models and widths", () => {
  const contextsOn = [
    { provider: "subrouter-deepseek-flash", api: "openai-completions", model: "deepseek-v4.1-flash-1017" },
    { provider: "openai", api: "openai-responses", model: "gpt-5" },
    { provider: "anthropic", api: "anthropic-messages", model: "claude-x" },
    { provider: "google", api: "google-generative-ai", model: "gemini-x" },
    { provider: "unknown-provider", api: "unknown-api", model: "unknown-model" },
  ];
  // Rendering is a pure function of the text: provider/model cannot influence it. Model and api
  // descriptors only need to be *possible* values; nothing in the module reads them.
  const outputs = contextsOn.map((descriptor) => {
    assert.ok(descriptor.model.length > 0);
    return renderInertMarkdown(TOOL_SHAPE);
  });
  for (const out of outputs) {
    assert.equal(out, outputs[0], "identical text must classify identically everywhere");
    assert.match(out, /inert, not executed/);
  }

  // The context the transformer *does* read is messageType, and nothing else.
  for (const width of [20, 80, 200]) {
    assert.equal(
      transformAssistantMarkdown(TOOL_SHAPE, { ...context("assistant"), availableWidth: width }),
      renderInertMarkdown(TOOL_SHAPE),
    );
  }
});

test("nesting collapses to one span and one fence", () => {
  const nested = `<tool_answer>
 first note
 <tool_call>
 <function_calls>
 <invoke name="read">
 <parameter name="path">a</parameter>
 </invoke>
 </function_calls>
 </tool_call>
 second note
</tool_answer>`;
  assert.equal(findInertSpans(nested).length, 1);
  const out = renderInertMarkdown(nested);
  assert.equal((out.match(/inert, not executed/g) ?? []).length, 1, "one label, no nested fences");
  assert.equal((out.match(/```text\n/g) ?? []).length, 1, "one fence");
  assert.ok(out.includes("</function_calls>"), "inner markup preserved verbatim");
});

test("unclosed opener is left byte-for-byte alone (streaming safe)", () => {
  const partial = `<tool_call>
 bash
 { "command": "echo hi" }`;
  assert.equal(findInertSpans(partial).length, 0);
  assert.equal(renderInertMarkdown(partial), partial);

  const midTag = "Working on it.\n\n<tool_c";
  assert.equal(renderInertMarkdown(midTag), midTag);

  const loneOpener = TOOL_SHAPE.slice(0, TOOL_SHAPE.indexOf("</tool_answer>"));
  assert.equal(renderInertMarkdown(loneOpener), loneOpener);
});

test("containers stay literal: fence, inline code, indent, blockquote", () => {
  const fenced = "Example:\n\n```xml\n<tool_call>\n bash\n</tool_call>\n```\n";
  const fenced2 = "Example:\n\n```\n" + TOOL_SHAPE + "\n```\n";
  const inline = "The `<tool_call>` tag leaks into prose.\n";
  const indented = "Example:\n\n    <tool_call>\n     bash\n    </tool_call>\n";
  const quoted = "> <tool_call>\n> bash\n> </tool_call>\n";
  for (const [name, text] of [
    ["labelled fence", fenced],
    ["bare fence", fenced2],
    ["inline code", inline],
    ["indented code", indented],
    ["blockquote", quoted],
  ]) {
    assert.equal(renderInertMarkdown(text), text, `${name} must stay literal`);
  }
});

test("a quoted example next to a real leak: only the leak is wrapped", () => {
  const mixed = [
    "Here is what the tag looks like:",
    "",
    "```",
    "<tool_call>",
    " bash",
    "</tool_call>",
    "```",
    "",
    "And here is what I actually emitted:",
    "",
    "<tool_call>",
    " bash",
    ' { "command": "echo hi" }',
    "</tool_call>",
    "",
  ].join("\n");
  assert.equal(findInertSpans(mixed).length, 1, "the fenced example is not a span");
  const out = renderInertMarkdown(mixed);
  assert.ok(out.includes("Here is what the tag looks like:"), "surrounding prose preserved");
  assert.ok(out.includes("```\n<tool_call>\n bash\n</tool_call>\n```"), "example untouched");
  assert.equal((out.match(/inert, not executed/g) ?? []).length, 1);
});

test("idempotent: a second pass is a no-op", () => {
  for (const text of [TOOL_SHAPE, ANALYSIS_SHAPE]) {
    const once = renderInertMarkdown(text);
    assert.notEqual(once, text, "first pass must change something");
    assert.equal(renderInertMarkdown(once), once);
    let acc = once;
    for (let i = 0; i < 10; i++) acc = renderInertMarkdown(acc);
    assert.equal(acc, once, "stable under repeated rendering");
  }
});

test("analysis/summary family is inert, labelled, and not reasoning replay", () => {
  const spans = findInertSpans(ANALYSIS_SHAPE);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((s) => s.family), ["reasoning", "reasoning"]);
  const out = renderInertMarkdown(ANALYSIS_SHAPE);
  assert.match(out, /analysis\/summary markup — inert, not replayed/);
  // This module returns Markdown only: it cannot produce a thinking block.
  assert.ok(!out.includes("thinking"));
});

test("fence length grows past backticks inside the markup", () => {
  const text = '<tool_call>\n bash\n { "command": "echo ```x```" }\n</tool_call>\n';
  const out = renderInertMarkdown(text);
  assert.match(out, /````text\n/, "outer fence must be longer than any inner run");
  assert.ok(out.includes("```x```"), "inner backticks preserved");
  assert.equal(fenceFor("no ticks"), "```");
  assert.equal(fenceFor("a `` b ``` c"), "````");
});

// D1 (acceptance of 542b668d4): a closer that is not preceded by a newline used to glue the
// closing fence to the last body line, leaving the block unterminated and folding the rest of the
// message into code. The classifier accepts a closer anywhere, so the renderer must cope.

test("a mid-line closer still produces a fence that starts its own line", () => {
  const cases = [
    ['compact tool_call', '<tool_call>\n bash\n {"a":1}</tool_call>'],
    ['compact analysis', '<analysis>weighed both</analysis>'],
    ['mid-line invoke closer', '<invoke name="read">\n<parameter name="path">a</parameter></invoke>'],
    ['body ending without newline, no prose after', '<tool_answer>\n done</tool_answer>'],
  ];
  for (const [name, text] of cases) {
    const spans = findInertSpans(text);
    assert.equal(spans.length, 1, `${name}: one span`);
    const body = text.slice(spans[0].bodyStart, spans[0].bodyEnd);
    const out = renderInertMarkdown(text);

    assert.ok(out.endsWith("\n```\n") || /\n```\n[^`]*$/.test(out), `${name}: fence line intact`);
    assert.match(out, /\n```\n/, `${name}: closing fence starts a line`);
    assert.ok(!/[^\n]```/.test(out), `${name}: no fence marker glued to prose`);
    assert.ok(out.includes(body), `${name}: body preserved verbatim`);
    assert.equal(renderInertMarkdown(out), out, `${name}: idempotent`);
  }
});

test("prose after a mid-line closer stays outside the fence", () => {
  const prose = "TRAILING PROSE must stay prose.";
  const text = `<tool_call>\n bash\n {"a":1}</tool_call> ${prose}`;
  const out = renderInertMarkdown(text);

  const closeAt = out.indexOf("\n```\n");
  assert.ok(closeAt >= 0, "closing fence must be on its own line");
  const proseAt = out.indexOf(prose);
  assert.ok(proseAt > closeAt, "prose follows the closing fence, not the body");
  assert.ok(!out.slice(0, closeAt).includes(prose), "prose is not inside the block");
  assert.equal((out.match(/\n```\n/g) ?? []).length, 1, "exactly one fence close");
  assert.equal(renderInertMarkdown(out), out, "idempotent");

  // A following span in the same message is still classified on its own, not swallowed.
  const two = `<tool_call>\n a</tool_call> middle <summary>\n b</summary> tail`;
  const out2 = renderInertMarkdown(two);
  assert.equal((out2.match(/inert, not (executed|replayed)/g) ?? []).length, 1, "only block-initial openers");
});

test("only assistant text is transformed (FT-37 surface untouched)", () => {
  const transform = transformAssistantMarkdown;
  for (const messageType of ["assistant-thinking", "user"] as const) {
    assert.equal(
      transform(TOOL_SHAPE, context(messageType)),
      TOOL_SHAPE,
      `${messageType} must not be transformed`,
    );
    assert.equal(isRenderableMessageType(messageType), false);
  }
  assert.notEqual(transform(TOOL_SHAPE, context("assistant")), TOOL_SHAPE);
  assert.equal(isRenderableMessageType("assistant"), true);
});

test("thinking markup stays FT-37's surface, untouched here", () => {
  const literal = "<thinking>\nstep one\n</thinking>\n\nanswer\n";
  assert.equal(renderInertMarkdown(literal), literal);
  const mixed = literal + "\n" + TOOL_SHAPE;
  const out = renderInertMarkdown(mixed);
  assert.ok(out.startsWith(literal), "thinking text left as-is");
  assert.match(out, /inert, not executed/);
});

// ---------------------------------------------------------------------------------------------
// The released `<invoke>` decision
// ---------------------------------------------------------------------------------------------

test("a prose mention of <invoke> without a same-name close is unchanged", () => {
  const prose = "The harness writes an <invoke> element per call, with no closer in this sentence.";
  assert.equal(findInertSpans(prose).length, 0, "no span without a matching close");
  assert.equal(renderInertMarkdown(prose), prose);

  // Also unchanged when the closer exists but names something else: not the same span.
  const mismatched = "<invoke>\n read a file\n</tool_call>\n";
  assert.equal(renderInertMarkdown(mismatched), mismatched);
});

test("a matched <invoke> wrapper is treated as protocol", () => {
  const wrapper = `<invoke name="read">
<parameter name="path">notes.md</parameter>
</invoke>`;
  const spans = findInertSpans(wrapper);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "invoke");
  const out = renderInertMarkdown(wrapper);
  assert.match(out, /inert, not executed/);
  assert.ok(out.includes('<parameter name="path">notes.md</parameter>'));
  assert.equal(renderInertMarkdown(out), out, "and stays idempotent");
});

test("a mid-line <invoke> mention is not promoted even with a closer on the next line", () => {
  const inlineProse = "It emits <invoke> then</invoke> later.\n";
  assert.equal(findInertSpans(inlineProse).length, 0, "opener must start its line");
  assert.equal(startsBlock("  <invoke>", 2), true);
  assert.equal(startsBlock("- <invoke>", 2), false, "list marker refused");
});

// ---------------------------------------------------------------------------------------------
// FT-37 preservation
// ---------------------------------------------------------------------------------------------

test("FT-37 parser still refuses tool markup and still accepts thinking tags", () => {
  assert.equal(hasReasoningTags(TOOL_SHAPE), false, "tool markup is not reasoning");
  assert.equal(hasReasoningTags(ANALYSIS_SHAPE), false, "analysis/summary is not reasoning");
  const segments = splitReasoning(TOOL_SHAPE);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "text");
  assert.equal(segments[0].text, TOOL_SHAPE, "FT-37 leaves the payload byte-identical");

  const thinking = "<thinking>\nstep one\n</thinking>\n\nanswer";
  assert.equal(hasReasoningTags(thinking), true, "accepted FT-37 recognition intact");
  assert.equal(findReasoningBlocks(thinking).length, 1);
  assert.equal(splitReasoning(thinking)[0].kind, "reasoning");
});

test("registers nothing but a display transformer (no durable hook)", () => {
  const calls: string[] = [];
  const host = {
    registerMarkdownTransformer: (fn: unknown) => {
      assert.equal(typeof fn, "function");
      assert.equal((fn as (...args: unknown[]) => unknown).length, 2, "transformer takes (markdown, context)");
      calls.push("markdown");
    },
    on: (name: string) => calls.push(`on:${name}`),
    registerTool: (t: { name?: string }) => calls.push(`tool:${t?.name}`),
    registerToolRenderer: () => calls.push("toolRenderer"),
    registerMessageRenderer: () => calls.push("messageRenderer"),
    registerEntryRenderer: () => calls.push("entryRenderer"),
    appendEntry: () => calls.push("appendEntry"),
    sendMessage: () => calls.push("sendMessage"),
  };
  toolMarkupInert(host);
  assert.deepEqual(calls, ["markdown"], "display-only: not a single durable registration");
});
