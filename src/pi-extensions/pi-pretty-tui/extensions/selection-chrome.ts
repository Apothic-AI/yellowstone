/**
 * Copying a selection must yield content, not the frame drawn around it.
 *
 * Pi rebuilds copied text from the rendered screen buffer, so a selection that
 * crosses a framed card carries the frame into the clipboard:
 *
 *     ╭─────────────────────────╮
 *     │ This is a test message. │
 *     ╰─────────────────────────╯
 *
 * Pi exposes no seam for a renderer to declare its chrome, and the copy method
 * is private. Mapping copied rows back to the components that drew them is not
 * an option either: in fullscreen mode Pi's laid-out leaves are `Container`
 * wrappers, not the message components an extension can get a handle on.
 *
 * So this trims each copied line by what it contains. That is sound because Pi
 * never puts box-drawing characters in prose — Markdown tables render as real
 * boxes (`┌─┬─┐`, `│ a │ b │`, `├─┼─┤`) — so a `│` or `─` on a copied line is
 * always frame or table art, never text the user meant to copy. A line that is
 * nothing but art (a rule, or a table separator) is dropped rather than copied
 * as a blank line, so selecting a whole card yields just its text.
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";

// Frame and table art: rounded and square box sets plus the rule glyphs.
const ART = "│┃║┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬─━═";
const ART_CHARS = new RegExp(`[${ART}]`, "u");
const ART_ONLY = new RegExp(`^[\\s${ART}]+$`, "u");
// A gutter is the art glyph plus the single padding space that follows or
// precedes it, which is how the frame renders `│ content │`.
const LEADING_GUTTER = new RegExp(`^[\\s]*[${ART}][\\s]`, "u");
const TRAILING_GUTTER = new RegExp(`[\\s][${ART}][\\s]*$`, "u");
const ANY_ART = new RegExp(`[${ART}]`, "gu");
// A rule row is a whole horizontal border, corner to corner. It may carry a
// title (`╭─ bash ───╮`) or a table separator's junctions, but it is chrome
// either way: the title is a label for the frame, not content of the copy.
const RULE_ROW = new RegExp(`^[\\s]*[╭╰├┌└╔╚╠][^\\n]*[╮╯┤┐┘╗╝╣][\\s]*$`, "u");

/** Remove frame art from one copied line, or undefined if it was pure art. */
export const stripFrame = (line: string): string | undefined => {
  const plain = stripTerminalSequences(line);
  if (!ART_CHARS.test(plain)) return plain.replace(/\s+$/u, "");
  // Drop whole rule rows, including any title they carry.
  if (ART_ONLY.test(plain) || RULE_ROW.test(plain)) return undefined;
  const trimmed = plain
    .replace(LEADING_GUTTER, "")
    .replace(TRAILING_GUTTER, "")
    .replace(ANY_ART, "")
    .replace(/\s+$/u, "");
  return ART_ONLY.test(trimmed) ? undefined : trimmed;
};

/** Rebuild copied text the way Pi does, with frame art removed. */
export const selectionText = (text: string): string | undefined => {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const kept = stripFrame(line);
    if (kept !== undefined) lines.push(kept);
  }
  const result = lines.join("\n");
  return result.trim().length === 0 ? undefined : result;
};
