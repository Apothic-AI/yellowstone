// harmony-duplicate-calls — recognise and remove tool calls that a checkpoint also spelled out
// as plain assistant text (FT-92).
//
// The defect: on some checkpoints (measured on gpt-6.2-sol through the openai-completions
// adapter) a response reports a tool call natively *and* writes the same call into its content
// channel in the openai-harmony recipient syntax:
//
//     {"path":"/tmp/x","offset":55,"limit":90} to=functions.read
//      to=functions.rooms_reply_all(team)
//     {"command":"grep -n -m 1 '...'"}   to=functions.bash
//
// pi keeps both, faithfully: `delta.content` becomes a text block, `delta.tool_calls` becomes a
// toolCall block, and nothing reconciles them. The text block is pure context tax — pi executes
// only toolCall blocks, so a text block has never run anything, and removing it cannot change
// behaviour. On the recorded evidence that tax is large: the nine known instances in one band
// carried 106 KB of duplicated calls, one of them 99 KB on its own.
//
// The detector is structural on purpose, not a shape-match on one recorded variant:
//
//   1. a recipient marker naming a tool (`to=functions.<name>`), and
//   2. after removing every JSON payload and every marker in the block, at most `MAX_RESIDUE`
//      characters of other content remain.
//
// Rule 2 is what keeps prose safe. A message that *discusses* this defect — quoting a leaked
// line inside a sentence — leaves the sentence behind, so it fails the residue test and is left
// alone. A leaked block is payload and marker only, so it passes whatever order the checkpoint
// emitted them in, whether the braces balance (one recorded variant ends `to=functions.find(
// pattern:"*")}`) and whether the payload repeats.
//
// The rule is also independent of the model id. The marker never occurs in legitimate content
// on this machine (a whole-home search found it only in harmony parsers and documents quoting
// them), so gating by model would only narrow a fix that already has a reliable discriminator —
// and would miss the next checkpoint that inherits the behaviour.

export interface AssistantMessageLike {
  role: string;
  content: unknown[];
  [key: string]: unknown;
}

export type HarmonyLeakKind = "duplicate" | "stale" | "fragment" | "aborted_edit_args";

export interface HarmonyLeak {
  /** Index of the offending text block in `message.content`. */
  index: number;
  /** `duplicate`: restates a native call in the same message. `stale`: parses as a call but has
   *  no native counterpart. `fragment`: a marker with no parseable payload. */
  kind: HarmonyLeakKind;
  /** The first tool named by a marker in the block, when one is named. */
  tool: string | null;
  chars: number;
}

export interface HarmonyStripResult {
  changed: boolean;
  message: AssistantMessageLike;
  removed: HarmonyLeak[];
  removedChars: number;
  counts: Record<HarmonyLeakKind, number>;
}

/** Characters other than JSON payloads and markers a leaked block may still contain. Measured
 *  variants leave at most `"]}`, `|}`, `(team)` and stray punctuation behind; prose leaves
 *  sentences. */
export const MAX_RESIDUE = 80;

/** A block can repeat the same leaked call once per attempted call — the loop of record 12559
 *  repeated it thirteen times — and each repetition may leave a little debris behind. The
 *  allowance therefore scales with the number of markers instead of being a fixed ceiling: a
 *  thirteen-repetition block is not made of prose because its debris added up. */
export const RESIDUE_PER_MARKER = 24;

const RECIPIENT = /to=functions\.([A-Za-z_][A-Za-z0-9_]*)/g;

interface Span {
  start: number;
  end: number;
}

/** Every `{...}` in the text that parses as a JSON object, string-aware so a brace inside a
 *  string cannot end a span early. A block that never closes is skipped rather than guessed at,
 *  unless `tail` is set — a message that was interrupted mid-payload still ends inside a call it
 *  was spelling out, and that tail is payload, not the start of a sentence. */
export function jsonObjectSpans(text: string, options: { tail?: boolean } = {}): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) {
      // Unterminated: with `tail`, the rest of the block is the payload that never finished.
      if (options.tail) {
        spans.push({ start: i, end: text.length });
        break;
      }
      i += 1;
      continue;
    }
    const slice = text.slice(i, end);
    try {
      JSON.parse(slice);
      spans.push({ start: i, end });
      i = end;
    } catch {
      i += 1;
    }
  }
  return spans;
}

function markerSpans(text: string): Array<Span & { tool: string }> {
  const out: Array<Span & { tool: string }> = [];
  RECIPIENT.lastIndex = 0;
  let match = RECIPIENT.exec(text);
  while (match !== null) {
    // Absorb an inline argument list — `to=functions.rooms_reply_all(team)` — so the residue
    // test is not fooled by its parentheses.
    let end = match.index + match[0].length;
    if (text[end] === "(") {
      let depth = 0;
      for (let j = end; j < text.length; j += 1) {
        if (text[j] === "(") depth += 1;
        else if (text[j] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = j + 1;
            break;
          }
        }
      }
    }
    out.push({ start: match.index, end, tool: match[1] });
    match = RECIPIENT.exec(text);
  }
  return out;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

