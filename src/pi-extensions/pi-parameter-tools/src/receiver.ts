// receiver.ts — the listener inside the target lane.
//
// The receiver is the part of this package that runs in the **target** session. It
// listens on a local socket, takes a request from another lane, checks that the
// request really names this session, and applies the change with **its own** pi
// session-control methods. The target session is therefore written by the process
// that owns it, and by nobody else.
//
// What the receiver checks, before it changes anything:
//
//   * the request names a session id, and it is this session's id;
//   * the request names a session file, and it is this session's file;
//   * the requested level is a level pi accepts;
//   * the requested model is a model *this* session's registry knows;
//   * this session is not in a held or reserved place.
//
// What it does not do: accept a request for another session, write a session file,
// start a process, or do anything the request did not ask for.
//
// The socket is **owned**, not merely used:
//
//   * the listener lives on a **private** path, and the path other lanes connect to
//     is a symlink to it. Node removes the socket it created when the server closes,
//     by name and unconditionally, so a receiver that listened on the shared path
//     itself would remove whatever was at that name — including a socket another
//     owner had taken over. On a private path the close removes this receiver's own
//     socket and nothing else;
//   * the shared name is removed only while it still points at **this** receiver's
//     socket, so a cleanup can never remove another owner's socket;
//   * a name that already has a listener is taken over by the most recent owner of
//     that session file, and a name left behind by a process that died is replaced.
//     The previous owner keeps its own socket, and its later cleanup cannot take the
//     name back.
//
// The socket's name is derived from the session id **and** the session file, so two
// sessions that happen to carry the same id (a copied session file keeps the header's
// id) do not share a path, and two processes on one session file agree on one path.

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { join } from "node:path";
import { type ChannelRequest, type ChannelResponse, ensureSocketDir } from "./channel.ts";
import { isHeldPlace } from "./holds.ts";
import { normaliseSessionPath } from "./identity.ts";
import { isThinkingLevel, type ModelRef, type ParameterToolResult } from "./params.ts";

const MAX_REQUEST_BYTES = 64 * 1024;

/** What the receiver needs from its own session to answer a request. */
export interface ReceiverSession {
	sessionId: string | null;
	sessionPath: string | null;
	workspaceId: string | null;
	tabId: string | null;
	paneId: string | null;
	/** The thinking levels this session's model supports. */
	supportedThinkingLevels(): string[];
	/** Resolve a model in this session's registry, or null. */
	resolveModel(ref: ModelRef): ModelRef | null;
	/** Apply the thinking level, in this process. */
	setThinkingLevel(level: string): void;
	/** Apply the model, in this process. False when the provider has no credentials. */
	setModel(ref: ModelRef): Promise<boolean>;
	/** This session's thinking level, read back. */
	thinkingLevel(): string | null;
	/** This session's model, read back. */
	model(): ModelRef | null;
	/** The session entry ids this session's branch gained. */
	records(): { modelChangeEntryId: string | null; thinkingLevelEntryId: string | null };
}

export interface ReceiverOptions {
	session: ReceiverSession;
	/** The socket path to listen on. */
	socketPath: string;
	/** A diagnostic sink; the receiver never writes to stdout. */
	onError?: (message: string) => void;
}

export interface Receiver {
	readonly socketPath: string;
	/** Whether this receiver owns the socket and is listening on it. */
	readonly listening: boolean;
	close(): void;
}

/** What is at a socket path. */
type SocketState = "absent" | "stale" | "live";

/**
 * Start the receiver.
 *
 * The socket is created 0600 in a per-user directory. The listener sits on a private
 * path and the path other lanes connect to is a symlink to it, so this receiver's own
 * cleanup can never remove a socket it does not own.
 *
 * A name that already has a listener is taken over: the pair (id, file) names one
 * session, and the most recent owner of that session file is the one that answers for
 * it. A name with a file but no listener is the remains of a process that died, and is
 * replaced. Either way the previous owner is left with its own socket, and its later
 * cleanup cannot take the name back.
 */
