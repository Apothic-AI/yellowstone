// receiver.test.ts — the listener inside the target lane.
//
// The receiver is the only thing that changes another session's parameters, so its
// refusals matter as much as its changes: a request that names another session, a
// held place, a level the model does not support, or a model without credentials is
// refused, and the session's own state is left alone.
//
// These tests use a fake session: the setters are counted, not run.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelRequest, sendRequest, socketPathFor } from "./channel.ts";
import type { ModelRef } from "./params.ts";
import { applyRequest, type ReceiverSession, startReceiver } from "./receiver.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const PATH = "/tmp/ft55/session.jsonl";

interface FakeSession extends ReceiverSession {
	calls: { setThinkingLevel: string[]; setModel: ModelRef[] };
}

function fakeSession(overrides: Partial<ReceiverSession> = {}): FakeSession {
	const state = {
		thinkingLevel: "off" as string | null,
		// The model the session starts with is not the one the requests ask for, so
		// a model change is a real change.
		model: { provider: "anthropic", modelId: "claude-sonnet-3-5" } as ModelRef | null,
	};
	const calls = { setThinkingLevel: [] as string[], setModel: [] as ModelRef[] };
	const session: FakeSession = {
		calls,
		sessionId: ID,
		sessionPath: PATH,
		workspaceId: null,
		tabId: null,
		paneId: null,
		supportedThinkingLevels: () => ["off", "low", "medium", "high"],
		resolveModel: (ref) =>
			ref.provider === "anthropic" && ref.modelId === "claude-sonnet-4"
				? { provider: ref.provider, modelId: ref.modelId }
				: null,
		setThinkingLevel: (level) => {
			calls.setThinkingLevel.push(level);
			state.thinkingLevel = level;
		},
		setModel: async (ref) => {
			calls.setModel.push(ref);
			state.model = ref;
			return true;
		},
		thinkingLevel: () => state.thinkingLevel,
		model: () => state.model,
		records: () => ({ modelChangeEntryId: "model-record", thinkingLevelEntryId: "thinking-record" }),
		...overrides,
	};
	return session;
}

function request(overrides: Partial<ChannelRequest> = {}): ChannelRequest {
	return {
		requestId: "req-1",
		tool: "set_session_thinking",
		sessionId: ID,
		sessionPath: PATH,
		action: "set_thinking",
		level: "high",
		...overrides,
	};
}

