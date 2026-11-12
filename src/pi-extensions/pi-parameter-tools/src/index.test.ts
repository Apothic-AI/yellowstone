// index.test.ts — what the extension registers.
//
// The factory is called with a fake ExtensionAPI: the point is that four tools are
// registered, with the static declarations the plan requires, and that the factory
// itself does not throw.

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import parameterTools from "./index.ts";

interface Registered {
	name: string;
	label: string;
	description: string;
	annotations?: Record<string, unknown>;
	executionMode?: string;
	outputSchema?: unknown;
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<unknown>;
}

function fakeApi(): {
	api: ExtensionAPI;
	tools: Map<string, Registered>;
	handlers: Map<string, (...args: unknown[]) => unknown>;
} {
	const tools = new Map<string, Registered>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	let thinkingLevel = "off";
	const api = {
		registerTool: (tool: Registered) => {
			tools.set(tool.name, tool);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level: string) => {
			thinkingLevel = level;
		},
		setModel: async () => true,
	} as unknown as ExtensionAPI;
	return { api, tools, handlers };
}

const fakeContext = {
	sessionManager: {
		getSessionId: () => "caller-session",
		getSessionFile: () => "/tmp/caller/session.jsonl",
		getBranch: () => [],
	},
	model: { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
	modelRegistry: { find: () => undefined },
	thinkingLevel: "off",
} as unknown as ExtensionContext;

describe("the extension", () => {
	test("registers exactly four tools", () => {
		const { api, tools } = fakeApi();
		parameterTools(api);
		expect([...tools.keys()].sort()).toEqual([
			"set_own_model",
			"set_own_thinking",
			"set_session_model",
			"set_session_thinking",
		]);
	});

	test("every tool declares the same static mutation contract", () => {
		const { api, tools } = fakeApi();
		parameterTools(api);
		for (const tool of tools.values()) {
			expect(tool.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			});
			expect(tool.executionMode).toBe("sequential");
			expect(tool.outputSchema).toBeDefined();
			expect(tool.label.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(20);
		}
	});

	test("the session-targeted tools ask for a session id and one binding", () => {
		const { api, tools } = fakeApi();
		parameterTools(api);
		for (const name of ["set_session_thinking", "set_session_model"]) {
			const tool = tools.get(name);
			expect(tool).toBeDefined();
			const schema = JSON.stringify(tool?.parameters ?? {});
			expect(schema).toContain("sessionId");
			expect(schema).toContain("sessionPath");
			expect(schema).toContain("lane");
		}
	});

	test("the receiver's life is tied to the session's life", () => {
		const { api, handlers } = fakeApi();
		parameterTools(api);
		// The receiver listens for requests from other lanes; it starts with the
		// session and stops with it, so no socket outlives the session that owns it.
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
	});

	test("the own thinking tool runs end to end against the extension context", async () => {
		const { api, tools } = fakeApi();
		parameterTools(api);
		const tool = tools.get("set_own_thinking");
		const result = (await tool?.execute("call-1", { level: "high" }, undefined, undefined, fakeContext)) as {
			isError: boolean;
			details: { applied: string; changed: boolean };
		};
		expect(result.isError).toBe(false);
		expect(result.details.applied).toBe("thinking");
		expect(result.details.changed).toBe(true);
	});

	test("a session-targeted call with no binding refuses, and changes nothing", async () => {
		const { api, tools } = fakeApi();
		parameterTools(api);
		const tool = tools.get("set_session_thinking");
		const result = (await tool?.execute(
			"call-2",
			{ sessionId: "target-id", level: "high" },
			undefined,
			undefined,
			fakeContext,
		)) as { isError: boolean; details: { refusal: { code: string } } };
		expect(result.isError).toBe(true);
		expect(result.details.refusal.code).toBe("identity_binding_required");
	});
});
