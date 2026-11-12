// rpc.ts — pi's own control channel.
//
// pi exposes a documented RPC mode: `pi --mode rpc` speaks JSONL on stdin/stdout and
// answers commands such as `get_state`, `set_model` and `set_thinking_level`. It is the
// supported way to drive a pi session's parameters from outside that session's own
// process — and its channel is the **parent's**: the parent of an RPC-mode child talks
// to it over that child's stdin.
//
// This module is deliberately small and injectable: the spawn function is a parameter,
// so the tests can drive the whole protocol without a process, and the integration
// test can drive and observe a real disposable pi.
//
// It is **not** the path by which this package changes another lane's session. A
// second process opened on somebody else's session file is not that session's process,
// and writing to a session file that a running lane owns makes two writers of one
// session. The client is here because it is how a pi is driven and observed — the
// caller's own session, and the disposable sessions of the tests — and because the
// receiver is the in-process half of the same shape.
//
// A **running** lane's session is never opened by a second process. The change goes to
// that lane's own process, over the receiver's local socket.

/** The subset of a child process this module uses. A fake satisfies it in tests. */
export interface RpcChild {
	stdin: { write(chunk: string): unknown; end(): unknown };
	stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown };
	stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown };
	on(event: "exit", listener: (code: number | null) => void): unknown;
	kill(signal?: string): unknown;
}

export type SpawnFn = (
	command: string,
	args: string[],
	options: { stdio: ["pipe", "pipe", "pipe"]; env?: Record<string, string> },
) => RpcChild;

/** The state pi reports about its session. */
export interface RpcState {
	model?: { provider?: string; id?: string } | null;
	thinkingLevel?: string | null;
	sessionFile?: string | null;
	sessionId?: string | null;
	[key: string]: unknown;
}

export interface RpcOutcome {
	ok: boolean;
	/** The error pi reported, when the command failed. */
	error?: string;
	data?: unknown;
}

export interface RpcSession {
	getState(): Promise<RpcOutcome>;
	getEntries(): Promise<RpcOutcome>;
	getAvailableModels(): Promise<RpcOutcome>;
	/** The commands the session's extensions registered. */
	getCommands(): Promise<RpcOutcome>;
	setModel(provider: string, modelId: string): Promise<RpcOutcome>;
	setThinkingLevel(level: string): Promise<RpcOutcome>;
	/** Start a new session in this process: what /new does. */
	newSession(): Promise<RpcOutcome>;
	/** Switch to another session file: what /resume does. */
	switchSession(sessionPath: string): Promise<RpcOutcome>;
	/** Send a prompt. A prompt that is a slash command runs the command, not the model. */
	prompt(message: string): Promise<RpcOutcome>;
	close(): Promise<void>;
}

export interface RpcOptions {
	spawn: SpawnFn;
	/** The pi binary. Defaults to `pi` on PATH. */
	command?: string;
	/** The session file to open. */
	sessionPath: string;
	/** How long a single command may take. */
	timeoutMs?: number;
	/** Extra environment for the child. */
	env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 4096;

/** An RPC command that did not come back in time, or whose child died. */
export class RpcError extends Error {
	constructor(
		message: string,
		readonly code: "timeout" | "exited" | "protocol",
		/** The child's own diagnostics, bounded. A diagnostic, never part of the message. */
		readonly detail?: string,
	) {
		super(message);
		this.name = "RpcError";
	}
}

/**
 * Open a pi session over the RPC channel.
 *
 * The child is pi itself, in RPC mode, opening the given session file. Nothing is
 * written to the session by opening it: pi only appends when a command changes
 * something.
 */
export async function openRpcSession(options: RpcOptions): Promise<RpcSession> {
	const command = options.command ?? "pi";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const child = options.spawn(command, ["--mode", "rpc", "--session", options.sessionPath], {
		stdio: ["pipe", "pipe", "pipe"],
		env: options.env,
	});

	let nextId = 0;
	let buffer = "";
	let stderrText = "";
	let stderrBytes = 0;
	let exited = false;
	const pending = new Map<
		string,
		{ resolve: (outcome: RpcOutcome) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();

	const failAll = (error: Error) => {
		for (const [, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	};

	child.on("exit", () => {
		exited = true;
		failAll(new RpcError("the pi RPC session exited before answering", "exited", stderrText));
	});
	child.stderr.on("data", (chunk: unknown) => {
		// The child's diagnostics are never part of a protocol error message; they are
		// kept, bounded, so a failure is diagnosable.
		stderrBytes += String(chunk).length;
		if (stderrBytes > MAX_STDERR_BYTES) {
			stderrBytes = MAX_STDERR_BYTES;
			return;
		}
		stderrText = `${stderrText}${String(chunk)}`.slice(-MAX_STDERR_BYTES);
	});
	child.stdout.on("data", (chunk: unknown) => {
		buffer += String(chunk);
		if (buffer.length > MAX_LINE_BYTES) {
			failAll(new RpcError("the pi RPC session sent an oversized record", "protocol"));
			return;
		}
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (record.type !== "response") continue;
			const id = typeof record.id === "string" ? record.id : null;
			if (!id) continue;
			const entry = pending.get(id);
			if (!entry) continue;
			pending.delete(id);
			clearTimeout(entry.timer);
			if (record.success === true) {
				entry.resolve({ ok: true, data: record.data });
			} else {
				entry.resolve({
					ok: false,
					error: typeof record.error === "string" ? record.error : "the command failed",
				});
			}
		}
	});

	const send = (command: Record<string, unknown>): Promise<RpcOutcome> => {
		if (exited) return Promise.reject(new RpcError("the pi RPC session is not running", "exited"));
		const id = `ft55-${++nextId}`;
		const record = JSON.stringify({ id, ...command });
		return new Promise<RpcOutcome>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new RpcError(`the pi RPC session did not answer ${String(command.type)} in time`, "timeout"));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try {
				child.stdin.write(`${record}\n`);
			} catch (error) {
				pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	return {
		async getState(): Promise<RpcOutcome> {
			return send({ type: "get_state" });
		},
		async getEntries(): Promise<RpcOutcome> {
			return send({ type: "get_entries" });
		},
		async getAvailableModels(): Promise<RpcOutcome> {
			return send({ type: "get_available_models" });
		},
		async getCommands(): Promise<RpcOutcome> {
			return send({ type: "get_commands" });
		},
		async setModel(provider: string, modelId: string): Promise<RpcOutcome> {
			return send({ type: "set_model", provider, modelId });
		},
		async setThinkingLevel(level: string): Promise<RpcOutcome> {
			return send({ type: "set_thinking_level", level });
		},
		async newSession(): Promise<RpcOutcome> {
			return send({ type: "new_session" });
		},
		async switchSession(sessionPath: string): Promise<RpcOutcome> {
			return send({ type: "switch_session", sessionPath });
		},
		async prompt(message: string): Promise<RpcOutcome> {
			return send({ type: "prompt", message });
		},
		async close(): Promise<void> {
			try {
				child.stdin.end();
			} catch {
				// The child may already be gone; closing is best effort.
			}
			child.kill("SIGTERM");
			for (const [, entry] of pending) {
				clearTimeout(entry.timer);
				entry.reject(new RpcError("the pi RPC session was closed", "exited"));
			}
			pending.clear();
		},
	};
}
