/**
 * Payload tests — what the target adapter actually puts on the wire.
 *
 * This is the only file that decides whether the fix is real. A passing `normalizeContent`
 * test proves a block was reclassified in memory; it proves nothing about whether the next
 * request carries that reasoning, and the whole hazard is that a ThinkingContent block can be
 * stored correctly and then silently omitted by the serialiser.
 *
 * Nothing here is a reimplementation. Each case calls the installed provider's real `stream()`
 * with an injected `fetch`, so pi's own `transformMessages`, compat resolution, message
 * conversion and body building all run; the stub only replaces the HTTP round trip, captures
 * the outgoing JSON body, and returns a minimal SSE response so the call completes. No model is
 * contacted and no request leaves the machine.
 *
 * The `pi-ai` location is resolved rather than assumed: it ships inside the installed
 * `pi-coding-agent` package's `node_modules`, not as a sibling global package. `PI_AI_DIST` may
 * override it for a different install.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeAssistantMessage, normalizeContent, planReplay } from "../src/reasoning-replay.ts";

// ---------------------------------------------------------------------------------------------
// Locating the installed pi-ai build
// ---------------------------------------------------------------------------------------------

/**
 * Candidate pi-ai locations.
 *
 * `PI_AI_DIST` is the portable override and is authoritative when set: it may point at the
 * package root *or* at its `dist` directory, so a different install layout needs no code
 * change. The fallback list only exists so a stock fleet checkout runs without ceremony.
 */
function normaliseDistLocation(value: string): string[] {
  const entries = [value, path.join(value, "dist")];
  return entries.filter((dir) => fs.existsSync(path.join(dir, "api/openai-completions.js")));
}

