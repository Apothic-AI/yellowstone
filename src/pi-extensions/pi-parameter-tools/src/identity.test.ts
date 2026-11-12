// identity.test.ts — the target handles and the binding precedence.

import { describe, expect, test } from "bun:test";
import {
	isOwnSession,
	normaliseSessionPath,
	resolveBinding,
	validateLane,
	validateSessionId,
	validateSessionPath,
} from "./identity.ts";

describe("the session id grammar", () => {
	test("accepts pi's own ids", () => {
		expect(validateSessionId("aaaaaaaa-0000-4000-8000-000000000001")).toBe("aaaaaaaa-0000-4000-8000-000000000001");
		expect(validateSessionId("abc")).toBe("abc");
		expect(validateSessionId("a.b_c-d")).toBe("a.b_c-d");
	});

	test("refuses anything else", () => {
		for (const value of [
			"",
			" ",
			".hidden",
			"trailing-",
			"-leading",
			"with space",
			"sla/sh",
			"nul\u0000",
			7,
			null,
			undefined,
		]) {
			expect(validateSessionId(value)).toBeNull();
		}
	});
});

describe("the session path grammar", () => {
	test("accepts an absolute .jsonl path", () => {
		expect(validateSessionPath("/tmp/a/session.jsonl")).toBe("/tmp/a/session.jsonl");
	});

	test("refuses a relative path, another extension and a NUL", () => {
		expect(validateSessionPath("relative/session.jsonl")).toBeNull();
		expect(validateSessionPath("/tmp/a/session.txt")).toBeNull();
		expect(validateSessionPath("/tmp/a/session.jsonl\u0000")).toBeNull();
		expect(validateSessionPath(42)).toBeNull();
	});

	test("normalises lexically, without touching the filesystem", () => {
		expect(normaliseSessionPath("/a/b/../b/x.jsonl")).toBe("/a/b/x.jsonl");
		expect(normaliseSessionPath("/a/./b/x.jsonl")).toBe("/a/b/x.jsonl");
		expect(validateSessionPath("/a/b/../b/x.jsonl")).toBe("/a/b/x.jsonl");
	});
});

describe("the lane grammar", () => {
	test("accepts herdr's lane names", () => {
		expect(validateLane("self-improvement-leader")).toBe("self-improvement-leader");
		expect(validateLane("a")).toBe("a");
	});

	test("refuses anything else", () => {
		for (const value of ["Upper", "1leading", "a".repeat(33), "with space", "dot.name", ""]) {
			expect(validateLane(value)).toBeNull();
		}
	});
});

describe("the binding resolution", () => {
	test("a session path alone is not a binding: the id is required too", () => {
		const result = resolveBinding({ sessionPath: "/tmp/a/s.jsonl" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("invalid_identifier");
	});

	test("both bindings at once is a conflict", () => {
		const result = resolveBinding({
			sessionId: "sid",
			sessionPath: "/tmp/a/s.jsonl",
			lane: "lane-a",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("identity_binding_conflict");
	});

	test("neither binding is a missing binding", () => {
		const result = resolveBinding({ sessionId: "sid" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("identity_binding_required");
	});

	test("a session path resolves to that path", () => {
		const result = resolveBinding({ sessionId: "sid", sessionPath: "/tmp/a/s.jsonl" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.binding.kind).toBe("session_path");
			expect(result.binding.sessionPath).toBe("/tmp/a/s.jsonl");
			expect(result.binding.lane).toBeNull();
		}
	});

	test("a lane resolves to that lane", () => {
		const result = resolveBinding({ sessionId: "sid", lane: "lane-a" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.binding.kind).toBe("lane");
			expect(result.binding.lane).toBe("lane-a");
			expect(result.binding.sessionPath).toBeNull();
		}
	});

	test("a malformed lane is refused before anything else", () => {
		const result = resolveBinding({ sessionId: "sid", lane: "Not A Lane" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("invalid_identifier");
	});
});

describe("the own-session comparison", () => {
	const own = { sessionId: "sid-1", sessionPath: "/tmp/a/s.jsonl" };

	test("the same id and the same file is the caller's own session", () => {
		const result = resolveBinding({ sessionId: "sid-1", sessionPath: "/tmp/a/s.jsonl" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(isOwnSession(result.binding, own)).toBe(true);
	});

	test("the same id with another file is not the caller's own session", () => {
		const result = resolveBinding({ sessionId: "sid-1", sessionPath: "/tmp/b/s.jsonl" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(isOwnSession(result.binding, own)).toBe(false);
	});

	test("another id with the caller's own file is not the caller's own session", () => {
		const result = resolveBinding({ sessionId: "sid-2", sessionPath: "/tmp/a/s.jsonl" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(isOwnSession(result.binding, own)).toBe(false);
	});
});
