import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ThoughtPresentation } from "../extensions/thought-presentation.ts";

initTheme("dark", false);
const theme = { fg: (_role, text) => text, bold: (text) => text };
const first = "Investigating room tool availability";
const second = "Exploring filesystem-based room messaging";
const summaries = [first, first, second, second];
// Representative of the historical FT-22 thinking source, not its plain display.
const source = summaries.map((text) => `**${text}**`).join("");
const plain = (lines) => lines.map(stripTerminalSequences).map((line) => line.trimEnd());
const details = (text, width = 300, owner = { markdownTheme: getMarkdownTheme() }, presentation = new ThoughtPresentation()) =>
  plain(presentation.details(owner, text, theme, width));
const content = (lines) => lines.map((line) => line.replace(/^  [│└] ?/u, "")).filter(Boolean);

test("FT-22: native synthetic source-versus-display proof", () => {
  const message = { role: "assistant", timestamp: 22, content: [{ type: "thinking", thinking: source, thinkingSignature: "reasoning_content" }] };
  const before = JSON.stringify(message);
  const native = plain(new AssistantMessageComponent(message).render(300));
  assert.equal(native.filter((line) => line.includes(first)).length, 1);
  assert.ok(native.join("\n").includes(first + first), "native Markdown also glues adjacent strong spans");
  assert.deepEqual(content(details(source)), summaries, "each explicit summary span needs its own display paragraph; repetitions remain source-faithful");
  assert.equal(JSON.stringify(message), before, "presentation must not rewrite stored thought/signature");
  if (process.env.FT22_PROOF) console.log(JSON.stringify({ source, native, candidate: details(source) }, null, 2));
});

test("FT-22: progressive snapshots and same-owner cache stay current", () => {
  const owner = { markdownTheme: getMarkdownTheme() };
  const presentation = new ThoughtPresentation();
  for (const [snapshot, expected] of [
    [`**${first}**`, [first]],
    [`**${first}****Exploring`, [first, "**Exploring"]],
    [`**${first}****Exploring filesystem`, [first, "**Exploring filesystem"]],
    [`**${first}****${second}**`, [first, second]],
    [source, summaries],
  ]) {
    assert.deepEqual(content(details(snapshot, 300, owner, presentation)), expected);
  }
  const cached = presentation.details(owner, source, theme, 300);
  assert.equal(presentation.details(owner, source, theme, 300), cached);
  const narrow = details(source, 24, owner, presentation);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 28));
  assert.deepEqual(content(details(source, 300, owner, presentation)), summaries);
});

test("FT-22: raw-only delimiter changes invalidate normalized display cache", () => {
  const owner = { markdownTheme: getMarkdownTheme() };
  const presentation = new ThoughtPresentation();
  const text = "**a****unfinished";
  const render = (source) => plain(presentation.details(owner, text, theme, 160, source));
  assert.deepEqual(content(render(text)), ["a", "**unfinished"]);
  for (const source of [text + " ", text + "\t"]) {
    assert.deepEqual(content(render(source)), [text]);
  }
  assert.deepEqual(content(render(text)), ["a", "**unfinished"]);
});

test("FT-22: ordinary prose, unmarked duplication, and code are not guessed apart", () => {
  for (const text of [
    "Investigating XInvestigating XExploring Y",
    "A sentence with **bold****emphasis** inside it.",
    "`**one****two**`",
    "```text\n**one****two**\n```",
    "**one** and **two**",
  ]) {
    const native = plain(new AssistantMessageComponent({ role: "assistant", timestamp: 23, content: [{ type: "thinking", thinking: text }] }).render(300))
      .map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(content(details(text)).map((line) => line.trim()), native, text);
  }
});

for (const text of [
  "** ****b**",
  "**a ****b**",
  "**a**** b**",
  "**a**** **",
  "**[x](https://example.invalid)****y**",
  "**a****[unfinished",
  "**a**** unfinished",
  "**a****unfinished ",
  "**a**** ",
  "**a****",
  "**a****_nested_**",
]) {
  test(`FT-22: ambiguous Markdown stays native: ${JSON.stringify(text)}`, () => {
    const owner = { markdownTheme: getMarkdownTheme() };
    const presentation = new ThoughtPresentation();
    const message = { role: "assistant", timestamp: 24, content: [{ type: "thinking", thinking: text }] };
    const before = JSON.stringify(message);
    const native = new AssistantMessageComponent(message);
    for (const width of [160, 24, 160]) {
      // Strip only the different presentation prefixes. Retain blank rows and
      // literal Markdown, so a newly introduced thematic break cannot hide.
      const baseline = plain(native.render(width)).slice(1).map((line) => line.replace(/^ /u, ""));
      // Native outputPad=1 reserves a column on each side; ThoughtPresentation
      // takes content width directly, so compare at the same width - 2.
      const candidate = details(text, width - 2, owner, presentation).map((line) => line.replace(/^  [│└] ?/u, ""));
      assert.deepEqual(candidate, baseline, `unchanged native rows at width ${width}`);
    }
    assert.equal(JSON.stringify(message), before);
  });
}

test("FT-22: existing summary newlines and Unicode content survive", () => {
  assert.deepEqual(content(details("**检查房间**\n\n**检查房间**\n\n**Vérifier les outils**")), ["检查房间", "检查房间", "Vérifier les outils"]);
  assert.deepEqual(content(details("**检查房间****检查房间****Vérifier les outils**")), ["检查房间", "检查房间", "Vérifier les outils"]);
});