describe("a request this session accepts", () => {
	test("the thinking level is changed, and the change is read back", async () => {
		const session = fakeSession();
		const result = await applyRequest(request(), session);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(result.changed).toBe(true);
		expect(result.thinking.before).toBe("off");
		expect(result.thinking.after).toBe("high");
		expect(session.calls.setThinkingLevel).toEqual(["high"]);
	});

	test("the same level again is a no-op", async () => {
		const session = fakeSession();
		const result = await applyRequest(request({ level: "off" }), session);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("none");
		expect(result.changed).toBe(false);
		expect(session.calls.setThinkingLevel).toEqual([]);
	});

	test("the model is changed, and the change is read back", async () => {
		const session = fakeSession();
		const result = await applyRequest(
			request({
				action: "set_model",
				level: undefined,
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			}),
			session,
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("model");
		expect(result.changed).toBe(true);
		expect(result.model.before?.modelId).toBe("claude-sonnet-3-5");
		expect(result.model.after?.modelId).toBe("claude-sonnet-4");
		expect(session.calls.setModel).toEqual([{ provider: "anthropic", modelId: "claude-sonnet-4" }]);
	});

	test("a model the session does not have is refused", async () => {
		const session = fakeSession();
		const result = await applyRequest(
			request({ action: "set_model", level: undefined, provider: "anthropic", modelId: "nope" }),
			session,
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("model_unknown");
		expect(session.calls.setModel).toEqual([]);
	});

	test("a model without credentials is refused", async () => {
		const session = fakeSession({ setModel: async () => false });
		const result = await applyRequest(
			request({ action: "set_model", level: undefined, provider: "anthropic", modelId: "claude-sonnet-4" }),
			session,
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("auth_missing");
	});
});

describe("a request this session refuses", () => {
	test("a request that names another session is refused", async () => {
		const session = fakeSession();
		const result = await applyRequest(request({ sessionId: "other-id" }), session);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("session_id_mismatch");
		expect(session.calls.setThinkingLevel).toEqual([]);
	});

	test("a request that names another session file is refused", async () => {
		const session = fakeSession();
		const result = await applyRequest(request({ sessionPath: "/tmp/ft55/other.jsonl" }), session);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("session_identity_mismatch");
		expect(session.calls.setThinkingLevel).toEqual([]);
	});

	test("a session in a held place refuses", async () => {
		const session = fakeSession({ workspaceId: "w2" });
		const result = await applyRequest(request(), session);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("held_lane");
		expect(session.calls.setThinkingLevel).toEqual([]);
	});

	test("a level pi does not accept is refused", async () => {
		const session = fakeSession();
		const result = await applyRequest(request({ level: "loud" }), session);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("invalid_level");
		expect(session.calls.setThinkingLevel).toEqual([]);
	});

	test("a level this model does not support is refused, not clamped", async () => {
		const session = fakeSession({ supportedThinkingLevels: () => ["off", "low"] });
		const result = await applyRequest(request({ level: "high" }), session);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("level_unsupported");
		expect(session.calls.setThinkingLevel).toEqual([]);
	});

	test("an action this receiver does not perform is refused", async () => {
		const session = fakeSession();
		const result = await applyRequest(request({ action: "restart" as never }), session);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("invalid_identifier");
		expect(session.calls.setThinkingLevel).toEqual([]);
	});
});

describe("the receiver as a listener", () => {
	test("it answers on its socket, and the socket goes when it closes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-receiver-"));
		const socketPath = socketPathFor(ID, PATH, dir);
		const session = fakeSession();
		const receiver = await startReceiver({ socketPath, session });
		try {
			expect(receiver.listening).toBe(true);
			expect(existsSync(socketPath)).toBe(true);
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request(),
				dir: dir,
				timeoutMs: 2000,
			});
			expect(response.ok).toBe(true);
			expect(response.receiver?.sessionId).toBe(ID);
			expect((response.result as { applied?: string } | undefined)?.applied).toBe("thinking");
			expect(session.calls.setThinkingLevel).toEqual(["high"]);
		} finally {
			receiver.close();
			expect(existsSync(socketPath)).toBe(false);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("who owns the socket", () => {
	test("the newest owner takes the name, and the old owner cannot take it back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-receiver-"));
		const socketPath = socketPathFor(ID, PATH, dir);
		const first = fakeSession();
		const second = fakeSession();
		const notices: string[] = [];
		const owner = await startReceiver({ socketPath, session: first });
		const newcomer = await startReceiver({
			socketPath,
			session: second,
			onError: (message) => notices.push(message),
		});
		try {
			expect(owner.listening).toBe(true);
			expect(newcomer.listening).toBe(true);
			expect(notices.join(" ")).toContain("took");

			// The name belongs to the newest owner: the request lands there.
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request(),
				dir,
				timeoutMs: 2000,
			});
			expect(response.ok).toBe(true);
			expect(second.calls.setThinkingLevel).toEqual(["high"]);
			expect(first.calls.setThinkingLevel).toEqual([]);

			// The previous owner shuts down. Its cleanup must not take the name
			// away from the owner that has it now.
			owner.close();
			expect(existsSync(socketPath)).toBe(true);
			const after = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request({ level: "medium" }),
				dir,
				timeoutMs: 2000,
			});
			expect(after.ok).toBe(true);
			expect(second.calls.setThinkingLevel).toEqual(["high", "medium"]);
			expect(first.calls.setThinkingLevel).toEqual([]);
		} finally {
			owner.close();
			newcomer.close();
			expect(existsSync(socketPath)).toBe(false);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a socket left behind by a process that died is replaced", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-receiver-"));
		const socketPath = socketPathFor(ID, PATH, dir);
		// A process that binds the socket and is killed leaves the file behind with
		// nobody listening: exactly what a crashed lane leaves.
		const child = spawn(
			process.execPath,
			[
				"-e",
				'const s = require("node:net").createServer(); s.listen(process.env.FT55_SOCKET, () => process.send("ready"));',
			],
			{ stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, FT55_SOCKET: socketPath } },
		);
		await new Promise<void>((resolve, reject) => {
			child.once("message", () => resolve());
			child.once("error", reject);
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		expect(existsSync(socketPath)).toBe(true);

		const notices: string[] = [];
		const receiver = await startReceiver({
			socketPath,
			session: fakeSession(),
			onError: (message) => notices.push(message),
		});
		try {
			expect(receiver.listening).toBe(true);
			expect(notices.join(" ")).toContain("replaced");
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request(),
				dir,
				timeoutMs: 2000,
			});
			expect(response.ok).toBe(true);
		} finally {
			receiver.close();
			expect(existsSync(socketPath)).toBe(false);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a request in flight is answered when the receiver closes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-receiver-"));
		const socketPath = socketPathFor(ID, PATH, dir);
		let markEntered: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The session's own setter holds the request open: the request is in flight.
		const session = fakeSession();
		const setModel = session.setModel;
		session.setModel = async (ref) => {
			markEntered();
			await gate;
			return await setModel(ref);
		};
		const receiver = await startReceiver({ socketPath, session });
		const pending = sendRequest({
			sessionId: ID,
			sessionPath: PATH,
			request: request({ action: "set_model", provider: "anthropic", modelId: "claude-sonnet-4" }),
			dir,
			timeoutMs: 5000,
		});
		await entered;
		receiver.close();
		release();
		release();
		// The caller gets its answer rather than a hang: closing stops new
		// connections, it does not cut off the one that is already running.
		const response = await pending;
		expect(response.ok).toBe(true);
		expect((response.result as { applied?: string } | undefined)?.applied).toBe("model");
		rmSync(dir, { recursive: true, force: true });
	});
});
