// herdr.test.ts — the lane classifier.
//
// The classifier is ordered and the first match wins. The default for an answer this
// build does not recognise is a generic failure: an unknown code is never read as a
// fact about the target.

import { describe, expect, test } from "bun:test";
import { type HerdrExecResult, readHerdrEnvironment, resolveLaneSession } from "./herdr.ts";

const MANAGED = { managed: true, endpoint: true, binary: true };

function execReturning(
	result: Partial<HerdrExecResult>,
): (command: string, args: string[]) => Promise<HerdrExecResult> {
	return async () => ({ code: 0, stdout: "", stderr: "", ...result });
}

describe("the herdr environment", () => {
	test("an unmanaged process is not managed by herdr", () => {
		expect(readHerdrEnvironment({}).managed).toBe(false);
		expect(readHerdrEnvironment({ HERDR_ENV: "1" }).managed).toBe(true);
	});

	test("the endpoint is the socket path", () => {
		expect(readHerdrEnvironment({ HERDR_SOCKET_PATH: "/tmp/sock" }).endpoint).toBe(true);
		expect(readHerdrEnvironment({ HERDR_SOCKET_PATH: " " }).endpoint).toBe(false);
	});
});

describe("the lane classifier", () => {
	test("a pi lane resolves to its session file", async () => {
		const result = await resolveLaneSession(
			"lane-a",
			execReturning({
				stdout: JSON.stringify({
					agent: { agent: "pi", pane_id: "w1A:p1", agent_session: { kind: "path", value: "/tmp/a/s.jsonl" } },
				}),
			}),
			MANAGED,
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.lane.sessionPath).toBe("/tmp/a/s.jsonl");
	});

	test("a lane that does not run pi is refused with the observed kind", async () => {
		const result = await resolveLaneSession(
			"lane-a",
			execReturning({
				stdout: JSON.stringify({ agent: { agent: "claude", agent_session: { kind: "path", value: "/tmp/a" } } }),
			}),
			MANAGED,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.code).toBe("target_not_pi");
			expect(result.failure.detail?.observedKind).toBe("claude");
		}
	});

	test("a lane whose session cannot be resolved is refused", async () => {
		const result = await resolveLaneSession(
			"lane-a",
			execReturning({
				stdout: JSON.stringify({ agent: { agent: "pi", agent_session: { kind: "unknown", value: "x" } } }),
			}),
			MANAGED,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("target_session_unresolvable");
	});

	test("a known missing-lane code is a missing lane", async () => {
		const result = await resolveLaneSession(
			"lane-a",
			execReturning({ code: 1, stdout: JSON.stringify({ code: "lane_not_found" }) }),
			MANAGED,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("target_lane_unknown");
	});

	test("a known ambiguous code is an ambiguous target", async () => {
		const result = await resolveLaneSession(
			"lane-a",
			execReturning({ code: 1, stdout: JSON.stringify({ code: "lane_ambiguous" }) }),
			MANAGED,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("target_ambiguous");
	});

	test("an unrecognised code is a generic failure, with the code as a detail", async () => {
		const result = await resolveLaneSession(
			"lane-a",
			execReturning({ code: 1, stdout: JSON.stringify({ code: "something_new" }) }),
			MANAGED,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.code).toBe("herdr_api_failure");
			expect(result.failure.detail?.herdrCode).toBe("something_new");
			expect(result.failure.message).not.toContain("something_new");
		}
	});

	test("a stderr that is not JSON is a generic failure with no code", async () => {
		const result = await resolveLaneSession(
			"lane-a",
			execReturning({ code: 1, stdout: "", stderr: "boom: /home/someone/.config/secret.jsonl" }),
			MANAGED,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.code).toBe("herdr_api_failure");
			expect(result.failure.detail).toBeUndefined();
			expect(result.failure.message).not.toContain("secret");
			expect(result.failure.message).not.toContain("/home");
		}
	});

	test("exit 2 is our defect, not a fact about the target", async () => {
		const result = await resolveLaneSession("lane-a", execReturning({ code: 2 }), MANAGED);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("herdr_api_failure");
	});

	test("a timeout is a timeout", async () => {
		const result = await resolveLaneSession("lane-a", execReturning({ code: 0, killed: true }), MANAGED);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.code).toBe("herdr_timeout");
	});

	test("outside a herdr environment the lane means nothing", async () => {
		const absent = await resolveLaneSession("lane-a", execReturning({}), {
			managed: false,
			endpoint: false,
			binary: false,
		});
		expect(absent.ok).toBe(false);
		if (!absent.ok) expect(absent.failure.code).toBe("herdr_absent");

		const unmanaged = await resolveLaneSession("lane-a", execReturning({}), {
			managed: false,
			endpoint: true,
			binary: true,
		});
		expect(unmanaged.ok).toBe(false);
		if (!unmanaged.ok) expect(unmanaged.failure.code).toBe("herdr_not_managed");

		const noEndpoint = await resolveLaneSession("lane-a", execReturning({}), {
			managed: true,
			endpoint: false,
			binary: true,
		});
		expect(noEndpoint.ok).toBe(false);
		if (!noEndpoint.ok) expect(noEndpoint.failure.code).toBe("herdr_unavailable");
	});
});