function candidateLocations(): string[] {
  const explicit = process.env.PI_AI_DIST;
  if (explicit) return normaliseDistLocation(explicit);

  const home = process.env.HOME ?? "";
  const roots = [
    path.join(home, ".local/share/mise/installs/node/22.23.3/lib/node_modules"),
    path.join(home, ".local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/node_modules"),
    path.join(home, ".npm-global/lib/node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ];

  const found: string[] = [];
  for (const root of roots) {
    found.push(
      path.join(root, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist"),
      path.join(root, "@earendil-works/pi-ai/dist"),
    );
  }
  return found;
}

function findPiAi(): string | undefined {
  // An explicit override that does not resolve is a hard error, not a silent fallback: a typo
  // in PI_AI_DIST must not turn the payload suite into a no-op.
  if (process.env.PI_AI_DIST) {
    const resolved = normaliseDistLocation(process.env.PI_AI_DIST);
    if (resolved.length === 0) {
      throw new Error(
        `PI_AI_DIST is set to "${process.env.PI_AI_DIST}" but no api/openai-completions.js was found there ` +
          `(checked that path and its dist/ subdirectory)`,
      );
    }
    return resolved[0];
  }
  return candidateLocations().find((dir) => fs.existsSync(path.join(dir, "api/openai-completions.js")));
}

const PI_AI = findPiAi();

/**
 * Verification gate. If the installed adapters cannot be located the payload suite is not
 * merely incomplete, it is unverified — so this fails loudly instead of letting the suite
 * report green with the only meaningful assertions skipped.
 */
test("verification gate: installed pi-ai adapters are discoverable", () => {
  assert.ok(
    PI_AI !== undefined,
    "installed pi-ai not found. Set PI_AI_DIST to the @earendil-works/pi-ai package root or its " +
      `dist directory. Looked in: ${candidateLocations().join(", ")}`,
  );
});

/** Fails the calling test with a clear reason when the adapters are missing. */
function requirePiAi(): string {
  assert.ok(PI_AI, "installed pi-ai not found; set PI_AI_DIST");
  return PI_AI as string;
}

/** Minimal model descriptor; only the fields the converters read are set. */
const model = (api: string, provider = "test-provider") => ({
  id: "test-model",
  name: "Test Model",
  api,
  provider,
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_000,
});

/**
 * A `fetch` that records the request body and replies with a fixed response.
 *
 * The bodies are deliberately minimal: these tests assert the *request*, and the response only
 * has to be well-formed enough for the adapter to finish and settle the stream.
 */
function capturingFetch(captured: { body?: any }, response: { contentType: string; body: string }) {
  return async (_url: string, init: any) => {
    if (typeof init?.body === "string") captured.body = JSON.parse(init.body);
    return new Response(response.body, {
      status: 200,
      headers: { "content-type": response.contentType },
    });
  };
}

const OPENAI_SSE = [
  'data: {"id":"chunk-1","model":"test-model","choices":[{"index":0,"delta":{"content":"ok"}}]}',
  "",
  'data: {"id":"chunk-1","model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

/** Google's streaming endpoints answer with newline-delimited JSON objects. */
const GOOGLE_STREAM = [
  '{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}',
  "",
].join("\n");

const ANTHROPIC_SSE = [
  'event: message_start data: {"type":"message_start","message":{"id":"msg_1","model":"test-model","usage":{"input_tokens":1,"output_tokens":0}}}',
  "",
  'event: content_block_start data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'event: content_block_delta data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  "",
  'event: content_block_stop data: {"type":"content_block_stop","index":0}',
  "",
  'event: message_delta data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  "",
  'event: message_stop data: {"type":"message_stop"}',
  "",
].join("\n");

/** Where a stored message came from. Kept separate from the target on purpose. */
interface Origin {
  api: string;
  provider: string;
  model: string;
}

interface CaptureOptions {
  /** The model making the new request — this is what the message is replayed to. */
  target: ReturnType<typeof model>;
  /** Who authored the stored message. Defaults to the target, i.e. a same-model turn. */
  origin?: Origin;
  content: any[];
}

/**
 * Runs one request through the real target adapter and returns the captured request body.
 *
 * `origin` is deliberately independent of `target`. An earlier revision derived the message's
 * own `provider`/`model` from the target, which made every message look same-model and turned
 * every "cross-API switch" case into a relabelled fixture that never exercised
 * `transformMessages`. Identity has to be faithful or the assertion is about nothing.
 */
async function captureRequestBody({ target, origin, content }: CaptureOptions): Promise<any> {
  const apiDir = requirePiAi();
  const adapterPath = path.join(apiDir, `api/${target.api}.js`);
  const adapter: any = await import(pathToFileUrl(adapterPath));

  const captured: { body?: any } = {};
  const isAnthropic = target.api === "anthropic-messages";
  const isGoogle = target.api.startsWith("google-");
  const fetchImpl = capturingFetch(captured, {
    contentType: isGoogle ? "application/json" : "text/event-stream",
    body: isAnthropic ? ANTHROPIC_SSE : isGoogle ? GOOGLE_STREAM : OPENAI_SSE,
  });

  const source = origin ?? { api: target.api, provider: target.provider, model: target.id };

  const message = {
    role: "assistant",
    api: source.api,
    provider: source.provider,
    model: source.model,
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content,
  };

  const context = {
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() },
      message,
      { role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() },
    ],
  };

  const stream = adapter.stream(target, context, {
    apiKey: "test-key",
    fetch: fetchImpl,
    maxRetries: 0,
  });

  for await (const _event of stream) {
    // Drain so the request is actually issued and adapter errors surface.
  }

  return captured.body;
}

function pathToFileUrl(filePath: string): string {
  return `file://${filePath}`;
}

// ---------------------------------------------------------------------------------------------
// Chat Completions — the adapter every observed leak runs on
// ---------------------------------------------------------------------------------------------

test("unsigned thinking block is OMITTED by the chat-completions serialiser", async () => {
  // This is the hazard the whole design turns on. It is not a hypothetical: it is why the fix
  // must write a field name rather than just reclassifying.
  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: [{ type: "thinking", thinking: "unsigned reasoning" }],
  });

  const serialised = JSON.stringify(body.messages ?? []);
  assert.equal(serialised.includes("unsigned reasoning"), false);
});

