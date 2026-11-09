import { describe, expect, it } from "vitest";

import {
	applySubagentSettings,
	parseSubagentSettings,
	type ProfileSubagentSettings,
} from "../src/subagent-settings.ts";

const context = { profile: "review", filePath: "/profiles/review.json" };
const settingsContext = { profile: "review", settingsPath: "/agent/settings.json" };

describe("parseSubagentSettings", () => {
	it("normalizes omitted and effectively empty declarations", () => {
		expect(parseSubagentSettings(undefined, context)).toBeUndefined();
		expect(parseSubagentSettings({}, context)).toBeUndefined();
		expect(parseSubagentSettings({ agentOverrides: {} }, context)).toBeUndefined();
		expect(parseSubagentSettings({ agentOverrides: { reviewer: {} } }, context)).toBeUndefined();
	});

	it("trims text, accepts native fields and retains explicit false values", () => {
		expect(parseSubagentSettings({ defaultModel: " model ", defaultThinking: "high", agentOverrides: {
			reviewer: { model: false, thinking: false, description: " reviewer ", advertise: false },
		} }, context)).toEqual({
			defaultModel: "model", defaultThinking: "high",
			agentOverrides: { reviewer: { model: false, thinking: false, description: "reviewer", advertise: false } },
		});
	});

	it("rejects nested invalid fields with full path and actionable context", () => {
		expect(() => parseSubagentSettings({ agentOverrides: { reviewer: { advertise: "no" } } }, context))
			.toThrow(/\/profiles\/review\.json.*profile "review".*subagents\.agentOverrides\.reviewer\.advertise.*boolean/);
		expect(() => parseSubagentSettings({ agentOverrides: { reviewer: { tools: [] } } }, context))
			.toThrow(/supported fields: model, thinking, description, advertise/);
		expect(() => parseSubagentSettings({ defaultThinking: "invalid" }, context)).toThrow(/off, minimal, low, medium, high, xhigh, max/);
	});

	it("rejects blank text and malformed role names", () => {
		for (const name of ["", " reviewer", "reviewer ", "review*", "reviewer\nrole", "reviewer\rrole", "reviewer\u2028role", "reviewer\u2029role"]) {
			expect(() => parseSubagentSettings({ agentOverrides: { [name]: { model: "m" } } }, context)).toThrow(/exact agent name/);
		}
		expect(() => parseSubagentSettings({ defaultModel: "  " }, context)).toThrow(/nonempty string/);
	});

	it("preserves internal spaces and tabs in exact role names", () => {
		expect(parseSubagentSettings({ agentOverrides: {
			"reviewer role": { model: "m" },
			"reviewer\trole": { model: "m" },
		} }, context)?.agentOverrides).toEqual({
			"reviewer role": { model: "m" },
			"reviewer\trole": { model: "m" },
		});
	});

	it("preserves prototype-looking role keys as own data properties", () => {
		const parsed = parseSubagentSettings(JSON.parse('{"agentOverrides":{"toString":{"advertise":false},"__proto__":{"model":" inherit "}}}'), context)!;
		expect(Object.hasOwn(parsed.agentOverrides!, "toString")).toBe(true);
		expect(Object.hasOwn(parsed.agentOverrides!, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(parsed.agentOverrides)).toBe(Object.prototype);
		expect(JSON.stringify(parsed)).toContain('"__proto__":{"model":"inherit"}');
	});
});

describe("applySubagentSettings", () => {
	it("partially merges only declared role fields and preserves unrelated native data", () => {
		const native = { subagents: { defaultModel: "base", custom: { keep: true }, agentOverrides: {
			reviewer: { model: "old", inheritedContext: true, tools: ["read"] }, scout: { model: "scout" },
		}, agentOverridesByProvider: { provider: { reviewer: { model: "provider" } } } } };
		const result = applySubagentSettings(native, { agentOverrides: { reviewer: { model: "new", advertise: false } } }, settingsContext);
		expect(result.subagents).toEqual({ defaultModel: "base", custom: { keep: true }, agentOverrides: {
			reviewer: { model: "new", inheritedContext: true, tools: ["read"], advertise: false }, scout: { model: "scout" },
		}, agentOverridesByProvider: { provider: { reviewer: { model: "provider" } } } });
		expect(native.subagents.agentOverrides.reviewer).toEqual({ model: "old", inheritedContext: true, tools: ["read"] });
	});

	it("writes defaults without inspecting malformed role entries and does not mutate inputs", () => {
		const native = { subagents: { agentOverrides: { malformed: false } } };
		const copy = structuredClone(native);
		const result = applySubagentSettings(native, { defaultModel: "shared" }, settingsContext);
		expect(result.subagents).toEqual({ defaultModel: "shared", agentOverrides: { malformed: false } });
		expect(native).toEqual(copy);
	});

	it("does not inspect native subagent content for an empty declaration", () => {
		const native = { subagents: false };
		expect(applySubagentSettings(native, undefined, settingsContext)).toEqual(native);
		expect(applySubagentSettings(native, {} as ProfileSubagentSettings, settingsContext)).toEqual(native);
	});

	it("creates only needed containers and reports malformed required containers", () => {
		expect(applySubagentSettings({}, { agentOverrides: { reviewer: { model: false } } }, settingsContext)).toEqual({
			subagents: { agentOverrides: { reviewer: { model: false } } },
		});
		for (const [native, path] of [[{ subagents: false }, "subagents"], [{ subagents: { agentOverrides: false } }, "subagents.agentOverrides"], [{ subagents: { agentOverrides: { reviewer: false } } }, "subagents.agentOverrides.reviewer"]] as const) {
			expect(() => applySubagentSettings(native, { agentOverrides: { reviewer: { model: "x" } } }, settingsContext))
				.toThrow(new RegExp(`${settingsContext.settingsPath}.*${path}`));
		}
	});

	it("preserves special keys when patching native maps", () => {
		const base = JSON.parse('{"subagents":{"agentOverrides":{"__proto__":{"model":"old"}}}}');
		const result = applySubagentSettings(base, { agentOverrides: JSON.parse('{"__proto__":{"model":"new"}}') }, settingsContext);
		const subagents = result.subagents as Record<string, unknown>;
		const overrides = subagents.agentOverrides as Record<string, unknown>;
		expect(Object.hasOwn(overrides, "__proto__")).toBe(true);
		expect(overrides["__proto__"]).toEqual({ model: "new" });
		expect(Object.getPrototypeOf(overrides)).toBe(Object.prototype);
	});
});