export async function startReceiver(options: ReceiverOptions): Promise<Receiver> {
	const { session, socketPath } = options;
	const dir = socketPath.slice(0, socketPath.lastIndexOf("/")) || ".";
	ensureSocketDir(dir);

	// What is at this name now? A live listener is another process that holds this
	// same session file; a file with no listener is the remains of a process that
	// died. Either way this receiver takes the name: the pair (id, file) names one
	// session, and the process that most recently took that session is the one that
	// should answer for it. The previous owner keeps its own socket on its private
	// path, and its later cleanup cannot take this name back.
	const state = await probeSocket(socketPath);
	if (state === "live") {
		options.onError?.(`the parameter receiver took ${socketPath} from the process that still held it`);
	} else if (state === "stale") {
		options.onError?.(`the parameter receiver replaced a socket left behind at ${socketPath}`);
	}

	// The listener lives on a **private** path, and the shared path is a symlink to
	// it. Node removes the path it created when the server closes -- unconditionally,
	// by name -- so a receiver that listened on the shared path directly would remove
	// whatever was at that name, including a socket another owner had taken over.
	// On a private path, the close removes this receiver's socket and nothing else,
	// and the shared name is removed only while it still points here.
	const privatePath = privateSocketPath(dir);

	let closed = false;
	const server: Server = createServer((socket: Socket) => {
		void handleConnection(socket, session);
	});
	server.on("error", (error: Error) => {
		options.onError?.(`the parameter receiver could not listen: ${error.message}`);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(privatePath, () => {
				server.off("error", onError);
				resolve();
			});
		});
	} catch (error) {
		options.onError?.(
			`the parameter receiver could not listen on ${socketPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { socketPath, listening: false, close: () => {} };
	}
	try {
		chmodSync(privatePath, 0o600);
	} catch {
		// The socket is already private by default; a failed chmod is not fatal.
	}
	try {
		publishSocket(socketPath, privatePath);
	} catch (error) {
		server.close();
		options.onError?.(
			`the parameter receiver could not publish ${socketPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { socketPath, listening: false, close: () => {} };
	}
	return {
		socketPath,
		listening: true,
		close(): void {
			if (closed) return;
			closed = true;
			// Stop accepting. A request already in flight finishes and answers: the
			// caller gets its answer rather than a hang.
			server.close();
			// Remove the shared name only while it still points at this receiver's
			// socket. A name another owner has taken over is not ours to remove.
			removePublishedSocket(socketPath, privatePath);
		},
	};
}

/**
 * The private path a receiver listens on.
 *
 * It is **shorter** than the shared path, and that matters: a socket path is
 * limited to about a hundred bytes, and a longer one is silently truncated by the
 * kernel -- the socket then lands under a name nobody asked for, and the name that
 * was asked for points at nothing.
 *
 * The name carries the process and a random part, so two receivers -- in one
 * process, or in two -- never share it.
 */
function privateSocketPath(dir: string): string {
	const nonce = randomBytes(3).toString("hex");
	return join(dir, `${process.pid}-${nonce}.sock`);
}

/**
 * Point the shared name at this receiver's socket.
 *
 * The symlink is created under a temporary name and renamed onto the shared path, so
 * a caller never sees a half-published name and a takeover is atomic.
 */
function publishSocket(sharedPath: string, privatePath: string): void {
	const temp = `${sharedPath}.tmp.${process.pid}`;
	try {
		unlinkSync(temp);
	} catch {
		// No temporary name to remove.
	}
	symlinkSync(privatePath, temp);
	try {
		renameSync(temp, sharedPath);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Already gone.
		}
		throw error;
	}
}

/**
 * Remove the shared name, if it still points at this receiver's socket.
 *
 * A name another owner has taken over is left alone: removing it would take their
 * socket off the path.
 */
function removePublishedSocket(sharedPath: string, privatePath: string): void {
	try {
		if (readlinkSync(sharedPath) !== privatePath) return;
		unlinkSync(sharedPath);
	} catch {
		// Gone, or not a symlink: either way there is nothing of ours to remove.
	}
}

/**
 * Whether a path has something at it.
 *
 * The link itself is looked at, not what it points at: a link to a socket that is
 * gone is a leftover, and a leftover is not the same as an empty path.
 */
