/**
 * FT-94 — the retry loop itself: attempt count, backoff growth, the delay cap, fail-fast on
 * permanent errors, cancellation during backoff, and the durable diagnostic trace.
 *
 * `transient-error-retry.test.ts` proves the *classification* decision against the installed
 * `isRetryableAssistantError`. This file proves the thing an operator actually cares about:
 * that a real session — pi's own agent loop, retry gates, extension runtime and provider
 * dispatch — keeps asking after the third failure instead of settling, that the sleeps it
 * takes are the ones the policy computes, and that a cancellation during a backoff sleep
 * ends the turn promptly.
 *
 * The harness is the one from `session-integration.test.ts`: a real `AgentSession` whose
 * provider is the **installed** `openai-completions` adapter with an injected `fetch`, so
 * response parsing, message conversion and the error-message shape are pi's own. The retry
 * policy is injected through `SettingsManager.inMemory`, which is the same accessor
 * `agent-session.js` reads at `_willRetryAfterAgentEnd` and `_prepareRetry` — so the
 * assertions below are about the real gates, not a copy of them.
 *
 * Every wait is short (base delay 10 ms, cap 40 ms; 4 s only where the test must observe a
 * sleep in progress). Nothing here contacts a model: the base URL is unroutable and the
 * injected fetch never performs I/O.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, "..", "src", "transient-error-retry.ts");

// Pi resolves its config directory from the environment before any argument; see
// session-integration.test.ts for the measured failure this prevents. The harness always
// passes an explicit throwaway agentDir, so the ambient value is unwanted here.
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CODING_AGENT_SESSION_DIR;

function resolvePackageRoot(candidate: string): string | undefined {
  return fs.existsSync(path.join(candidate, "dist/index.js")) ? candidate : undefined;
}

function piPackageRoot(): string | undefined {
  const explicit = process.env.PI_SDK_ROOT;
  if (explicit) {
    const resolved = resolvePackageRoot(explicit);
    if (!resolved) throw new Error(`PI_SDK_ROOT is set to "${explicit}" but no dist/index.js was found there`);
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

test("verification gate: SDK, adapter and the extension under test are discoverable", () => {
  assert.ok(
    PI_ROOT,
    "installed pi-coding-agent not found. Set PI_SDK_ROOT to the package root (not PI_CODING_AGENT_DIR).",
  );
  assert.ok(PI_AI, `installed pi-ai not found. Set PI_AI_DIST to the package root or its dist directory.`);
  assert.ok(fs.existsSync(EXTENSION_PATH), `extension file must exist on disk at ${EXTENSION_PATH}`);
});

// ---------------------------------------------------------------------------------------------
// Scripted gateway responses
// ---------------------------------------------------------------------------------------------

const REQUEST_ID = "20261119095112854781304HZXFss7T";
const HTTP2_STREAM_DROP = "upstream stream read failed before completion: http2: response body closed";
const ROUTING_BUDGET_BODY = JSON.stringify({
  message: `routing retry budget expired before first protocol event (request id: ${REQUEST_ID})`,
});
const MALFORMED_BODY = JSON.stringify({
  error: { message: "invalid_request_error: the request body is malformed", type: "invalid_request_error" },
});

function successSse(text: string): string {
  return [
    `data: ${JSON.stringify({ id: "chunk-1", model: "test-model", choices: [{ index: 0, delta: { content: text } }] })}`,
    "",
    `data: ${JSON.stringify({ id: "chunk-1", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

interface Scripted {
  status: number;
  body: string | ReadableStream<Uint8Array>;
  contentType?: string;
}

interface Harness {
  logFile: string;
  fetchTimes: number[];
  diagnostics: () => any[];
  lines: () => any[];
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function createHarness(
  script: Scripted[],
  settings: Record<string, unknown>,
  useRetryExtension = true,
): Promise<Harness> {
  assert.ok(PI_ROOT && PI_AI);

  const sdk: any = await import(`file://${path.join(PI_ROOT, "dist/index.js")}`);
  const adapter: any = await import(`file://${path.join(PI_AI, "api/openai-completions.js")}`);

  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ft94-retry-"));
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "cwd");
  const sessions = path.join(dir, "sessions");
  for (const d of [agentDir, cwd, sessions]) fs.mkdirSync(d, { recursive: true });

  // Durable diagnostics go to a file this test owns; the extension reads the override at
  // call time. Set before the session runs so no record can reach the fleet's real path.
  const logFile = path.join(dir, "retry-events.jsonl");
  process.env.PI_FLEET_RETRY_LOG = logFile;

  let turn = 0;
  const fetchTimes: number[] = [];
  const requestBodies: any[] = [];

  const model = {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "cc-test",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_000,
  };

  const captureFetch = async (_url: string, init: any) => {
    if (typeof init?.body === "string") requestBodies.push(JSON.parse(init.body));
    fetchTimes.push(Date.now());
    const entry = script[Math.min(turn, script.length - 1)];
    turn++;
    return new Response(entry.body, {
      status: entry.status,
      headers: { "content-type": entry.contentType ?? "text/event-stream" },
    });
  };

  const provider = {
    id: "cc-test",
    name: "CC Test",
    auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
    getModels: () => [model],
    stream: (m: any, context: any, options: any) =>
      adapter.stream(m, context, { ...options, apiKey: "test-key", fetch: captureFetch, maxRetries: 0 }),
    streamSimple: (m: any, context: any, options: any) =>
      adapter.streamSimple(m, context, { ...options, apiKey: "test-key", fetch: captureFetch, maxRetries: 0 }),
  };

  const modelRuntime = await sdk.ModelRuntime.create({ agentDir });
  modelRuntime.registerNativeProvider(provider);

  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: useRetryExtension ? [EXTENSION_PATH] : [],
    noExtensions: false,
  });
  await resourceLoader.reload();

  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader,
    sessionManager: sdk.SessionManager.create(cwd, sessions),
    settingsManager: sdk.SettingsManager.inMemory({ retry: settings }),
    noTools: "all",
  });
  await session.bindExtensions({});

  const lines = () => {
    const files = fs.readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
    assert.equal(files.length, 1, "exactly one session file should exist");
    return fs
      .readFileSync(path.join(sessions, files[0]), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  };

  const diagnostics = () =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : [];

  return {
    logFile,
    fetchTimes,
    diagnostics,
    lines,
    prompt: (text: string) => session.prompt(text),
    abort: () => session.abort(),
    dispose: async () => {
      session.dispose();
      // `PI_FLEET_RETRY_KEEP_DIR=1` keeps the throwaway session and its diagnostic log for
      // inspection instead of deleting them; the receipt's captured trace is produced this way.
      if (process.env.PI_FLEET_RETRY_KEEP_DIR === "1") {
        console.error(`[ft94] kept harness dir: ${dir}`);
        fs.writeFileSync(path.join(dir, "fetch-times.json"), JSON.stringify(fetchTimes));
        return;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Waits until `check` returns true, polling every 20 ms; throws after `timeoutMs`. */
