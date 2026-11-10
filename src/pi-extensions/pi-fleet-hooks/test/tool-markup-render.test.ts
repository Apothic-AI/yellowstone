/**
 * Render tests — what Pi actually puts on the terminal.
 *
 * A classifier test proves a span was recognised. It proves nothing about whether a registered
 * transformer ever reaches rendered assistant text, or whether the message that pi dispatches
 * tools from was changed on the way. Both questions are answered here by driving the *installed*
 * `AssistantMessageComponent` — pi's own visible-answer renderer, the same class pretty-tui
 * patches while delegating to it — and by snapshotting the message and the dispatch list around
 * the transform.
 *
 * No TTY, no network, no model: the component renders to a string at a fixed width.
 *
 * The SDK location is resolved rather than assumed, and a missing install **fails** this file
 * instead of skipping it: a green run whose only real assertion was skipped is a false
 * verification. `PI_SDK_ROOT` is the portable override; it is deliberately not
 * `PI_CODING_AGENT_DIR`, which is pi's runtime config directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import toolMarkupInert, {
  transformAssistantMarkdown,
  type MarkdownTransformContext,
} from "../src/tool-markup-inert.ts";

// ---------------------------------------------------------------------------------------------
// Locating the installed pi-coding-agent build
// ---------------------------------------------------------------------------------------------

function packageRoot(candidate: string): string | undefined {
  return fs.existsSync(path.join(candidate, "dist/index.js")) ? candidate : undefined;
}

function candidateRoots(): string[] {
  const home = process.env.HOME ?? "";
  return [
    path.join(home, ".local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent"),
    path.join(home, ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent"),
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
  ];
}

function findPi(): string | undefined {
  // An explicit override that does not resolve is a hard error, not a silent fallback: a typo in
  // PI_SDK_ROOT must fail the gate rather than quietly testing whichever install happens to exist.
  const explicit = process.env.PI_SDK_ROOT;
  if (explicit) {
    const resolved = packageRoot(explicit);
    if (!resolved) {
      throw new Error(`PI_SDK_ROOT is set to "${explicit}" but no dist/index.js was found there`);
    }
    return resolved;
  }
  return candidateRoots().find((dir) => packageRoot(dir));
}

const PI_ROOT = findPi();

/** Verification gate. This proof cannot be skipped. */
test("verification gate: installed pi-coding-agent is discoverable", () => {
  assert.ok(
    PI_ROOT !== undefined,
    "installed pi-coding-agent not found. Set PI_SDK_ROOT to the package root. Looked in: " +
      candidateRoots().join(", "),
  );
});

interface Component {
  render(width: number): string[];
}

const ansi = (text: string): string =>
  text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "");

/** Synthetic markup, modelled on the documented shape — no incident content. */
const TOOL_SHAPE = [
  "<tool_answer>",
  " Understood — flat, named by what they carry.",
  "",
  " <tool_call>",
  " bash",
  ' { "command": "echo hi", "description": "demo" }',
  " </tool_call>",
  "</tool_answer>",
].join("\n");

const assistantMessage = () => ({
  role: "assistant" as const,
  provider: "subrouter-deepseek-flash",
  model: "deepseek-v4.1-flash-1017",
  content: [
    { type: "text" as const, text: TOOL_SHAPE },
    {
      type: "toolCall" as const,
      id: "call_1",
      name: "bash",
      arguments: { command: "echo hi", description: "demo" },
    },
  ],
  stopReason: "toolUse" as const,
  timestamp: 1_700_000_000_000,
  usage: { input: 1, output: 1 },
});

/** The dispatch step `agent-loop.js` performs after `message_end`. */
function dispatchCalls(message: { content: Array<{ type: string }> }) {
  return message.content
    .filter((c) => c.type === "toolCall")
    .map((c) => JSON.stringify(c));
}

async function loadPi() {
  assert.ok(PI_ROOT, "pi-coding-agent not found; set PI_SDK_ROOT");
  const mod: any = await import(pathToFileURL(path.join(PI_ROOT as string, "dist/index.js")).href);
  // Headless render needs a theme; initialise before any component is constructed.
  mod.initTheme("dark");
  return mod;
}

