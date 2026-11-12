// identity.ts — who is the target, and is that unambiguous?
//
// Pure: no runtime, no process, no filesystem. The grammars for the three target
// handles (session id, session path, herdr lane), the lexical path normalisation, and
// the binding resolution that decides whether a request names exactly one session.
//
// The rule the whole package rests on: **a target must be identified exactly once.**
// A session id alone is never enough (ids can repeat across session files), and two
// bindings at once are a conflict, not a preference.

import type { RefusalCode } from "./params.ts";

/** pi's session id shape. */
export const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** herdr's lane name shape. */
export const LANE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** A validated session id, or null. */
export function validateSessionId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim();
	if (!id || !SESSION_ID_RE.test(id)) return null;
	return id;
}

/**
 * Normalise a session path **lexically**.
 *
 * `.` and `..` segments are resolved without touching the filesystem: no `realpath`,
 * no symlink resolution. An alias that spells the same file differently is a
 * different spelling, and refusing it is honest — guessing that two spellings are the
 * same file is how a tool ends up changing the wrong session.
 */
export function normaliseSessionPath(value: string): string {
	const segments: string[] = [];
	for (const part of value.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	return `/${segments.join("/")}`;
}

/**
 * Validate a session path: absolute, a `.jsonl` basename, no NUL byte.
 *
 * Returns the normalised path or null.
 */
export function validateSessionPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (!raw || raw.includes("\0")) return null;
	if (!raw.startsWith("/")) return null;
	const normalised = normaliseSessionPath(raw);
	if (!normalised.endsWith(".jsonl")) return null;
	if (normalised === "/.jsonl") return null;
	return normalised;
}

/** Validate a herdr lane name, or null. */
export function validateLane(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const lane = value.trim();
	if (!lane || !LANE_RE.test(lane)) return null;
	return lane;
}

/** The three handles a session-targeted request may carry. */
export interface TargetRequest {
	sessionId?: unknown;
	sessionPath?: unknown;
	lane?: unknown;
}

export interface ResolvedBinding {
	kind: "session_path" | "lane";
	sessionId: string;
	/** The session file, when the binding named one directly. */
	sessionPath: string | null;
	lane: string | null;
}

export interface BindingFailure {
	code: RefusalCode;
	message: string;
}

export type BindingResult = { ok: true; binding: ResolvedBinding } | { ok: false; failure: BindingFailure };

/**
 * Resolve the target binding.
 *
 * The order is the order of the refusals, and each step refuses before anything is
 * read:
 *
 * 1. **Shape** — exactly one of `sessionPath` / `lane`. Both is a conflict, neither
 *    is a missing binding.
 * 2. **Grammar** — the session id, the path and the lane each have to look like what
 *    they claim to be.
 *
 * The path is returned normalised; the lane is returned as named. Which session a
 * lane or a path actually points at is resolved later, against the target itself.
 */
export function resolveBinding(request: TargetRequest): BindingResult {
	const hasPath = request.sessionPath !== undefined && request.sessionPath !== null;
	const hasLane = request.lane !== undefined && request.lane !== null;
	if (hasPath && hasLane) {
		return {
			ok: false,
			failure: {
				code: "identity_binding_conflict",
				message: "give either a session path or a lane, not both",
			},
		};
	}
	if (!hasPath && !hasLane) {
		return {
			ok: false,
			failure: {
				code: "identity_binding_required",
				message: "name the target: a session path or a herdr lane",
			},
		};
	}

	const sessionId = validateSessionId(request.sessionId);
	if (!sessionId) {
		return {
			ok: false,
			failure: { code: "invalid_identifier", message: "the session id is not a session id" },
		};
	}

	if (hasPath) {
		const sessionPath = validateSessionPath(request.sessionPath);
		if (!sessionPath) {
			return {
				ok: false,
				failure: {
					code: "invalid_identifier",
					message: "the session path must be absolute and end in .jsonl",
				},
			};
		}
		return { ok: true, binding: { kind: "session_path", sessionId, sessionPath, lane: null } };
	}

	const lane = validateLane(request.lane);
	if (!lane) {
		return {
			ok: false,
			failure: { code: "invalid_identifier", message: "the lane name is not a herdr lane name" },
		};
	}
	return { ok: true, binding: { kind: "lane", sessionId, sessionPath: null, lane } };
}

/**
 * Does this binding name the caller's own session?
 *
 * The caller's own id **and** its own file must match: an id that matches while the
 * file does not is the duplicate-id case, and it is refused rather than treated as
 * the caller's own session.
 */
export function isOwnSession(
	binding: ResolvedBinding,
	own: { sessionId: string | null; sessionPath: string | null },
): boolean {
	if (!own.sessionId || !own.sessionPath) return false;
	if (binding.sessionId !== own.sessionId) return false;
	if (binding.sessionPath === null) return false;
	return binding.sessionPath === own.sessionPath;
}
