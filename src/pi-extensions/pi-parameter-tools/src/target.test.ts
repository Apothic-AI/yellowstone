// target.test.ts — what the four tools do, and what they refuse.
//
// The runtime and the control channel are injected, so these tests never start a
// process, never call a provider and never touch a session file.

import { describe, expect, test } from "bun:test";
import { makeFakeRuntime } from "./fakes.ts";
import { applyOwnModel, applyOwnThinking, applySessionModel, applySessionThinking } from "./target.ts";

describe("set_own_thinking", () => {
	test("sets the level and reports the change", async () => {
		const runtime = makeFakeRuntime({ thinkingLevel: "off" });
		const result = await applyOwnThinking(runtime, "set_own_thinking", "high");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(result.changed).toBe(true);
		expect(result.thinking.before).toBe("off");
		expect(result.thinking.after).toBe("high");
		expect(runtime.calls.setThinkingLevel).toEqual(["high"]);
	});

	test("the same level again is a no-op: the setter is not called", async () => {
		const runtime = makeFakeRuntime({ thinkingLevel: "high" });
		const result = await applyOwnThinking(runtime, "set_own_thinking", "high");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("none");
		expect(result.changed).toBe(false);
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("an unknown level is refused, never clamped", async () => {
		const runtime = makeFakeRuntime();
		const result = await applyOwnThinking(runtime, "set_own_thinking", "HIGH");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("invalid_level");
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("a level the model does not support is refused, and the supported ones are named", async () => {
		const runtime = makeFakeRuntime({ supported: ["off", "low"] });
		const result = await applyOwnThinking(runtime, "set_own_thinking", "xhigh");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("level_unsupported");
		expect(result.refusal?.detail?.supported).toEqual(["off", "low"]);
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});
});

describe("set_own_model", () => {
	test("sets the model and reports the change", async () => {
		const runtime = makeFakeRuntime({
			model: { provider: "anthropic", modelId: "claude-sonnet-4" },
			knownModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				{ provider: "anthropic", modelId: "claude-opus-4" },
			],
		});
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-opus-4");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("model");
		expect(result.changed).toBe(true);
		expect(result.model.before?.modelId).toBe("claude-sonnet-4");
		expect(result.model.after?.modelId).toBe("claude-opus-4");
		expect(runtime.calls.setModel).toEqual([{ provider: "anthropic", modelId: "claude-opus-4" }]);
	});

	test("the same model again is a no-op: the setter is not called", async () => {
		const runtime = makeFakeRuntime({ model: { provider: "anthropic", modelId: "claude-sonnet-4" } });
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-sonnet-4");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("none");
		expect(result.changed).toBe(false);
		expect(runtime.calls.setModel).toEqual([]);
	});

	test("a model the registry does not know is refused", async () => {
		const runtime = makeFakeRuntime();
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "nope");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("model_unknown");
		expect(runtime.calls.setModel).toEqual([]);
	});

	test("a provider without credentials is refused", async () => {
		const runtime = makeFakeRuntime({
			authed: false,
			knownModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				{ provider: "anthropic", modelId: "claude-opus-4" },
			],
		});
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-opus-4");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("auth_missing");
	});

	test("a setter that throws is an apply failure, not an auth failure", async () => {
		const runtime = makeFakeRuntime({
			knownModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				{ provider: "anthropic", modelId: "claude-opus-4" },
			],
		});
		runtime.setOwnModel = async () => {
			throw new Error("boom");
		};
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-opus-4");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("apply_failed");
	});
});

