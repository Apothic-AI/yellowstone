import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLaunchPlan, readLaunchPlanFile, type PlanApplicationSurface } from "../src/switching/apply-plan.ts";

let root: string;
let runtimeDir: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-apply-"));
	runtimeDir = path.join(root, "runtime");
	await import("node:fs/promises").then((fs) => fs.mkdir(runtimeDir, { recursive: true }));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function writePlan(plan: unknown): Promise<void> {
	await writeFile(path.join(runtimeDir, "pi-profile.json"), JSON.stringify(plan));
}

interface FakeTool {
	name: string;
	sourceInfo?: { path?: string; source?: string };
}

interface FakeSurface extends PlanApplicationSurface {
	activeTools: string[];
	notifications: Array<{ message: string; level: string }>;
}

function fakeSurface(overrides?: { liveTools?: Array<string | FakeTool> }): FakeSurface {
	const notifications: Array<{ message: string; level: string }> = [];
	const surface: FakeSurface = {
		activeTools: [],
		notifications,
		getAllTools: () =>
			(overrides?.liveTools ?? ["read", "bash", "grep"]).map((t) =>
				typeof t === "string" ? { name: t } : t,
			),
		setActiveTools(names) {
			surface.activeTools = names;
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
	};
	return surface;
}

describe("applyLaunchPlan", () => {
	it("expands tool references against the live registry, including extension tools", async () => {
		await writePlan({ profile: "review", source: "global", tools: ["read"], toolReferences: ["read", "lint*"] });
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "bash", sourceInfo: { path: "<builtin:bash>", source: "builtin" } },
				{ name: "lint_check", sourceInfo: { path: "/agent/extensions/linter.ts", source: "extension" } },
			],
		});

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "lint_check"]);
	});

	it("does not keep a sibling extension tool when tools is empty", async () => {
		await writePlan({
			profile: "no-pi-tools",
			source: "global",
			tools: [],
			toolReferences: [],
			resolved: {
				skills: [],
				extensions: [
					{ id: "probe", entry: "/agent/extensions/probe.ts" },
					{ id: "linter", entry: "/agent/extensions/linter.ts" },
				],
			},
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "mcp", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
				{ name: "lint_check", sourceInfo: { path: "/agent/extensions/linter.ts", source: "extension" } },
				{ name: "probe_tool", sourceInfo: { path: "/agent/extensions/probe.ts", source: "extension" } },
			],
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["mcp"]);
		expect(result.warnings).toEqual([]);
	});

	it("does not classify sibling extension tools as MCP-owned", async () => {
		await writePlan({
			profile: "no-pi-tools",
			source: "global",
			tools: [],
			toolReferences: [],
			resolved: {
				skills: [],
				extensions: [
					{ id: "mcp-helper", entry: "/agent/extensions/mcp-helper.ts" },
					{ id: "linter", entry: "/agent/extensions/linter.ts" },
				],
			},
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "mcp", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
				{ name: "helper_tool", sourceInfo: { path: "/agent/extensions/mcp-helper.ts", source: "extension" } },
				{ name: "lint_check", sourceInfo: { path: "/agent/extensions/linter.ts", source: "extension" } },
			],
		});

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["mcp"]);
	});

	it("retains MCP-owned tools when tools narrows Pi tools to read-only", async () => {
		await writePlan({
			profile: "review",
			source: "global",
			tools: ["read"],
			toolReferences: ["read"],
			resolved: {
				skills: [],
				extensions: [],
			},
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "bash", sourceInfo: { path: "<builtin:bash>", source: "builtin" } },
				{ name: "mcp", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
				{ name: "search", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			],
		});

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		// Builtin 'read' is selected by tools, 'bash' is excluded, but MCP-owned tools are retained.
		expect(surface.activeTools).toEqual(["read", "mcp", "search"]);
	});

	it("retains native MCP discovery entry points when the plan marks gateways", async () => {
		await writePlan({
			profile: "review",
			source: "global",
			tools: ["read"],
			toolReferences: ["read"],
			mcpGateways: true,
			resolved: { skills: [], extensions: [] },
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "bash", sourceInfo: { path: "<builtin:bash>", source: "builtin" } },
				{ name: "codemode", sourceInfo: { path: "builtin:codemode", source: "builtin" } },
				{ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
				{ name: "lint_check", sourceInfo: { path: "/agent/extensions/linter.ts", source: "extension" } },
			],
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "codemode", "tool_search"]);
		expect(result.warnings).toEqual([]);
	});

	it("warns when a native MCP entry point did not register", async () => {
		await writePlan({
			profile: "review",
			source: "global",
			tools: ["read"],
			toolReferences: ["read"],
			mcpGateways: true,
			resolved: { skills: [], extensions: [] },
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
			],
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "tool_search"]);
		expect(result.warnings.some((warning) => warning.includes('MCP entry point "codemode" is unavailable'))).toBe(true);
	});

	it("does not use a same-named foreign tool as an MCP gateway", async () => {
		await writePlan({
			profile: "review",
			source: "global",
			tools: ["read"],
			toolReferences: ["read"],
			mcpGateways: true,
			resolved: { skills: [], extensions: [] },
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "codemode", sourceInfo: { path: "/agent/extensions/other.ts", source: "extension" } },
				{ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
			],
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "tool_search"]);
		expect(
			result.warnings.some(
				(warning) => warning.includes('MCP entry point "codemode" is registered by /agent/extensions/other.ts'),
			),
		).toBe(true);
	});

	it("an overlay disable of a gateway still wins", async () => {
		await writePlan({
			profile: "review",
			source: "global",
			tools: ["read"],
			toolReferences: ["read"],
			mcpGateways: true,
			disabledTools: ["codemode"],
			resolved: { skills: [], extensions: [] },
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "codemode", sourceInfo: { path: "builtin:codemode", source: "builtin" } },
				{ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
			],
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "tool_search"]);
		expect(result.warnings).toEqual([]);
	});

	it("warns about legacy MCP references and directs user to mcp_tools", async () => {
		await writePlan({
			profile: "review",
			source: "global",
			tools: ["read", "mcp__*"],
			toolReferences: ["read", "mcp__*", "mcp_direct"],
			resolved: {
				skills: [],
				extensions: [],
			},
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "mcp__search", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
				{ name: "mcp_direct", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			],
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		// MCP tools are retained via registration ownership, not via toolReferences
		expect(surface.activeTools).toEqual(["read", "mcp__search", "mcp_direct"]);
		// Legacy references receive actionable migration guidance naming mcp_tools
		expect(result.warnings.some((w) => w.includes("mcp__*") && w.includes("mcp_tools"))).toBe(true);
		expect(result.warnings.some((w) => w.includes("mcp_direct") && w.includes("mcp_tools"))).toBe(true);
	});

	it("respects winning registration sourceInfo on name collision", async () => {
		// When non-MCP wins a name, tools selects it without legacy MCP warning
		await writePlan({ profile: "test", source: "global", tools: ["search"], toolReferences: ["search"] });
		const surfaceNonMcp = fakeSurface({
			liveTools: [
				{ name: "search", sourceInfo: { path: "/agent/extensions/local-search.ts", source: "extension" } },
			],
		});
		const resultNonMcp = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface: surfaceNonMcp });
		expect(surfaceNonMcp.activeTools).toEqual(["search"]);
		expect(resultNonMcp.warnings).toEqual([]);

		// When MCP wins the name, tools does NOT select it as a Pi tool and warns with migration guidance
		await writePlan({ profile: "test", source: "global", tools: ["search"], toolReferences: ["search"] });
		const surfaceMcp = fakeSurface({
			liveTools: [
				{ name: "search", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			],
		});
		const resultMcp = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface: surfaceMcp });
		expect(surfaceMcp.activeTools).toEqual(["search"]); // retained as MCP tool
		expect(resultMcp.warnings.some((w) => w.includes("search") && w.includes("mcp_tools"))).toBe(true);
	});

	it("empty tools denies all Pi tools while retaining MCP tools", async () => {
		await writePlan({
			profile: "no-pi-tools",
			source: "global",
			tools: [],
			toolReferences: [],
			resolved: {
				skills: [],
				extensions: [],
			},
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "mcp", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			],
		});

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["mcp"]);
	});

	it("does not call setActiveTools when tools is undeclared and no overlay, even if mcpTools is present", async () => {
		await writePlan({
			profile: "default",
			source: "builtin",
			mcpTools: { github: ["search"] },
		});
		const surface = fakeSurface({
			liveTools: [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "mcp", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			],
		});

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		// setActiveTools was never called; activeTools remains empty
		expect(surface.activeTools).toEqual([]);
	});

	it("keeps unknown MCP names in the plan without tool-name warnings", async () => {
		await writePlan({
			profile: "github-restricted",
			source: "global",
			mcpTools: { github: ["serach"] },
		});
		const surface = fakeSurface();

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(result.warnings).toEqual([]);
	});

	it("subtracts the overlay's disabled tool entries from the base expansion at session start", async () => {
		await writePlan({
			profile: "review",
			source: "global",
			tools: ["read", "grep"],
			toolReferences: ["read", "bash", "grep"],
			disabledTools: ["bash"],
		});
		const surface = fakeSurface();

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "grep"]);
	});

	it("narrows the live registry at session start when the plan carries disabled tool entries without tool references", async () => {
		await writePlan({ profile: "default", source: "builtin", disabledTools: ["grep"] });
		const surface = fakeSurface();

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "bash"]);
	});

	it("keeps disabled tools disabled across reload: a glob entry re-expands against the live registry", async () => {
		await writePlan({ profile: "default", source: "builtin", disabledTools: ["gr*"] });
		const surface = fakeSurface({ liveTools: ["read", "bash", "grep", "graphene"] });

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "bash"]);
	});

	it("warns about a disabled tool entry the live registry no longer provides", async () => {
		await writePlan({ profile: "default", source: "builtin", disabledTools: ["vanished"] });
		const surface = fakeSurface();

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read", "bash", "grep"]);
		expect(result.warnings.some((warning) => warning.includes("vanished"))).toBe(true);
	});

	it("warns about literal tools no live tool provides instead of dropping them silently", async () => {
		await writePlan({ profile: "review", source: "global", tools: ["read"], toolReferences: ["read", "ghost-tool"] });
		const surface = fakeSurface();

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual(["read"]);
		expect(result.warnings.some((warning) => warning.includes("ghost-tool"))).toBe(true);
	});

	it("leaves tools untouched when the plan declares none", async () => {
		await writePlan({ profile: "default", source: "builtin" });
		const surface = fakeSurface();

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(surface.activeTools).toEqual([]);
	});

	it("persists the selection to the global state file on reload", async () => {
		const agentDir = path.join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writePlan({ profile: "impl", source: "global", agentDir, persistSelection: true });
		const surface = fakeSurface();

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		const state = JSON.parse(await readFile(path.join(agentDir, "pi-profile-state.json"), "utf8"));
		expect(state).toEqual({ activeProfile: "impl" });
	});

	it("persists project-sourced profiles to the project state file", async () => {
		const agentDir = path.join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writePlan({ profile: "impl", source: "project", agentDir, persistSelection: true });
		const surface = fakeSurface();

		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		const projectState = JSON.parse(await readFile(path.join(root, ".pi", "pi-profile-state.json"), "utf8"));
		expect(projectState.activeProfile).toBe("impl");
	});

	it("never writes state for launch-transient selections or at startup", async () => {
		const agentDir = path.join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writePlan({ profile: "impl", source: "global", agentDir });
		const surface = fakeSurface();
		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		await writePlan({ profile: "impl", source: "global", agentDir, persistSelection: true });
		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "startup", surface });

		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(agentDir, "pi-profile-state.json"))).toBe(false);
	});

	it("observes extension ownership only for declared subagent settings and warns non-fatally", async () => {
		await writePlan({ profile: "review", source: "global", subagents: { defaultModel: "provider/model" } });
		const surface = fakeSurface();
		const observations: string[] = [];
		const warnings: string[] = [];
		Object.assign(surface, {
			observeSubagents: async () => {
				observations.push("observed");
				return "unconfirmed";
			},
			notifySubagentWarning: (message: string) => warnings.push(message),
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(observations).toEqual(["observed"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('profile "review"');
		expect(warnings[0]).toContain("/subagents-models");
		expect(result.warnings).toEqual(warnings);
		expect(surface.activeTools).toEqual([]);
	});

	it("does not observe or warn about subagents without effective declarations", async () => {
		await writePlan({ profile: "review", source: "global" });
		const surface = fakeSurface();
		let observations = 0;
		const warnings: string[] = [];
		Object.assign(surface, {
			observeSubagents: async () => {
				observations += 1;
				return "unconfirmed";
			},
			notifySubagentWarning: (message: string) => warnings.push(message),
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(observations).toBe(0);
		expect(warnings).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("treats a failed ownership observation as unconfirmed and continues", async () => {
		await writePlan({ profile: "review", source: "global", subagents: { defaultModel: "provider/model" } });
		const surface = fakeSurface();
		const warnings: string[] = [];
		Object.assign(surface, {
			observeSubagents: async () => { throw new Error("metadata unavailable"); },
			notifySubagentWarning: (message: string) => warnings.push(message),
		});

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(result.warnings).toHaveLength(1);
		expect(warnings).toEqual(result.warnings);
	});

	it("returns a one-shot change summary and clears the marker", async () => {
		const agentDir = path.join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writePlan({ profile: "impl", source: "global", agentDir, switchedFrom: "review", tools: ["read"] });
		const surface = fakeSurface();

		const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });

		expect(result.summary).toContain("review → impl");
		expect(result.summary).toContain("tools: [read]");
		expect(surface.notifications.some((entry) => entry.message.includes("review → impl"))).toBe(true);
		const rewritten = JSON.parse(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8"));
		expect(rewritten.switchedFrom).toBeUndefined();
	});
});


describe("persisted activation diagnostics", () => {
	const issue = { kind: "extension", code: "unknown-reference", reference: "missing", message: 'profile "review": missing extension; not loaded' };
	it("reads older plans without diagnostics and retains additive diagnostics through marker clearing", async () => {
		await writePlan({ profile: "review", source: "global" });
		expect((await readLaunchPlanFile(runtimeDir))?.diagnostics).toBeUndefined();
		await writePlan({ profile: "review", source: "global", diagnostics: [issue], switchedFrom: "default" });
		await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface: fakeSurface() });
		expect((await readLaunchPlanFile(runtimeDir))?.diagnostics).toEqual([issue]);
	});
	it("emits each diagnostic once on reload but not again on startup/new/resume", async () => {
		await writePlan({ profile: "review", source: "global", diagnostics: [issue, { ...issue }] });
		for (const reason of ["startup", "new", "resume"]) {
			const surface = fakeSurface();
			await applyLaunchPlan({ runtimeDir, cwd: root, reason, surface });
			expect(surface.notifications).toEqual([]);
		}
		for (let activation = 0; activation < 2; activation++) {
			const surface = fakeSurface();
			const result = await applyLaunchPlan({ runtimeDir, cwd: root, reason: "reload", surface });
			expect(result.warnings).toEqual([issue.message]);
			expect(surface.notifications).toEqual([{ message: issue.message, level: "warning" }]);
		}
	});
});