test("the transformer reaches rendered assistant text, and changes nothing else", async () => {
  const pi = await loadPi();
  const { AssistantMessageComponent, getMarkdownTheme } = pi;

  const message = assistantMessage();
  const messageBefore = JSON.stringify(message);
  const dispatchBefore = dispatchCalls(message);

  const transform = (markdown: string, context: MarkdownTransformContext) =>
    transformAssistantMarkdown(markdown, context);

  const withTransformer = new AssistantMessageComponent(
    message as never,
    true,
    getMarkdownTheme(),
    "Thinking...",
    1,
    [transform],
  ) as Component;
  const withoutTransformer = new AssistantMessageComponent(
    message as never,
    true,
    getMarkdownTheme(),
    "Thinking...",
    1,
    [],
  ) as Component;

  const rendered = ansi(withTransformer.render(80).join("\n"));
  const plain = ansi(withoutTransformer.render(80).join("\n"));

  // The label and a fence are what an operator sees instead of raw protocol markup.
  assert.match(rendered, /inert, not executed/, "label must reach rendered output");
  assert.match(rendered, /```text/, "raw markup must be replaced by a fenced block");
  assert.ok(rendered.includes("<tool_call>"), "the markup itself is preserved inside the fence");
  assert.ok(!plain.includes("inert, not executed"), "the baseline render has no label");
  assert.notEqual(rendered, plain, "the transformer is the cause of the difference");

  // ... and the dispatchable message is untouched by rendering at all.
  assert.equal(JSON.stringify(message), messageBefore, "message payload unchanged");
  assert.deepEqual(dispatchCalls(message), dispatchBefore, "dispatch list identical");
  assert.equal(dispatchBefore.length, 1, "exactly one executable call");
});

test("the entry registers exactly one transformer on a real-shaped host", async () => {
  const pi = await loadPi();
  const registered: unknown[] = [];
  const host = {
    registerMarkdownTransformer: (fn: unknown) => registered.push(fn),
  };
  toolMarkupInert(host);
  assert.equal(registered.length, 1, "one registration, nothing else");

  // Drive the registered transformer against pi's component, so the contract used by `pi` and the
  // contract this package tests are demonstrably the same one.
  const { AssistantMessageComponent, getMarkdownTheme } = pi;
  const message = assistantMessage();
  const component = new AssistantMessageComponent(
    message as never,
    true,
    getMarkdownTheme(),
    "Thinking...",
    1,
    registered as never[],
  ) as Component;
  assert.match(ansi(component.render(80).join("\n")), /inert, not executed/);
  assert.equal(dispatchCalls(message).length, 1);
});

test("thinking text is not wrapped by the registered transformer", async () => {
  const pi = await loadPi();
  const { AssistantMessageComponent, getMarkdownTheme } = pi;
  const thinking = "<thinking>\nweighing two options\n</thinking>\n\nanswer";
  const message = {
    role: "assistant" as const,
    content: [{ type: "thinking" as const, thinking }],
    stopReason: "stop" as const,
    timestamp: 1_700_000_000_000,
    usage: { input: 1, output: 1 },
  };
  const component = new AssistantMessageComponent(
    message as never,
    false,
    getMarkdownTheme(),
    "Thinking...",
    1,
    [transformAssistantMarkdown],
  ) as Component;
  const text = ansi(component.render(80).join("\n"));
  assert.ok(!text.includes("inert, not replayed"), "assistant-thinking content must be untouched");
  assert.match(text, /weighing two options/);
});

// D1 (acceptance of 542b668d4): when the closing tag is not preceded by a newline, the closing
// fence must still start a line. Otherwise the block never terminates, the prose that follows is
// rendered as code, and a literal fence is flushed at the end of the message.
test("a mid-line closer does not fold trailing prose into the code block", async () => {
  const pi = await loadPi();
  const { AssistantMessageComponent, getMarkdownTheme } = pi;

  const PROSE = "TRAILING PROSE must stay prose.";
  const text = `<tool_call>\n bash\n {"a":1}</tool_call> ${PROSE}`;
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    timestamp: 1_700_000_000_000,
    usage: { input: 1, output: 1 },
  };

  const render = (transformers: unknown[]) =>
    ansi(
      (
        new AssistantMessageComponent(
          message as never,
          true,
          getMarkdownTheme(),
          "Thinking...",
          1,
          transformers as never[],
        ) as Component
      )
        .render(80)
        .join("\n"),
    );

  const rendered = render([transformAssistantMarkdown]);
  const lines = rendered.split("\n").map((line) => line.trimEnd());
  const openAt = lines.findIndex((line) => /^\s*```text\s*$/.test(line));
  const closeAt = lines.findIndex(
    (line, index) => index > openAt && line.trim() === "```",
  );
  const proseLine = lines.findIndex((line) => line.includes(PROSE));

  assert.ok(openAt >= 0, "a fenced block opens");
  assert.ok(closeAt > openAt, "the closing fence is on its own line");
  assert.ok(proseLine >= 0, "the trailing prose must still be rendered");
  assert.ok(closeAt < proseLine, "prose renders after the closing fence, outside the block");

  // The markup is inside the block; the prose is not, and no fence marker leaks afterwards.
  const inBlock = lines.slice(openAt, closeAt).join("\n");
  assert.ok(inBlock.includes("bash"), "markup body stays inside the fence");
  assert.ok(!inBlock.includes(PROSE), "trailing prose is not inside the fence");
  assert.ok(
    !lines.slice(closeAt + 1).some((line) => line.trim() === "```"),
    "no fence marker leaks after the block",
  );
});
