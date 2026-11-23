/**
 * FT-92 — leaked harmony tool-call text: classifier, stripper, and hook wiring.
 *
 * The aborted edit-argument recurrence is based on the prefix supplied by SI (`{"path":...,"edits":[...`);
 * the exact session entry has not been independently located, so these tests use synthetic bytes.
 * Every fixture below except the synthetic large one is copied verbatim from the session record
 * where the defect was found (yellowstone-leader, 2026-11-20, `gpt-6.2-sol` band). The large
 * fixture is modelled on record line 12216, whose single text block held 99,395 characters of a
 * codemode payload — the reason this matters is volume, so the test keeps that shape without
 * copying the payload.
 *
 * The invariant under test: a leaked block is removed, every native `toolCall` survives, and
 * prose that merely quotes the marker is never touched. A false positive here deletes an
 * explanation; a false negative leaves the context tax in place.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RESIDUE,
  classifyHarmonyBlock,
  isAbortedEditArgsPrefix,
  jsonObjectSpans,
  residualLength,
  stripHarmonyToolCalls,
  type AssistantMessageLike,
} from "../src/harmony-duplicate-calls.ts";
import harmonyDuplicates, {
  harmonyStripCounters,
  resetHarmonyStripCounters,
  stripAssistantMessage,
} from "../src/harmony-duplicates.ts";

/** Record line 12075: payload, newline, marker, stray brace. Native call in that message: read. */
const FIXTURE_12075 = `{"path":"/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget"}
to=functions.find(pattern:"*")}
`;

/** Record line 12077: payload, marker, inline arguments, trailing junk. */
const FIXTURE_12077 = `{"path":"/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget"} to=functions.grep(pattern:"display: false|MONITORS_WIDGET_KEY|watchersPills",path:"/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget/src/pi-extensions/bizzy",glob:"**/*.ts",context:4,limit:30)"]}
`;

/** Record line 12156: the variant with stray wide punctuation and a second payload. */
const FIXTURE_12156 = `{"path":"/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget/src/pi-extensions/bizzy/node_modules/.bin"}
to=functions.ls \u3011\u3010\u3002\u3011\u3010\u201d\u3011\u3010commentary json}elseif{} for functions.ls:
{"path":"/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget/src/pi-extensions/bizzy"}`;

/** Record line 12265: marker and an inline argument list, nothing else. */
const FIXTURE_12265 = ` to=functions.rooms_reply_all(team)`;

/** Record line 12236: payload, marker, then the payload repeated. */
const FIXTURE_12236 = `{"path":"/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget/src/pi-extensions/bizzy/src/__tests__/monitor-widget.test.ts","offset":55,"limit":90} to=functions.read
{"path":"/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget/src/pi-extensions/bizzy/src/__tests__/monitor-widget.test.ts","offset":55,"limit":90}`;

/** Shape of record line 12216: one codemode payload restated as text, ~99 KB in the record. */
function largeFixture(bytes = 24_000): string {
  const body = "x".repeat(bytes);
  // Built with JSON.stringify so the fixture is really parseable JSON: the defect is about
  // volume, and a hand-escaped payload would test the escaping instead of the volume.
  const payload = JSON.stringify({
    code: `// @options: {"max_output_tokens": 2000, "timeout_ms": 500000}\nconst body = ${JSON.stringify(body)};`,
  });
  return `${payload} to=functions.codemode`;
}

function message(content: unknown[], role = "assistant"): AssistantMessageLike {
  return { role, content };
}

function text(value: string) {
  return { type: "text", text: value };
}

function call(name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id: `call_${name}`, name, arguments: args };
}

const READ_ARGS = {
  path: "/home/bitnom/Code/yellowstone-wt/ft90-monitor-widget/src/pi-extensions/bizzy/src/__tests__/monitor-widget.test.ts",
  offset: 55,
  limit: 90,
};

/** The live loop, record line 12559: the same call repeated thirteen times, the last one cut off
 *  mid-payload because the turn was interrupted. A fixed residue ceiling rejected this block as
 *  prose (residue 86 against a cap of 80), which is why the allowance scales per marker and why
 *  an unterminated tail counts as payload. */