test("a reasoning_content field name carries the block onto the wire", async () => {
  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: [
      { type: "thinking", thinking: "recovered reasoning here", thinkingSignature: "reasoning_content" },
      { type: "text", text: "the answer" },
    ],
  });

  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  assert.ok(assistant, "an assistant message must be in the request");
  assert.equal(assistant.reasoning_content, "recovered reasoning here");
  assert.equal(assistant.content, "the answer");
});

test("recovered reasoning written with the wrong field name is recovered on the wire", async () => {
  // End-to-end: the extension rewrites a leaking message, and the real serialiser carries it.
  const leaking = {
    role: "assistant",
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "<thinking>recovered by the hook</thinking>\nvisible answer" }],
  };

  const normalized = normalizeAssistantMessage(leaking as any);
  assert.ok(normalized, "the hook must rewrite this message");

  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: normalized.content as any[],
  });
  const assistant = body.messages.find((entry: any) => entry.role === "assistant");

  assert.equal(assistant.reasoning_content, "recovered by the hook");
  // Surrounding text is preserved byte for byte, and the parser promises exactly that: the
  // newline that followed the closing marker stays. Trimming here would be a behaviour change
  // made to satisfy a test, not to satisfy the parser's contract.
  assert.equal(assistant.content, "\nvisible answer");
  // The markers must not survive into the request as prose.
  assert.equal(JSON.stringify(body).includes("<thinking>"), false);
});

test("mixed native + recovered reasoning both reach the wire, in the joint field", async () => {
  // The 45-group case: native thinking already present, leaked text alongside. Both must be
  // serialised; pi joins every thinking block into the first block's field.
  const message = {
    role: "assistant",
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      { type: "thinking", thinking: "NATIVE", thinkingSignature: "reasoning_content" },
      { type: "text", text: "preamble\n<thinking>RECOVERED</thinking>\nanswer" },
    ],
  };

  const normalized = normalizeAssistantMessage(message as any);
  assert.ok(normalized);

  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: normalized.content as any[],
  });
  const assistant = body.messages.find((entry: any) => entry.role === "assistant");

  assert.equal(JSON.stringify(body).includes("RECOVERED"), true, "recovered reasoning must not be omitted");
  assert.equal(JSON.stringify(body).includes("NATIVE"), true, "native reasoning must not be lost");
  assert.match(assistant.reasoning_content, /NATIVE/);
  assert.match(assistant.reasoning_content, /RECOVERED/);
});

test("a reasoning_details signature makes pi omit thinking text — the mixed-loss hazard", async () => {
  // Documents pi's behaviour that the planReplay gate exists to avoid depending on: with a
  // reasoning_details signature present, appended thinking text does NOT travel. The gate
  // keeps recovered reasoning as text in this shape instead of letting it vanish.
  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: [
      {
        type: "thinking",
        thinking: "details-backed reasoning",
        thinkingSignature: JSON.stringify([{ type: "reasoning.text", text: "details-backed reasoning" }]),
      },
      // A visible text block is required: the adapter drops an assistant turn that has neither
      // text nor tool calls, which would make this fixture assert nothing.
      { type: "text", text: "answer" },
    ],
  });

  const serialised = JSON.stringify(body);
  assert.equal(Array.isArray(body.messages.find((m: any) => m.role === "assistant")?.reasoning_details), true);
  // The text is present only via the details payload, never as a reasoning_* text field.
  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  assert.equal(assistant.reasoning_content, undefined);
  assert.equal(assistant.reasoning, undefined);
  assert.equal(serialised.includes("reasoning_details"), true);
});

test("preserve mode leaves the request byte-identical to the unmodified text", async () => {
  // For an adapter we do not rewrite (openai-responses shape is not exercised here, but the
  // same rule applies), the visible text must survive unchanged rather than being dropped.
  const leaking = {
    role: "assistant",
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "error",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "<thinking>partial" }],
  };

  // Error messages are skipped, so content is untouched and the text still travels.
  assert.equal(normalizeAssistantMessage(leaking as any), undefined);

  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: leaking.content as any[],
  });
  assert.equal(JSON.stringify(body).includes("<thinking>partial"), true);
});