async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

const FAST = { enabled: true, maxRetries: 1_000_000_000, baseDelayMs: 10, maxAgentDelayMs: 40 };

test("retry diagnostics use the fleet jitter setting and preserve the five-minute hard cap", async () => {
  const harness = await createHarness(
    [{ status: 403, body: ROUTING_BUDGET_BODY }, { status: 200, body: successSse("recovered") }],
    { enabled: true, maxRetries: 1_000_000_000, baseDelayMs: 100, maxAgentDelayMs: 300_000, jitterRatio: 0.2 },
  );
  try {
    await harness.prompt("verify fleet jitter propagation");
    const scheduled = harness.diagnostics().filter((entry) => entry.event === "retry_scheduled");
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delayMs >= 80, true, `expected lower bound 80 ms, got ${scheduled[0].delayMs}`);
    assert.equal(scheduled[0].delayMs <= 120, true, `expected upper bound 120 ms, got ${scheduled[0].delayMs}`);
    assert.equal(scheduled[0].delayMs <= 300_000, true, "the fleet cap remains a hard ceiling");
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// Requirement: retries continue past the finite budget, with exponential growth and a cap
// ---------------------------------------------------------------------------------------------

test("Pi 1.6 still settles the HTTP/2 stream drop without the fleet retry extension", async () => {
  const harness = await createHarness(
    [
      {
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "partial", model: "test-model", choices: [{ index: 0, delta: { content: "partial" } }] })}\\n\\n`,
              ),
            );
            controller.error(new Error(HTTP2_STREAM_DROP));
          },
        }),
      },
    ],
    FAST,
    false,
  );

  try {
    await harness.prompt("check native Pi retry for HTTP/2 close");
    assert.equal(harness.fetchTimes.length, 1, "native Pi classifier does not retry this exact failure");
    const assistantEntries = harness
      .lines()
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
    assert.equal(assistantEntries.at(-1)?.message.stopReason, "error");
    assert.equal(assistantEntries.at(-1)?.message.errorMessage, HTTP2_STREAM_DROP);
  } finally {
    await harness.dispose();
  }
});

test("a real session retries the recorded HTTP/2 stream drop and recovers the same turn", async () => {
  const harness = await createHarness(
    [
      {
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "partial", model: "test-model", choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`,
              ),
            );
            controller.error(new Error(HTTP2_STREAM_DROP));
          },
        }),
      },
      { status: 200, body: successSse("recovered after stream drop") },
    ],
    FAST,
  );

  try {
    await harness.prompt("recover after a transient HTTP/2 response-body close");
    assert.equal(harness.fetchTimes.length, 2, "Pi must issue a second provider request after the stream drop");
    const assistantEntries = harness
      .lines()
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
    assert.equal(assistantEntries[0]?.message.stopReason, "error");
    assert.equal(assistantEntries[0]?.message.errorMessage, `server_error: ${HTTP2_STREAM_DROP}`);
    assert.equal(assistantEntries.at(-1)?.message.stopReason, "stop", "the same turn must recover and finish");
    const scheduled = harness.diagnostics().filter((entry) => entry.event === "retry_scheduled");
    assert.equal(scheduled.length, 1);
    assert.match(String(scheduled[0].reason), /upstream stream read failed before completion: http2: response body closed/);
    assert.equal(harness.diagnostics().filter((entry) => entry.event === "recovered").length, 1);
  } finally {
    await harness.dispose();
  }
});

