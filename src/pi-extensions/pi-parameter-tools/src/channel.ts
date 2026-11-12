// channel.ts — the local delivery channel between two pi sessions.
//
// A request has to reach the process that owns the target session. pi exposes no
// cross-process session control, so the two sessions talk over a local UNIX socket:
// the target lane's extension listens on one (the **receiver**), and the caller
// connects to it to ask for a change.
//
// The socket is the target's own process. The change is applied by that process, with
// that process's own session-control methods, so the target session is written by its
// owner and by nobody else.
//
// The socket path is derived from the target's session id **and** its session file, so
// both sides agree on it without a registry, a token, a grant file or a directory to
// enumerate. The path is short (a digest of the pair), and the socket is created 0600
// inside a per-user directory.
//
// The pair, not the id alone: a copied session file keeps the id in its header, so two
// different sessions can carry the same id, and one id is not an identity. Two processes
// that hold the same id and the same file are holding the same session, and they must
// agree on one socket rather than each taking a path the other then removes.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normaliseSessionPath } from "./identity.ts";

/** The directory name under the runtime directory. */
export const SOCKET_DIR_NAME = "pi-parameter-tools";

/** The per-user directory the sockets live in. */
export function socketDir(env: Record<string, string | undefined> = process.env): string {
	const runtime = env.XDG_RUNTIME_DIR?.trim();
	const base = runtime?.startsWith("/") ? runtime : tmpdir();
	return join(base, SOCKET_DIR_NAME);
}

/**
 * The socket path for a session.
 *
 * Both sides derive it the same way: a digest of the session id and the **normalised**
 * session path, so the path says nothing about the session and stays short enough for a
 * socket path. The normalisation is the same lexical rule the identity checks use, so
 * two spellings of one file agree here exactly where they agree there.
 */
export function socketPathFor(
	sessionId: string,
	sessionPath: string | null | undefined,
	dir: string = socketDir(),
): string {
	const key = `${sessionId}\u0000${sessionPath ? normaliseSessionPath(sessionPath) : ""}`;
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
	return join(dir, `${digest}.sock`);
}

/** What a caller asks a receiver to do. */
export interface ChannelRequest {
	requestId: string;
	tool: string;
	/** The session the caller believes it is talking to. */
	sessionId: string;
	/** The session file the caller believes it is talking to. */
	sessionPath: string;
	action: "set_thinking" | "set_model";
	level?: string;
	provider?: string;
	modelId?: string;
}

/** What a receiver answers. */
export interface ChannelResponse {
	ok: boolean;
	/** The refusal, when the receiver refused. */
	refusal?: { code: string; message: string; detail?: Record<string, unknown> };
	/** The result, when the receiver applied the change. */
	result?: Record<string, unknown>;
	/** The receiver's own identity, so the caller can check who answered. */
	receiver?: { sessionId: string | null; sessionPath: string | null };
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Ask a receiver to make a change, and wait for its answer.
 *
 * The caller is the one with the deadline: a receiver that is gone, busy or stuck must
 * not hang the caller. Every failure is a typed one, and a timeout says so rather than
 * looking like an empty answer.
 */
export async function sendRequest(options: {
	sessionId: string;
	/** The session file of the session being asked. Part of the socket's identity. */
	sessionPath: string | null | undefined;
	request: ChannelRequest;
	dir?: string;
	timeoutMs?: number;
}): Promise<ChannelResponse> {
	const dir = options.dir ?? socketDir();
	const path = socketPathFor(options.sessionId, options.sessionPath, dir);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return await new Promise<ChannelResponse>((resolve) => {
		let settled = false;
		const finish = (response: ChannelResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.destroy();
			} catch {
				// The socket may already be gone.
			}
			resolve(response);
		};
		// The socket's error handler is attached **before** the connection is
		// attempted. A first connection to a path that is not there raises its error
		// straight away, and an error with no listener is a crash, not a refusal.
		const socket = new Socket();
		const timer = setTimeout(() => {
			finish({
				ok: false,
				refusal: {
					code: "target_timeout",
					message: "the target session did not answer in time",
					detail: { timeoutMs },
				},
			});
		}, timeoutMs);
		socket.on("error", (error: NodeJS.ErrnoException) => {
			const code = error?.code === "ENOENT" ? "receiver_unavailable" : "target_unreachable";
			finish({
				ok: false,
				refusal: {
					code,
					message:
						code === "receiver_unavailable"
							? "the target session is not listening: it has no receiver loaded"
							: "the target session could not be reached",
					detail: { cause: error?.code ?? "unknown" },
				},
			});
		});
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(options.request)}\n`);
		});
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (buffer.length > MAX_RESPONSE_BYTES) {
				finish({
					ok: false,
					refusal: { code: "target_protocol_error", message: "the target sent an oversized answer" },
				});
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			try {
				finish(JSON.parse(line) as ChannelResponse);
			} catch {
				finish({
					ok: false,
					refusal: { code: "target_protocol_error", message: "the target sent an answer this build cannot read" },
				});
			}
		});
		socket.on("close", () => {
			finish({
				ok: false,
				refusal: { code: "target_unreachable", message: "the target session closed the connection" },
			});
		});
		try {
			socket.connect(path);
		} catch (error) {
			finish({
				ok: false,
				refusal: {
					code: "receiver_unavailable",
					message: "the target session is not listening: it has no receiver loaded",
					detail: { cause: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
				},
			});
		}
	});
}

/** Create the socket directory, private to this user. */
export function ensureSocketDir(dir: string = socketDir()): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
