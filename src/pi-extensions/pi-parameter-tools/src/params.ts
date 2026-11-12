// params.ts — the parameter vocabulary and the result envelope.
//
// Pure: no runtime, no process, no filesystem. The levels, the model reference
// grammar, the refusal codes and the envelope that every tool returns live here, so
// the four tools and the tests agree on one vocabulary.

/**
 * The thinking levels pi accepts.
 *
 * "off" is a level of its own (a model that does not reason); the rest are the
 * reasoning efforts. The list is pi's own: `ThinkingLevel` in pi-ai is
 * "minimal" | "low" | "medium" | "high" | "xhigh" | "max", and `ModelThinkingLevel`
 * adds "off".
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** Is this one of the levels pi accepts? An unknown string is refused, never clamped. */
export function isThinkingLevel(value: unknown): value is ThinkingLevelName {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** A model reference: the provider and the model's id within that provider. */
export interface ModelRef {
	provider: string;
	modelId: string;
}

/**
 * Validate a model reference.
 *
 * Two required strings, no shorthand: a `provider/modelId` shorthand would have to
 * disambiguate ids that themselves contain `/` and `:`, and that ambiguity is a bug
 * waiting to happen. Returns the trimmed reference or null.
 */
export function validateModelRef(provider: unknown, modelId: unknown): ModelRef | null {
	if (typeof provider !== "string" || typeof modelId !== "string") return null;
	const p = provider.trim();
	const m = modelId.trim();
	if (!p || !m) return null;
	// A handle that can name a file is a handle that can be made to name one.
	if (/[\s/\\]/.test(p) || /[\s]/.test(m)) return null;
	return { provider: p, modelId: m };
}

/** The stable refusal codes. Every refusal names one of these. */
export type RefusalCode =
	| "invalid_identifier"
	| "invalid_level"
	| "level_unsupported"
	| "no_model_selected"
	| "model_unknown"
	| "auth_missing"
	| "identity_binding_required"
	| "identity_binding_conflict"
	| "no_session_file"
	| "session_id_mismatch"
	| "session_identity_mismatch"
	| "target_timeout"
	| "receiver_unavailable"
	| "target_unreachable"
	| "target_protocol_error"
	| "held_lane"
	| "target_session_unresolvable"
	| "target_lane_unknown"
	| "target_not_pi"
	| "target_ambiguous"
	| "lane_targets_other_session"
	| "herdr_absent"
	| "herdr_not_managed"
	| "herdr_unavailable"
	| "herdr_api_failure"
	| "apply_failed"
	| "partial_apply";

/** How the requested change landed in memory. */
export type Applied = "model" | "thinking" | "both" | "none" | "unknown";

/** What the tool was asked to do, and what it resolved to. */
export interface TargetReport {
	kind: "own" | "session";
	/** The session the change actually landed in. */
	sessionId: string | null;
	/** The session file the change actually landed in, when there is one. */
	sessionPath: string | null;
	/** What the caller asked for. */
	requested: {
		sessionId?: string;
		sessionPath?: string;
		lane?: string;
		[key: string]: unknown;
	};
	/** How the target was reached. */
	resolution: {
		source: "in_memory" | "session_file" | "lane" | "receiver";
		lane?: string;
	} | null;
}

export interface ParameterToolResult {
	ok: boolean;
	tool: string;
	target: TargetReport;
	model: { before: ModelRef | null; requested: ModelRef | null; after: ModelRef | null };
	thinking: {
		before: string | null;
		requested: string | null;
		after: string | null;
		supported: string[];
	};
	applied: Applied;
	changed: boolean;
	records: { modelChangeEntryId: string | null; thinkingLevelEntryId: string | null };
	/** Never "written" and never "durable": an extension cannot prove either. */
	disk: { state: "unknown" | "not_applicable" };
	/** When the new parameter takes effect. */
	effective: "next_request";
	partial: boolean;
	warnings: string[];
	refusal?: { code: RefusalCode; message: string; detail?: Record<string, unknown> };
}

export function emptyTarget(requested: TargetReport["requested"] = {}): TargetReport {
	return { kind: "own", sessionId: null, sessionPath: null, requested, resolution: null };
}

/**
 * A refusal result.
 *
 * A refusal carries the same envelope as a success: the caller learns what was
 * requested, what was resolved, what the state was, and why nothing changed.
 */
export function refusal(
	tool: string,
	code: RefusalCode,
	message: string,
	target: TargetReport,
	detail?: Record<string, unknown>,
): ParameterToolResult {
	return {
		ok: false,
		tool,
		target,
		model: { before: null, requested: null, after: null },
		thinking: { before: null, requested: null, after: null, supported: [] },
		applied: "none",
		changed: false,
		records: { modelChangeEntryId: null, thinkingLevelEntryId: null },
		disk: { state: "unknown" },
		effective: "next_request",
		partial: false,
		warnings: [],
		refusal: detail ? { code, message, detail } : { code, message },
	};
}

/** The one-line summary the model reads. The structured result carries the truth. */
export function summarise(result: ParameterToolResult): string {
	if (result.refusal) return `${result.tool}: refused (${result.refusal.code}) — ${result.refusal.message}`;
	const what = result.applied === "none" ? "no change" : `applied ${result.applied}`;
	const extra = result.partial ? "; partial" : "";
	return `${result.tool}: ${what}${extra}.`;
}
