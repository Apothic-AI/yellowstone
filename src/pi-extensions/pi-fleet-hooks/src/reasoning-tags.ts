// reasoning-tags — find reasoning markup a model wrote as ordinary prose.
//
// Some models emit their own harness's reasoning delimiters as literal text instead of a
// structured reasoning field. Pi's stream parsers only build a ThinkingContent block from a
// real reasoning channel (`reasoning_content` / `reasoning` / `reasoning_text` in Chat
// Completions, `thought` parts in Gemini, signatures in Anthropic), so text arriving in the
// visible content field stays a TextContent block and renders as prose. See
// `FT-37-47-MECHANISM.md` in the Fleet record for the full citation trail.
//
// This module is the *detector*: pure, no Pi imports, no I/O, no provider or model names. It
// answers one question — "which spans of this string are delimited reasoning?" — and nothing
// else. Deciding what to do with the answer (and whether the target adapter can replay it)
// belongs to `reasoning-replay.ts`.
//
// Conservatism is the whole design. A false negative leaves today's behaviour (tags shown as
// prose, which is the bug but not a regression); a false positive eats visible answer text or
// corrupts a quoted example. Every rule below refuses rather than guesses:
//
//   1. Two spellings only, `<thinking>` and `<think>`. FT-47's tool-protocol tags are
//      deliberately absent: reclassifying `<tool_call>` prose as reasoning would misrepresent
//      it. Rendering those is a separate, cosmetic concern and not this file's business.
//   2. A tag inside a code fence or inline code span is an example, not protocol. Fences are
//      recognised with their info string (```xml, ```ts), because the examples that matter
//      most for this defect are language-labelled.
//   3. An opening tag must start its block, and a quoted container is never promoted at all.
//      Prose like "the <thinking> tag leaks" is left alone unless it happens to sit at the head
//      of a line; a line inside a blockquote is left alone even then, because a quote is more
//      likely to be a pasted example than protocol and the two are indistinguishable.
//   4. The whole tag sequence must be a clean, strictly non-nested alternation of open/close
//      pairs. If any opener appears inside another reasoning block — same name or the other
//      one — EVERY block in the text is refused, because which close terminates which body is
//      unknowable and guessing is how answer text gets eaten. Orphan closing tags are dropped
//      rather than treated as nesting; they are common leftover markup and carry no ambiguity.
//   5. A block needs a matching close tag. An unterminated opener is refused, never swallowed.
//   6. Text between and around recognised blocks is preserved byte for byte, in order.

/** A run of the original text, classified. */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string };