function repeatedFixture(count = 13): string {
  const one =
    JSON.stringify({
      command:
        "cd /home/bitnom/Code/yellowstone && git diff -- src/pi-extensions/pi-modes/src/prompt-composition.ts",
      description: "inspect the unrelated dirty pi-modes diff",
      timeout: 300,
    }) + " to=functions.bash";
  const whole = Array.from({ length: count }, () => one).join("\n");
  return whole.slice(0, whole.length - 42);
}

void test("residual accounting: a leaked block is payload and marker only", () => {
  for (const fixture of [FIXTURE_12075, FIXTURE_12077, FIXTURE_12156, FIXTURE_12265, FIXTURE_12236]) {
    assert.ok(
      residualLength(fixture) <= MAX_RESIDUE,
      `residue ${residualLength(fixture)} should be within ${MAX_RESIDUE}: ${JSON.stringify(fixture.slice(0, 60))}`,
    );
  }
});

void test("residual accounting: a sentence that quotes the marker is prose, not a leak", () => {
  const prose =
    "The record shows `to=functions.read` leaking into content, and the same block also appears " +
    'in a JSON example: {"path":"/tmp/x"} — but this sentence is the explanation, not a copy.';
  assert.ok(residualLength(prose) > MAX_RESIDUE);
  assert.equal(classifyHarmonyBlock(prose, []), null);
});

void test("JSON spans are string-aware and skip unbalanced payloads", () => {
  const spans = jsonObjectSpans('{"a": "}"} {"b": 1');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 0);
  assert.ok(spans[0].end > 0);
});

void test("classification distinguishes duplicate, stale and fragment", () => {
  const natives = [{ name: "read", args: JSON.stringify({ limit: 90, offset: 55, path: READ_ARGS.path }) }];
  assert.deepEqual(classifyHarmonyBlock(FIXTURE_12236, natives), { kind: "duplicate", tool: "read" });
  assert.deepEqual(
    classifyHarmonyBlock(FIXTURE_12236, [{ name: "write", args: natives[0].args }]),
    { kind: "stale", tool: "read" },
  );
  assert.deepEqual(classifyHarmonyBlock(FIXTURE_12265, natives), { kind: "fragment", tool: "rooms_reply_all" });
  assert.deepEqual(classifyHarmonyBlock(FIXTURE_12075, natives), { kind: "stale", tool: "find" });
});

void test("the live loop - thirteen repetitions, last one truncated - is a leak, not prose", () => {
  const live = repeatedFixture();
  assert.ok(live.length > 2000, "the fixture keeps the recorded shape");
  assert.ok(classifyHarmonyBlock(live, []), "repeated debris must not read as prose");
  const result = stripHarmonyToolCalls(message([text(live)]));
  assert.equal(result.changed, true);
  assert.equal(result.removed[0].kind, "stale", "the payloads parse and there is no native call");
  assert.equal(result.message.content.length, 0);
});

void test("a single interrupted payload still counts as a leaked call", () => {
  const truncated =
    '{"path":"/tmp/x","offset":55,"limit":90} to=functions.read {"path":"/tmp/y","off';
  assert.ok(classifyHarmonyBlock(truncated, []), "the unterminated tail is payload, not a sentence");
});

void test("the stripper removes only the leaked text block and keeps every native call", () => {
  const original = message([
    { type: "thinking", thinking: "considering" },
    text(FIXTURE_12236),
    call("read", READ_ARGS),
    text("Here is what the file contains."),
  ]);
  const result = stripHarmonyToolCalls(original);

  assert.equal(result.changed, true);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].kind, "duplicate");
  assert.equal(result.counts.duplicate, 1);
  assert.equal(result.message.content.length, 3, "thinking, native call and the ordinary sentence survive");
  const kinds = result.message.content.map((block) => (block as { type: string }).type);
  assert.deepEqual(kinds, ["thinking", "toolCall", "text"]);
  assert.equal(original.content.length, 4, "the input message is not mutated");
});

