/**
 * Verified-pass steering — the prompt-only stage-1 observer.
 *
 * These tests pin exactly what the operator re-scoped it to: a question, at a moment, and
 * nothing else. No snapshot, no working-tree write, no stop. The invariant that matters most
 * is the negative one — with the hook disabled (the default) it must inject nothing at all,
 * and after a single notice it must not nag about the same verifier pass again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-verified-pass-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_VERIFIED_PASS;

import {
  buildNotice,
  decideSteering,
  defaultConfig,
  initialState,
  isVerifierCommand,
  isVerifierPass,
  loadConfig,
  type SteeringConfig,
  type SteeringState,
} from "../src/verified-pass-steering.ts";
import verifiedPassSteering from "../src/verified-pass-steering.ts";

function enabled(overrides: Partial<SteeringConfig> = {}): SteeringConfig {
  return { ...defaultConfig(), enabled: true, ...overrides };
}

/** Runs a sequence of events through the machine and collects the notices it produces. */
function run(events: Parameters<typeof decideSteering>[1][], config = enabled()): string[] {
  let state: SteeringState = initialState();
  const notices: string[] = [];
  for (const event of events) {
    const decision = decideSteering(state, event, config);
    state = decision.state;
    if (decision.notice) notices.push(decision.notice);
  }
  return notices;
}

test("disabled by default: no verifier pass, no notice, state untouched", () => {
  const config = defaultConfig();
  assert.equal(config.enabled, false, "the hook is opt-in");
  const notices = run(
    [
      { kind: "bash", command: "npm test", isError: false },
      { kind: "edit", toolName: "edit" },
      { kind: "edit", toolName: "edit" },
    ],
    config,
  );
  assert.deepEqual(notices, []);
});

test("loadConfig stays disabled without a config file", () => {
  rmSync(join(agentDir, "verified-pass.json"), { force: true });
  const config = loadConfig();
  assert.equal(config.enabled, false);
  assert.ok(config.verifierPatterns.length > 0, "defaults cover the common runners");
});

test("loadConfig reads the opt-in file and merges narrow overrides", () => {
  writeFileSync(
    join(agentDir, "verified-pass.json"),
    JSON.stringify({ enabled: true, verifierPatterns: ["bin/verify"], editsBeforeNotice: 2 }),
  );
  const config = loadConfig();
  assert.equal(config.enabled, true);
  assert.deepEqual(config.verifierPatterns, ["bin/verify"]);
  assert.equal(config.editsBeforeNotice, 2);
  rmSync(join(agentDir, "verified-pass.json"), { force: true });
});

test("PI_VERIFIED_PASS=1 enables without a config file", () => {
  process.env.PI_VERIFIED_PASS = "1";
  try {
    assert.equal(loadConfig().enabled, true);
  } finally {
    delete process.env.PI_VERIFIED_PASS;
  }
});

test("verifier detection needs success and a declared pattern", () => {
  assert.equal(isVerifierPass("npm test", false), true);
  assert.equal(isVerifierPass("npm test", true), false, "a failing run is not a pass");
  assert.equal(isVerifierPass("ls -la", false), false, "an ordinary command is not a verifier");
  assert.equal(isVerifierCommand("cd x && node --test test/a.test.ts"), true);
  assert.equal(isVerifierCommand("bin/verify", ["bin/verify"]), true, "declared patterns narrow the set");
  assert.equal(isVerifierCommand("npm test", ["bin/verify"]), false);
});

test("an edit after a pass produces exactly one notice", () => {
  const notices = run([
    { kind: "bash", command: "npm test", isError: false },
    { kind: "edit", toolName: "edit" },
    { kind: "edit", toolName: "write" },
    { kind: "edit", toolName: "edit" },
  ]);
  assert.equal(notices.length, 1, "one question per verifier pass, not a nagging loop");
  assert.match(notices[0]!, /npm test/);
  assert.match(notices[0]!, /Source edit since that pass: 1/);
  assert.match(notices[0]!, /No snapshot was taken/);
  assert.match(notices[0]!, /nothing will be rolled back/);
});