function stable(value: unknown): string {
  try {
    return JSON.stringify(sortKeysDeep(value));
  } catch {
    return "";
  }
}

/** How much of a block is *not* a payload or a marker. Whitespace is ignored: the recorded
 *  variants differ only in newlines and spaces. */
export function residualLength(text: string): number {
  const spans = [...jsonObjectSpans(text, { tail: true }), ...markerSpans(text)].sort(
    (a, b) => a.start - b.start,
  );
  let cursor = 0;
  let out = "";
  for (const span of spans) {
    if (span.start > cursor) out += text.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  out += text.slice(cursor);
  return out.replace(/\s+/g, "").length;
}

function nativeCalls(message: AssistantMessageLike): Array<{ name: string; args: string }> {
  const out: Array<{ name: string; args: string }> = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (b.type !== "toolCall") continue;
    out.push({ name: typeof b.name === "string" ? b.name : "", args: stable(b.arguments) });
  }
  return out;
}

/** A leaked block begins with its payload or its marker. A sentence begins with a sentence — and
 *  that first character is what keeps an explanation that *quotes* a leaked line out of the fix. */
export function isCallShaped(text: string): boolean {
  const head = text.replace(/^\s+/, '');
  return head.startsWith("{") || head.startsWith("to=functions.");
}

/** Classify one text block. `null` means "as far as this module can tell, this is prose". */
export function classifyHarmonyBlock(
  text: string,
  natives: readonly { name: string; args: string }[],
): { kind: HarmonyLeakKind; tool: string | null } | null {
  if (!isCallShaped(text)) return null;
  const markers = markerSpans(text);
  if (markers.length === 0) return null;
  const allowance = Math.max(MAX_RESIDUE, RESIDUE_PER_MARKER * markers.length);
  if (residualLength(text) > allowance) return null;

  const payloads: unknown[] = [];
  for (const span of jsonObjectSpans(text)) {
    try {
      payloads.push(JSON.parse(text.slice(span.start, span.end)));
    } catch {
      /* jsonObjectSpans already parsed it; unreachable in practice */
    }
  }

  const tool = markers[0]?.tool ?? null;
  if (payloads.length === 0) return { kind: "fragment", tool };

  for (const payload of payloads) {
    const args = stable(payload);
    if (args && natives.some((call) => call.name === tool && call.args === args)) {
      return { kind: "duplicate", tool };
    }
  }
  return { kind: "stale", tool };
}

/** Drop text that is an interrupted edit-argument JSON prefix. This deliberately recognizes only
 *  the observed path-then-edits-array shape; complete JSON and unrelated JSON are not candidates. */
export function isAbortedEditArgsPrefix(text: string): boolean {
  try {
    JSON.parse(text);
    return false;
  } catch {
    return /^\s*\{\s*"path"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"edits"\s*:\s*\[/.test(text);
  }
}

/** Drop every text block in an assistant message that is a leaked call. `aborted` additionally
 *  enables the narrowly-scoped edit-argument prefix cleanup; history repair never enables it. */
export function stripHarmonyToolCalls(
  message: AssistantMessageLike,
  options: { aborted?: boolean } = {},
): HarmonyStripResult {
  const empty: Record<HarmonyLeakKind, number> = {
    duplicate: 0,
    stale: 0,
    fragment: 0,
    aborted_edit_args: 0,
  };
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return { changed: false, message, removed: [], removedChars: 0, counts: empty };
  }

  const natives = nativeCalls(message);
  const removed: HarmonyLeak[] = [];
  const counts: Record<HarmonyLeakKind, number> = {
    duplicate: 0,
    stale: 0,
    fragment: 0,
    aborted_edit_args: 0,
  };
  let removedChars = 0;
  const content: unknown[] = [];

  message.content.forEach((block, index) => {
    const text =
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? (block as { text?: unknown }).text
        : undefined;
    if (typeof text !== "string") {
      content.push(block);
      return;
    }
    const abortedEditArgs = options.aborted === true && isAbortedEditArgsPrefix(text);
    const verdict = abortedEditArgs
      ? { kind: "aborted_edit_args" as const, tool: null }
      : classifyHarmonyBlock(text, natives);
    if (!verdict) {
      content.push(block);
      return;
    }
    counts[verdict.kind] += 1;
    removedChars += text.length;
    removed.push({ index, kind: verdict.kind, tool: verdict.tool, chars: text.length });
    // The block is dropped whole: removing the marker and the payload is the same thing, and a
    // block that passed the residue test has nothing else in it worth keeping.
  });

  if (removed.length === 0) {
    return { changed: false, message, removed, removedChars: 0, counts };
  }
  return {
    changed: true,
    message: { ...message, content },
    removed,
    removedChars,
    counts,
  };
}
