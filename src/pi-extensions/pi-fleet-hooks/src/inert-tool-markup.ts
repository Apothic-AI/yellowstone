// inert-tool-markup — find model-emitted tool-protocol markup and render it inert.
//
// The defect (FT-47): some models emit their own harness's *tool-protocol* delimiters as literal
// text instead of (or in addition to) a structured tool call. Pi's stream parsers build a
// toolCall block only from a structured channel (`choice.delta.tool_calls` on Chat Completions),
// so that markup stays a TextContent block and renders as prose. See
// `docs/FT-47-INERT-TOOL-MARKUP.md`.
//
// This module is the classifier *and* the renderer, and it is display-only. It transforms a
// Markdown string on its way to Pi's renderer. It does not read or write a message, cannot add a
// toolCall block, and never executes anything — which matters, because `message_end` runs before
// pi dispatches tools (`agent-loop.js` emits the event, then filters `content` for `toolCall`
// blocks), so anything that manufactured a call there would run, and in the observed corpus the
// prose usually duplicates a call the model already emitted.
//
// Two families, both inert:
//
//   tool      `<tool_call>`, `<tool_answer>`, `<invoke>`, `<function_call>`, `<tool_result>`
//             — a harness's call serialisation. Labelled "not executed".
//   reasoning `<analysis>`, `<summary>`
//             — a harness's scratchpad/answer split. Labelled "not replayed", because FT-37
//             deliberately does not claim these: promoting them to thinking blocks would change
//             reasoning-replay semantics, which is out of scope here.
//
// Conservatism is the whole design, and it is the same conservatism as `reasoning-tags.ts`:
// a false negative leaves today's behaviour, a false positive restyles a sentence or eats a
// quoted example. So:
//
//   1. An opener must start its line — at most three columns of indentation, no list marker, no
//      blockquote marker. A marker line is refused rather than restructured, because this
//      renderer *inserts* a fenced block and a fence cannot live mid-list without corrupting it.
//   2. Content inside a fence, an indented block, or an inline span is an example, not protocol.
//      That mask is `codeMask` from `reasoning-tags.ts`, imported rather than re-written: one
//      definition of "literal container" for both FT-37 and FT-47.
//   3. A span must close with a *same-name* tag at matching depth. Markup nested inside an
//      accepted span collapses into it, so a `<tool_answer>` wrapping a `<tool_call>` is one
//      inert block, not three.
//   4. An unclosed opener is left byte-identical. That is what makes streaming safe: a partial
//      turn cannot swallow the prose that follows it.
//   5. Surrounding text is preserved in order and byte for byte.

import { codeMask, columns } from "./reasoning-tags.ts";

/** Which construct the markup imitates. Drives the label only. */
export type InertFamily = "tool" | "reasoning";

/** One recognised span, as offsets into the original Markdown. */
export interface InertSpan {
  family: InertFamily;
  /** The opener's tag name, lower-case. */
  name: string;
  /** Offset of the opening "<". */
  start: number;
  /** Offset just past the opening ">". */
  bodyStart: number;
  /** Offset of the closing "<". */
  bodyEnd: number;
  /** Offset just past the closing ">". */
  end: number;
}

const FAMILY: Readonly<Record<string, InertFamily>> = {
  tool_call: "tool",
  tool_answer: "tool",
  invoke: "tool",
  function_call: "tool",
  tool_result: "tool",
  analysis: "reasoning",
  summary: "reasoning",
};

/**
 * Tag families this renderer recognises.
 *
 * `invoke` is here because it is the dominant protocol-shaped form in the bounded FT-47 corpus
 * (1,120 occurrences against 50 for `<tool_call>`), and `tool_result` because it is the same
 * harness's result side. Names are matched case-insensitively with an optional `/` for the
 * closing form, and attribute text is tolerated but not interpreted.
 */
const TAG = new RegExp(`<\\s*(/)?\\s*(${Object.keys(FAMILY).join("|")})\\b[^>]*>`, "gi");

const LABEL: Readonly<Record<InertFamily, string>> = {
  tool: "⏸ model-emitted tool-protocol markup — inert, not executed",
  reasoning: "⏸ model-emitted analysis/summary markup — inert, not replayed",
};

/**
 * True when an opener may begin an inert block.
 *
 * Stricter than `startsBlock` in `reasoning-tags.ts` on purpose: that one permits list markers
 * because it only *removes* text, while this one inserts a fenced block and would break the list.
 */
export function startsBlock(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  if (!/^[ \t]*$/.test(prefix)) return false;
  return columns(prefix) <= 3;
}

/**
 * The recognition core. Returns accepted inert spans in document order; nesting collapses into
 * the outermost span. Unclosed openers contribute nothing.
 */
export function findInertSpans(text: string): InertSpan[] {
  if (!text.includes("<")) return [];

  const mask = codeMask(text);
  const hits: Array<{ name: string; closing: boolean; start: number; end: number }> = [];

  for (const match of text.matchAll(TAG)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    let inCode = false;
    for (let i = start; i < end; i++) {
      if (mask[i]) {
        inCode = true;
        break;
      }
    }
    if (inCode) continue;
    hits.push({ name: match[2].toLowerCase(), closing: Boolean(match[1]), start, end });
  }

  const spans: InertSpan[] = [];
  let open: (typeof hits)[number] | null = null;
  let depth = 0;

  for (const hit of hits) {
    if (!hit.closing) {
      if (depth === 0) {
        open = startsBlock(text, hit.start) ? hit : null;
        depth = open ? 1 : 0;
        continue;
      }
      depth++;
      continue;
    }
    // Orphan closing tags are leftover markup from a truncated protocol: they carry no nesting
    // information, so they must not veto a span that is otherwise well formed.
    if (depth === 0) continue;
    depth--;
    if (depth > 0) continue;
    if (!open || hit.name !== open.name) {
      open = null;
      continue;
    }
    const body = text.slice(open.end, hit.start);
    if (body.trim().length > 0) {
      spans.push({
        family: FAMILY[open.name] ?? "tool",
        name: open.name,
        start: open.start,
        bodyStart: open.end,
        bodyEnd: hit.start,
        end: hit.end,
      });
    }
    open = null;
  }

  return spans;
}

/** A fence longer than any backtick run inside the body, so the block cannot close early. */
export function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Rewrites every accepted span as a labelled, fenced block; everything else is preserved.
 *
 * Idempotent by construction: the rewritten tags sit inside a fence, so a second pass masks them
 * and returns its input unchanged.
 */
export function renderInertMarkdown(markdown: string): string {
  const spans = findInertSpans(markdown);
  if (spans.length === 0) return markdown;

  let out = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) out += markdown.slice(cursor, span.start);
    const body = markdown.slice(span.bodyStart, span.bodyEnd);
    out += `${LABEL[span.family]}\n${fenceFor(body)}text\n${body}${fenceFor(body)}\n`;
    cursor = span.end;
  }
  out += markdown.slice(cursor);
  return out;
}

/**
 * The two `messageType` values this renderer acts on.
 *
 * `assistant-thinking` is FT-37's surface (already reclassified, or deliberately left literal on
 * adapters that cannot replay it), and user text may be an example the operator pasted, so both
 * are returned untouched.
 */
export function isRenderableMessageType(messageType: string): boolean {
  return messageType === "assistant";
}