test("a real session retries a 403 routing-budget family past the old 3-attempt budget and keeps the turn", async () => {
  // Six identical failures, then success. Raw `403:` is not retryable by pi's classifier, so
  // reaching the seventh request at all proves the rewrite reached the retry decision.
  const harness = await createHarness(
    [
      ...Array.from({ length: 6 }, () => ({ status: 403, body: ROUTING_BUDGET_BODY })),
      { status: 200, body: successSse("recovered") },
    ],
    FAST,
  );

  try {
    await harness.prompt("first question");

    // --- the loop kept going -------------------------------------------------------------
    assert.equal(
      harness.fetchTimes.length,
      7,
      "six failed attempts must be followed by a seventh request, not a settled turn",
    );

    const assistantEntries = harness
      .lines()
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
    const last = assistantEntries[assistantEntries.length - 1];
    assert.equal(last.message.stopReason, "stop", "the turn must end on the successful attempt");
    assert.equal(
      assistantEntries.filter((entry) => entry.message.stopReason === "error").length,
      6,
      "one error record per failed attempt",
    );

    // --- the delay sequence: exponential, then capped -------------------------------------
    const scheduled = harness.diagnostics().filter((d) => d.event === "retry_scheduled");
    assert.deepEqual(
      scheduled.map((d) => d.attempt),
      [1, 2, 3, 4, 5, 6],
      "one diagnostic record per retry, numbered from 1",
    );
    assert.deepEqual(
      scheduled.map((d) => d.delayMs),
      [10, 20, 40, 40, 40, 40],
      "delays double from baseDelayMs and stop at maxAgentDelayMs",
    );
    assert.equal(
      scheduled.every((d) => d.requestId === REQUEST_ID),
      true,
      "every record carries the gateway request id",
    );
    assert.equal(
      scheduled.every((d) => String(d.reason).startsWith("server_error: 403:")),
      true,
      "the promoted text is what the diagnostic records as the reason",
    );

    // --- the computed delay is the delay actually slept -----------------------------------
    // Gap N is the sleep taken after failure N. Asserting a lower bound at 80% of the logged
    // delay proves the number in the diagnostic is the number that reached the timer, not a
    // recomputation that happened to be recorded.
    const gaps = harness.fetchTimes.slice(1).map((t, i) => t - harness.fetchTimes[i]);
    scheduled.forEach((record, i) => {
      assert.ok(
        gaps[i] >= record.delayMs * 0.8,
        `gap after attempt ${record.attempt} was ${gaps[i]} ms; logged delay ${record.delayMs} ms never reached the timer`,
      );
    });

    // --- terminal disposition --------------------------------------------------------------
    const recovered = harness.diagnostics().filter((d) => d.event === "recovered");
    assert.equal(recovered.length, 1, "the chain closes with one recovered record");
    assert.equal(recovered[0].attempts, 6);
  } finally {
    await harness.dispose();
  }
});

