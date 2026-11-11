/**
 * FT-20 minimal fix — deterministic regression tests.
 *
 * No provider, no network, no agent process, no store on disk. Every completion
 * goes through a stub that either throws (proving the code cannot reach a real
 * provider) or returns a canned response. Nothing here writes to the live
 * memory store; the "store" objects are call counters.
 *
 * Run:  node --test test/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseReviewOperations,
  parseReviewOperationsDetailed,
} from "../dist/src/handlers/review-memory-ops.js";
import { describeDiagnostics } from "../dist/src/handlers/background-review.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** A completion stub that fails the test if anything ever tries to call a
 * provider. Used for the pure-parser cases. */
const forbiddenProvider = () => {
  throw new Error("FATAL: a provider completion was attempted in a unit test");
};

/** Minimal model shape; `reasoning: false` keeps buildDirectReviewCompletionOptions
 * from touching thinking options. */
const fakeModel = { provider: "test-provider", id: "test-model", api: "test-api", reasoning: false };

/** Canned completion result. Note: no `usage`, which the code tolerates. */
const response = (text, stopReason = "stop") => ({
  stopReason,
  content: text === null ? [] : [{ type: "text", text }],
});

/** Call-counting store double: enough surface for applyReviewOperations. */
function countingStore() {
  const calls = [];
  const record = (kind) => (...args) => {
    calls.push({ kind, args: args.map((a) => (typeof a === "string" ? a.slice(0, 40) : a)) });
    return Promise.resolve({ success: true });
  };
  return {
    calls,
    store: {
      add: record("add"),
      replace: record("replace"),
      remove: record("remove"),
      addFailure: record("addFailure"),
      applyMutationPlan: record("applyMutationPlan"),
    },
  };
}