/** A recognised reasoning block, as offsets into the original string. */
export interface ReasoningBlock {
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

/**
 * Opening tag, tolerant of inner whitespace (`< thinking >`) because models vary, but not of
 * attributes — a tag with attributes is not the shape these templates emit, and accepting it
 * widens the false-positive surface for no gain.
 */
const OPEN = /<\s*(thinking|think)\s*>/g;

const CLOSE = /<\s*\/\s*(thinking|think)\s*>/g;

/**
 * Width of a whitespace run in columns, with a tab advancing to the next multiple of four.
 *
 * Counting a tab as one character is how a tab-indented code block slips past an indentation
 * check; CommonMark expands it to the next tab stop, which is what the four-column rule means.
 */
export function columns(whitespace: string): number {
  let width = 0;
  for (const char of whitespace) {
    if (char === "\t") {
      width += 4 - (width % 4);
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Strips blockquote markers from a line, returning the remainder.
 *
 * Blockquotes matter because `> ```xml` is a fence inside a blockquote, and `> <thinking>` is a
 * quoted example. The earlier line-local mask never looked past `>`, so both were treated as
 * live protocol.
 */
function stripQuoteMarkers(line: string): string {
  let rest = line;
  while (true) {
    const marker = /^[ \t]{0,3}>[ \t]?/.exec(rest);
    if (!marker) return rest;
    rest = rest.slice(marker[0].length);
  }
}

/**
 * Marks every character that lies inside a code construct: a fenced block, an indented block,
 * or an inline code span.
 *
 * Three container forms have to be honoured, because each one is somewhere an operator or an
 * agent legitimately writes a literal example of the markup this detector looks for:
 *
 *   - **Fenced**, including inside a blockquote (`> ```xml`). The fence marker is tested after
 *     the container prefix, and a backtick fence's info string may not itself contain a
 *     backtick.
 *   - **Indented code**, four or more columns after the container prefix. This is CommonMark's
 *     other code form and it is the most common way a tag example is pasted.
 *   - **Inline spans**, which may cross lines: a backtick opened on one line closes on a later
 *     one. The earlier revision matched per line, so a multi-line span was invisible and its
 *     contents were promoted.
 *
 * This is deliberately not a Markdown parser. It recognises the containers that can hold a
 * literal example and marks them whole; anything subtler is left to the `startsBlock` guard and
 * to the conservative refusals in `findReasoningBlocks`.
 */
export function codeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const lines = text.split(/(?<=\n)/);

  let fence: string | null = null;
  let offset = 0;

  const markLine = (length: number) => {
    for (let i = 0; i < length; i++) mask[offset + i] = true;
  };

  // --- pass 1: fenced blocks, honouring blockquote containers -------------------------------
  for (const line of lines) {
    const body = line.replace(/\n$/, "");
    const quoted = stripQuoteMarkers(body);
    const indent = /^[ \t]*/.exec(quoted)?.[0] ?? "";
    // A fence may be indented by at most three columns.
    const inner = columns(indent) <= 3 ? quoted.slice(indent.length) : "";

    if (fence !== null) {
      markLine(line.length);
      // A closing fence carries no info string.
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(inner);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      offset += line.length;
      continue;
    }

    const open = /^(`{3,}|~{3,})(.*)$/.exec(inner);
    if (open) {
      const marker = open[1];
      const info = open[2];
      // A backtick fence's info string may not contain a backtick.
      if (marker[0] === "~" || !info.includes("`")) {
        fence = marker;
        markLine(line.length);
      }
    }

    offset += line.length;
  }

  // --- pass 2: indented code blocks ---------------------------------------------------------
  offset = 0;
  for (const line of lines) {
    const body = line.replace(/\n$/, "");
    const already = mask.slice(offset, offset + line.length).every(Boolean);
    if (!already && body.trim().length > 0) {
      const quoted = stripQuoteMarkers(body);
      const indent = /^[ \t]*/.exec(quoted)?.[0] ?? "";
      // Four or more columns is an indented code block. A tab reaches column four by itself.
      if (columns(indent) >= 4) markLine(line.length);
    }
    offset += line.length;
  }

  // --- pass 3: inline code spans, allowed to cross lines ------------------------------------
  let i = 0;
  while (i < text.length) {
    if (mask[i] || text[i] !== "`") {
      i++;
      continue;
    }
    let runLength = 0;
    while (text[i + runLength] === "`" && !mask[i + runLength]) runLength++;

    // Find the next unmasked run of exactly the same length.
    let closeAt = -1;
    let scan = i + runLength;
    while (scan < text.length) {
      if (mask[scan] || text[scan] !== "`") {
        scan++;
        continue;
      }
      let candidateLength = 0;
      while (text[scan + candidateLength] === "`" && !mask[scan + candidateLength]) candidateLength++;
      if (candidateLength === runLength) {
        closeAt = scan;
        break;
      }
      scan += candidateLength;
    }

    if (closeAt === -1) {
      // Unterminated run: not a span. Leave it as text rather than masking the rest.
      i += runLength;
      continue;
    }

    for (let k = i; k < closeAt + runLength; k++) mask[k] = true;
    i = closeAt + runLength;
  }

  return mask;
}

/**
 * True when the tag at `index` begins its block.
 *
 * At most three columns of indentation, then list markers, then whitespace. Two refusals ride
 * along, and both exist because the alternative is eating a literal example:
 *
 *   - **Four or more columns** is an indented code block. `codeMask` masks that case; this is
 *     the second line of defence if masking ever misses a container.
 *   - **A blockquote marker anywhere in the prefix** refuses the tag outright. A quoted line is
 *     a quote of something — most often a pasted example of the markup — and this detector has
 *     no way to tell a quoted example from quoted reasoning. Rather than guess, quoted
 *     containers are never promoted: the text is preserved byte for byte. This is a deliberate
 *     gap, not an oversight: quoted reasoning is not a protocol shape worth supporting at the
 *     risk of silently deleting a sentence that merely *mentions* the markup.
 */
export function startsBlock(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);

