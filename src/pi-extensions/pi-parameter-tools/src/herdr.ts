// herdr.ts — resolve a herdr lane to the pi session behind it.
//
// One command, one purpose: `herdr agent get <lane>` says which agent runs in a lane
// and which session file that agent is using. The lane binding is what lets a caller
// name a target by its fleet name instead of by a file path.
//
// The classifier is ordered and the first match wins, and the default is a generic
// failure: an error code this build does not recognise is never reinterpreted as a
// fact about the target.

import type { RefusalCode } from "./params.ts";

export interface HerdrExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
}

export type HerdrExecFn = (
	command: string,
	args: string[],
	options: { timeoutMs?: number },
) => Promise<HerdrExecResult>;

export interface HerdrAgentPayload {
	agent?: unknown;
	pane_id?: unknown;
	agent_session?: { kind?: unknown; value?: unknown } | null;
}

export interface HerdrLaneResolution {
	sessionPath: string;
	/** The agent kind herdr reported, e.g. "pi". */
	kind: string;
	paneId: string | null;
}

export interface HerdrLaneFailure {
	code: RefusalCode | "herdr_timeout";
	message: string;
	detail?: Record<string, unknown>;
}

export type HerdrLaneResult = { ok: true; lane: HerdrLaneResolution } | { ok: false; failure: HerdrLaneFailure };

/** The codes herdr is known to use for "there is no such lane". */
const TARGET_MISSING_CODES = new Set(["lane_not_found", "not_found", "unknown_lane", "no_such_lane"]);
/** The codes herdr is known to use for "that name is ambiguous". */
const AMBIGUOUS_CODES = new Set(["lane_ambiguous", "ambiguous", "multiple_lanes"]);
/** The codes herdr is known to use for "the service is not there". */
const UNAVAILABLE_CODES = new Set(["unavailable", "not_running", "server_unavailable", "daemon_unavailable"]);

const MACHINE_CODE_RE = /^[a-z][a-z0-9_.-]{0,40}$/;

export interface HerdrEnvironment {
	/** Is herdr managing this process? */
	managed: boolean;
	/** Is the herdr endpoint reachable from here? */
	endpoint: boolean;
	/** Is the herdr binary on PATH? */
	binary: boolean;
}

/** Read the herdr environment from an environment map. */
export function readHerdrEnvironment(env: Record<string, string | undefined>): HerdrEnvironment {
	const socket = env.HERDR_SOCKET_PATH;
	return {
		managed: env.HERDR_ENV === "1",
		endpoint: Boolean(socket?.trim()),
		binary: env.HERDR_BIN !== "0",
	};
}

/**
 * Resolve a lane to the pi session behind it.
 *
 * The order: the environment first (a lane only means something inside a herdr
 * environment), then the classifier over the command's own answer.
 */
export async function resolveLaneSession(
	lane: string,
	exec: HerdrExecFn,
	env: HerdrEnvironment,
	timeoutMs = 2000,
): Promise<HerdrLaneResult> {
	if (!env.binary && !env.endpoint) {
		return {
			ok: false,
			failure: { code: "herdr_absent", message: "herdr is not available in this environment" },
		};
	}
	if (!env.managed) {
		return {
			ok: false,
			failure: { code: "herdr_not_managed", message: "this process is not managed by herdr" },
		};
	}
	if (!env.endpoint) {
		return {
			ok: false,
			failure: {
				code: "herdr_unavailable",
				message: "the herdr endpoint is not reachable from this environment",
			},
		};
	}

	let result: HerdrExecResult;
	try {
		result = await exec("herdr", ["agent", "get", lane], { timeoutMs });
	} catch (error) {
		return {
			ok: false,
			failure: {
				code: "herdr_api_failure",
				message: "herdr agent get failed",
				detail: { cause: error instanceof Error ? error.name : "unknown" },
			},
		};
	}

	if (result.killed) {
		return { ok: false, failure: { code: "herdr_timeout", message: "herdr agent get timed out" } };
	}
	if (result.code === 2) {
		return {
			ok: false,
			failure: { code: "herdr_api_failure", message: "herdr agent get failed (exit 2)" },
		};
	}
	if (result.code !== 0) {
		const parsed = parseJson(result.stdout) ?? parseJson(result.stderr);
		const code = typeof parsed?.code === "string" ? parsed.code : null;
		if (code && TARGET_MISSING_CODES.has(code)) {
			return {
				ok: false,
				failure: { code: "target_lane_unknown", message: "no such lane", detail: { herdrCode: code } },
			};
		}
		if (code && AMBIGUOUS_CODES.has(code)) {
			return {
				ok: false,
				failure: { code: "target_ambiguous", message: "the lane name is ambiguous", detail: { herdrCode: code } },
			};
		}
		if (code && UNAVAILABLE_CODES.has(code)) {
			return {
				ok: false,
				failure: {
					code: "herdr_unavailable",
					message: "herdr is unavailable",
					detail: { herdrCode: code },
				},
			};
		}
		// Rows 6 and 7: an unrecognised code, or no code at all. The message stays
		// generic; a machine-shaped code may be reported as a detail.
		return {
			ok: false,
			failure: {
				code: "herdr_api_failure",
				message: `herdr agent get failed (exit ${result.code})`,
				detail: code && MACHINE_CODE_RE.test(code) ? { herdrCode: code } : undefined,
			},
		};
	}

	const payload = parseJson(result.stdout);
	const agent = payload?.agent;
	if (!payload || typeof agent !== "object" || agent === null) {
		return {
			ok: false,
			failure: { code: "herdr_api_failure", message: "herdr agent get returned no agent record" },
		};
	}
	const agentKind = typeof (agent as HerdrAgentPayload).agent === "string" ? (agent as HerdrAgentPayload).agent : "";
	if (agentKind !== "pi") {
		return {
			ok: false,
			failure: {
				code: "target_not_pi",
				message: "that lane does not run a pi agent",
				detail: { observedKind: agentKind || "unknown" },
			},
		};
	}
	const session = (agent as HerdrAgentPayload).agent_session;
	const kind = session && typeof session.kind === "string" ? session.kind : "";
	const value = session && typeof session.value === "string" ? session.value : "";
	if (kind !== "path" || !value.startsWith("/")) {
		return {
			ok: false,
			failure: {
				code: "target_session_unresolvable",
				message: "that lane's session file could not be resolved",
			},
		};
	}
	const rawPaneId = (agent as HerdrAgentPayload).pane_id;
	const paneId = typeof rawPaneId === "string" ? rawPaneId : null;
	return { ok: true, lane: { sessionPath: value, kind: agentKind, paneId } };
}

function parseJson(text: string): Record<string, unknown> | null {
	if (!text?.trim().startsWith("{")) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}