function pathIsThere(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * What is at a socket path: nothing, a file with no listener, or a live listener.
 *
 * A connection that succeeds means somebody is listening. A refused connection means
 * the file is there and nobody owns it.
 */
function probeSocket(path: string): Promise<SocketState> {
	return new Promise<SocketState>((resolve) => {
		let settled = false;
		const finish = (state: SocketState) => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				// The socket is already gone.
			}
			resolve(state);
		};
		// The error handler is attached **before** the connection is attempted: a
		// first connection to a path that is not there raises its error straight
		// away, and an error with no listener is a crash, not a state.
		const socket = new Socket();
		socket.on("connect", () => finish("live"));
		socket.on("error", () => {
			// The path is either not there at all, or there with nobody listening:
			// the file itself says which. The error code does not: one runtime
			// reports a refused connection, another reports a missing file.
			finish(pathIsThere(path) ? "stale" : "absent");
		});
		try {
			socket.connect(path);
		} catch {
			finish("absent");
		}
	});
}

async function handleConnection(socket: Socket, session: ReceiverSession): Promise<void> {
	let buffer = "";
	socket.on("error", () => {
		// A broken connection is the caller's problem; the receiver stays up.
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		if (buffer.length > MAX_REQUEST_BYTES) {
			respond(socket, {
				ok: false,
				refusal: { code: "invalid_identifier", message: "the request is too large" },
			});
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		let request: ChannelRequest;
		try {
			request = JSON.parse(line) as ChannelRequest;
		} catch {
			respond(socket, {
				ok: false,
				refusal: { code: "invalid_identifier", message: "the request is not a request this build can read" },
			});
			return;
		}
		void respondWithResult(socket, request, session);
	});
}

async function respondWithResult(socket: Socket, request: ChannelRequest, session: ReceiverSession): Promise<void> {
	const result = await applyRequest(request, session);
	respond(socket, {
		ok: result.ok,
		refusal: result.refusal,
		result: result.ok ? (result as unknown as Record<string, unknown>) : undefined,
		receiver: { sessionId: session.sessionId, sessionPath: session.sessionPath },
	});
}

/** Write one answer and close the connection. */
function respond(socket: Socket, response: ChannelResponse): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// The caller may already be gone.
	}
	socket.end();
}