void test("the 99 KB variant is removed and its volume is counted", () => {
  const big = largeFixture();
  assert.ok(big.length > 20_000);
  const result = stripHarmonyToolCalls(message([text(big), call("codemode", { code: "x" })]));
  assert.equal(result.changed, true);
  assert.equal(result.counts.stale + result.counts.fragment + result.counts.duplicate, 1);
  assert.equal(result.removedChars, big.length);
  assert.equal(result.message.content.length, 1);
  assert.equal((result.message.content[0] as { type: string }).type, "toolCall");
});

void test("nothing is removed when there is nothing to remove", () => {
  const cases = [
    message([call("read", READ_ARGS)]),
    message([text("A plain sentence about the run.")]),
    message([text('{"path":"/tmp/x"}'), call("read", READ_ARGS)]),
    message([text("It quoted `to=functions.read` inside a longer explanation, which is prose.")]),
    message([text(FIXTURE_12236)], "user"),
  ];
  for (const candidate of cases) {
    const result = stripHarmonyToolCalls(candidate);
    assert.equal(result.changed, false, JSON.stringify(candidate.content).slice(0, 80));
  }
});

/** Records the registrations the extension makes, so the wiring is asserted rather than assumed. */
function host() {
  const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx?: unknown) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  const fire = async (name: string, event: unknown) => {
    let current: unknown = event;
    let returned: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(current, {});
      if (result && typeof result === "object" && ("message" in result || "messages" in result)) {
        returned = result;
        current = result;
      }
    }
    return returned as { message?: AssistantMessageLike; messages?: AssistantMessageLike[] } | undefined;
  };
  return { pi, fire, handlers };
}

void test("message_end returns a replacement with the leak gone", async () => {
  resetHarmonyStripCounters();
  const { pi, fire } = host();
  harmonyDuplicates(pi as never);

  const event = { message: message([text(FIXTURE_12236), call("read", READ_ARGS)]) };
  const out = await fire("message_end", event);

  assert.ok(out?.message, "a replacement is returned");
  assert.equal(out?.message?.content.length, 1);
  assert.equal((out?.message?.content[0] as { type: string }).type, "toolCall");
  assert.equal(harmonyStripCounters.blocks, 1);
  assert.equal(harmonyStripCounters.duplicate, 1);
  assert.equal(harmonyStripCounters.chars, FIXTURE_12236.length);
});

void test("aborted message_end removes only a partial edit-argument JSON prefix", async () => {
  resetHarmonyStripCounters();
  const { pi, fire } = host();
  harmonyDuplicates(pi as never);
  const partial = '{"path":"/tmp/file.ts","edits":[{"oldText":"before","newText":"after"}';

  const out = await fire("message_end", {
    message: { ...message([text(partial)]), stopReason: "aborted" },
  });

  assert.deepEqual(out?.message?.content, []);
  assert.equal(harmonyStripCounters.aborted_edit_args, 1);
  assert.equal(harmonyStripCounters.duplicate, 0);
  assert.equal(harmonyStripCounters.stale, 0);
  assert.equal(harmonyStripCounters.fragment, 0);
});

void test("non-aborted message_end retains the same partial edit-argument JSON", async () => {
  resetHarmonyStripCounters();
  const { pi, fire } = host();
  harmonyDuplicates(pi as never);
  const partial = '{"path":"/tmp/file.ts","edits":[{"oldText":"before","newText":"after"}';
  const candidate = message([text(partial)]);

  const out = await fire("message_end", {
    message: { ...candidate, stopReason: "stop" },
    // The reason belongs to the assistant message; an event-level lookalike must not activate it.
    stopReason: "aborted",
  });

  assert.equal(out, undefined);
  assert.equal(harmonyStripCounters.aborted_edit_args, 0);
  assert.equal((candidate.content[0] as { text: string }).text, partial);
});

void test("aborted-only prefix classifier retains complete and unrelated plain JSON prose", () => {
  const complete = '{"path":"/tmp/file.ts","edits":[{"oldText":"before","newText":"after"}]}';
  const unrelated = '{"operation":"edit","path":"/tmp/file.ts","changes":[]}';

  assert.equal(isAbortedEditArgsPrefix(complete), false);
  assert.equal(isAbortedEditArgsPrefix(unrelated), false);
});

