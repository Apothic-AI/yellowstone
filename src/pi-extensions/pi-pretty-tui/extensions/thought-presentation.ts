import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";

// Some reasoning_content sources already contain adjacent **summary** spans,
// including repetitions. Add only display boundaries where the entire payload
// is a stream of plain strong spans (possibly with an unfinished last span).
// Do not infer boundaries in prose/code or discard repeated source content.
function summaryParagraphs(text: string, source: string): string {
  // Fail closed on nested Markdown and invalid delimiter whitespace. Otherwise
  // a pseudo-span such as ** ** could become a thematic break after splitting.
  if (/[`\\_[\]()<>~&]/u.test(source)) return text;
  if (!/^(?:\*\*[^*\r\n]+\*\*(?:[ \t]*\r?\n[ \t]*)*)+(?:\*\*[^*\r\n]+)?$/u.test(source)) return text;
  for (const [, body] of source.matchAll(/\*\*([^*]+?)(?:\*\*|$)/gu)) {
    if (!body.trim() || body.trim() !== body) return text;
  }
  return text.replace(/(\*\*[^*\r\n]+\*\*)(?=\*\*)/gu, "$1\n\n");
}

/** Thought content is independent of activity grouping and mode defaults. */
export class ThoughtPresentation {
  private cache = new WeakMap<object, {
    text: string; source: string; theme: any; palette: string; markdownTheme: any; component: Markdown;
    width?: number; lines?: string[];
  }>();

  header(label: string, width: number, theme: any): string {
    return truncateToWidth(
      theme.fg("mdLink", "● ") + theme.fg("text", theme.bold(label)),
      Math.max(1, width), "…",
    );
  }

  details(owner: any, text: string, theme: any, contentWidth: number, source = text): string[] {
    const palette = ["dim", "muted", "mdHeading", "mdCode", "mdCodeBlock", "mdLink"]
      .map((role) => theme.fg(role, "x")).join("|");
    let detail = this.cache.get(owner);
    if (!detail || detail.text !== text || detail.source !== source || detail.theme !== theme || detail.palette !== palette || detail.markdownTheme !== owner.markdownTheme) {
      detail = {
        text, source, theme, palette, markdownTheme: owner.markdownTheme,
        component: new Markdown(summaryParagraphs(text, source), 0, 0, owner.markdownTheme, {
          color: (line: string) => theme.fg("muted", line), italic: true,
        }),
      };
      this.cache.set(owner, detail);
    }
    if (detail.width === contentWidth && detail.lines) return detail.lines;
    const lines = detail.component.render(Math.max(1, contentWidth));
    detail.width = contentWidth;
    detail.lines = lines.map((line, index) =>
      theme.fg("dim", index === lines.length - 1 ? "  └ " : "  │ ") + line,
    );
    return detail.lines;
  }
}
