// pi-parameter-tools — set the model and the thinking level of a pi session.
//
// Four tools:
//
//   set_own_thinking      the calling agent's thinking/reasoning effort
//   set_own_model         the calling agent's provider/model
//   set_session_thinking  an explicitly identified pi session's thinking effort
//   set_session_model     an explicitly identified pi session's provider/model
//
// The own tools change the caller's own session, in the caller's own process, through
// pi's own session-control methods.
//
// The session-targeted tools name their target explicitly: a session id **and** one
// unambiguous binding (a session path or a herdr lane). A session id alone is never
// enough, because ids can repeat across session files.
//
// The target is reached through a **receiver** inside the target's own pi process.
// pi exposes no cross-process session control, so this package brings its own: the
// target's extension listens on a local socket (the receiver), the caller sends the
// request there, and the target's process applies the change with **its own** pi
// setters and answers with the state it observed there. The target session is
// therefore written by the process that owns it, and by nobody else.
//
// What this package does NOT do: write a session file by hand, type into another
// pane's terminal, relay a slash command, edit settings, restart anything, or start
// a second pi process to change a session that is already running. The change is made
// by pi's own setter, in a pi process, for one named session.

import { getSupportedThinkingLevels, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ChannelRequest, type ChannelResponse, sendRequest, socketPathFor } from "./channel.ts";
import { readHerdrEnvironment, resolveLaneSession } from "./herdr.ts";
import { isHeldPlace } from "./holds.ts";
import { emptyTarget, type ModelRef, type ParameterToolResult, refusal, summarise, THINKING_LEVELS } from "./params.ts";
import { type Receiver, startReceiver } from "./receiver.ts";
import { readSessionHeaderId } from "./session-file.ts";
import {
	applyOwnModel,
	applyOwnThinking,
	applySessionModel,
	applySessionThinking,
	type ParameterRuntime,
} from "./target.ts";

