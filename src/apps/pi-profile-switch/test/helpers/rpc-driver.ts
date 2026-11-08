import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

/**
 * Minimal JSON-RPC driver for a spawned `pi --mode rpc` subprocess.
 * Used by integration tests to introspect a real pi session (commands,
 * state) without a TUI or model calls.
 */

export interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: Record<string, unknown> & { commands?: Array<{ name: string; source: string; path?: string }> };
	error?: string;
}

export class RpcDriver {
	private child: ChildProcess;
	private pending = new Map<string, (response: RpcResponse) => void>();
	private seq = 0;
	readonly stderr: string[] = [];
	/** All parsed stdout messages (responses and unsolicited events). */
	readonly messages: unknown[] = [];
	/** Scripted dialog answers: consumed in order for extension_ui_request
	 *  prompts (select/input → {value}, confirm → {confirmed}). */
	private dialogAnswers: Array<{ value?: string; confirmed?: boolean }> = [];
	private waiters: Array<{ predicate: (message: unknown) => boolean; resolve: (message: unknown) => void }> = [];

	constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
		this.child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr?.on("data", (chunk) => this.stderr.push(String(chunk)));
		const rl = readline.createInterface({ input: this.child.stdout! });
		rl.on("line", (line) => {
			let message: RpcResponse;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.type === "response" && message.id && this.pending.has(message.id)) {
				this.pending.get(message.id)!(message);
				this.pending.delete(message.id);
			}
			this.messages.push(message);
			if (
				typeof message === "object" &&
				message !== null &&
				(message as { type?: string }).type === "extension_ui_request" &&
				(message as { method?: string }).method !== "notify"
			) {
				const request = message as unknown as { id: string; method: string };
				const answer = this.dialogAnswers.shift() ?? { confirmed: true };
				this.child.stdin!.write(
					JSON.stringify({
						type: "extension_ui_response",
						id: request.id,
						...(request.method === "confirm" ? { confirmed: answer.confirmed ?? true } : {}),
						...(request.method !== "confirm" && answer.value !== undefined
							? { value: answer.value }
							: request.method !== "confirm"
								? { cancelled: true }
								: {}),
					}) + "\n",
				);
			}
			for (const waiter of [...this.waiters]) {
				if (waiter.predicate(message)) {
					this.waiters.splice(this.waiters.indexOf(waiter), 1);
					waiter.resolve(message);
				}
			}
		});
	}

	/** Queue scripted answers for upcoming extension dialogs. */
	answerDialogs(answers: Array<{ value?: string; confirmed?: boolean }>): void {
		this.dialogAnswers.push(...answers);
	}

	/** Resolves with the next (or an already-seen) message matching the
	 *  predicate. For unsolicited events such as displayed custom messages. */
	waitFor(predicate: (message: unknown) => boolean, timeoutMs = 20_000): Promise<unknown> {
		const seen = this.messages.find(predicate);
		if (seen !== undefined) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
			this.waiters.push({
				predicate,
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
		});
	}

	send(command: Record<string, unknown>, timeoutMs = 20_000): Promise<RpcResponse> {
		const id = `req-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for ${String(command.type)}`));
			}, timeoutMs);
			this.pending.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			this.child.stdin!.write(JSON.stringify({ id, ...command }) + "\n");
		});
	}

	async commandNames(): Promise<Array<{ name: string; source: string }>> {
		const response = await this.send({ type: "get_commands" });
		return (response.data?.commands ?? []).map((command) => ({ name: command.name, source: command.source }));
	}

	async skillCommandNames(): Promise<string[]> {
		return (await this.commandNames())
			.filter((command) => command.source === "skill")
			.map((command) => command.name)
			.sort();
	}

	async close(): Promise<void> {
		this.child.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}

	/** Resolves once the spawned process has fully exited (in RPC launcher
	 *  tests: launcher exit implies the pi child is already dead). */
	async waitForExit(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise((resolve) => this.child.once("exit", resolve));
	}
}
