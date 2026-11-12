// rpc.test.ts — the control-channel protocol.
//
// The child is a fake that speaks pi's JSONL: a command goes in, a response with the
// same id comes back. The point of these tests is the protocol handling, not pi.

import { describe, expect, test } from "bun:test";
import { openRpcSession, type RpcChild, RpcError } from "./rpc.ts";

class FakeChild implements RpcChild {
	written: string[] = [];
	ended = false;
	killed = false;
	private stdoutListeners: ((chunk: unknown) => void)[] = [];
	private stderrListeners: ((chunk: unknown) => void)[] = [];
	private exitListeners: ((code: number | null) => void)[] = [];

	stdin = {
		write: (chunk: string) => {
			this.written.push(chunk);
			return true;
		},
		end: () => {
			this.ended = true;
			return true;
		},
	};

	stdout = {
		on: (_event: "data", listener: (chunk: unknown) => void) => {
			this.stdoutListeners.push(listener);
		},
	};

	stderr = {
		on: (_event: "data", listener: (chunk: unknown) => void) => {
			this.stderrListeners.push(listener);
		},
	};

	on(_event: "exit", listener: (code: number | null) => void) {
		this.exitListeners.push(listener);
		return this;
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}

	/** Answer the command that was written last. */
	answer(payload: Record<string, unknown>) {
		for (const listener of this.stdoutListeners) listener(`${JSON.stringify(payload)}\n`);
	}

	/** Answer the last command with a success or a failure. */
	answerLast(success: boolean, data?: unknown, error?: string) {
		const last = this.written[this.written.length - 1] ?? "";
		const id = JSON.parse(last.trim()).id as string;
		this.answer(
			error === undefined
				? { id, type: "response", command: "x", success, data }
				: { id, type: "response", command: "x", success, error },
		);
	}

	exit(code: number | null) {
		for (const listener of this.exitListeners) listener(code);
	}
}

describe("the RPC client", () => {
	test("sends a command and correlates the response", async () => {
		const child = new FakeChild();
		const session = await openRpcSession({
			spawn: () => child,
			sessionPath: "/tmp/a/session.jsonl",
		});
		const pending = session.getState();
		expect(child.written).toHaveLength(1);
		const sent = JSON.parse(child.written[0]?.trim() ?? "{}");
		expect(sent.type).toBe("get_state");
		expect(typeof sent.id).toBe("string");
		child.answerLast(true, { sessionId: "sid" });
		const outcome = await pending;
		expect(outcome.ok).toBe(true);
		expect((outcome.data as { sessionId: string }).sessionId).toBe("sid");
	});

	test("a failed command is reported with pi's own message", async () => {
		const child = new FakeChild();
		const session = await openRpcSession({ spawn: () => child, sessionPath: "/tmp/a/session.jsonl" });
		const pending = session.setModel("anthropic", "nope");
		child.answerLast(false, undefined, "Model not found: anthropic/nope");
		const outcome = await pending;
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe("Model not found: anthropic/nope");
	});

	test("records that are not responses are ignored", async () => {
		const child = new FakeChild();
		const session = await openRpcSession({ spawn: () => child, sessionPath: "/tmp/a/session.jsonl" });
		const pending = session.getState();
		child.answer({ type: "message_update", delta: "hello" });
		child.answer({ type: "response", command: "get_state", success: true, data: { sessionId: "wrong" } });
		child.answerLast(true, { sessionId: "sid" });
		const outcome = await pending;
		expect(outcome.ok).toBe(true);
		expect((outcome.data as { sessionId: string }).sessionId).toBe("sid");
	});

	test("a child that exits before answering fails the command", async () => {
		const child = new FakeChild();
		const session = await openRpcSession({ spawn: () => child, sessionPath: "/tmp/a/session.jsonl" });
		const pending = session.getState();
		child.exit(1);
		await expect(pending).rejects.toBeInstanceOf(RpcError);
	});

	test("a command that is not answered in time fails", async () => {
		const child = new FakeChild();
		const session = await openRpcSession({
			spawn: () => child,
			sessionPath: "/tmp/a/session.jsonl",
			timeoutMs: 40,
		});
		await expect(session.getState()).rejects.toBeInstanceOf(RpcError);
	});

	test("closing ends the child", async () => {
		const child = new FakeChild();
		const session = await openRpcSession({ spawn: () => child, sessionPath: "/tmp/a/session.jsonl" });
		await session.close();
		expect(child.ended).toBe(true);
		expect(child.killed).toBe(true);
	});

	test("the child is pi, in RPC mode, opening the named session", async () => {
		const child = new FakeChild();
		const calls: { command: string; args: string[] }[] = [];
		await openRpcSession({
			spawn: (command, args) => {
				calls.push({ command, args });
				return child;
			},
			sessionPath: "/tmp/a/session.jsonl",
		});
		expect(calls[0]?.command).toBe("pi");
		expect(calls[0]?.args).toEqual(["--mode", "rpc", "--session", "/tmp/a/session.jsonl"]);
	});
});