describe("set_session_thinking", () => {
	test("changes the caller's own session, addressed explicitly, in this process", async () => {
		const runtime = makeFakeRuntime({
			sessionId: "own-session-id",
			sessionPath: "/tmp/own/session.jsonl",
			thinkingLevel: "off",
			sessionHeaderIds: { "/tmp/own/session.jsonl": "own-session-id" },
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "own-session-id", sessionPath: "/tmp/own/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(result.changed).toBe(true);
		expect(result.thinking.before).toBe("off");
		expect(result.thinking.after).toBe("high");
		expect(runtime.calls.setThinkingLevel).toEqual(["high"]);
		expect(result.target.resolution?.source).toBe("session_file");
	});

	test("another session is changed by its own receiver, and the answer is the target's", async () => {
		const runtime = makeFakeRuntime({
			sessionHeaderIds: { "/tmp/target/session.jsonl": "target-id" },
			sendToTarget: async (request) => ({
				ok: true,
				result: {
					ok: true,
					tool: request.tool,
					target: { kind: "session", sessionId: request.sessionId, sessionPath: request.sessionPath },
					model: { before: null, requested: null, after: null },
					thinking: { before: "off", requested: request.level, after: "high", supported: ["high"] },
					applied: "thinking",
					changed: true,
					records: { modelChangeEntryId: null, thinkingLevelEntryId: "target-record" },
					disk: { state: "unknown" },
					effective: "next_request",
					partial: false,
					warnings: [],
				},
				receiver: { sessionId: request.sessionId, sessionPath: request.sessionPath },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(result.changed).toBe(true);
		expect(result.thinking.before).toBe("off");
		expect(result.thinking.after).toBe("high");
		expect(result.records.thinkingLevelEntryId).toBe("target-record");
		expect(result.target.resolution?.source).toBe("receiver");
		// the request went to the target, not to this session
		expect(runtime.calls.deliveries).toHaveLength(1);
		expect(runtime.calls.deliveries[0]?.sessionId).toBe("target-id");
		expect(runtime.calls.deliveries[0]?.request.action).toBe("set_thinking");
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("a target with no receiver listening is refused, and nothing is changed", async () => {
		const runtime = makeFakeRuntime({
			sessionHeaderIds: { "/tmp/target/session.jsonl": "target-id" },
			sendToTarget: async () => ({
				ok: false,
				refusal: { code: "receiver_unavailable", message: "the target session is not listening" },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("receiver_unavailable");
		expect(result.changed).toBe(false);
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("a target that does not answer in time is refused as a timeout", async () => {
		const runtime = makeFakeRuntime({
			sessionHeaderIds: { "/tmp/target/session.jsonl": "target-id" },
			sendToTarget: async () => ({
				ok: false,
				refusal: { code: "target_timeout", message: "the target session did not answer in time" },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("target_timeout");
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("a session file that holds another session is refused", async () => {
		const runtime = makeFakeRuntime({
			sessionHeaderIds: { "/tmp/target/session.jsonl": "other-id" },
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("session_id_mismatch");
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("a session file with no session id is refused", async () => {
		const runtime = makeFakeRuntime({ sessionHeaderIds: {} });
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("no_session_file");
	});

	test("two bindings at once is refused before the target is resolved", async () => {
		const runtime = makeFakeRuntime();
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl", lane: "lane-a" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("identity_binding_conflict");
		expect(runtime.calls.laneResolutions).toEqual([]);
	});

	test("no binding at all is refused before the target is resolved", async () => {
		const runtime = makeFakeRuntime();
		const result = await applySessionThinking(runtime, "set_session_thinking", { sessionId: "target-id" }, "high");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("identity_binding_required");
		expect(runtime.calls.laneResolutions).toEqual([]);
	});

	test("a lane binding resolves the lane to a session, and the request goes to its receiver", async () => {
		const runtime = makeFakeRuntime({
			sessionHeaderIds: { "/tmp/lane/session.jsonl": "target-id" },
			resolveLane: async () => ({
				ok: true,
				lane: { sessionPath: "/tmp/lane/session.jsonl", kind: "pi", paneId: "w1A:p1" },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", lane: "lane-a" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("receiver_unavailable");
		expect(result.target.resolution?.source).toBe("lane");
		expect(result.target.resolution?.lane).toBe("lane-a");
		expect(runtime.calls.laneResolutions).toEqual(["lane-a"]);
		expect(runtime.calls.deliveries[0]?.sessionId).toBe("target-id");
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("a lane that cannot be resolved is refused", async () => {
		const runtime = makeFakeRuntime({
			resolveLane: async () => ({
				ok: false,
				failure: { code: "target_lane_unknown", message: "no such lane" },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", lane: "lane-a" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("target_lane_unknown");
	});

	test("a lane in a held place is refused", async () => {
		const runtime = makeFakeRuntime({
			sessionHeaderIds: { "/tmp/lane/session.jsonl": "target-id" },
			resolveLane: async () => ({
				ok: true,
				lane: { sessionPath: "/tmp/lane/session.jsonl", kind: "pi", paneId: "w2:p1" },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", lane: "lane-a" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("held_lane");
	});
});

describe("set_session_model", () => {
	test("changes the caller's own model, addressed explicitly, in this process", async () => {
		const runtime = makeFakeRuntime({
			sessionId: "own-session-id",
			sessionPath: "/tmp/own/session.jsonl",
			sessionHeaderIds: { "/tmp/own/session.jsonl": "own-session-id" },
			knownModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				{ provider: "anthropic", modelId: "claude-opus-4" },
			],
		});
		const result = await applySessionModel(
			runtime,
			"set_session_model",
			{ sessionId: "own-session-id", sessionPath: "/tmp/own/session.jsonl" },
			"anthropic",
			"claude-opus-4",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("model");
		expect(result.changed).toBe(true);
		expect(result.model.after?.modelId).toBe("claude-opus-4");
		expect(runtime.calls.setModel).toEqual([{ provider: "anthropic", modelId: "claude-opus-4" }]);
	});

	test("another session's model is changed by its own receiver", async () => {
		const runtime = makeFakeRuntime({
			sessionHeaderIds: { "/tmp/target/session.jsonl": "target-id" },
			sendToTarget: async (request) => ({
				ok: true,
				result: {
					ok: true,
					tool: request.tool,
					target: { kind: "session", sessionId: request.sessionId, sessionPath: request.sessionPath },
					model: {
						before: { provider: "anthropic", modelId: "claude-sonnet-4" },
						requested: null,
						after: { provider: "anthropic", modelId: "claude-opus-4" },
					},
					thinking: { before: "off", requested: null, after: "off", supported: [] },
					applied: "model",
					changed: true,
					records: { modelChangeEntryId: "target-model-record", thinkingLevelEntryId: null },
					disk: { state: "unknown" },
					effective: "next_request",
					partial: false,
					warnings: [],
				},
				receiver: { sessionId: request.sessionId, sessionPath: request.sessionPath },
			}),
		});
		const result = await applySessionModel(
			runtime,
			"set_session_model",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"anthropic",
			"claude-opus-4",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("model");
		expect(result.changed).toBe(true);
		expect(result.records.modelChangeEntryId).toBe("target-model-record");
		expect(runtime.calls.deliveries[0]?.request.action).toBe("set_model");
		expect(runtime.calls.setModel).toEqual([]);
	});
});

describe("isolation", () => {
	test("a change aimed at another session leaves this session alone", async () => {
		const runtime = makeFakeRuntime({
			sessionId: "own-session-id",
			sessionPath: "/tmp/a/session.jsonl",
			sessionHeaderIds: { "/tmp/b/session.jsonl": "b-id" },
			sendToTarget: async (request) => ({
				ok: true,
				result: {
					ok: true,
					tool: request.tool,
					target: { kind: "session", sessionId: request.sessionId, sessionPath: request.sessionPath },
					model: { before: null, requested: null, after: null },
					thinking: { before: "off", requested: request.level, after: "high", supported: [] },
					applied: "thinking",
					changed: true,
					records: { modelChangeEntryId: null, thinkingLevelEntryId: "b-record" },
					disk: { state: "unknown" },
					effective: "next_request",
					partial: false,
					warnings: [],
				},
				receiver: { sessionId: request.sessionId, sessionPath: request.sessionPath },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "b-id", sessionPath: "/tmp/b/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(true);
		// this session did not move; the target did
		expect(runtime.calls.setThinkingLevel).toEqual([]);
		expect(runtime.state.thinkingLevel).toBe("off");
		expect(runtime.calls.deliveries[0]?.sessionId).toBe("b-id");
	});

	test("and a change aimed at this session changes only this session", async () => {
		const runtime = makeFakeRuntime({
			sessionId: "a-id",
			sessionPath: "/tmp/a/session.jsonl",
			sessionHeaderIds: { "/tmp/a/session.jsonl": "a-id" },
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "a-id", sessionPath: "/tmp/a/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(true);
		expect(runtime.state.thinkingLevel).toBe("high");
	});
});
