// channel.test.ts — the local delivery channel.
//
// The channel is the only way a request reaches another session's process. These
// tests are about the channel itself: where the socket is, what the request carries,
// and what the caller is told when the other end is gone, busy, or speaks nonsense.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelRequest, ensureSocketDir, sendRequest, socketDir, socketPathFor } from "./channel.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const OTHER_ID = "99999999-8888-7777-6666-555555555555";
/** The session file of the session being asked. */
const PATH = "/tmp/ft55/session.jsonl";
/** Another file that carries the same session id: a copied session file does. */
const SAME_ID_OTHER_FILE = "/tmp/ft55/copy-of-session.jsonl";

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

describe("where the socket is", () => {
	test("the socket path is derived from the session id and its file, and says nothing about either", () => {
		const dir = socketDir();
		const path = socketPathFor(ID, PATH, dir);
		expect(path).toBe(socketPathFor(ID, PATH, dir));
		expect(path).not.toBe(socketPathFor(OTHER_ID, PATH, dir));
		// The same id and another file is another session: a copied session file keeps
		// the header's id, so the id alone does not name a session.
		expect(path).not.toBe(socketPathFor(ID, SAME_ID_OTHER_FILE, dir));
		expect(path).not.toContain(ID);
		expect(path).not.toContain("session.jsonl");
		expect(path.startsWith(dir)).toBe(true);
	});

	test("the socket path agrees on one spelling of one file", () => {
		const dir = socketDir();
		// The same lexical rule the identity checks use: two spellings of one file
		// agree here exactly where they agree there.
		expect(socketPathFor(ID, "/tmp/ft55/./session.jsonl", dir)).toBe(socketPathFor(ID, PATH, dir));
		expect(socketPathFor(ID, "/tmp/ft55/x/../session.jsonl", dir)).toBe(socketPathFor(ID, PATH, dir));
	});

	test("the socket directory is the runtime directory, when there is one", () => {
		expect(socketDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/pi-parameter-tools");
		// A relative runtime directory is not a directory: the temporary directory is
		// used instead.
		expect(socketDir({ XDG_RUNTIME_DIR: "relative" })).toBe(join(tmpdir(), "pi-parameter-tools"));
		expect(socketDir({})).toBe(join(tmpdir(), "pi-parameter-tools"));
	});
});

describe("asking a receiver", () => {
	test("the request carries the caller's request id, the tool and the binding", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const seen: { value: ChannelRequest | null } = { value: null };
		const server: Server = createServer((socket: Socket) => {
			socket.on("data", (chunk: Buffer) => {
				seen.value = JSON.parse(chunk.toString("utf8").split("\n")[0] ?? "{}") as ChannelRequest;
				socket.write(`${JSON.stringify({ ok: true, result: { applied: "thinking" } })}\n`);
				socket.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, PATH, dir), resolve));
		try {
			const response = await sendRequest({ sessionId: ID, sessionPath: PATH, request: request(), dir });
			expect(response.ok).toBe(true);
			expect(response.result?.applied).toBe("thinking");
			expect(seen.value?.requestId).toBe("req-1");
			expect(seen.value?.tool).toBe("set_session_thinking");
			expect(seen.value?.sessionId).toBe(ID);
			expect(seen.value?.sessionPath).toBe("/tmp/ft55/session.jsonl");
			expect(seen.value?.action).toBe("set_thinking");
			expect(seen.value?.level).toBe("high");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a target that is not listening is reported as unavailable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		try {
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request(),
				dir,
				timeoutMs: 1000,
			});
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("receiver_unavailable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a target that does not answer is a timeout, not a hang", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const server: Server = createServer(() => {
			// accept, and say nothing
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, PATH, dir), resolve));
		try {
			const started = Date.now();
			const response = await sendRequest({ sessionId: ID, sessionPath: PATH, request: request(), dir, timeoutMs: 250 });
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_timeout");
			expect(Date.now() - started).toBeLessThan(3000);
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an answer this build cannot read is a protocol error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const server: Server = createServer((socket: Socket) => {
			socket.on("data", () => {
				socket.write("this is not json\n");
				socket.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, PATH, dir), resolve));
		try {
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request(),
				dir,
				timeoutMs: 1000,
			});
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_protocol_error");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a target that closes without answering is unreachable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const server: Server = createServer((socket: Socket) => {
			socket.on("data", () => {
				socket.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, PATH, dir), resolve));
		try {
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request(),
				dir,
				timeoutMs: 1000,
			});
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_unreachable");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the socket directory is created private to this user", () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		try {
			const socketDirPath = ensureSocketDir(join(dir, "pi-parameter-tools"));
			expect(existsSync(socketDirPath)).toBe(true);
			expect(statSync(socketDirPath).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("which session the request reaches", () => {
	/** A receiver that answers, and counts what it was asked. */
	function answeringReceiver(received: string[]): Server {
		return createServer((socket: Socket) => {
			socket.on("data", (chunk: Buffer) => {
				received.push(chunk.toString("utf8").trim());
				socket.write(`${JSON.stringify({ ok: true, result: { applied: "thinking" } })}\n`);
				socket.end();
			});
		});
	}

	test("a request for one session reaches that session's receiver, and no other", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const forThis: string[] = [];
		const forThat: string[] = [];
		const mine = answeringReceiver(forThis);
		const theirs = answeringReceiver(forThat);
		await new Promise<void>((resolve) => mine.listen(socketPathFor(ID, PATH, dir), resolve));
		await new Promise<void>((resolve) => theirs.listen(socketPathFor(OTHER_ID, PATH, dir), resolve));
		try {
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request(),
				dir,
				timeoutMs: 2000,
			});
			expect(response.ok).toBe(true);
			// the request went to the session it named, and to no other session
			expect(forThis).toHaveLength(1);
			expect(forThat).toHaveLength(0);
			expect(JSON.parse(forThis[0] ?? "{}").sessionId).toBe(ID);
		} finally {
			mine.close();
			theirs.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a target that does not answer times out, and leaves another session's receiver alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const forThat: string[] = [];
		const silent = createServer(() => {
			// accept, and say nothing
		});
		const theirs = answeringReceiver(forThat);
		await new Promise<void>((resolve) => silent.listen(socketPathFor(ID, PATH, dir), resolve));
		await new Promise<void>((resolve) => theirs.listen(socketPathFor(OTHER_ID, PATH, dir), resolve));
		try {
			const started = Date.now();
			const response = await sendRequest({ sessionId: ID, sessionPath: PATH, request: request(), dir, timeoutMs: 250 });
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_timeout");
			expect(Date.now() - started).toBeLessThan(3000);
			// the timeout was this target's, and it cost no other session anything
			expect(forThat).toHaveLength(0);
		} finally {
			silent.close();
			theirs.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a session's receiver is reached only by that session's id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const forThat: string[] = [];
		const theirs = answeringReceiver(forThat);
		await new Promise<void>((resolve) => theirs.listen(socketPathFor(OTHER_ID, PATH, dir), resolve));
		try {
			// A request that names one session never reaches another's receiver, not
			// even when the receiver would have accepted it.
			const response = await sendRequest({
				sessionId: ID,
				sessionPath: PATH,
				request: request({ sessionId: OTHER_ID }),
				dir,
				timeoutMs: 1000,
			});
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("receiver_unavailable");
			expect(forThat).toHaveLength(0);
		} finally {
			theirs.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