/**
 * Negative control for the budget: the same script and the extension loaded, but with the
 * finite policy the fleet ran before FT-94. Three retries and a settled error is what the
 * unbounded run above must differ from — otherwise the extra attempts were not the policy's
 * doing.
 */
test("with maxRetries 3 the same script stops after three retries and settles on the error", async () => {
  const harness = await createHarness(
    [{ status: 403, body: ROUTING_BUDGET_BODY }],
    { enabled: true, maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 40 },
  );

  try {
    await harness.prompt("first question");

    assert.equal(harness.fetchTimes.length, 4, "3 retries after the initial attempt, then settle");
    const scheduled = harness.diagnostics().filter((d) => d.event === "retry_scheduled");
    assert.deepEqual(scheduled.map((d) => d.delayMs), [10, 20, 40]);

    const assistantEntries = harness
      .lines()
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
    assert.equal(assistantEntries[assistantEntries.length - 1].message.stopReason, "error");

    const settled = harness.diagnostics().filter((d) => d.event === "settled");
    assert.equal(settled.length, 1);
    assert.equal(settled[0].attempts, 3);
    assert.match(settled[0].reason, /routing retry budget expired/);
    assert.equal(settled[0].requestId, REQUEST_ID);
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// Requirement: permanent failures still fail fast
// ---------------------------------------------------------------------------------------------

test("a malformed request fails on the first attempt and never spins", async () => {
  const harness = await createHarness([{ status: 400, body: MALFORMED_BODY }], FAST);

  try {
    await harness.prompt("first question");

    assert.equal(harness.fetchTimes.length, 1, "a 400 must not be retried, whatever the budget");
    assert.deepEqual(
      harness.diagnostics().filter((d) => d.event === "retry_scheduled"),
      [],
      "nothing is scheduled for a permanent failure",
    );

    const assistantEntries = harness
      .lines()
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
    const last = assistantEntries[assistantEntries.length - 1];
    assert.equal(last.message.stopReason, "error");
    assert.match(last.message.errorMessage, /invalid_request_error/);
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// Requirement: the turn stays cancellable during backoff
// ---------------------------------------------------------------------------------------------

test("aborting during a backoff sleep ends the turn promptly and stops the retries", async () => {
  // A 4 s sleep gives the test a window wide enough to observe cancellation; the assertion is
  // that abort returns in well under that sleep, i.e. the wait was interrupted rather than run
  // to completion.
  const harness = await createHarness([{ status: 403, body: ROUTING_BUDGET_BODY }], {
    enabled: true,
    maxRetries: 1_000_000_000,
    baseDelayMs: 4_000,
    maxAgentDelayMs: 4_000,
  });

  try {
    const promptPromise = harness.prompt("first question").catch(() => undefined);

    await waitFor(
      () => harness.diagnostics().some((d) => d.event === "retry_scheduled"),
      2_000,
      "the first retry to be scheduled",
    );

    const t0 = Date.now();
    await harness.abort();
    const abortMs = Date.now() - t0;
    assert.ok(abortMs < 2_000, `abort() must interrupt the 4000 ms sleep, took ${abortMs} ms`);

    await promptPromise;
    // Give a late retry a moment to appear if cancellation had failed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harness.fetchTimes.length, 1, "no request may be issued after the abort");

    const aborted = harness.diagnostics().filter((d) => d.event === "aborted");
    assert.equal(aborted.length, 1, "the chain closes with an aborted record");
    assert.equal(aborted[0].aborted, true);
    assert.equal(aborted[0].requestId, REQUEST_ID);
  } finally {
    await harness.dispose();
  }
});