/** The refusal or the result of a request, decided by the receiver. */
export async function applyRequest(request: ChannelRequest, session: ReceiverSession): Promise<ParameterToolResult> {
	const identity = { sessionId: session.sessionId, sessionPath: session.sessionPath };
	if (!request || typeof request !== "object") {
		return refuse("invalid_identifier", "the request is not a request this build can read", identity);
	}
	if (!session.sessionId || !session.sessionPath) {
		return refuse("no_session_file", "this session has no identity to answer for", identity);
	}
	// The binding: the request must name *this* session, by id and by file.
	if (request.sessionId !== session.sessionId) {
		return refuse("session_id_mismatch", "that request names another session", identity, {
			requestedSessionId: request.sessionId,
		});
	}
	if (normaliseSessionPath(request.sessionPath) !== normaliseSessionPath(session.sessionPath)) {
		return refuse("session_identity_mismatch", "that request names another session file", identity, {
			requestedSessionPath: request.sessionPath,
		});
	}
	if (isHeldPlace(session)) {
		return refuse("held_lane", "this session is in a held or reserved place", identity);
	}

	if (request.action === "set_thinking") {
		if (!isThinkingLevel(request.level)) {
			return refuse("invalid_level", "that is not a thinking level pi accepts", identity);
		}
		const supported = session.supportedThinkingLevels();
		if (!supported.includes(request.level as string)) {
			return refuse(
				"level_unsupported",
				`this session's model does not support that thinking level (supported: ${supported.join(", ") || "none"})`,
				identity,
				{ supported },
			);
		}
		const before = session.thinkingLevel();
		const changed = before !== request.level;
		if (changed) session.setThinkingLevel(request.level as string);
		const after = session.thinkingLevel();
		const records = session.records();
		return {
			ok: true,
			tool: request.tool,
			target: {
				kind: "session",
				sessionId: session.sessionId,
				sessionPath: session.sessionPath,
				requested: { sessionId: request.sessionId, sessionPath: request.sessionPath },
				resolution: { source: "in_memory" },
			},
			model: { before: session.model(), requested: null, after: session.model() },
			thinking: { before, requested: request.level as string, after, supported },
			applied: changed && after === request.level ? "thinking" : "none",
			changed: changed && after === request.level,
			records,
			disk: { state: "unknown" },
			effective: "next_request",
			partial: changed && after === request.level && !records.thinkingLevelEntryId,
			warnings: [],
		};
	}

	if (request.action === "set_model") {
		const ref: ModelRef = { provider: request.provider ?? "", modelId: request.modelId ?? "" };
		if (!ref.provider || !ref.modelId) {
			return refuse("invalid_identifier", "a model needs a provider and a model id", identity);
		}
		const resolved = session.resolveModel(ref);
		if (!resolved) {
			return refuse("model_unknown", "that provider/model is not in this session's registry", identity, {
				requested: ref,
			});
		}
		const beforeModel = session.model();
		const beforeThinking = session.thinkingLevel();
		if (beforeModel && beforeModel.provider === resolved.provider && beforeModel.modelId === resolved.modelId) {
			return {
				ok: true,
				tool: request.tool,
				target: {
					kind: "session",
					sessionId: session.sessionId,
					sessionPath: session.sessionPath,
					requested: { sessionId: request.sessionId, sessionPath: request.sessionPath },
					resolution: { source: "in_memory" },
				},
				model: { before: beforeModel, requested: resolved, after: beforeModel },
				thinking: {
					before: beforeThinking,
					requested: null,
					after: beforeThinking,
					supported: session.supportedThinkingLevels(),
				},
				applied: "none",
				changed: false,
				records: { modelChangeEntryId: null, thinkingLevelEntryId: null },
				disk: { state: "unknown" },
				effective: "next_request",
				partial: false,
				warnings: [],
			};
		}
		let authed = false;
		try {
			authed = await session.setModel(resolved);
		} catch (error) {
			return refuse("apply_failed", "the model change failed", identity, {
				cause: error instanceof Error ? error.message : "unknown",
			});
		}
		if (!authed) {
			return refuse("auth_missing", "that provider has no configured credentials", identity, {
				requested: resolved,
			});
		}
		const afterModel = session.model();
		const afterThinking = session.thinkingLevel();
		const records = session.records();
		const modelChanged =
			!!afterModel && afterModel.provider === resolved.provider && afterModel.modelId === resolved.modelId;
		const thinkingChanged = afterThinking !== beforeThinking;
		return {
			ok: true,
			tool: request.tool,
			target: {
				kind: "session",
				sessionId: session.sessionId,
				sessionPath: session.sessionPath,
				requested: { sessionId: request.sessionId, sessionPath: request.sessionPath },
				resolution: { source: "in_memory" },
			},
			model: { before: beforeModel, requested: resolved, after: afterModel },
			thinking: {
				before: beforeThinking,
				requested: null,
				after: afterThinking,
				supported: session.supportedThinkingLevels(),
			},
			applied: modelChanged ? (thinkingChanged ? "both" : "model") : "none",
			changed: modelChanged,
			records,
			disk: { state: "unknown" },
			effective: "next_request",
			partial: modelChanged && !records.modelChangeEntryId,
			warnings: [],
		};
	}

	return refuse("invalid_identifier", "that is not an action this receiver performs", identity);
}

function refuse(
	code: string,
	message: string,
	identity: { sessionId: string | null; sessionPath: string | null },
	detail?: Record<string, unknown>,
): ParameterToolResult {
	return {
		ok: false,
		tool: "receiver",
		target: {
			kind: "session",
			sessionId: identity.sessionId,
			sessionPath: identity.sessionPath,
			requested: {},
			resolution: { source: "in_memory" },
		},
		model: { before: null, requested: null, after: null },
		thinking: { before: null, requested: null, after: null, supported: [] },
		applied: "none",
		changed: false,
		records: { modelChangeEntryId: null, thinkingLevelEntryId: null },
		disk: { state: "unknown" },
		effective: "next_request",
		partial: false,
		warnings: [],
		refusal: detail ? { code: code as never, message, detail } : { code: code as never, message },
	};
}
