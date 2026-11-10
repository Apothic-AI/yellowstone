/**
 * Real Pi session pipeline integration proof.
 *
 * Every other test in this package exercises a seam directly: the parser, the plan, or one
 * adapter's `stream()` in isolation. None of them proves the thing an operator cares about,
 * which is that a *session* — the real agent loop, the real extension runtime, the real
 * `SessionManager`, the real provider dispatch — persists a normalised message and then sends
 * the recovered reasoning on the next request. A pure function that is correct but never wired
 * up looks identical to a fix.
 *
 * So this file builds an actual session:
 *
 *   - `DefaultResourceLoader` with the extension file loaded **from disk** by path, so what runs
 *     is the shipped `reasoning-recovery.ts`, not an inlined copy of its logic;
 *   - `session.bindExtensions()`, so `message_end` is registered by pi's own extension runtime;
 *   - a real file-backed `SessionManager`, so the assertion reads the JSONL pi actually wrote;
 *   - a provider whose `api` is `openai-completions` and whose stream is the **installed
 *     adapter** with an injected `fetch`. That keeps pi's real `transformMessages`,
 *     `convertMessages` and body building in the path, and means the "outgoing payload"
 *     assertion is the genuine request body rather than a hand-built object.
 *
 * Everything is local. The `baseUrl` is an unroutable placeholder, the injected `fetch` never
 * performs I/O, and the scripted responses are fixed SSE frames. No model is contacted, no
 * credential is read, and the agent directory is a throwaway temp dir so no fleet configuration
 * or extension is discovered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, "..", "src", "reasoning-recovery.ts");

// Pi resolves its config directory from the environment before it looks at any argument:
// `getAgentDir()` in `dist/config.js` prefers `PI_CODING_AGENT_DIR` over `~/.pi/agent`. A lane
// launched with that variable set therefore leaks its real config into this process — measured:
// the credential store tried to `mkdir '/nonexistent'` and failed the run. The harness below
// always passes an explicit throwaway `agentDir`, so the ambient value is both unwanted and, if
// it points somewhere read-only or missing, fatal. Cleared here so the proof is hermetic in any
// lane. This is the config directory, not an install location: the install override is
// `PI_SDK_ROOT`, and `PI_AI_DIST` covers pi-ai.
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CODING_AGENT_SESSION_DIR;

// ---------------------------------------------------------------------------------------------
// Locating the installed packages
// ---------------------------------------------------------------------------------------------

/**
 * Resolves a candidate SDK installation directory.
 *
 * `PI_SDK_ROOT` is the install-location override. It is deliberately *not*
 * `PI_CODING_AGENT_DIR`: that variable is Pi's runtime config directory — `getAgentDir()` in
 * `dist/config.js` reads it to locate `models.json`, `auth.json` and themes — and repurposing it
 * to mean "the package" would make this file point config discovery at the install. Sessions
 * here always pass an explicit throwaway `agentDir`.
 */
function resolvePackageRoot(candidate: string): string | undefined {
  return fs.existsSync(path.join(candidate, "dist/index.js")) ? candidate : undefined;
}

function piPackageRoot(): string | undefined {
  // An explicit override that does not resolve is a hard error, not a silent fallback: a typo in
  // PI_SDK_ROOT must fail the gate rather than quietly testing whichever install happens to be in
  // the default location.
  const explicit = process.env.PI_SDK_ROOT;
  if (explicit) {
    const resolved = resolvePackageRoot(explicit);
    if (!resolved) {
      throw new Error(
        `PI_SDK_ROOT is set to "${explicit}" but no dist/index.js was found there`,
      );
    }
    return resolved;
  }

  return resolvePackageRoot(
    path.join(
      process.env.HOME ?? "",
      ".local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent",
    ),
  );
}

function resolveDist(candidate: string): string | undefined {
  for (const dir of [candidate, path.join(candidate, "dist")]) {
    if (fs.existsSync(path.join(dir, "api/openai-completions.js"))) return dir;
  }
  return undefined;
}

function piAiDist(piRoot: string): string | undefined {
  // An explicit override that does not resolve is a hard error, not a silent fallback: a typo
  // in PI_AI_DIST must not turn this proof into a no-op that still reports green.
  const explicit = process.env.PI_AI_DIST;
  if (explicit) {
    const resolved = resolveDist(explicit);
    if (!resolved) {
      throw new Error(
        `PI_AI_DIST is set to "${explicit}" but no api/openai-completions.js was found there ` +
          `(checked that path and its dist/ subdirectory)`,
      );
    }
    return resolved;
  }
  return resolveDist(path.join(piRoot, "node_modules/@earendil-works/pi-ai/dist"));
}

const PI_ROOT = piPackageRoot();
const PI_AI = PI_ROOT ? piAiDist(PI_ROOT) : undefined;