function fakeCtx() {
  return {
    model: fakeModel,
    modelRegistry: {
      getAll: () => [fakeModel],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
    sessionManager: { getSessionId: () => "test-session" },
  };
}

const baseOptions = (text, stopReason) => ({
  userPrompt: "PROMPT-SENTINEL-" + "p".repeat(100),
  systemPrompt: "system",
  config: {},
  // The stub ignores the request; the payload comes from the closure.
  deps: { completeSimple: async () => response(text, stopReason) },
});

/* ------------------------------------------------------------------ */
/* 1. Parser contract: the defect and its fix                          */
/* ------------------------------------------------------------------ */

test("canonical empty operations payload is a true empty, not a failure", () => {
  const parsed = parseReviewOperationsDetailed('{"operations": []}');
  assert.equal(parsed.kind, "empty_payload");
  // The legacy entry point keeps its old, permissive meaning.
  assert.deepEqual(parseReviewOperations('{"operations": []}'), []);
});

test("the five-word decline is still accepted as a decline", () => {
  assert.deepEqual(parseReviewOperationsDetailed("Nothing to save."), { kind: "declined" });
});

test("invalid non-empty operations fail closed instead of becoming silent empty", () => {
  // THE DEFECT: 0.10.0 returned [] (= ok/empty) for this, so a malformed
  // operation disappeared with no diagnostic and no applied count.
  const parsed = parseReviewOperationsDetailed('{"operations":[{"action":"delete","target":"memory"}]}');
  assert.equal(parsed.kind, "invalid_operations");
  assert.deepEqual(parsed.reasonCodes, ["unknown_action"]);
  // And the legacy entry point now refuses it rather than pretending it is empty.
  assert.equal(parseReviewOperations('{"operations":[{"action":"delete","target":"memory"}]}'), null);
});

test("a mixed valid+invalid array is refused whole, never partially accepted", () => {
  const mixed = JSON.stringify({
    operations: [
      { action: "add", target: "memory", content: "a durable fact" },
      { action: "remove", target: "memory" }, // missing old_text
    ],
  });
  const parsed = parseReviewOperationsDetailed(mixed);
  assert.equal(parsed.kind, "invalid_operations");
  assert.deepEqual(parsed.reasonCodes, ["missing_old_text"]);
  assert.ok(!("operations" in parsed), "no operations may survive a refusal");
});

test("required-field and vocabulary failures each produce a named reason code", () => {
  const cases = [
    ['{"operations":[{"target":"memory","content":"x"}]}', "missing_action"],
    ['{"operations":[{"action":"add","content":"x"}]}', "missing_target"],
    ['{"operations":[{"action":"add","target":"nope","content":"x"}]}', "unknown_target"],
    ['{"operations":[{"action":"add","target":"memory"}]}', "missing_content"],
    ['{"operations":[{"action":"replace","target":"memory","content":"x"}]}', "missing_old_text"],
    ['{"operations":[{"action":"replace","target":"memory","old_text":"x"}]}', "missing_content"],
    ['{"operations":["not an object"]}', "not_an_object"],
    ['{"operations":[null]}', "not_an_object"],
  ];
  for (const [text, expected] of cases) {
    const parsed = parseReviewOperationsDetailed(text);
    assert.equal(parsed.kind, "invalid_operations", text);
    assert.deepEqual(parsed.reasonCodes, [expected], text);
  }
});

test("prose, refusals, malformed and truncated JSON all stay failures — not declines", () => {
  const failures = [
    "Nothing new worth saving from this conversation.",
    "No new durable memories to add.",
    "I can't help with that.",
    "Error: upstream 502 bad gateway",
    '{"operations":[{"action":"add","target":"memory","content":"trunc',
    '{"operations": "not an array"}',
    "",
  ];
  for (const text of failures) {
    const parsed = parseReviewOperationsDetailed(text);
    assert.equal(parsed.kind, "unparsable", JSON.stringify(text));
    assert.equal(parseReviewOperations(text), null, JSON.stringify(text));
  }
});

test("valid full operations are preserved exactly as before", () => {
  const parsed = parseReviewOperationsDetailed(JSON.stringify({
    operations: [
      { action: "add", target: "memory", content: "fact", category: "insight" },
      { action: "replace", target: "user", old_text: "old", content: "new" },
      { action: "remove", target: "project", old_text: "gone" },
      { action: "add", target: "failure", content: "broke", category: "tool-quirk", failure_reason: "why" },
    ],
  }));
  assert.equal(parsed.kind, "operations");
  assert.equal(parsed.operations.length, 4);
  assert.deepEqual(parsed.operations[3], {
    action: "add",
    target: "failure",
    content: "broke",
    category: "tool-quirk",
    failure_reason: "why",
  });
});

test("a fenced, complete payload still parses (extraction cascade untouched)", () => {
  const parsed = parseReviewOperationsDetailed('Here you go:\n```json\n{"operations":[{"action":"add","target":"memory","content":"x"}]}\n```');
  assert.equal(parsed.kind, "operations");
  assert.equal(parsed.operations.length, 1);
});

/* ------------------------------------------------------------------ */
/* 2. Transport behaviour: fail closed end to end, with no writes       */
/* ------------------------------------------------------------------ */

/** Drive runDirectMemoryCompletion through the stub. */
async function runDirect(text, stopReason, { projectStore = null, signal } = {}) {
  const { runDirectMemoryCompletion } = await import("../dist/src/handlers/review-memory-ops.js");
  const { calls, store } = countingStore();
  const result = await runDirectMemoryCompletion(
    fakeCtx(),
    store,
    projectStore,
    { ...baseOptions(text, stopReason), ...(signal ? { signal } : {}) },
    null,
    "Fleet",
    { completeSimple: async () => response(text, stopReason) },
  );
  return { result, calls };
}

test("invalid operations: reported as invalid_operations, and NOTHING is written", async () => {
  const { result, calls } = await runDirect('{"operations":[{"action":"delete","target":"memory"}]}');
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, "invalid_operations");
  assert.equal(result.appliedCount, 0);
  assert.deepEqual(calls, [], "fail-closed must not touch the store");
  assert.equal(result.diagnostics?.invalidOperationCount, 1);
  assert.deepEqual(result.diagnostics?.reasonCodes, ["unknown_action"]);
});

test("mixed array end to end: reported, atomic, no partial apply", async () => {
  const mixed = JSON.stringify({
    operations: [
      { action: "add", target: "memory", content: "a durable fact" },
      { action: "remove", target: "memory" },
    ],
  });
  const { result, calls } = await runDirect(mixed);
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, "invalid_operations");
  assert.deepEqual(calls, [], "the valid operation must not be applied either");
});

test("valid operations still apply, and the result stays ok", async () => {
  const { result, calls } = await runDirect('{"operations":[{"action":"add","target":"memory","content":"fact"}]}');
  assert.equal(result.ok, true);
  assert.equal(result.appliedCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "add");
});

test("canonical empty plan stays a silent success and writes nothing", async () => {
  const { result, calls } = await runDirect('{"operations": []}');
  assert.equal(result.ok, true);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.fallbackReason, "empty");
  assert.deepEqual(calls, []);
});