test("edits before a pass are not evidence against the agent", () => {
  const notices = run([
    { kind: "edit", toolName: "edit" },
    { kind: "edit", toolName: "edit" },
  ]);
  assert.deepEqual(notices, [], "without a verifier pass there is no question to ask");
});

test("a failed verifier run does not arm the notice", () => {
  const notices = run([
    { kind: "bash", command: "npm test", isError: true },
    { kind: "edit", toolName: "edit" },
  ]);
  assert.deepEqual(notices, []);
});

test("a later pass re-arms, so repair work is asked about again", () => {
  const notices = run([
    { kind: "bash", command: "npm test", isError: false },
    { kind: "edit", toolName: "edit" },
    { kind: "bash", command: "cargo test", isError: false },
    { kind: "edit", toolName: "edit" },
  ]);
  assert.equal(notices.length, 2);
  assert.match(notices[0]!, /npm test/);
  assert.match(notices[1]!, /cargo test/);
});

test("a new human prompt clears a stale pass", () => {
  const notices = run([
    { kind: "bash", command: "npm test", isError: false },
    { kind: "input" },
    { kind: "edit", toolName: "edit" },
  ]);
  assert.deepEqual(notices, [], "a fresh request is not post-pass drift");
});

test("editsBeforeNotice delays the question", () => {
  const config = enabled({ editsBeforeNotice: 3 });
  const early = run(
    [
      { kind: "bash", command: "npm test", isError: false },
      { kind: "edit", toolName: "edit" },
      { kind: "edit", toolName: "edit" },
    ],
    config,
  );
  assert.deepEqual(early, [], "two edits is below the declared threshold");
  const reached = run(
    [
      { kind: "bash", command: "npm test", isError: false },
      { kind: "edit", toolName: "edit" },
      { kind: "edit", toolName: "edit" },
      { kind: "edit", toolName: "edit" },
    ],
    config,
  );
  assert.equal(reached.length, 1);
  assert.match(reached[0]!, /Source edits since that pass: 3/);
});

test("the notice offers continue-or-stop and never asserts an action", () => {
  const notice = buildNotice("npm test", 2);
  assert.match(notice, /continue/);
  assert.match(notice, /stop and report/);
  assert.doesNotMatch(notice, /\bI (?:stopped|reverted|restored|snapshotted)\b/i);
});

test("registration defaults to silence and never writes during a pass", () => {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const sent: { text: string; options?: unknown }[] = [];
  verifiedPassSteering({
    on(name: string, handler: any) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name)!.push(handler);
    },
    sendUserMessage(text: string, options?: unknown) {
      sent.push({ text, options });
    },
  } as any);

  const emit = (name: string, event: any) => {
    for (const handler of handlers.get(name) ?? []) handler(event, {});
  };

  emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "npm test" } });
  emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: false, result: {} });
  emit("tool_execution_end", { toolCallId: "c2", toolName: "edit", isError: false, result: {} });
  assert.deepEqual(sent, [], "disabled hook sends nothing");
});

test("registration steers exactly once when enabled, at the tool boundary", () => {
  writeFileSync(join(agentDir, "verified-pass.json"), JSON.stringify({ enabled: true }));
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const sent: { text: string; options?: any }[] = [];
  verifiedPassSteering({
    on(name: string, handler: any) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name)!.push(handler);
    },
    sendUserMessage(text: string, options?: any) {
      sent.push({ text, options });
    },
  } as any);

  const emit = (name: string, event: any) => {
    for (const handler of handlers.get(name) ?? []) handler(event, {});
  };

  emit("input", { text: "do the thing" }); // re-reads config and starts clean
  emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "npm test" } });
  emit("tool_execution_end", { toolCallId: "a", toolName: "bash", isError: false, result: {} });
  emit("tool_execution_end", { toolCallId: "b", toolName: "edit", isError: false, result: {} });
  emit("tool_execution_end", { toolCallId: "c", toolName: "edit", isError: false, result: {} });

  assert.equal(sent.length, 1, "one question, not a repetition per edit");
  assert.equal(sent[0]!.options?.deliverAs, "steer", "delivered as steering, not a stop");
  assert.match(sent[0]!.text, /npm test/);
  rmSync(join(agentDir, "verified-pass.json"), { force: true });
});