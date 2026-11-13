import { describe, expect, it, vi } from "vitest";

import type { LaunchPlanFile } from "../src/switching/apply-plan.ts";
import type { ProfileComposition } from "../src/profile-composition.ts";
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

/**
 * FT54 S2 §7 — status renders composition truth from the ACTIVE PLAN only.
 *
 * The recorded Markdown below is the pre-change output for the same plan,
 * captured at the accepted S1 tip (`2ae6f74e…`) before any S2 edit. An
 * activation without composition must still render it byte-for-byte.
 */
const RECORDED_PRE_CHANGE_STATUS = `### profile: capture (global)
skills:
  alpha → /agent/skills/alpha/SKILL.md
extensions:
  local-ext → /agent/extensions/local-ext.ts
tools: [read]
mcp: enabled=[github] disabled=[] missing=[]
mcp tools:
  github: unrestricted
unmatched (zero-match globs this resolution): [skill:nope-*]
conflict: skill:alpha — plan resolved /agent/skills/alpha/SKILL.md, Pi registered not loaded (Pi first-wins load order)`;

const fsCalls = vi.hoisted(() => ({ read: 0, write: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: (...args: Parameters<typeof actual.readFile>) => {
			fsCalls.read += 1;
			return actual.readFile(...args);
		},
		writeFile: (...args: Parameters<typeof actual.writeFile>) => {
			fsCalls.write += 1;
			return actual.writeFile(...args);
		},
	};
});

const baseComposition: ProfileComposition = {
	strategy: "append",
	branch: "composed",
	globalPath: "/global/leader.json",
	projectPath: "/project/.pi/profiles/leader.json",
	referenceContributors: { skills: {}, extensions: {}, mcps: {}, tools: {} },
	unapplied: [],
	diagnostics: [],
};

const composedPlan = (overrides: Partial<LaunchPlanFile> = {}): LaunchPlanFile => ({
	profile: "leader",
	source: "project",
	resolved: {
		skills: [{ name: "alpha", filePath: "/agent/skills/alpha/SKILL.md" }],
		extensions: [{ id: "linter", entry: "/agent/extensions/linter.ts" }],
	},
	tools: ["read"],
	composition: baseComposition,
	resourceSelection: { skills: true, extensions: false },
	...overrides,
});

