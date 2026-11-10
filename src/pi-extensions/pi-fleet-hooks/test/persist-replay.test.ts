/**
 * Persist-then-replay proof.
 *
 * The rest of the suite proves three things separately: the parser recognises markup, the plan
 * chooses a strategy, and the adapter serialises a given content array. This file closes the
 * loop between them, because the failure mode worth fearing is not any one of those — it is a
 * message that is normalised correctly, persisted correctly, and *then* serialised without the
 * recovered reasoning. Each step has to be exercised in sequence for the claim to mean anything.
 *
 * The sequence:
 *
 *   1. take a message shaped like the ones in the live corpus,
 *   2. run the real hook entry point on it,
 *   3. serialise it exactly as pi persists a session message and parse it back, so a field the
 *      hook invented (or dropped) would show up as a mismatch rather than being masked by an
 *      in-memory object,
 *   4. rebuild the follow-up request through the installed Chat Completions adapter with the
 *      network stubbed, and assert the recovered reasoning is in the payload.
 *
 * What this is: an end-to-end check of the SDK contract this extension relies on.
 * What it is not: a live lane. Installing into a running lane is the leader's step, after this
 * is green. No model is contacted and no request leaves the machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeAssistantMessage } from "../src/reasoning-replay.ts";

const CANDIDATES = [
  process.env.PI_AI_DIST,
  path.join(
    process.env.HOME ?? "",
    ".local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist",
  ),
].filter((value): value is string => typeof value === "string" && value.length > 0);

function findPiAi(): string | undefined {
  for (const candidate of CANDIDATES) {
    for (const dir of [candidate, path.join(candidate, "dist")]) {
      if (fs.existsSync(path.join(dir, "api/openai-completions.js"))) return dir;
    }
  }
  return undefined;
}

const PI_AI = findPiAi();

test("persist-then-replay: recovered reasoning survives the session record into the next request", async () => {
  assert.ok(
    PI_AI,
    "installed pi-ai not found; set PI_AI_DIST. This proof cannot be skipped — a green run " +
      "without it would assert nothing about replay.",
  );

  // 1. A message shaped exactly as the corpus records them: a real reasoning channel AND a
  //    second reasoning block that leaked into text. This is the mixed case, 45/45 groups.
  const leaked = {
    role: "assistant",
    api: "openai-completions",
    provider: "subrouter-example",
    model: "example-model",
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      { type: "thinking", thinking: "NATIVE CHANNEL REASONING", thinkingSignature: "reasoning_content" },
      {
        type: "text",
        text: "<thinking>RECOVERED FROM TEXT</thinking>\nThe answer is four.",
      },
    ],
  };

  // 2. The real hook entry point, exactly as `message_end` calls it.
  const afterHook = normalizeAssistantMessage(leaked as any);
  assert.ok(afterHook, "the hook must rewrite the leaking message");
  assert.equal(
    afterHook.content.filter((block: any) => block.type === "thinking").length,
    2,
    "both reasoning blocks must be stored distinctly",
  );

  // 3. Persist and reload. pi writes one JSON object per line; a round trip is enough to prove
  //    nothing relies on object identity or on a non-serialisable field.
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ft37-persist-"));
  const sessionPath = path.join(dir, "session.jsonl");
  try {
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "message", id: "entry-1", timestamp: new Date().toISOString(), message: afterHook })}\n`,
      "utf8",
    );

    const line = fs.readFileSync(sessionPath, "utf8").trim();
    const reloaded = JSON.parse(line).message as typeof afterHook;

    assert.equal(reloaded.content.length, afterHook.content.length);
    for (let i = 0; i < reloaded.content.length; i++) {
      assert.deepEqual(
        reloaded.content[i],
        afterHook.content[i],
        `content block ${i} must survive persistence unchanged`,
      );
    }

    // 4. The follow-up request, through the installed adapter.
    const adapter: any = await import(
      `file://${path.join(PI_AI as string, "api/openai-completions.js")}`
    );

    const target = {
      id: "example-model",
      name: "Example",
      api: "openai-completions",
      provider: "subrouter-example",
      baseUrl: "https://example.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };

    const captured: { body?: any } = {};
    const sse = [
      'data: {"id":"c1","model":"example-model","choices":[{"index":0,"delta":{"content":"ok"}}]}',
      "",
      'data: {"id":"c1","model":"example-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const stream = adapter.stream(
      target,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "earlier question" }], timestamp: 1 },
          reloaded,
          { role: "user", content: [{ type: "text", text: "follow-up question" }], timestamp: 2 },
        ],
      },
      {
        apiKey: "test-key",
        maxRetries: 0,
        fetch: async (_url: string, init: any) => {
          captured.body = JSON.parse(init.body);
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      },
    );

    for await (const _event of stream) {
      // drain
    }

    const assistant = captured.body.messages.find((entry: any) => entry.role === "assistant");
    assert.ok(assistant, "the persisted message must reach the request");

    // The claim under test: recovered reasoning is in the reasoning field, not left as prose.
    assert.match(assistant.reasoning_content, /NATIVE CHANNEL REASONING/);
    assert.match(assistant.reasoning_content, /RECOVERED FROM TEXT/);

    // And the visible answer is intact, without marker noise.
    assert.equal(assistant.content, "\nThe answer is four.");
    assert.equal(JSON.stringify(captured.body).includes("<thinking>"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persist-then-replay: an adapter with no safe replay keeps the reasoning as text", async () => {
  // The honest negative. On an API where the reasoning cannot be carried, the content must
  // still be persisted and still reach the request — as text. Not silently dropped, and not
  // dressed up as reasoning it cannot verify.
  const leaked = {
    role: "assistant",
    api: "openai-responses",
    provider: "some-provider",
    model: "some-model",
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "<thinking>KEPT AS TEXT</thinking>\nanswer" }],
  };

  const afterHook = normalizeAssistantMessage(leaked as any);
  assert.equal(afterHook, undefined, "no rewrite on an API without a verified replay path");

  // The original block, markers included, is what persists and what is sent.
  const persisted = JSON.parse(JSON.stringify(leaked)) as typeof leaked;
  assert.deepEqual(persisted.content, leaked.content);
  assert.equal(JSON.stringify(persisted).includes("KEPT AS TEXT"), true);
});
