import { describe, expect, it } from "vitest";

import { buildStatusReport, formatStatusMarkdown } from "../src/switching/status.ts";

const basePlan = {
	profile: "review",
	source: "global",
	resolved: {
		skills: [
			{ name: "code-review", filePath: "/agent/skills/code-review/SKILL.md" },
			{ name: "debug", filePath: "/agent/skills/debug/SKILL.md" },
		],
		extensions: [{ id: "linter", entry: "/agent/extensions/linter.ts" }],
	},
	tools: ["read", "grep"],
	mcps: ["github"],
};

const emptyRuntime = {
	disabledMcpServers: [] as string[],
	commands: [],
	tools: [],
};

describe("buildStatusReport", () => {
	it("reports resolved absolute paths, mcp tri-state, and overlay contents", () => {
		const report = buildStatusReport({
			plan: basePlan,
			overlay: { disabledSkills: ["noisy"] },
			discoveredMcpServers: ["github", "linear"],
			...emptyRuntime,
		});

		expect(report.mcp).toEqual({ enabled: ["github"], disabled: ["linear"], missing: [] });
		expect(report.overlay).toEqual({ disabledSkills: ["noisy"] });
		expect(report.conflicts.map((conflict) => conflict.winnerPath)).toEqual(["not loaded", "not loaded"]);
	});

	it("derives enabled servers from discovery when mcps is undeclared in plan", () => {
		const planWithoutMcps = {
			profile: "default",
			source: "builtin",
			resolved: { skills: [], extensions: [] },
		};
		const report = buildStatusReport({
			plan: planWithoutMcps,
			discoveredMcpServers: ["github", "linear"],
			...emptyRuntime,
		});

		expect(report.mcp).toEqual({ enabled: ["github", "linear"], disabled: [], missing: [] });
	});

	it("respects merged-config-disabled servers without an MCP whitelist", () => {
		const planWithoutMcps = {
			profile: "default",
			source: "builtin",
			resolved: { skills: [], extensions: [] },
		};
		const report = buildStatusReport({
			plan: planWithoutMcps,
			discoveredMcpServers: ["github", "linear"],
			disabledMcpServers: ["linear"], // server marked enabled: false in the merged snapshot
			commands: [],
			tools: [],
		});

		expect(report.mcp).toEqual({ enabled: ["github"], disabled: ["linear"], missing: [] });
		expect(report.mcpTools).toEqual([{ server: "github", policy: "unrestricted" }]);
	});

	it("distinguishes omitted servers (unrestricted) and empty tool lists (none)", () => {
		const plan = {
			...basePlan,
			mcps: ["github", "linear"],
			mcpTools: { linear: [] },
		};
		const report = buildStatusReport({
			plan,
			discoveredMcpServers: ["github", "linear"],
			...emptyRuntime,
		});

		expect(report.mcpTools).toEqual([
			{ server: "github", policy: "unrestricted" },
			{ server: "linear", policy: "none", tools: [] },
		]);
		const markdown = formatStatusMarkdown(report);
		expect(markdown).toContain("github: unrestricted");
		expect(markdown).toContain("linear: no enabled MCP tools");
		expect(markdown).not.toMatch(/validation|tool.*missing|did you mean/i);
	});

	it("reports declared MCP names without validating them", () => {
		const report = buildStatusReport({
			plan: { ...basePlan, mcpTools: { github: ["serach"] } },
			discoveredMcpServers: ["github"],
			...emptyRuntime,
		});

		expect(report.mcpTools).toEqual([{ server: "github", policy: "restricted", tools: ["serach"] }]);
		expect(formatStatusMarkdown(report)).toContain("github: [serach]");
		expect(formatStatusMarkdown(report)).not.toMatch(/validation|tool.*missing|did you mean/i);
	});

	it("reports the glob delta versus the previous activation", () => {
		const report = buildStatusReport({
			plan: {
				...basePlan,
				previousResolved: {
					skills: ["code-review", "old-skill"],
					extensions: ["linter"],
					tools: ["read", "bash"],
					mcps: [],
				},
			},
			discoveredMcpServers: ["github"],
			...emptyRuntime,
		});

		expect(report.delta?.added).toContain("skill:debug");
		expect(report.delta?.added).toContain("mcp:github");
		expect(report.delta?.removed).toEqual(["skill:old-skill", "tool:bash"]);
	});

	it("reports same-name conflicts with Pi's actual winner, never blocking", () => {
		const report = buildStatusReport({
			plan: basePlan,
			discoveredMcpServers: [],
			...emptyRuntime,
			commands: [
				{ name: "skill:code-review", sourceInfo: { path: "/agent/skills/code-review/SKILL.md" } },
				{ name: "skill:debug", sourceInfo: { path: "/project/.pi/skills/debug/SKILL.md" } },
			],
		});

		expect(report.conflicts).toEqual([
			{
				name: "skill:debug",
				expectedPath: "/agent/skills/debug/SKILL.md",
				winnerPath: "/project/.pi/skills/debug/SKILL.md",
			},
		]);
	});

	it("flags resolved skills that never registered as not loaded", () => {
		const report = buildStatusReport({ plan: basePlan, discoveredMcpServers: [], ...emptyRuntime });
		expect(report.conflicts.map((conflict) => conflict.winnerPath)).toEqual(["not loaded", "not loaded"]);
	});

	it("reports subagent overrides as declared inputs and defaults missing observation to unconfirmed", () => {
		const declaration = { defaultModel: "provider/model", agentOverrides: { reviewer: { description: "Review code" } } };
		const report = buildStatusReport({
			plan: { ...basePlan, subagents: declaration },
			discoveredMcpServers: [],
			...emptyRuntime,
		});

		expect(report.subagents).toEqual({ declared: declaration, extension: "unconfirmed" });
		const markdown = formatStatusMarkdown(report);
		expect(markdown).toContain("profile-declared overrides");
		expect(markdown).toContain("not effective runtime mappings");
		expect(markdown).toContain("/subagents-models");
		expect(markdown).toContain("Review code");
	});

	it("includes native ownership observation only with a declaration", () => {
		const withDeclaration = buildStatusReport({
			plan: { ...basePlan, subagents: { defaultModel: "provider/model" } },
			subagentObservation: "detected",
			discoveredMcpServers: [],
			...emptyRuntime,
		});
		const withoutDeclaration = buildStatusReport({
			plan: basePlan,
			subagentObservation: "detected",
			discoveredMcpServers: [],
			...emptyRuntime,
		});

		expect(withDeclaration.subagents?.extension).toBe("detected");
		expect(Object.hasOwn(withoutDeclaration, "subagents")).toBe(false);
	});

	it("keeps the structured report shape unchanged without subagent declarations", () => {
		const report = buildStatusReport({ plan: basePlan, discoveredMcpServers: [], ...emptyRuntime });
		expect(Object.hasOwn(report, "subagents")).toBe(false);
	});

	it("keeps project-owned, non-disabled servers enabled when mcps is defined", () => {
		const report = buildStatusReport({
			plan: { ...basePlan, mcps: ["github"] },
			discoveredMcpServers: ["github", "linear", "proj-srv"],
			disabledMcpServers: [],
			projectMcpServers: ["proj-srv"],
			commands: [],
			tools: [],
		});

		expect(report.mcp).toEqual({
			enabled: ["github", "proj-srv"],
			disabled: ["linear"],
			missing: [],
		});
	});

	it("reports a project-owned server as enabled even with an empty mcps selection", () => {
		const report = buildStatusReport({
			plan: { ...basePlan, mcps: [] },
			discoveredMcpServers: ["github", "proj-srv"],
			disabledMcpServers: [],
			projectMcpServers: ["proj-srv"],
			commands: [],
			tools: [],
		});

		expect(report.mcp).toEqual({
			enabled: ["proj-srv"],
			disabled: ["github"],
			missing: [],
		});
	});

	it("treats a project-shadowed user-level server as project-owned and enabled", () => {
		const report = buildStatusReport({
			plan: { ...basePlan, mcps: [] },
			discoveredMcpServers: ["shared-shadowed"],
			disabledMcpServers: [],
			projectMcpServers: ["shared-shadowed"],
			commands: [],
			tools: [],
		});

		expect(report.mcp).toEqual({
			enabled: ["shared-shadowed"],
			disabled: [],
			missing: [],
		});
	});

	it("does not add disabled project servers to enabled when mcps is defined", () => {
		const report = buildStatusReport({
			plan: { ...basePlan, mcps: [] },
			discoveredMcpServers: ["github", "proj-srv"],
			disabledMcpServers: ["proj-srv"],
			projectMcpServers: ["proj-srv"],
			commands: [],
			tools: [],
		});

		expect(report.mcp).toEqual({
			enabled: [],
			disabled: ["github", "proj-srv"],
			missing: [],
		});
	});

	it("keeps existing behavior when projectMcpServers is omitted", () => {
		const report = buildStatusReport({
			plan: { ...basePlan, mcps: [] },
			discoveredMcpServers: ["github", "proj-srv"],
			disabledMcpServers: [],
			commands: [],
			tools: [],
		});

		expect(report.mcp).toEqual({
			enabled: [],
			disabled: ["github", "proj-srv"],
			missing: [],
		});
	});

	it("reports tool conflicts only when the winner is neither builtin nor a selected extension", () => {
		const tools = [
			{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
			{ name: "grep", sourceInfo: { path: "/other/extensions/sneaky.ts", source: "extension" } },
		];
		const report = buildStatusReport({ plan: basePlan, discoveredMcpServers: [], disabledMcpServers: [], commands: [], tools });

		expect(report.conflicts).toEqual([
			{ name: "skill:code-review", expectedPath: "/agent/skills/code-review/SKILL.md", winnerPath: "not loaded" },
			{ name: "skill:debug", expectedPath: "/agent/skills/debug/SKILL.md", winnerPath: "not loaded" },
			{ name: "tool:grep", expectedPath: "builtin or selected extension", winnerPath: "/other/extensions/sneaky.ts" },
		]);

		const withExtensionTool = buildStatusReport({
			plan: { ...basePlan, tools: ["lint-fix"] },
			discoveredMcpServers: [],
			disabledMcpServers: [],
			commands: [],
			tools: [{ name: "lint-fix", sourceInfo: { path: "/agent/extensions/linter.ts", source: "extension" } }],
		});
		expect(withExtensionTool.conflicts.map((conflict) => conflict.name)).toEqual(["skill:code-review", "skill:debug"]);
	});
});

describe("formatStatusMarkdown", () => {
	it("renders all sections readably", () => {
		const report = buildStatusReport({
			plan: basePlan,
			overlay: { disabledSkills: ["noisy"], disabledTools: ["bash", "mcp-*"] },
			discoveredMcpServers: ["github", "linear"],
			...emptyRuntime,
		});

		const markdown = formatStatusMarkdown(report);
		expect(markdown).toContain("profile: review (global)");
		expect(markdown).toContain("overlay: -skill:noisy -tool:bash -tool:mcp-*");
		expect(markdown).toContain("code-review → /agent/skills/code-review/SKILL.md");
		expect(markdown).toContain("mcp: enabled=[github] disabled=[linear]");
	});
});


describe("diagnostic status and dormant MCP policies", () => {
	it("includes skipped-reference diagnostics without claiming skipped resources are resolved", () => {
		const issue = { kind: "skill", code: "unknown-reference", reference: "missing", message: 'profile "review": missing skill; not loaded' };
		const report = buildStatusReport({ plan: { profile: "review", source: "global", resolved: { skills: [], extensions: [] }, diagnostics: [issue, { ...issue }] }, discoveredMcpServers: [], ...emptyRuntime });
		expect(report.skills).toEqual([]);
		expect(report.extensions).toEqual([]);
		expect(report.diagnostics).toEqual([issue]);
		expect(formatStatusMarkdown(report)).toContain(issue.message);
	});
	it("reports missing declarations lost from the effective selection and marks retained policies dormant", () => {
		const diagnostics = [{ kind: "mcp", code: "unknown-reference", reference: "missing-selection", message: "selection not loaded" }];
		const report = buildStatusReport({ plan: { profile: "review", source: "global", mcps: [], mcpTools: { missing: ["opaque"], disabled: [], project: ["opaque"] }, diagnostics }, discoveredMcpServers: ["disabled", "project"], disabledMcpServers: ["disabled"], projectMcpServers: ["project"], commands: [], tools: [] });
		expect(report.mcp).toEqual({ enabled: ["project"], disabled: ["disabled"], missing: ["missing", "missing-selection"] });
		expect(report.mcpTools).toContainEqual({ server: "missing", policy: "restricted", tools: ["opaque"], state: "missing" });
		expect(report.mcpTools).toContainEqual({ server: "disabled", policy: "none", tools: [], state: "disabled" });
		expect(report.mcpTools).toContainEqual({ server: "project", policy: "restricted", tools: ["opaque"], state: "project" });
		const text = formatStatusMarkdown(report);
		expect(text).toContain("missing: declared policy [opaque] (missing; not applied)");
		expect(text).toContain("disabled: declared policy [] (disabled; not applied)");
		expect(text).toContain("project: declared policy [opaque] (project-owned; not applied)");
		expect(text).not.toContain("disabled: no enabled MCP tools");
		expect(text).not.toContain("project: [opaque]");
	});
	it("never classifies missing or newly source-disabled selected names as enabled", () => {
		const report = buildStatusReport({ plan: { profile: "review", source: "global", mcps: ["missing", "disabled", "kept"] }, discoveredMcpServers: ["disabled", "kept"], disabledMcpServers: ["disabled"], commands: [], tools: [] });
		expect(report.mcp).toEqual({ enabled: ["kept"], disabled: ["disabled"], missing: ["missing"] });
	});
});


describe("retained activation knowledge before MCP reload", () => {
	it.each([{ code: "unknown-reference", state: "missing" }, { code: "disabled-server", state: "disabled" }] as const)("keeps a $state policy dormant after source changes until reload", ({ code, state }) => {
		const issue = { kind: "mcp-tools", code, reference: "late", message: "late policy was not applied this activation" };
		const plan = { profile: "policy", source: "global", mcpTools: { late: ["search"] }, diagnostics: [issue] };
		const input = { discoveredMcpServers: ["late", "native", "project"], disabledMcpServers: [], projectMcpServers: ["project"], commands: [], tools: [] };
		const beforeReload = buildStatusReport({ ...input, plan });
		expect(beforeReload.mcp.enabled).toEqual(["native", "project"]);
		expect(beforeReload.mcp.disabled).toContain("late");
		expect(beforeReload.mcpTools).toContainEqual({ server: "late", policy: "restricted", tools: ["search"], state });
		expect(formatStatusMarkdown(beforeReload)).toContain(`late: declared policy [search] (${state}; not applied)`);
		expect(beforeReload.diagnostics).toEqual([issue]);
		const afterReload = buildStatusReport({ ...input, plan: { ...plan, diagnostics: undefined } });
		expect(afterReload.mcp.enabled).toEqual(["late", "native", "project"]);
		expect(afterReload.mcpTools).toContainEqual({ server: "late", policy: "restricted", tools: ["search"] });
	});
	it("preserves older plans and native project precedence even with an old user-level miss", () => {
		const input = { discoveredMcpServers: ["late"], disabledMcpServers: [], commands: [], tools: [] };
		const plan = { profile: "policy", source: "global", mcpTools: { late: ["search"] } };
		expect(buildStatusReport({ ...input, plan }).mcp.enabled).toEqual(["late"]);
		const report = buildStatusReport({ ...input, projectMcpServers: ["late"], plan: { ...plan, diagnostics: [{ kind: "mcp-tools", code: "unknown-reference", reference: "late", message: "old user miss" }] } });
		expect(report.mcp.enabled).toEqual(["late"]);
		expect(report.mcpTools).toEqual([{ server: "late", policy: "restricted", tools: ["search"], state: "project" }]);
	});
});