test("a textSignature block is serialised untouched", async () => {
  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: [{ type: "text", text: "<thinking>signed text</thinking>", textSignature: "opaque-provider-state" }],
  });

  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("<thinking>signed text</thinking>"), true);
});

test("across a model switch pi drops reclassified reasoning — native policy, unchanged", async () => {
  // Guards the correction: this hook must not change pi's cross-model portability rule. A
  // thinking block authored by another model is dropped by transformMessages, native or
  // recovered alike, and we do not smuggle it back in as text.
  const body = await captureRequestBody({
    // Origin: a Chat Completions message authored by test-provider/test-model.
    origin: { api: "openai-completions", provider: "test-provider", model: "test-model" },
    // Target: same API, different provider — a genuine provider switch, not a relabelled fixture.
    target: model("openai-completions", "other-provider"),
    content: [
      { type: "thinking", thinking: "RECOVERED ACROSS A SWITCH", thinkingSignature: "reasoning_content" },
      { type: "text", text: "visible answer" },
    ],
  });

  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("RECOVERED ACROSS A SWITCH"), false);
  // And it must not reappear disguised as answer text.
  assert.equal(serialised.includes("visible answer"), true);
});

// ---------------------------------------------------------------------------------------------
// Anthropic — the adapter where a signature would have to be invented
// ---------------------------------------------------------------------------------------------

test("anthropic downgrades a signature-less thinking block to text, losing nothing", async () => {
  const body = await captureRequestBody({
    target: model("anthropic-messages"),
    content: [
      { type: "thinking", thinking: "recovered for anthropic" },
      { type: "text", text: "answer" },
    ],
  });

  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  const serialised = JSON.stringify(assistant);
  assert.equal(serialised.includes("recovered for anthropic"), true);
  // It must travel as text, not as a thinking block with an invented signature.
  const types = (assistant.content ?? []).map((block: any) => block.type);
  assert.equal(types.includes("thinking"), false);
  assert.equal(types.includes("text"), true);
});

test("anthropic never receives a fabricated signature from the hook", async () => {
  // The negative case, stated directly: if the hook set reasoning_content on an Anthropic
  // message it would be forwarded as a thinking signature. It does not.
  const leaking = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "<thinking>A</thinking>b" }],
  };

  const normalized = normalizeAssistantMessage(leaking as any);
  assert.ok(normalized);

  const body = await captureRequestBody({
    target: model("anthropic-messages"),
    content: normalized.content as any[],
  });
  const serialised = JSON.stringify(body.messages);
  assert.equal(serialised.includes("reasoning_content"), false);
  assert.equal(serialised.includes('"signature"'), false);
  assert.equal(serialised.includes("A"), true);
});

// --- Real cross-API transition, identity-faithful (leader correction) ------------------------
//
// The earlier worry was that a Chat Completions message carrying a field-name signature would
// reach the Responses converter, which calls JSON.parse on thinkingSignature without a guard.
// That cannot happen for a genuine transition: transformMessages runs first
// (`openai-responses-shared.js:118`) and drops thinking blocks whose origin model differs from
// the target, so the converter never sees the block. These cases keep the original
// `api`/`provider`/`model` on the message and change only the TARGET — a real switch, not a
// fixture relabelled as Responses.

test("a real CC→Responses switch drops the recovered block before any JSON.parse", async () => {
  const anthropicLike = {
    role: "assistant",
    // Origin is genuinely Chat Completions.
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "thinking", thinking: "CC ORIGIN REASONING", thinkingSignature: "reasoning_content" }],
  };

  // Target is the Responses API under the same provider and model id — the api field alone moves.
  const body = await captureRequestBody({
    origin: { api: "openai-completions", provider: "test-provider", model: "test-model" },
    // Only the target api moves; the message keeps its real Chat Completions identity.
    target: model("openai-responses", "test-provider"),
    content: anthropicLike.content,
  });

  // No throw: transformMessages filtered the foreign thinking block, so the converter's
  // unguarded JSON.parse(thinkingSignature) was never reached.
  assert.ok(body, "the Responses request must be built without throwing");
  assert.equal(JSON.stringify(body).includes("CC ORIGIN REASONING"), false);
});