test("the explicit decline phrase stays a silent success", async () => {
  const { result, calls } = await runDirect("Nothing to save.");
  assert.equal(result.ok, true);
  assert.equal(result.appliedCount, 0);
  assert.deepEqual(calls, []);
});

test("prose is still a parse_error (not swallowed), and writes nothing", async () => {
  const { result, calls } = await runDirect("I reviewed the conversation and found nothing durable.");
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, "parse_error");
  assert.deepEqual(calls, []);
  assert.equal(result.diagnostics?.stopReason, "stop");
});

test("truncation (stopReason length) is a parse_error and is marked as truncation", async () => {
  const { result } = await runDirect('{"operations":[{"action":"add","target":"memory","content":"trunc', "length");
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, "parse_error");
  assert.equal(result.diagnostics?.stopReason, "length");
});

test("an empty clean stop is empty_response, an abort is aborted — both unchanged", async () => {
  const empty = await runDirect(null, "stop");
  assert.equal(empty.result.ok, true);
  assert.equal(empty.result.fallbackReason, "empty_response");

  const controller = new AbortController();
  controller.abort();
  const { runDirectMemoryCompletion } = await import("../dist/src/handlers/review-memory-ops.js");
  const { calls, store } = countingStore();
  const aborted = await runDirectMemoryCompletion(
    fakeCtx(), store, null,
    { userPrompt: "p", systemPrompt: "s", config: {}, signal: controller.signal },
    null, null,
    { completeSimple: forbiddenProvider },
  );
  assert.equal(aborted.fallbackReason, "aborted");
  assert.deepEqual(calls, []);
});

test("a project operation without a project store fails closed instead of skipping", async () => {
  const { result, calls } = await runDirect('{"operations":[{"action":"add","target":"project","content":"fact"}]}');
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, "invalid_operations");
  assert.deepEqual(calls, []);
});

test("a provider error response still surfaces as provider_error, not a parse failure", async () => {
  const { runDirectMemoryCompletion } = await import("../dist/src/handlers/review-memory-ops.js");
  const { store } = countingStore();
  const result = await runDirectMemoryCompletion(
    fakeCtx(), store, null,
    { userPrompt: "p", systemPrompt: "s", config: {} },
    null, null,
    { completeSimple: async () => ({ stopReason: "error", errorMessage: "upstream 502", content: [] }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, "provider_error");
});

/* ------------------------------------------------------------------ */
/* 3. Diagnostics: bounded, redacted, and safe to paste                 */
/* ------------------------------------------------------------------ */

test("diagnostics carry counts and lengths only — never text, never secrets", async () => {
  const secretText = "sk-live-SECRET-DO-NOT-LEAK " + "MEMORYBODY".repeat(50);
  const { result } = await runDirect(secretText);
  const rendered = describeDiagnostics(result.diagnostics);

  // Present and useful.
  assert.match(rendered, /model=redacted/);
  assert.match(rendered, /stopReason=stop/);
  assert.match(rendered, /responseChars=\d+/);
  assert.match(rendered, /promptChars=\d+/);

  // Absent: the response body, the API key, the sentinels, any endpoint.
  assert.ok(!rendered.includes("sk-live"), "a credential-shaped string leaked");
  assert.ok(!rendered.includes("MEMORYBODY"), "response text leaked");
  assert.ok(!rendered.includes("SECRET"), "response text leaked");
  assert.ok(!rendered.includes("PROMPT-SENTINEL"), "prompt text leaked");
  assert.ok(!/@|https?:|api\./i.test(rendered), "endpoint-shaped text leaked");

  // Bounded: a long line is impossible by construction.
  assert.ok(rendered.length < 240, `diagnostics were ${rendered.length} chars`);

  // responseChars is JS string length (UTF-16 code units), stated as such.
  assert.equal(result.diagnostics.responseChars, secretText.length);
});

test("reason codes are a fixed vocabulary with no free text from the model", async () => {
  const hostile = JSON.stringify({
    operations: [{ action: "sk-live-SECRET", target: "memory", content: "x" }],
  });
  const { result } = await runDirect(hostile);
  const rendered = describeDiagnostics(result.diagnostics);
  assert.deepEqual(result.diagnostics?.reasonCodes, ["unknown_action"]);
  assert.ok(!rendered.includes("SECRET"));
  assert.match(rendered, /reasons=unknown_action/);
});

test("describeDiagnostics tolerates a missing diagnostics object", () => {
  assert.equal(describeDiagnostics(undefined), "");
});