void test("message_end stays silent when the message is clean", async () => {
  resetHarmonyStripCounters();
  const { pi, fire } = host();
  harmonyDuplicates(pi as never);

  const out = await fire("message_end", { message: message([call("read", READ_ARGS)]) });
  assert.equal(out, undefined, "no replacement for a clean message");
  assert.equal(harmonyStripCounters.blocks, 0);
});

void test("context_with_system strips stored leaks from the outgoing transcript", async () => {
  resetHarmonyStripCounters();
  const { pi, fire } = host();
  harmonyDuplicates(pi as never);

  const stored = message([text(FIXTURE_12265), call("rooms_reply_all", { message: "hello" })]);
  const out = await fire("context_with_system", {
    messages: [{ role: "user", content: [text("hi")] }, stored, message([text("clean prose")])],
  });

  assert.ok(out?.messages, "a replacement transcript is returned");
  assert.equal(out?.messages?.length, 3);
  assert.equal(out?.messages?.[1].content.length, 1, "the leaked block is gone from history");
  assert.equal(harmonyStripCounters.fragment, 1);
});

void test("context_with_system returns nothing when the transcript is clean", async () => {
  resetHarmonyStripCounters();
  const { pi, fire } = host();
  harmonyDuplicates(pi as never);
  const out = await fire("context_with_system", { messages: [message([call("read", READ_ARGS)])] });
  assert.equal(out, undefined);
});

void test("stripAssistantMessage ignores non-assistant and malformed messages", () => {
  assert.equal(stripAssistantMessage({ role: "user", content: [text(FIXTURE_12265)] }, false), undefined);
  assert.equal(stripAssistantMessage(null, false), undefined);
  assert.equal(stripAssistantMessage({ role: "assistant", content: [] }, false), undefined);
});

void test("history repair can be switched off while message_end stays on", () => {
  const previous = process.env.PI_HARMONY_HISTORY;
  process.env.PI_HARMONY_HISTORY = "off";
  try {
    const { pi, handlers } = host();
    harmonyDuplicates(pi as never);
    assert.ok(handlers.get("message_end")?.length, "message_end stays registered");
    assert.equal(handlers.get("context_with_system"), undefined, "history repair is not registered");
  } finally {
    if (previous === undefined) delete process.env.PI_HARMONY_HISTORY;
    else process.env.PI_HARMONY_HISTORY = previous;
  }
});

function host0() {
  const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx?: unknown) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  const fire = async (name: string, event: unknown) => {
    let current: unknown = event;
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(current, {});
      if (result && typeof result === "object" && ("message" in result || "messages" in result)) {
        current = result;
      }
    }
    return current;
  };
  return { pi, fire };
}

void test("/harmony reports the counters, so loading is provable in band", async () => {
  resetHarmonyStripCounters();
  const commands = new Map<
    string,
    { description: string; handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const host = {
    on() {
      /* not under test here */
    },
    registerCommand(
      name: string,
      definition: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, definition);
    },
  };
  harmonyDuplicates(host as never);

  const command = commands.get("harmony");
  assert.ok(command, "the command is registered");

  // One strip first, so the reported numbers are not all zero.
  const { pi, fire } = host0();
  harmonyDuplicates(pi as never);
  await fire("message_end", { message: message([text(FIXTURE_12265), call("rooms_reply_all", { message: "x" })]) });

  const notices: string[] = [];
  await command.handler("", { ui: { notify: (line: string) => notices.push(line) } });

  assert.equal(notices.length, 1);
  assert.match(notices[0], /harmony stripper: strips=\d+ blocks=\d+ chars=\d+/);
  assert.match(notices[0], /fragment=1/);
});

void test("the extension can be switched off by environment", () => {
  const previous = process.env.PI_HARMONY_STRIP;
  process.env.PI_HARMONY_STRIP = "off";
  try {
    const { pi, handlers } = host();
    harmonyDuplicates(pi as never);
    assert.equal(handlers.size, 0, "no handlers are registered when disabled");
  } finally {
    if (previous === undefined) delete process.env.PI_HARMONY_STRIP;
    else process.env.PI_HARMONY_STRIP = previous;
  }
});