test("a CC→Responses switch keeps the visible answer text", async () => {
  const leaking = {
    role: "assistant",
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "<thinking>recovered</thinking>\nVISIBLE ANSWER" }],
  };

  const normalized = normalizeAssistantMessage(leaking as any);
  assert.ok(normalized);

  const body = await captureRequestBody({
    origin: { api: "openai-completions", provider: "test-provider", model: "test-model" },
    target: model("openai-responses", "test-provider"),
    content: normalized.content as any[],
  });

  // Text blocks are preserved across a switch (signatures are stripped, content is not).
  assert.equal(JSON.stringify(body).includes("VISIBLE ANSWER"), true);
});

test("a native reasoning_details block is not JSON.parsed into a Responses item across a switch", async () => {
  // Same guarantee for the opaque shape: the block is foreign, so it is filtered before the
  // converter would have forwarded the parsed JSON as a fabricated reasoning item.
  const origin = {
    role: "assistant",
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      {
        type: "thinking",
        thinking: "details reasoning",
        thinkingSignature: JSON.stringify([{ type: "reasoning.text", text: "details reasoning" }]),
      },
    ],
  };

  const body = await captureRequestBody({
    origin: { api: "openai-completions", provider: "test-provider", model: "test-model" },
    target: model("openai-responses", "test-provider"),
    content: origin.content,
  });

  assert.ok(body);
  const serialised = JSON.stringify(body);
  // Must not be re-emitted as a provider-issued reasoning item.
  assert.equal(serialised.includes('"type":"reasoning.text"'), false);
});

// --- Google: verified through its own converter ----------------------------------------------
//
// `google-shared.js:147` exports `convertMessages(model, context)`, and that function calls
// `transformMessages` itself, so asserting on its output is a faithful end-to-end converter
// check with nothing stubbed. The converter — not a guess about server acceptance — is what
// puts Google on the unsigned pathway: it emits a native unsigned `{ thought: true, text }`
// part for a same-provider/same-model thinking block, which is the same shape pi already
// produces. Server acceptance is deliberately not exercised here.

test("google converter emits an unsigned thought part for recovered reasoning", async () => {
  const apiDir = requirePiAi();
  const shared: any = await import(pathToFileUrl(path.join(apiDir, "api/google-shared.js")));

  const target = model("google-generative-ai");

  const normalized = normalizeAssistantMessage({
    role: "assistant",
    api: "google-generative-ai",
    provider: target.provider,
    model: target.id,
    stopReason: "stop",
    content: [{ type: "text", text: "<thinking>google recovered</thinking>\nanswer" }],
  } as any);
  assert.ok(normalized, "the hook must reclassify on google-generative-ai");

  const contents = shared.convertMessages(target, {
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() },
      {
        role: "assistant",
        api: "google-generative-ai",
        provider: target.provider,
        model: target.id,
        stopReason: "stop",
        timestamp: Date.now(),
        content: normalized.content,
      },
    ],
  });

  const parts = contents
    .filter((entry: any) => entry.role === "model")
    .flatMap((entry: any) => entry.parts ?? []);

  const thought = parts.find((part: any) => part.thought === true);
  assert.ok(thought, "a thought part must be emitted");
  assert.equal(thought.text, "google recovered");
  // No fabricated signature: pi's own validator only keeps a real base64 signature.
  assert.equal("thoughtSignature" in thought, false);
  // The visible answer still travels.
  assert.equal(JSON.stringify(contents).includes("answer"), true);
});

test("google-vertex behaves the same as google-generative-ai", () => {
  assert.equal(planReplay("google-vertex", []).mode, "unsigned");
});