const MUTATION_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const RESULT_SCHEMA = Type.Object(
	{
		ok: Type.Boolean(),
		tool: Type.String(),
		target: Type.Object({}, { additionalProperties: true }),
		model: Type.Object({}, { additionalProperties: true }),
		thinking: Type.Object({}, { additionalProperties: true }),
		applied: Type.String(),
		changed: Type.Boolean(),
		records: Type.Object({}, { additionalProperties: true }),
		disk: Type.Object({}, { additionalProperties: true }),
		effective: Type.String(),
		partial: Type.Boolean(),
		warnings: Type.Array(Type.String()),
		refusal: Type.Optional(Type.Object({}, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);

const TARGET_PARAMETERS = {
	sessionId: Type.String({
		description: "The target session's id, exactly as the target reports it.",
	}),
	sessionPath: Type.Optional(
		Type.String({
			description: "Absolute path of the target session file (ends in .jsonl). Give this OR a lane.",
		}),
	),
	lane: Type.Optional(
		Type.String({
			description: "The herdr lane that runs the target session. Give this OR a session path.",
		}),
	),
};

function modelRef(model: unknown): ModelRef | null {
	if (!model || typeof model !== "object") return null;
	const record = model as { provider?: unknown; id?: unknown };
	if (typeof record.provider !== "string" || typeof record.id !== "string") return null;
	return { provider: record.provider, modelId: record.id };
}

/** The record ids the own session's branch gained, if any. */
function ownRecords(ctx: ExtensionContext): {
	modelChangeEntryId: string | null;
	thinkingLevelEntryId: string | null;
} {
	const out = { modelChangeEntryId: null as string | null, thinkingLevelEntryId: null as string | null };
	let branch: unknown[] = [];
	try {
		branch = (ctx.sessionManager.getBranch() ?? []) as unknown[];
	} catch {
		return out;
	}
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; id?: unknown };
		if (typeof record.id !== "string") continue;
		if (record.type === "model_change") out.modelChangeEntryId = record.id;
		if (record.type === "thinking_level_change") out.thinkingLevelEntryId = record.id;
	}
	return out;
}

/**
 * The runtime the tools work against: the caller's own session, plus the reach.
 *
 * It is exported so that a host (or a test) can drive the same path the tools
 * drive, against a real extension context, rather than a stand-in.
 */
export function createParameterRuntime(pi: ExtensionAPI, ctx: ExtensionContext): ParameterRuntime {
	return {
		own: {
			sessionId: ctx.sessionManager.getSessionId() ?? null,
			sessionPath: ctx.sessionManager.getSessionFile() ?? null,
			model: modelRef(ctx.model),
			thinkingLevel: pi.getThinkingLevel() ?? null,
		},
		getModel: async () => modelRef(ctx.model),
		getThinkingLevel: async () => pi.getThinkingLevel() ?? null,
		supportedThinkingLevels: () => {
			const model = ctx.model;
			if (!model) return [...THINKING_LEVELS];
			return getSupportedThinkingLevels(model);
		},
		resolveModel: async (ref) => {
			const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
			return found ? { provider: found.provider, modelId: found.id } : null;
		},
		setOwnModel: async (ref) => {
			const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
			if (!found) return false;
			return pi.setModel(found);
		},
		setOwnThinkingLevel: async (level) => {
			pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		},
		ownRecords: async () => ownRecords(ctx),
		resolveLane: async (lane) =>
			resolveLaneSession(
				lane,
				async (command, args, options) => {
					const result = await pi.exec(command, args, { timeout: options.timeoutMs });
					return { code: result.code, stdout: result.stdout, stderr: result.stderr, killed: result.killed };
				},
				readHerdrEnvironment(process.env as Record<string, string | undefined>),
			),
		readSessionHeaderId: async (sessionPath) => readSessionHeaderId(sessionPath),
		sendToTarget: async (request: ChannelRequest, options: { timeoutMs?: number }): Promise<ChannelResponse> => {
			return await sendRequest({
				sessionId: request.sessionId,
				sessionPath: request.sessionPath,
				request,
				timeoutMs: options.timeoutMs,
			});
		},
	};
}

function toolResult(result: ParameterToolResult) {
	return {
		content: [{ type: "text" as const, text: summarise(result) }],
		details: result,
		structuredContent: result as unknown as JsonValue,
		isError: !result.ok,
	};
}

/**
 * The refusal for a lane that is in a held or reserved place.
 *
 * The fleet's holds are not this package's to lift: a lane in a held workspace does
 * not report itself to the roster, and it does not change its own parameters either.
 */
function heldRefusal(tool: string): ParameterToolResult | null {
	const handles = {
		workspaceId: process.env.HERDR_WORKSPACE_ID ?? null,
		tabId: process.env.HERDR_TAB_ID ?? null,
		paneId: process.env.HERDR_PANE_ID ?? null,
	};
	if (!isHeldPlace(handles)) return null;
	return refusal(tool, "held_lane", "this lane is in a held or reserved place", emptyTarget(), {
		held: true,
	});
}

export default function parameterTools(pi: ExtensionAPI) {
	// The receiver: this session listens for requests from other lanes that want its
	// model or its thinking level changed. It is started with the session and closed
	// with it, and it changes only this session, with this session's own setters.
	//
	// The session's identity is the pair (id, file): a copied session file keeps the
	// header's id, so the id alone does not name a session. The socket's path is
	// derived from the pair, and the receiver owns that socket: it takes the name
	// when it is the most recent owner of that session file, and its cleanup removes
	// only its own socket, never the one another owner has taken over.
	let receiver: Receiver | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId() ?? null;
		const sessionPath = ctx.sessionManager.getSessionFile() ?? null;
		// The previous session's receiver goes with the previous session: pi emits
		// `session_shutdown` for it, and a session that starts without a file has
		// nothing another lane could name.
		receiver?.close();
		receiver = null;
		if (!sessionId || !sessionPath) return;
		receiver = await startReceiver({
			socketPath: socketPathFor(sessionId, sessionPath),
			session: {
				sessionId,
				sessionPath,
				workspaceId: process.env.HERDR_WORKSPACE_ID ?? null,
				tabId: process.env.HERDR_TAB_ID ?? null,
				paneId: process.env.HERDR_PANE_ID ?? null,
				supportedThinkingLevels: () => {
					const model = ctx.model;
					if (!model) return [...THINKING_LEVELS];
					return getSupportedThinkingLevels(model);
				},
				resolveModel: (ref) => {
					const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
					return found ? { provider: found.provider, modelId: found.id } : null;
				},
				setThinkingLevel: (level) => {
					pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
				},
				setModel: async (ref) => {
					const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
					if (!found) return false;
					return pi.setModel(found);
				},
				thinkingLevel: () => pi.getThinkingLevel() ?? null,
				model: () => modelRef(ctx.model),
				records: () => ownRecords(ctx),
			},
		});
	});

	pi.on("session_shutdown", async () => {
		receiver?.close();
		receiver = null;
	});

	pi.registerTool({
		name: "set_own_thinking",
		label: "Set Own Thinking",
		description:
			"Set the calling agent's thinking/reasoning effort for this session. Levels: off, minimal, low, medium, high, xhigh, max. A level the current model does not support is refused, not clamped. Same level again is a no-op.",
		promptSnippet: "Set this session's thinking/reasoning effort",
		promptGuidelines: [
			"Use set_own_thinking to change this session's reasoning effort; use set_session_thinking for another session.",
			"Read the returned before/after; a level the model does not support comes back as level_unsupported.",
		],
		parameters: Type.Object({
			level: Type.String({ description: "off | minimal | low | medium | high | xhigh | max" }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const held = heldRefusal("set_own_thinking");
			if (held) return toolResult(held);
			return toolResult(await applyOwnThinking(createParameterRuntime(pi, ctx), "set_own_thinking", params.level));
		},
	});

	pi.registerTool({
		name: "set_own_model",
		label: "Set Own Model",
		description:
			"Set the calling agent's provider/model for this session. The provider and model id must be a model pi's registry knows. The same model again is a no-op. The new model takes effect on the next request.",
		promptSnippet: "Set this session's provider and model",
		promptGuidelines: [
			"Use set_own_model to change this session's model; use set_session_model for another session.",
			"An unknown model comes back as model_unknown and a provider without credentials as auth_missing.",
		],
		parameters: Type.Object({
			provider: Type.String({ description: "The provider id, e.g. anthropic." }),
			modelId: Type.String({ description: "The model id within that provider." }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const held = heldRefusal("set_own_model");
			if (held) return toolResult(held);
			return toolResult(
				await applyOwnModel(createParameterRuntime(pi, ctx), "set_own_model", params.provider, params.modelId),
			);
		},
	});

	pi.registerTool({
		name: "set_session_thinking",
		label: "Set Session Thinking",
		description:
			"Set the thinking/reasoning effort of an explicitly identified pi session. Name the session id and one unambiguous binding: a session file path OR a herdr lane. The named session's own file must hold that session id. The request goes to the target's own running pi process, which applies the change with its own setters and answers with what it observed. A target that is not running, or that has no receiver loaded, is refused (receiver_unavailable) and nothing is changed.",
		promptSnippet: "Set another pi session's thinking/reasoning effort by explicit target",
		promptGuidelines: [
			"Give both a sessionId and exactly one of sessionPath or lane; a session id alone is refused as ambiguous.",
			"A refusal names the reason (identity_binding_required, session_id_mismatch, held_lane, receiver_unavailable, target_timeout, ...); nothing is changed on a refusal.",
		],
		parameters: Type.Object({
			...TARGET_PARAMETERS,
			level: Type.String({ description: "off | minimal | low | medium | high | xhigh | max" }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const held = heldRefusal("set_session_thinking");
			if (held) return toolResult(held);
			return toolResult(
				await applySessionThinking(
					createParameterRuntime(pi, ctx),
					"set_session_thinking",
					{ sessionId: params.sessionId, sessionPath: params.sessionPath, lane: params.lane },
					params.level,
				),
			);
		},
	});

	pi.registerTool({
		name: "set_session_model",
		label: "Set Session Model",
		description:
			"Set the provider/model of an explicitly identified pi session. Name the session id and one unambiguous binding: a session file path OR a herdr lane. The named session's own file must hold that session id. The request goes to the target's own running pi process, which applies the change with its own setters and answers with what it observed. A target that is not running, or that has no receiver loaded, is refused (receiver_unavailable) and nothing is changed.",
		promptSnippet: "Set another pi session's provider and model by explicit target",
		promptGuidelines: [
			"Give both a sessionId and exactly one of sessionPath or lane; a session id alone is refused as ambiguous.",
			"The model is resolved in the target's own registry: an unknown model comes back as model_unknown.",
		],
		parameters: Type.Object({
			...TARGET_PARAMETERS,
			provider: Type.String({ description: "The provider id, e.g. anthropic." }),
			modelId: Type.String({ description: "The model id within that provider." }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const held = heldRefusal("set_session_model");
			if (held) return toolResult(held);
			return toolResult(
				await applySessionModel(
					createParameterRuntime(pi, ctx),
					"set_session_model",
					{ sessionId: params.sessionId, sessionPath: params.sessionPath, lane: params.lane },
					params.provider,
					params.modelId,
				),
			);
		},
	});
}