/**
 * Verification gate. This proof cannot be skipped: a green run with the one end-to-end case
 * absent would assert nothing about persistence or replay.
 */
test("verification gate: SDK and adapters are discoverable", () => {
  assert.ok(
    PI_ROOT,
    "installed pi-coding-agent not found. Set PI_SDK_ROOT to the package root " +
      "(not PI_CODING_AGENT_DIR, which is Pi's runtime config directory).",
  );
  assert.ok(
    PI_AI,
    `installed pi-ai not found. Set PI_AI_DIST to the package root or its dist directory. ` +
      `Looked under ${PI_ROOT}`,
  );
  assert.ok(fs.existsSync(EXTENSION_PATH), `extension file must exist on disk at ${EXTENSION_PATH}`);
});

// ---------------------------------------------------------------------------------------------
// Scripted Chat Completions responses
// ---------------------------------------------------------------------------------------------

/**
 * Builds a Chat Completions SSE body. `reasoning` goes into `delta.reasoning_content` (the
 * structured channel pi maps to a thinking block) and `text` into `delta.content` (the visible
 * channel, where the leak lives).
 */
function chatCompletionsSse(options: { reasoning?: string; text?: string }): string {
  const deltas: string[] = [];
  if (options.reasoning) {
    deltas.push(
      `data: ${JSON.stringify({
        id: "chunk-1",
        model: "test-model",
        choices: [{ index: 0, delta: { reasoning_content: options.reasoning } }],
      })}`,
      "",
    );
  }
  if (options.text) {
    deltas.push(
      `data: ${JSON.stringify({
        id: "chunk-1",
        model: "test-model",
        choices: [{ index: 0, delta: { content: options.text } }],
      })}`,
      "",
    );
  }
  deltas.push(
    `data: ${JSON.stringify({
      id: "chunk-1",
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    "",
    "data: [DONE]",
    "",
  );
  return deltas.join("\n");
}

interface Harness {
  dir: string;
  requestBodies: any[];
  lines: () => any[];
  prompt: (text: string) => Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * Creates a real isolated session whose provider is the installed Chat Completions adapter.
 *
 * The provider is registered as a *native* provider with a complete `Provider` object, which is
 * the same path `pi.registerProvider(name, completeProvider)` takes. Its `stream` delegates to
 * the installed adapter's `stream` with a capture `fetch`, so nothing about message conversion,
 * compat resolution or body building is reimplemented here.
 */
async function createHarness(
  responses: Array<{ reasoning?: string; text?: string }>,
  options: { loadExtension?: boolean } = {},
): Promise<Harness> {
  assert.ok(PI_ROOT && PI_AI);

  const sdk: any = await import(`file://${path.join(PI_ROOT, "dist/index.js")}`);
  const adapter: any = await import(
    `file://${path.join(PI_AI, "api/openai-completions.js")}`
  );

  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ft37-sdk-"));
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "cwd");
  const sessions = path.join(dir, "sessions");
  for (const d of [agentDir, cwd, sessions]) fs.mkdirSync(d, { recursive: true });

  // Scripted responses, consumed in order. Each entry is one assistant turn.
  let turn = 0;
  const requestBodies: any[] = [];

  const model = {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "cc-test",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_000,
  };

  const captureFetch = async (_url: string, init: any) => {
    if (typeof init?.body === "string") requestBodies.push(JSON.parse(init.body));
    const script = responses[Math.min(turn, responses.length - 1)];
    turn++;
    return new Response(chatCompletionsSse(script), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const provider = {
    id: "cc-test",
    name: "CC Test",
    auth: {
      apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-key" } }) },
    },
    getModels: () => [model],
    stream: (m: any, context: any, options: any) =>
      adapter.stream(m, context, { ...options, apiKey: "test-key", fetch: captureFetch, maxRetries: 0 }),
    streamSimple: (m: any, context: any, options: any) =>
      adapter.streamSimple(m, context, {
        ...options,
        apiKey: "test-key",
        fetch: captureFetch,
        maxRetries: 0,
      }),
  };

  const modelRuntime = await sdk.ModelRuntime.create({ agentDir });
  modelRuntime.registerNativeProvider(provider);

  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    // The shipped extension, loaded from disk by pi's own extension loader.
    additionalExtensionPaths: options.loadExtension === false ? [] : [EXTENSION_PATH],
    // No discovery: an isolated agent dir and cwd contain nothing else.
    noExtensions: false,
  });
  await resourceLoader.reload();

  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader,
    // A real file-backed manager, so the assertion reads what pi actually persisted.
    sessionManager: sdk.SessionManager.create(cwd, sessions),
    settingsManager: sdk.SettingsManager.inMemory({}),
    noTools: "all",
  });

  // Registers the extension's message_end handler through pi's runtime.
  await session.bindExtensions({});

  const sessionFile = () => {
    const files = fs.readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
    assert.equal(files.length, 1, "exactly one session file should exist");
    return path.join(sessions, files[0]);
  };

  const lines = () => {
    const file = sessionFile();
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  };

  return {
    dir,
    requestBodies,
    lines,
    prompt: (text: string) => session.prompt(text),
    dispose: async () => {
      session.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------------------------

test("a real session persists the normalised message and replays recovered reasoning", async () => {
  // First turn: a native reasoning channel AND a leaked reasoning block in visible text — the
  // mixed shape that 45 of 45 leaking provider/model groups in the corpus contain.
  const harness = await createHarness([
    { reasoning: "NATIVE CHANNEL", text: "<thinking>RECOVERED FROM TEXT</thinking>\nThe answer is four." },
    { text: "second answer" },
  ]);

  try {
    assert.equal(harness.requestBodies.length, 0, "no request should be issued before prompting");

    // --- turn 1 -----------------------------------------------------------------------------
    await harness.prompt("first question");

    // --- persisted JSONL --------------------------------------------------------------------
    const entries = harness.lines();
    const assistantEntry = entries.find(
      (entry) => entry.type === "message" && entry.message?.role === "assistant",
    );
    assert.ok(assistantEntry, "an assistant message must be persisted");

    const content = assistantEntry.message.content as any[];
    const kinds = content.map((block) => block.type);

    // The claim: the persisted record stores recovered reasoning distinctly, not as prose.
    assert.deepEqual(kinds, ["thinking", "thinking", "text"], `persisted block kinds: ${JSON.stringify(kinds)}`);

    const [native, recovered, visible] = content;
    assert.equal(native.thinking, "NATIVE CHANNEL");
    assert.equal(native.thinkingSignature, "reasoning_content");
    assert.equal(recovered.thinking, "RECOVERED FROM TEXT");
    assert.equal(recovered.thinkingSignature, "reasoning_content");
    assert.equal(visible.text, "\nThe answer is four.");

    // And the marker text is gone from the record.
    assert.equal(JSON.stringify(assistantEntry).includes("<thinking>"), false);

    // --- turn 2: the actual outgoing payload ------------------------------------------------
    const beforeSecond = harness.requestBodies.length;
    await harness.prompt("second question");
    assert.ok(
      harness.requestBodies.length > beforeSecond,
      "the second prompt must issue a request",
    );

    const secondBody = harness.requestBodies[harness.requestBodies.length - 1];
    const assistantOut = (secondBody.messages ?? []).find((m: any) => m.role === "assistant");
    assert.ok(assistantOut, "the persisted assistant turn must be in the follow-up request");

    // Recovered reasoning is in the reasoning field, joined with the native channel.
    assert.match(assistantOut.reasoning_content, /NATIVE CHANNEL/);
    assert.match(assistantOut.reasoning_content, /RECOVERED FROM TEXT/);
    // The visible answer travels unmangled, without marker noise.
    assert.equal(assistantOut.content, "\nThe answer is four.");
    assert.equal(JSON.stringify(secondBody).includes("<thinking>"), false);
  } finally {
    await harness.dispose();
  }
});

/**
 * Negative control.
 *
 * The positive test asserts a two-thinking-block record, which is only reachable if the
 * extension ran. This test proves the same pipeline produces the *unfixed* shape when the
 * extension is not loaded — so the earlier assertion is attributable to the extension rather
 * than to the harness, the adapter, or pi happening to normalise on its own.
 */
test("without the extension the same pipeline persists the raw leaked text", async () => {
  const harness = await createHarness(
    [
      { reasoning: "NATIVE CHANNEL", text: "<thinking>RECOVERED FROM TEXT</thinking>\nThe answer is four." },
      { text: "second answer" },
    ],
    { loadExtension: false },
  );

  try {
    await harness.prompt("first question");

    const assistantEntry = harness
      .lines()
      .find((entry) => entry.type === "message" && entry.message?.role === "assistant");
    assert.ok(assistantEntry);

    const content = assistantEntry.message.content as any[];
    assert.deepEqual(
      content.map((block) => block.type),
      ["thinking", "text"],
      "without the hook the leaked reasoning stays in a text block",
    );
    assert.equal(content[1].text, "<thinking>RECOVERED FROM TEXT</thinking>\nThe answer is four.");

    // And the next request carries the markup as prose, which is the defect.
    const before = harness.requestBodies.length;
    await harness.prompt("second question");
    assert.ok(harness.requestBodies.length > before);
    const body = harness.requestBodies[harness.requestBodies.length - 1];
    const out = (body.messages ?? []).find((m: any) => m.role === "assistant");
    assert.equal(JSON.stringify(out).includes("<thinking>"), true);
  } finally {
    await harness.dispose();
  }
});