  // Measure the leading run first, then match only what follows it. Folding the budget into one
  // regex lets the trailing `[ \t]*` swallow a fourth space, which is exactly the indented-code
  // boundary.
  const leading = /^[ \t]*/.exec(prefix)?.[0] ?? "";
  if (columns(leading) > 3) return false;

  const rest = prefix.slice(leading.length);
  // A quote marker means "this is quoted material", so nothing here is promoted.
  if (rest.includes(">")) return false;

  return /^(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*[ \t]*$/.test(rest);
}

interface TagHit {
  name: string;
  start: number;
  end: number;
  closing: boolean;
}

/** Every reasoning tag in `text` that is not inside a code span, in document order. */
function tagHits(text: string, mask: boolean[]): TagHit[] {
  const hits: TagHit[] = [];

  for (const source of [OPEN, CLOSE]) {
    source.lastIndex = 0;
    for (const match of text.matchAll(source)) {
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
      hits.push({ name: match[1], start, end, closing: match[0].includes("/") });
    }
  }

  return hits.sort((a, b) => a.start - b.start);
}

/**
 * The recognition core. Returns accepted reasoning blocks in document order, or an empty array
 * when the tag sequence is not unambiguously parseable.
 *
 * This is the single recognition core: every consumer is defined in terms of it, so the
 * durable path and any future display path cannot drift into two different definitions of
 * "looks like a tag".
 */
export function findReasoningBlocks(text: string): ReasoningBlock[] {
  if (!text.includes("<")) return [];

  const mask = codeMask(text);
  const all = tagHits(text, mask);

  // Drop orphan closing tags. They are leftover markup from a truncated or partially consumed
  // protocol and carry no nesting information, so they must not veto an otherwise clean text.
  const balanced: TagHit[] = [];
  let depth = 0;
  for (const hit of all) {
    if (hit.closing) {
      if (depth === 0) continue;
      depth--;
      balanced.push(hit);
    } else {
      depth++;
      balanced.push(hit);
    }
  }

  // Strict alternation, and names must match within each pair. Anything else — nested openers,
  // mixed <think>/<thinking> nesting, an unterminated opener — refuses the whole text.
  if (balanced.length % 2 !== 0) return [];
  const pairs: Array<{ open: TagHit; close: TagHit }> = [];
  for (let i = 0; i < balanced.length; i += 2) {
    const open = balanced[i];
    const close = balanced[i + 1];
    if (open.closing || !close.closing) return [];
    if (open.name !== close.name) return [];
    pairs.push({ open, close });
  }

  const blocks: ReasoningBlock[] = [];
  for (const { open, close } of pairs) {
    if (!startsBlock(text, open.start)) continue;
    if (text.slice(open.end, close.start).trim().length === 0) continue;
    blocks.push({
      name: open.name,
      start: open.start,
      bodyStart: open.end,
      bodyEnd: close.start,
      end: close.end,
    });
  }

  return blocks;
}

/**
 * Splits `text` into ordered segments, promoting delimited reasoning and leaving everything
 * else untouched.
 */
export function splitReasoning(text: string): Segment[] {
  const blocks = findReasoningBlocks(text);
  if (blocks.length === 0) return [{ kind: "text", text }];

  const segments: Segment[] = [];
  let cursor = 0;

  for (const block of blocks) {
    if (block.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, block.start) });
    }
    segments.push({ kind: "reasoning", text: text.slice(block.bodyStart, block.bodyEnd) });
    cursor = block.end;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }

  return segments;
}

/** True when `splitReasoning` would promote anything. */
export function hasReasoningTags(text: string): boolean {
  return findReasoningBlocks(text).length > 0;
}
