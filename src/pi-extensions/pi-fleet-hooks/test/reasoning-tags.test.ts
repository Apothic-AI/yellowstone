/**
 * Parser tests.
 *
 * The parser has one job and two failure modes that matter. A false negative leaves today's
 * behaviour — tags rendered as prose — which is the bug, not a regression. A false positive
 * eats visible answer text or corrupts a quoted example. Almost every test below is a false
 * positive defence, because that is the direction where a bug is unrecoverable for the reader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeMask,
  findReasoningBlocks,
  hasReasoningTags,
  splitReasoning,
  startsBlock,
} from "../src/reasoning-tags.ts";

const bodies = (text: string) =>
  splitReasoning(text)
    .filter((segment) => segment.kind === "reasoning")
    .map((segment) => segment.text);
const textOf = (text: string) =>
  splitReasoning(text)
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("");

test("promotes a block-initial <thinking> block and keeps the surrounding text", () => {
  const input = "<thinking>\nCheck the fixture first.\n</thinking>\nThe answer is 4.";
  const segments = splitReasoning(input);

  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["reasoning", "text"],
  );
  assert.equal(segments[0].text, "\nCheck the fixture first.\n");
  assert.equal(segments[1].text, "\nThe answer is 4.");
});

test("recognises the short <think> spelling as well as <thinking>", () => {
  assert.deepEqual(bodies("<think>short form</think>"), ["short form"]);
  assert.deepEqual(bodies("<thinking>long form</thinking>"), ["long form"]);
});

test("does not mistake <thinking> for <think> — the longer name wins", () => {
  const segments = splitReasoning("<thinking>a</thinking>");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "reasoning");
});

test("tolerates inner whitespace in the tag", () => {
  assert.deepEqual(bodies("< thinking >padded</ thinking >"), ["padded"]);
});

test("preserves the reasoning body byte for byte, including leading and trailing newlines", () => {
  const body = "\n\n  indented\n\nsecond paragraph  \n\n";
  assert.deepEqual(bodies(`<thinking>${body}</thinking>`), [body]);
});

test("a fenced example is an example, not protocol", () => {
  const input = [
    "Here is what the model emits:",
    "",
    "```",
    "<thinking>this is inside a fence</thinking>",
    "```",
    "",
    "Done.",
  ].join("\n");

  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("a tilde fence is a fence too", () => {
  const input = "~~~\n<thinking>fenced</thinking>\n~~~";
  assert.equal(hasReasoningTags(input), false);
});

test("an inline code span is an example, not protocol", () => {
  const input = "The `<thinking>` marker leaks — see the report.";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("double-backtick spans only close on a matching run", () => {
  const input = "Use ``a `<thinking>b</thinking>` c`` carefully.";
  assert.equal(hasReasoningTags(input), false);
});

test("a real block after an inline example is still promoted", () => {
  const input = "It writes `<thinking>`, like this:\n<thinking>actual reasoning</thinking>\nDone.";
  const segments = splitReasoning(input);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["text", "reasoning", "text"],
  );
  assert.equal(segments[1].text, "actual reasoning");
});

test("an unterminated opening tag does not swallow the rest of the answer", () => {
  const input = "<thinking>no close tag\nand the answer is 42";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("a stray closing tag alone is left as text", () => {
  const input = "reasoning went here\n</thinking>\nanswer";
  assert.equal(hasReasoningTags(input), false);
});

test("nested same-name openers are ambiguous and are refused", () => {
  const input = "<thinking>outer <thinking>inner</thinking></thinking>";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("two sequential blocks are both promoted, in order", () => {
  const input = "<thinking>first</thinking>\nmiddle\n<thinking>second</thinking>\ntail";
  const segments = splitReasoning(input);
  assert.deepEqual(
    segments.map((segment) => [segment.kind, segment.text]),
    [
      ["reasoning", "first"],
      ["text", "\nmiddle\n"],
      ["reasoning", "second"],
      ["text", "\ntail"],
    ],
  );
});

test("an empty block is not reasoning and stays as written", () => {
  const input = "<thinking>\n</thinking>answer";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("a tag mid-sentence is prose about the tag, not a reasoning block", () => {
  const input = "The model wrote <thinking>x</thinking> inline in a paragraph.";
  assert.equal(hasReasoningTags(input), false);
});

test("block-initial recognises list markers but refuses a quote marker", () => {
  assert.equal(startsBlock("- <thinking>x", 2), true);
  assert.equal(startsBlock("1. <thinking>x", 3), true);
  assert.equal(startsBlock("> <thinking>x", 2), false);
  assert.equal(startsBlock("text <thinking>x", 5), false);
});

test("a list item carrying a reasoning block is promoted", () => {
  const segments = splitReasoning("- <thinking>bullet reasoning</thinking>");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["text", "reasoning"],
  );
  assert.equal(segments[0].text, "- ");
});

test("splitting is idempotent — a second pass finds nothing", () => {
  const first = splitReasoning("<thinking>one</thinking>\nvisible\n<thinking>two</thinking>");
  const rejoined = first
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("");
  assert.equal(hasReasoningTags(rejoined), false);
});

test("a tag with attributes is not matched — narrower surface, fewer surprises", () => {
  assert.equal(hasReasoningTags("<thinking source=\"model\">x</thinking>"), false);
});

test("splitting is idempotent — the promoted output re-parses to nothing", () => {
  const segments = splitReasoning("<thinking>a</thinking>b");
  const textOnly = segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("");
  assert.equal(hasReasoningTags(textOnly), false);
});

// --- Review items (leader, 2026-11-10) -------------------------------------------------------

test("a language-labelled fence is still a fence — ```xml with a tag example", () => {
  const input = [
    "The shape is:",
    "",
    "```xml",
    "<thinking>quoted example</thinking>",
    "```",
    "",
    "Done.",
  ].join("\n");
  assert.equal(hasReasoningTags(input), false);
});

test("a ts-labelled fence with a tag example is a fence", () => {
  const input = "```ts\nconst x = '<thinking>example</thinking>';\n```";
  assert.equal(hasReasoningTags(input), false);
});

test("an info string does not stop the fence from closing", () => {
  // ```xml inside the body must not close a fence opened by ```.
  const input = "```\n```xml\n<thinking>inside</thinking>\n```";
  assert.equal(hasReasoningTags(input), false);
});

test("a real block after a language-labelled fence is still promoted", () => {
  const input = "```xml\n<thinking>example</thinking>\n```\n<thinking>real</thinking>";
  assert.deepEqual(bodies(input), ["real"]);
});

test("a backtick info string may not contain a backtick, so that line is not a fence", () => {
  // Per CommonMark this is not a fence opener; the following tag is real prose text.
  const input = "``` a ` b\n<thinking>real</thinking>";
  assert.deepEqual(bodies(input), ["real"]);
});

test("nested same-name openers refuse the ENTIRE text, not just the outer block", () => {
  // The previous revision advanced past the outer opener and then promoted the inner one,
  // which is precisely the guess this parser is supposed to refuse.
  const input = "<thinking>outer <thinking>inner</thinking></thinking>";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(findReasoningBlocks(input), []);
  assert.deepEqual(textOf(input), input);
});

test("mixed <think>/<thinking> nesting is refused", () => {
  const input = "<thinking>a<think>b</think></thinking>";
  assert.equal(hasReasoningTags(input), false);
});

test("nesting refuses even a valid block elsewhere in the same text", () => {
  // Deliberately blunt: a text with an unparseable span promotes nothing. Under-fixing is
  // recoverable; mis-pairing a close tag eats answer text.
  const input = "<thinking>good</thinking>\n<thinking>a<think>b</think></thinking>";
  assert.equal(hasReasoningTags(input), false);
});

test("an unterminated opener refuses the text rather than swallowing the answer", () => {
  const input = "<thinking>no close\nand the answer is 42";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("an orphan closing tag does not veto an otherwise clean text", () => {
  // Orphan closes are common leftover markup (1098 orphan </invoke> in one corpus file) and
  // carry no nesting information, so they are dropped rather than treated as ambiguity.
  const input = "</thinking>\n<thinking>real</thinking>";
  assert.deepEqual(bodies(input), ["real"]);
});

test("a line discussing the tag is not promoted and keeps its markers", () => {
  const input = "<thinking> is the tag that leaks, per the operator.";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

// --- Container-code regressions (leader adversarial probes, fd8812e7) ------------------------
//
// Each of these is a place a literal example of the markup is legitimately written. Promoting
// any of them is a destructive false positive: the example disappears from the answer and
// reappears as reasoning the model never reasoned.

test("four-space indented code is code, not protocol", () => {
  const input = "    <thinking>literal indented code example</thinking>";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("indented code keeps its protected status beside real protocol", () => {
  const input = "    <thinking>example</thinking>\n<thinking>real reasoning</thinking>";
  assert.deepEqual(bodies(input), ["real reasoning"]);
});

test("a tab-indented line is code", () => {
  const input = "\t<thinking>tab indented example</thinking>";
  assert.equal(hasReasoningTags(input), false);
});

test("a multiline inline-code span is code across its line breaks", () => {
  const input = "`multiline code\n<thinking>example</thinking>\n`";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("a multiline inline span closes only on a matching run length", () => {
  const input = "``span with `inside`\n<thinking>x</thinking>\n``";
  assert.equal(hasReasoningTags(input), false);
});

test("fenced code inside a blockquote is code", () => {
  const input = "> ```xml\n> <thinking>quoted fenced example</thinking>\n> ```";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("a blockquote fence closes on a blockquote fence, not on a bare one", () => {
  const input = "> ```\n> <thinking>inside</thinking>\n> ```\n<thinking>real</thinking>";
  assert.deepEqual(bodies(input), ["real"]);
});

test("indented code inside a blockquote is code", () => {
  const input = ">     <thinking>indented quoted example</thinking>";
  assert.equal(hasReasoningTags(input), false);
});

// --- Quoted containers are never promoted (B1) ---------------------------------------------
//
// A quoted line is a quote of something, and the overwhelmingly common case is a pasted example
// of the markup. There is no way to distinguish a quoted example from quoted reasoning, so the
// whole container is refused and preserved byte for byte. This is a deliberate gap: quoted
// reasoning is not a protocol shape worth supporting at the risk of deleting a sentence that
// merely mentions the tag.

test("a plain blockquote tag is not promoted and survives byte for byte", () => {
  const input = "> <thinking>quoted prose example</thinking>";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("a nested blockquote tag is not promoted", () => {
  const input = "> > <thinking>nested quoted example</thinking>";
  assert.equal(hasReasoningTags(input), false);
  assert.deepEqual(textOf(input), input);
});

test("a blockquote containing a list marker is not promoted", () => {
  const input = "> - <thinking>quoted list example</thinking>";
  assert.equal(hasReasoningTags(input), false);
});

test("a blockquote with leading indentation is not promoted", () => {
  const input = "   > <thinking>indented quoted example</thinking>";
  assert.equal(hasReasoningTags(input), false);
});

test("a quoted example does not veto genuine top-level reasoning elsewhere", () => {
  const input = "> <thinking>quoted example</thinking>\n<thinking>real reasoning</thinking>";
  assert.deepEqual(bodies(input), ["real reasoning"]);
});

test("genuine top-level reasoning is still promoted (positive control)", () => {
  assert.deepEqual(bodies("<thinking>real reasoning</thinking>"), ["real reasoning"]);
  assert.deepEqual(bodies("- <thinking>bulleted reasoning</thinking>"), ["bulleted reasoning"]);
});

test("four-space indentation is refused by startsBlock even without masking", () => {
  assert.equal(startsBlock("    <thinking>x", 4), false);
  assert.equal(startsBlock("   <thinking>x", 3), true);
});