test("google drops recovered reasoning across a model switch, like every adapter", async () => {
  const apiDir = requirePiAi();
  const shared: any = await import(pathToFileUrl(path.join(apiDir, "api/google-shared.js")));

  const target = model("google-generative-ai");
  const contents = shared.convertMessages(target, {
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() },
      {
        role: "assistant",
        api: "google-generative-ai",
        // Different origin model: pi's portability rule applies to recovered reasoning too.
        provider: target.provider,
        model: "some-other-model",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [
          { type: "thinking", thinking: "GOOGLE CROSS-MODEL", thinkingSignature: undefined },
          { type: "text", text: "visible" },
        ],
      },
    ],
  });

  assert.equal(JSON.stringify(contents).includes("GOOGLE CROSS-MODEL"), false);
  assert.equal(JSON.stringify(contents).includes("visible"), true);
});

// --- Content-less-turn gate: an accident this fix would otherwise introduce -------------------
//
// openai-completions drops an assistant message that has neither visible content nor tool calls
// (`:1040-1055`), after writing reasoning_content. If the only text in a turn was the tagged
// reasoning, reclassifying it would turn a present message into an absent one — losing the
// reasoning as well as the markup. The plan keeps the tagged source in that shape.

test("a tag-only turn keeps its message on the wire, tagged text intact", async () => {
  const leaking = {
    role: "assistant",
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "<thinking>RECOVERED ONLY</thinking>" }],
  };

  // The hook must decline: converting would leave nothing to send.
  assert.equal(normalizeAssistantMessage(leaking as any), undefined);

  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: leaking.content as any[],
  });

  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  assert.ok(assistant, "the message must not be dropped from the request");
  assert.equal(JSON.stringify(assistant).includes("RECOVERED ONLY"), true);
});

test("converting the same tag-only turn WOULD drop the message — why the gate exists", async () => {
  // Proves the hazard is real rather than theoretical: hand the adapter the converted shape and
  // the assistant turn disappears entirely.
  const converted = [
    { type: "thinking", thinking: "RECOVERED ONLY", thinkingSignature: "reasoning_content" },
  ];

  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: converted as any[],
  });

  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  assert.equal(assistant, undefined, "a content-less converted turn is dropped outright");
});

test("mixed native plus tag-only is also preserved, and the native block still replays", async () => {
  const native = { type: "thinking", thinking: "NATIVE", thinkingSignature: "reasoning_content" };
  const tagged = { type: "text", text: "<thinking>RECOVERED ONLY</thinking>" };

  const result = normalizeContent([native, tagged] as any[], "openai-completions");
  assert.equal(result.changed, false);

  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: [native, tagged] as any[],
  });
  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  assert.ok(assistant, "the message survives");
  assert.match(assistant.reasoning_content, /NATIVE/);
  assert.equal(JSON.stringify(assistant).includes("RECOVERED ONLY"), true);
});

test("a tag-only turn with a native tool call is converted and still present", async () => {
  const content = [
    { type: "text", text: "<thinking>RECOVERED</thinking>" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
  ];

  const result = normalizeContent(content as any[], "openai-completions");
  assert.equal(result.changed, true, "a tool call keeps the turn visible, so conversion is safe");

  const body = await captureRequestBody({
    target: model("openai-completions"),
    content: result.content as any[],
  });
  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  assert.ok(assistant);
  assert.match(assistant.reasoning_content, /RECOVERED/);
  assert.equal(Array.isArray(assistant.tool_calls), true);
});

test("unknown provider and model names on a supported API are detected and replayed", async () => {
  // Requirement: detection is content-driven and ungated. Identity must not matter.
  const weird = {
    role: "assistant",
    api: "openai-completions",
    provider: "provider-that-does-not-exist",
    model: "model-that-does-not-exist",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "<thinking>UNKNOWN IDENTITY</thinking>\nanswer" }],
  };

  const normalized = normalizeAssistantMessage(weird as any);
  assert.ok(normalized, "an unknown provider/model must still be normalised");

  // Replay through a target with the same unknown identity, so no switch filtering applies.
  const target = { ...model("openai-completions"), id: weird.model, provider: weird.provider };
  const body = await captureRequestBody({ target, content: normalized.content as any[] });

  const assistant = body.messages.find((entry: any) => entry.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.reasoning_content, "UNKNOWN IDENTITY");
  assert.equal(assistant.content, "\nanswer");
});