describe("status composition rendering (FT54 S2 §7)", () => {
	const statusInput = {
		discoveredMcpServers: [],
		disabledMcpServers: [],
		commands: [],
		tools: [],
	};

	it("names the strategy, both paths, and per-kind intent", () => {
		const report = buildStatusReport({ plan: composedPlan(), ...statusInput });
		const markdown = formatStatusMarkdown(report);

		expect(markdown).toContain("composition: append (composed)");
		expect(markdown).toContain("base: /global/leader.json");
		expect(markdown).toContain("project: /project/.pi/profiles/leader.json");
		expect(markdown).toContain("intent: skills=declared extensions=native mcps=native tools=declared");
		expect(report.intent).toEqual({ skills: true, extensions: false, mcps: false, tools: true });
	});

	it("reports both contributors and keeps native identities unattributed", () => {
		const report = buildStatusReport({
			plan: composedPlan({
				origins: { skills: { alpha: "both", beta: "native" } },
				extensionOrigins: { "/agent/extensions/linter.ts": { id: "linter", contributors: "project" } },
			}),
			...statusInput,
		});
		const markdown = formatStatusMarkdown(report);

		expect(markdown).toContain("alpha → /agent/skills/alpha/SKILL.md (contributors: both)");
		expect(markdown).toContain("linter → /agent/extensions/linter.ts (contributors: project)");
		expect(markdown).toContain("contributors: skills alpha=both; extensions linter=project");
		expect(markdown).toContain("native (selected through no declaration): skills [beta]");
		// A native identity never acquires a fabricated scope contributor.
		expect(markdown).not.toContain("beta=global");
		expect(markdown).not.toContain("beta=project");
	});

	it("describes an unrestricted kind honestly with its unapplied references and their file", () => {
		const report = buildStatusReport({
			plan: composedPlan({
				resourceSelection: { skills: true, extensions: false },
				origins: { skills: { alpha: "global" } },
				composition: { ...baseComposition, unapplied: [{ kind: "skills", reference: "review", scope: "project" }] },
			}),
			...statusInput,
		});
		const markdown = formatStatusMarkdown(report);

		expect(markdown).toContain("extensions=native");
		expect(markdown).toContain(
			'unapplied: skills "review" (declared by /project/.pi/profiles/leader.json; not applied, not validated)',
		);
		// Unapplied references are static, never validated or reported as unknown.
		expect(markdown).not.toMatch(/unknown|did you mean/i);
	});

	it("reports a standalone append as informational, not as a failure", () => {
		const report = buildStatusReport({
			plan: composedPlan({
				resourceSelection: { skills: true, extensions: true },
				composition: {
					...baseComposition,
					branch: "standalone",
					globalPath: undefined,
					unapplied: [],
					diagnostics: [{ code: "append-standalone", message: "no base" }],
				},
			}),
			...statusInput,
		});
		const markdown = formatStatusMarkdown(report);

		expect(markdown).toContain("composition: append (standalone)");
		expect(markdown).toContain("no global base: the project definition applies on its own (informational, not a failure)");
		expect(markdown).not.toContain("unapplied:");
		expect(markdown).not.toMatch(/failed|failure:/i);
		expect(report.composition?.branch).toBe("standalone");
	});

	it("never conflates boot-pending references with resolved or claimed per-tool contributors", () => {
		const report = buildStatusReport({
			plan: composedPlan({
				tools: ["read"],
				toolOrigins: { read: { contributors: "global", state: "resolved", at: "boot" } },
				pendingToolReferences: [{ reference: "lint-fix", contributors: "both", resolvesAt: "session-start" }],
			}),
			...statusInput,
		});
		const markdown = formatStatusMarkdown(report);

		expect(markdown).toContain("tools: [read]");
		expect(markdown).toContain(
			'tools awaiting session start: "lint-fix" (both) — boot-snapshot pending; current session outcome not recorded (UNKNOWN)',
		);
		// No resolved per-tool contributor and no current outcome is claimed.
		expect(markdown).not.toContain("read=global");
		expect(markdown).not.toMatch(/lint-fix (is |was )?(currently |now )?(pending|resolved|selected|existing)/i);
		expect(Object.hasOwn(report, "toolOrigins")).toBe(false);
	});

	it("performs no additional definition read, write, or reapproval call", async () => {
		fsCalls.read = 0;
		fsCalls.write = 0;
		const report = buildStatusReport({
			plan: composedPlan({
				origins: { skills: { alpha: "both" } },
				extensionOrigins: { "/agent/extensions/linter.ts": { id: "linter", contributors: "both" } },
				pendingToolReferences: [{ reference: "lint-fix", contributors: "both", resolvesAt: "session-start" }],
			}),
			...statusInput,
		});
		formatStatusMarkdown(report);
		expect(fsCalls.read).toBe(0);
		expect(fsCalls.write).toBe(0);

		// Static surface: the module imports no filesystem or catalog reader.
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		const source = await actual.readFile("src/switching/status.ts", "utf8");
		expect(source).not.toMatch(/from "node:fs/);
		expect(source).not.toMatch(/profile-catalog\.ts"|extension-discovery\.ts"/);
	});

	it("produces byte-equivalent output for an activation without composition", () => {
		const report = buildStatusReport({
			plan: {
				profile: "capture",
				source: "global",
				resolved: {
					skills: [{ name: "alpha", filePath: "/agent/skills/alpha/SKILL.md" }],
					extensions: [{ id: "local-ext", entry: "/agent/extensions/local-ext.ts" }],
				},
				tools: ["read"],
				mcps: ["github"],
				unmatched: ["skill:nope-*"],
			},
			discoveredMcpServers: ["github"],
			disabledMcpServers: [],
			commands: [],
			tools: [],
		});
		expect(formatStatusMarkdown(report)).toBe(RECORDED_PRE_CHANGE_STATUS);
		expect(Object.keys(report)).toEqual([
			"profile",
			"source",
			"overlay",
			"skills",
			"extensions",
			"tools",
			"mcp",
			"mcpTools",
			"unmatched",
			"conflicts",
		]);
	});
});
