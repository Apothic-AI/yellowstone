import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedProfile } from "../src/profile-catalog.ts";
import { ActivationError, resolveProfile } from "../src/profile-resolver.ts";
import { DiscoveredExtensions, discoverExtensions } from "../src/extension-discovery.ts";
import { loadMergedMcpServers, type MergedMcpResult } from "../src/mcp-config.ts";
import type { SkillEntry } from "../src/skill-registry.ts";
import { resolveModelProfileInNode } from "./helpers/model-profile-runner.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function skill(name: string): SkillEntry {
	return {
		name,
		filePath: path.join(fixture.agentDir, "skills", name, "SKILL.md"),
		source: "auto",
		scope: "user",
		origin: "top-level",
	};
}

function profile(name: string, definition: ResolvedProfile["definition"]): ResolvedProfile {
	return { name, source: "global", definition };
}

async function extensionsWith(names: string[] = []): Promise<DiscoveredExtensions> {
	const extensionsDir = path.join(fixture.agentDir, "extensions");
	await mkdir(extensionsDir, { recursive: true });
	for (const name of names) {
		const entry = path.join(extensionsDir, `${name}.ts`);
		await writeFile(entry, "export default function () {}\n");
	}
	return discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
}

describe("resolveProfile", () => {
	it("carries child settings verbatim without parent-model validation or resource selection", async () => {
		const subagents = { defaultModel: "provider/model:high", agentOverrides: { unknownRole: { model: "inherit" } } };
		const plan = await resolveProfile({
			profile: profile("review", { subagents }), skills: [], extensions: await extensionsWith(),
		});
		expect(plan.subagents).toEqual(subagents);
		expect(plan.extensions).toEqual([]);
		expect(plan.tools).toBeUndefined();
		expect(plan.model).toBeUndefined();
		expect(plan.resourceSelection).toEqual({ skills: false, extensions: false });
	});

	it("expands literal and glob skill references against the registry, deduped", async () => {
		const skills = [skill("code-review"), skill("git-commit"), skill("research-web"), skill("research-docs")];

		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review", "research-*", "git-commit"] }),
			skills,
			extensions: await extensionsWith(),
		});

		expect(plan.skills.map((entry) => entry.name).sort()).toEqual([
			"code-review",
			"git-commit",
			"research-docs",
			"research-web",
		]);
	});

	it("skips a missing literal skill with actionable diagnostics", async () => {
		const plan = await resolveProfile({ profile: profile("review", { skills: ["no-such-skill"] }), skills: [skill("code-review")], extensions: await extensionsWith() });
		expect(plan.skills).toEqual([]);
		expect(plan.filter).toBe("selection");
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ kind: "skill", reference: "no-such-skill", message: expect.stringContaining('profile "review"') }));
		expect(plan.diagnostics?.[0].message).toContain("not loaded");
		expect(plan.diagnostics?.[0].message).toContain("code-review");
	});

	it("treats a glob with no current matches as empty, not an error", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["future-*"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
		});

		expect(plan.skills).toEqual([]);
	});

	it("resolves multiple declared extensions directly without dependencies", async () => {
		const extensions = await extensionsWith(["review-guard", "audit-log", "unrelated"]);

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["review-guard", "audit-log"] }),
			skills: [],
			extensions,
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["audit-log", "review-guard"]);
	});

	it("expands extension globs against discovered extensions", async () => {
		const extensions = await extensionsWith(["github-pr", "github-ci", "other"]);

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["github-*"] }),
			skills: [],
			extensions,
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["github-ci", "github-pr"]);
	});

	it("skips a missing literal extension with diagnostics", async () => {
		const plan = await resolveProfile({ profile: profile("review", { extensions: ["ghost"] }), skills: [], extensions: await extensionsWith() });
		expect(plan.extensions).toEqual([]);
		expect(plan.filter).toBe("selection");
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ kind: "extension", reference: "ghost", message: expect.stringContaining('profile "review"') }));
		expect(plan.diagnostics?.[0].message).toContain("not loaded");
	});

	it("passes literal tool names through and expands tool globs against Pi's built-in tools", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { tools: ["read", "search_issues", "gre*"] }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.tools).toEqual(["read", "search_issues", "grep"]);
	});

	it("keeps loose extension entries distinct for runtime attribution", async () => {
		const extensions = await extensionsWith(["probe", "linter"]);
		const probeEntry = path.join(fixture.agentDir, "extensions", "probe.ts");
		const linterEntry = path.join(fixture.agentDir, "extensions", "linter.ts");

		const plan = await resolveProfile({
			profile: profile("lint", { extensions: ["probe", "linter"], tools: ["lint_*"] }),
			skills: [],
			extensions,
		});

		expect(plan.extensions).toEqual([
			{ id: "probe", entry: probeEntry },
			{ id: "linter", entry: linterEntry },
		]);
		expect(plan.toolReferences).toEqual(["lint_*"]);
	});

	it("keeps the raw tool references for extension-side expansion", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { tools: ["read", "mcp__*"] }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.toolReferences).toEqual(["read", "mcp__*"]);
	});

	it("leaves tools, model, and instructions out of the plan when undeclared", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
		});

		expect(plan.tools).toBeUndefined();
		expect(plan.model).toBeUndefined();
		expect(plan.instructions).toBeUndefined();
	});

	it("carries a declared model without standalone validation", async () => {
		const plan = await resolveModelProfileInNode({ defaultProvider: "extension-provider", defaultModel: "local-model", defaultThinkingLevel: "high" });
		expect(plan.model).toEqual({ provider: "extension-provider", id: "local-model", thinkingLevel: "high" });
		expect(plan.diagnostics).toBeUndefined();
	});

	it("preserves a complete declaration even without a static registry or credentials", async () => {
		const plan = await resolveProfile({ profile: profile("review", { defaultProvider: "unknown-provider", defaultModel: "unknown-model" }), skills: [], extensions: await extensionsWith() });
		expect(plan.model).toEqual({ provider: "unknown-provider", id: "unknown-model" });
		expect(plan.diagnostics).toBeUndefined();
	});

	it("warns and omits only an unsupported thinking contribution", async () => {
		const plan = await resolveModelProfileInNode({ defaultProvider: "extension-provider", defaultModel: "local-model", defaultThinkingLevel: "extreme" });
		expect(plan.model).toEqual({ provider: "extension-provider", id: "local-model" });
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ kind: "thinking", reference: "extreme", message: expect.stringContaining('profile "review"') }));
		expect(plan.diagnostics?.[0].message).toContain("ignored");
	});

	it.each([{}, { defaultThinkingLevel: "extreme" }, { defaultProvider: "provider", defaultThinkingLevel: "extreme" }, { defaultModel: "model", defaultThinkingLevel: "extreme" }])("ignores thinking without a complete model declaration %j", async (definition) => {
		const plan = await resolveProfile({ profile: profile("review", definition), skills: [], extensions: await extensionsWith() });
		expect(plan.model).toBeUndefined();
		expect(plan.diagnostics).toBeUndefined();
	});

	it("expands mcp references against the discovered server names", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { mcps: ["github", "internal-*"] }),
			skills: [],
			extensions: await extensionsWith(),
			discoveredMcpServers: ["github", "internal-docs", "internal-ci", "other"],
		});

		expect(plan.mcps).toEqual(["github", "internal-docs", "internal-ci"]);
	});

	it("warns on a literal mcp reference the snapshot never discovered", async () => {
		const plan = await resolveProfile({
				profile: profile("review", { mcps: ["github-ro"] }),
				skills: [],
				extensions: await extensionsWith(),
				discoveredMcpServers: ["github"],
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/unknown MCP server: "github-ro" \(usable candidates: github\)/);
	});

	it("names usable user-level candidates when an mcps reference is unknown", async () => {
		const mcpDiscovery: MergedMcpResult = {
			servers: {
				github: { url: "https://gh" },
				linear: { command: "linear", enabled: false },
				"proj-srv": { url: "https://proj" },
			},
			sharedServers: new Set(["github", "linear"]),
			projectServers: new Set(["proj-srv"]),
			serverOwners: { github: "user", linear: "user", "proj-srv": "project" },
		};

		const plan = await resolveProfile({
				profile: profile("review", { mcps: ["typo"] }),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/unknown MCP server: "typo" \(usable candidates: github\)/);
	});

	it("states no user-level servers when an unknown mcps reference has no candidates", async () => {
		const mcpDiscovery: MergedMcpResult = {
			servers: { "proj-srv": { url: "https://proj" } },
			sharedServers: new Set(),
			projectServers: new Set(["proj-srv"]),
			serverOwners: { "proj-srv": "project" },
		};

		const plan = await resolveProfile({
				profile: profile("review", { mcps: ["typo"] }),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/unknown MCP server: "typo" \(no user-level servers are discovered\)/);
	});

	it("fails activation when mcp is declared without server discovery", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { mcps: ["github"] }),
				skills: [],
				extensions: await extensionsWith(),
			}),
		).rejects.toThrow(/no MCP server discovery is available/);
	});

	it("warns when mcps selects a server disabled in its winning definition", async () => {
		const mcpDiscovery: MergedMcpResult = {
			servers: { github: { url: "https://gh", enabled: false } },
			sharedServers: new Set(),
			projectServers: new Set(),
			serverOwners: { github: "user" },
		};

		const plan = await resolveProfile({
				profile: profile("review", { mcps: ["github"] }),
				skills: [],
				extensions: await extensionsWith(),
				discoveredMcpServers: ["github"],
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/selected MCP server "github" is disabled in its source configuration/);
	});

	it("hands selected transport definitions to native Pi unchanged", async () => {
		const definition = { type: "sse", url: "http://localhost:3000/sse", headers: { fixture: "kept" } };
		const mcpDiscovery: MergedMcpResult = { servers: { github: definition }, sharedServers: new Set(), projectServers: new Set(), serverOwners: { github: "user" } };
		const plan = await resolveProfile({ profile: profile("review", { mcps: ["github"] }), skills: [], extensions: await extensionsWith(), mcpDiscovery });
		expect(plan.mcps).toEqual(["github"]);
		expect(plan.instanceMcpConfig?.mcpServers).toEqual({ github: definition });
		expect(plan.diagnostics).toBeUndefined();
	});

	it("passes an unselected SSE server through without failing activation", async () => {
		const mcpDiscovery: MergedMcpResult = {
			servers: { github: { type: "sse", url: "http://localhost:3000/sse" } },
			sharedServers: new Set(),
			projectServers: new Set(),
			serverOwners: { github: "user" },
		};

		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
			discoveredMcpServers: ["github"],
			mcpDiscovery,
		});

		expect(plan.mcps).toBeUndefined();
		expect(plan.instanceMcpConfig).toBeUndefined();
	});

	it("warns when mcps names a project-owned server", async () => {
		const mcpDiscovery: MergedMcpResult = {
			servers: { github: { url: "https://gh" }, "proj-srv": { url: "https://proj" } },
			sharedServers: new Set(["github"]),
			projectServers: new Set(["proj-srv"]),
			serverOwners: { github: "user", "proj-srv": "project" },
		};

		const plan = await resolveProfile({
				profile: profile("review", { mcps: ["github", "proj-srv"] }),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/cannot select project-level MCP server "proj-srv"/);
	});

	it("a non-empty mcps selection does not materialize project-owned servers", async () => {
		const mcpDiscovery: MergedMcpResult = {
			servers: {
				github: { url: "https://gh" },
				linear: { command: "linear" },
				"proj-srv": { url: "https://proj" },
			},
			sharedServers: new Set(["github", "linear"]),
			projectServers: new Set(["proj-srv"]),
			serverOwners: { github: "user", linear: "user", "proj-srv": "project" },
		};

		const plan = await resolveProfile({
			profile: profile("review", { mcps: ["github"] }),
			skills: [],
			extensions: await extensionsWith(),
			mcpDiscovery,
		});

		expect(plan.mcps).toEqual(["github"]);
		expect(plan.instanceMcpConfig).toEqual({
			mcpServers: { github: { url: "https://gh" }, linear: { command: "linear", enabled: false } },
		});
	});

	it("carries declared instructions into the plan", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { instructions: "Be picky." }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.instructions).toBe("Be picky.");
	});

	describe("empty mcps selection", () => {
		function mockMcpDiscovery(options: {
			servers?: Record<string, Record<string, unknown>>;
			sharedServers?: string[];
			projectServers?: string[];
			serverOwners?: Record<string, "user" | "project">;
			baseConfig?: Record<string, unknown>;
		} = {}): MergedMcpResult {
			const servers = options.servers ?? {
				github: { url: "https://gh" },
				linear: { command: "linear" },
			};
			const sharedServers = new Set(options.sharedServers ?? ["github"]);
			const projectServers = new Set(options.projectServers ?? []);
			const serverOwners: Record<string, "user" | "project"> = options.serverOwners ?? {};
			for (const s of Object.keys(servers)) {
				if (!Object.hasOwn(serverOwners, s)) {
					serverOwners[s] = projectServers.has(s) ? "project" : "user";
				}
			}
			return { servers, sharedServers, projectServers, serverOwners, baseConfig: options.baseConfig };
		}

		it("retains an empty mcps array as an empty selection", async () => {
			const plan = await resolveProfile({
				profile: profile("review", { mcps: [] }),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery: mockMcpDiscovery({ servers: { github: { url: "https://gh" } }, sharedServers: ["github"] }),
			});

			expect(plan.mcps).toEqual([]);
			expect((plan.instanceMcpConfig?.mcpServers as Record<string, unknown>)?.github).toEqual({ url: "https://gh", enabled: false });
		});

		it("fails activation for empty mcps without MCP discovery", async () => {
			await expect(
				resolveProfile({
					profile: profile("review", { mcps: [] }),
					skills: [],
					extensions: await extensionsWith(),
				}),
			).rejects.toThrow(/empty MCP server selection but no MCP server discovery/);
		});

		it("retains an empty mcps selection when discovery finds no servers", async () => {
			const plan = await resolveProfile({
				profile: profile("review", { mcps: [] }),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery: mockMcpDiscovery({ servers: {}, sharedServers: [], projectServers: [] }),
			});

			expect(plan.mcps).toEqual([]);
			expect(plan.instanceMcpConfig).toEqual({ mcpServers: {} });
		});

		it("an empty mcps selection disables shared user servers but keeps project servers enabled", async () => {
			const plan = await resolveProfile({
				profile: profile("review", { mcps: [] }),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery: mockMcpDiscovery({
					servers: { github: { url: "https://gh" }, "proj-srv": { url: "https://proj" } },
					sharedServers: ["github"],
					projectServers: ["proj-srv"],
				}),
			});

			expect(plan.mcps).toEqual([]);
			expect(plan.instanceMcpConfig).toEqual({
				mcpServers: { github: { url: "https://gh", enabled: false } },
			});
		});
	});
});

describe("overlay application (ticket 06)", () => {
	it("narrows resolved skills by disabledSkills", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review", "debug"] }),
			skills: [skill("code-review"), skill("debug")],
			extensions: await extensionsWith(),
			overlay: { disabledSkills: ["debug"] },
		});

		expect(plan.skills.map((entry) => entry.name)).toEqual(["code-review"]);
	});

	it("rejects disabling a skill the profile does not resolve", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { skills: ["code-review"] }),
				skills: [skill("code-review")],
				extensions: await extensionsWith(),
				overlay: { disabledSkills: ["ghost-skill"] },
			}),
		).rejects.toThrow(/overlay disables unknown skill "ghost-skill"/);
	});

	it("narrows extensions by disabledExtensions", async () => {
		const extensions = await extensionsWith(["linter", "helper"]);

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["linter", "helper"] }),
			skills: [],
			extensions,
			overlay: { disabledExtensions: ["helper"] },
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["linter"]);
	});

	it("rejects disabling an extension the profile does not resolve", async () => {
		const extensions = await extensionsWith(["linter"]);

		await expect(
			resolveProfile({
				profile: profile("review", { extensions: ["linter"] }),
				skills: [],
				extensions,
				overlay: { disabledExtensions: ["ghost-ext"] },
			}),
		).rejects.toThrow(/overlay disables unknown extension "ghost-ext"/);
	});

	it("narrows mcp servers and tools by disabled entries", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { mcps: ["github", "linear"], tools: ["read", "bash"] }),
			skills: [],
			extensions: await extensionsWith(),
			discoveredMcpServers: ["github", "linear"],
			liveToolNames: ["read", "bash", "grep"],
			overlay: { disabledMcps: ["linear"], disabledTools: ["bash"] },
		});

		expect(plan.mcps).toEqual(["github"]);
		expect(plan.tools).toEqual(["read"]);
		expect(plan.toolReferences).toEqual(["read", "bash"]);
		expect(plan.disabledTools).toEqual(["bash"]);
	});

	it("a tool disable removes a matching tool from the live-registry base on a profile without declared tools", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
			liveToolNames: ["read", "bash", "grep"],
			overlay: { disabledTools: ["bash"] },
		});

		expect(plan.tools).toBeUndefined();
		expect(plan.toolReferences).toBeUndefined();
		expect(plan.disabledTools).toEqual(["bash"]);
	});

	it("rejects disabling a tool the profile does not resolve", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { skills: ["code-review"], tools: ["read", "bash"] }),
				skills: [skill("code-review")],
				extensions: await extensionsWith(),
				liveToolNames: ["read", "bash"],
				overlay: { disabledTools: ["ghost-tool"] },
			}),
		).rejects.toThrow(/overlay disables unknown tool "ghost-tool"/);
	});

	it("lands a zero-match tool glob disable in unmatched with an overlay prefix instead of failing", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"], tools: ["read", "bash"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
			liveToolNames: ["read", "bash"],
			overlay: { disabledTools: ["ghost-*"] },
		});

		expect(plan.tools).toEqual(["read", "bash"]);
		expect(plan.disabledTools).toEqual(["ghost-*"]);
		expect(plan.unmatched).toEqual(["overlay tool:ghost-*"]);
	});

	it("narrows tools by a glob disable entry against the declared references", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { tools: ["read", "grep", "find"] }),
			skills: [],
			extensions: await extensionsWith(),
			liveToolNames: ["read", "grep", "find", "ls"],
			overlay: { disabledTools: ["gr*"] },
		});

		expect(plan.tools).toEqual(["read", "find"]);
		expect(plan.toolReferences).toEqual(["read", "grep", "find"]);
		expect(plan.disabledTools).toEqual(["gr*"]);
	});

	it("fails a tool disable when no live tool registry is available", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { skills: ["code-review"] }),
				skills: [skill("code-review")],
				extensions: await extensionsWith(),
				overlay: { disabledTools: ["bash"] },
			}),
		).rejects.toThrow(/overlay disables tools but no live tool registry is available/);
	});

	it("an undeclared profile with an overlay that disables nothing yields no tools field", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
			liveToolNames: ["read", "bash"],
			overlay: { disabledSkills: ["code-review"] },
		});

		expect(plan.tools).toBeUndefined();
		expect(plan.disabledTools).toBeUndefined();
	});

	it("narrows resolved skills by a glob disable entry", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review", "git-commit", "git-rebase"] }),
			skills: [skill("code-review"), skill("git-commit"), skill("git-rebase")],
			extensions: await extensionsWith(),
			overlay: { disabledSkills: ["git-*"] },
		});

		expect(plan.skills.map((entry) => entry.name)).toEqual(["code-review"]);
	});

	it("narrows resolved extensions by a glob disable entry", async () => {
		const extensions = await extensionsWith(["linter", "github-pr", "github-ci"]);

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["linter", "github-pr", "github-ci"] }),
			skills: [],
			extensions,
			overlay: { disabledExtensions: ["github-*"] },
		});

		expect(plan.extensions.map((entry) => entry.id)).toEqual(["linter"]);
	});

	it("narrows resolved MCP servers by a glob disable entry", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { mcps: ["github", "linear", "linter-docs"] }),
			skills: [],
			extensions: await extensionsWith(),
			discoveredMcpServers: ["github", "linear", "linter-docs"],
			overlay: { disabledMcps: ["linear", "linter-*"] },
		});

		expect(plan.mcps).toEqual(["github"]);
	});

	it("lands a zero-match glob disable in unmatched with an overlay prefix instead of failing", async () => {
		const skills = [skill("code-review")];
		const extensions = await extensionsWith(["linter"]);

		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"], extensions: ["linter"], mcps: ["github"] }),
			skills,
			extensions,
			discoveredMcpServers: ["github"],
			overlay: { disabledSkills: ["ghost-*"], disabledExtensions: ["ghost-*"], disabledMcps: ["ghost-*"] },
		});

		expect(plan.skills.map((entry) => entry.name)).toEqual(["code-review"]);
		expect(plan.extensions.map((entry) => entry.id)).toEqual(["linter"]);
		expect(plan.mcps).toEqual(["github"]);
		expect(plan.unmatched).toEqual([
			"overlay skill:ghost-*",
			"overlay extension:ghost-*",
			"overlay mcp:ghost-*",
		]);
	});

	it("a zero-match MCP glob disable on a profile without declared mcps stays unrestricted and warns", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
			overlay: { disabledMcps: ["ghost-*"] },
		});

		expect(plan.mcps).toBeUndefined();
		expect(plan.unmatched).toEqual(["overlay mcp:ghost-*"]);
	});

	it("a literal MCP disable on a profile without declared mcps still fails identifying the entry", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { skills: ["code-review"] }),
				skills: [skill("code-review")],
				extensions: await extensionsWith(),
				overlay: { disabledMcps: ["github"] },
			}),
		).rejects.toThrow(/overlay disables unknown MCP server "github"/);
	});

	it("rejects disabling an MCP server the profile does not resolve", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { mcps: ["github"] }),
				skills: [],
				extensions: await extensionsWith(),
				discoveredMcpServers: ["github"],
				overlay: { disabledMcps: ["ghost-server"] },
			}),
		).rejects.toThrow(/overlay disables unknown MCP server "ghost-server"/);
	});
});

describe("sparse skill and extension selection (fix-undeclared-resource-filtering)", () => {
	it("an omitted skills field keeps the full discovery result as its overlay vocabulary", async () => {
		const skills = [skill("alpha-skill"), skill("beta-skill")];
		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["linter"] }),
			skills,
			extensions: await extensionsWith(["linter"]),
		});

		expect(plan.resourceSelection).toEqual({ skills: false, extensions: true });
		expect(plan.skills.map((entry) => entry.name).sort()).toEqual(["alpha-skill", "beta-skill"]);
		expect(plan.extensions.map((entry) => entry.id)).toEqual(["linter"]);
	});

	it("an omitted extensions field keeps the full discovery result as its overlay vocabulary", async () => {
		const extensions = await extensionsWith(["linter", "helper"]);
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["alpha-skill"] }),
			skills: [skill("alpha-skill"), skill("beta-skill")],
			extensions,
		});

		expect(plan.resourceSelection).toEqual({ skills: true, extensions: false });
		expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["helper", "linter"]);
	});

	it("an explicit empty selection stays restrictive and is distinguishable from omission", async () => {
		const extensions = await extensionsWith(["linter"]);
		const plan = await resolveProfile({
			profile: profile("review", { skills: [], extensions: [] }),
			skills: [skill("alpha-skill")],
			extensions,
		});

		expect(plan.resourceSelection).toEqual({ skills: true, extensions: true });
		expect(plan.skills).toEqual([]);
		expect(plan.extensions).toEqual([]);
	});

	it("a declared skill list narrows skills only and leaves extensions at native visibility", async () => {
		const extensions = await extensionsWith(["linter", "helper"]);
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["alpha-skill"] }),
			skills: [skill("alpha-skill"), skill("beta-skill")],
			extensions,
		});

		expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["helper", "linter"]);
	});

	it("a declared extension list narrows extensions only and leaves skills at native visibility", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["linter"] }),
			skills: [skill("alpha-skill"), skill("beta-skill")],
			extensions: await extensionsWith(["linter", "helper"]),
		});

		expect(plan.extensions.map((entry) => entry.id)).toEqual(["linter"]);
		expect(plan.skills.map((entry) => entry.name).sort()).toEqual(["alpha-skill", "beta-skill"]);
	});

	it("declared references warn on misses without reverting the selection to native visibility", async () => {
		const missing = await resolveProfile({
			profile: profile("review", { skills: ["ghost-skill"] }),
			skills: [skill("alpha-skill")],
			extensions: await extensionsWith(["linter"]),
		});
		expect(missing.resourceSelection).toEqual({ skills: true, extensions: false });
		expect(missing.skills).toEqual([]);
		expect(missing.extensions.map((entry) => entry.id)).toEqual(["linter"]);
		expect(missing.diagnostics).toContainEqual(expect.objectContaining({ kind: "skill", code: "unknown-reference", reference: "ghost-skill" }));

		const plan = await resolveProfile({
			profile: profile("review", { skills: ["future-*"] }),
			skills: [skill("alpha-skill")],
			extensions: await extensionsWith(),
		});
		expect(plan.skills).toEqual([]);
		expect(plan.unmatched).toEqual(["skill:future-*"]);
	});

	it("records the concrete exclusions when an overlay narrows an omitted skill kind", async () => {
		const skills = [skill("alpha-skill"), skill("beta-skill")];
		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["linter"] }),
			skills,
			extensions: await extensionsWith(["linter"]),
			overlay: { disabledSkills: ["beta-skill"] },
		});

		expect(plan.resourceSelection.skills).toBe(false);
		expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
		expect((plan.disabledSkills ?? []).map((entry) => entry.name)).toEqual(["beta-skill"]);
		expect(plan.disabledExtensions).toBeUndefined();
	});

	it("records the concrete exclusions when an overlay narrows an omitted extension kind", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["alpha-skill"] }),
			skills: [skill("alpha-skill")],
			extensions: await extensionsWith(["linter", "helper"]),
			overlay: { disabledExtensions: ["helper"] },
		});

		expect(plan.resourceSelection.extensions).toBe(false);
		expect(plan.extensions.map((entry) => entry.id)).toEqual(["linter"]);
		expect((plan.disabledExtensions ?? []).map((entry) => entry.id)).toEqual(["helper"]);
		expect(plan.disabledSkills).toBeUndefined();
	});

	it("re-expands a native-base overlay glob against the omitted kind on every resolution", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["linter"] }),
			skills: [skill("git-commit"), skill("git-rebase"), skill("alpha-skill")],
			extensions: await extensionsWith(["linter"]),
			overlay: { disabledSkills: ["git-*"] },
		});

		expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
		expect((plan.disabledSkills ?? []).map((entry) => entry.name).sort()).toEqual(["git-commit", "git-rebase"]);
	});

	it("a declared kind keeps overlay exclusions in the selection and records none separately", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["alpha-skill", "beta-skill"] }),
			skills: [skill("alpha-skill"), skill("beta-skill")],
			extensions: await extensionsWith(),
			overlay: { disabledSkills: ["beta-skill"] },
		});

		expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
		expect(plan.disabledSkills).toBeUndefined();
	});
});

describe("discovery-first extension references (ADR-0007)", () => {
	async function registryWithPackage(name: string): Promise<{ registry: DiscoveredExtensions; entry: string }> {
		const root = path.join(fixture.agentDir, "npm", "node_modules", name);
		await mkdir(root, { recursive: true });
		const entry = path.join(root, "index.ts");
		await writeFile(entry, "export default function () {}\n");
		await writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
		);
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ packages: [`npm:${name}`] }),
		);
		const registry = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		return { registry, entry };
	}

	it("a profile references an installed package by name, no registration", async () => {
		const { registry, entry } = await registryWithPackage("pi-web-access");

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["pi-web-access"] }),
			skills: [],
			extensions: registry,
		});

		expect(plan.extensions).toEqual([{ id: "pi-web-access", entry }]);
	});

	it("a profile references an extension by absolute path", async () => {
		const dir = path.join(fixture.agentDir, "extensions");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, "one-off.ts");
		await writeFile(file, "export default function () {}\n");

		const plan = await resolveProfile({
			profile: profile("review", { extensions: [file] }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.extensions).toEqual([{ id: file, entry: file }]);
	});

	it("unknown extension literals warn with actionable guidance", async () => {
		const { registry } = await registryWithPackage("pi-web-access");
		const plan = await resolveProfile({ profile: profile("review", { extensions: ["web-access"] }), skills: [], extensions: registry });
		expect(plan.extensions).toEqual([]);
		expect(plan.diagnostics?.[0].message).toContain('did you mean "pi-web-access"');
		expect(plan.diagnostics?.[0].message).not.toContain("resources.json");
	});

	it("zero-match globs land in plan.unmatched instead of failing silently", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["future-*"], extensions: ["ghost-*"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
		});

		expect(plan.skills).toEqual([]);
		expect(plan.extensions).toEqual([]);
		expect(plan.unmatched).toEqual(["skill:future-*", "extension:ghost-*"]);
	});

	it("overlays disable package-selected extensions by their resolved ID", async () => {
		const { registry, entry } = await registryWithPackage("pi-web-access");

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["pi-web-access"] }),
			skills: [],
			extensions: registry,
			overlay: { disabledExtensions: ["pi-web-access"] },
		});

		expect(plan.extensions).toEqual([]);
		expect(entry).toContain("pi-web-access");
	});
});

describe("mcp_tools resolution and server policy", () => {
	function mockMcpDiscovery(options: {
		servers?: Record<string, Record<string, unknown>>;
		sharedServers?: string[];
		projectServers?: string[];
		serverOwners?: Record<string, "user" | "project">;
		baseConfig?: Record<string, unknown>;
	} = {}): MergedMcpResult {
		const servers = options.servers ?? {
			github: { url: "https://gh" },
			linear: { command: "linear" },
		};
		const sharedServers = new Set(options.sharedServers ?? ["github", "linear"]);
		const projectServers = new Set(options.projectServers ?? []);
		const serverOwners: Record<string, "user" | "project"> = options.serverOwners ?? {};
		for (const s of Object.keys(servers)) {
			if (!Object.hasOwn(serverOwners, s)) {
				serverOwners[s] = projectServers.has(s) ? "project" : "user";
			}
		}
		return {
			servers,
			sharedServers,
			projectServers,
			serverOwners,
			baseConfig: options.baseConfig,
		};
	}

	it("warns when mcp_tools names prototype properties absent from discovered servers", async () => {
		const mcpDiscovery = mockMcpDiscovery({ servers: { github: { url: "https://gh" } } });

		for (const serverName of ["toString", "__proto__"]) {
			const definition = JSON.parse(
				`{"mcp_tools":{${JSON.stringify(serverName)}:["search"]}}`,
			);
			const plan = await resolveProfile({
					profile: profile("review", definition),
					skills: [],
					extensions: await extensionsWith(),
					mcpDiscovery,
				});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(`unknown MCP server "${serverName}"`);
		}
	});

	it("diagnoses configured __proto__ when discovery can only represent toString", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			'{"mcpServers":{"toString":{"url":"https://string"},"__proto__":{"url":"https://proto"}}}',
		);
		const mcpDiscovery = await loadMergedMcpServers(fixture.agentDir, undefined, { homeDir: fixture.root });
		const definition = JSON.parse(
			'{"mcp_tools":{"toString":["search"],"__proto__":["lookup"]}}',
		);

		const plan = await resolveProfile({
				profile: profile("review", definition),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/unknown MCP server "__proto__".*toString/);
	});

	it("warns when mcp_tools names an unknown server, providing usable candidates", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: { github: { url: "https://gh" } },
		});

		const plan = await resolveProfile({
				profile: profile("review", {
					mcp_tools: { typo_server: ["search"] },
				} as any),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/unknown MCP server "typo_server".*github/);
	});

	it("warns when mcp_tools names a disabled server, providing usable candidates", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: {
				github: { url: "https://gh" },
				disabled_server: { url: "https://dis", enabled: false },
			},
		});

		const plan = await resolveProfile({
				profile: profile("review", {
					mcp_tools: { disabled_server: ["search"] },
				} as any),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/MCP server "disabled_server" is disabled.*github/);
	});

	it("warns when mcp_tools names a server disabled by mcps allowlist", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: {
				github: { url: "https://gh" },
				linear: { command: "linear" },
			},
		});

		const plan = await resolveProfile({
				profile: profile("review", {
					mcps: ["github"],
					mcp_tools: { linear: ["search"] },
				} as any),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/MCP server "linear" is disabled.*github/);
	});

	it("warns when mcp_tools names a project-only server", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: {
				github: { url: "https://gh" },
				"proj-srv": { url: "https://proj" },
			},
			projectServers: ["proj-srv"],
		});

		const plan = await resolveProfile({
				profile: profile("review", {
					mcp_tools: { "proj-srv": ["search"] },
				} as any),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/cannot narrow project-level MCP server "proj-srv"/);
	});

	it("warns when mcp_tools names a project-shadowed server", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: {
				"shared-shadowed": { url: "https://proj-override" },
			},
			projectServers: ["shared-shadowed"],
			serverOwners: { "shared-shadowed": "project" },
		});

		const plan = await resolveProfile({
				profile: profile("review", {
					mcp_tools: { "shared-shadowed": ["search"] },
				} as any),
				skills: [],
				extensions: await extensionsWith(),
				mcpDiscovery,
			});
		expect(plan.diagnostics?.map((issue) => issue.message).join("\n")).toMatch(/cannot narrow project-level MCP server "shared-shadowed"/);
	});

	it("does not require an adapter extension for mcp_tools", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: { github: { url: "https://gh" } },
		});

		const plan = await resolveProfile({
			profile: profile("review", {
				mcp_tools: { github: ["search"] },
			} as any),
			skills: [],
			extensions: await extensionsWith(),
			mcpDiscovery,
		});

		expect(plan.mcpTools).toEqual({ github: ["search"] });
		expect(plan.instanceMcpConfig).toBeDefined();
	});

	it("does not require adapter when mcp_tools is empty object or undeclared", async () => {
		const plan = await resolveProfile({
			profile: profile("review", {
				mcp_tools: {},
			} as any),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.mcpTools).toBeUndefined();
		expect(plan.instanceMcpConfig).toBeUndefined();
	});

	it("replaces merged toolExposure with the profile's toolExposure using direct/hidden", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: {
				github: { url: "https://gh", toolExposure: { delete: "hidden" } },
			},
		});

		const plan = await resolveProfile({
			profile: profile("review", {
				mcp_tools: { github: ["search", "delete"] },
			} as any),
			skills: [],
			extensions: await extensionsWith(),
			mcpDiscovery,
		});

		const server = (plan.instanceMcpConfig?.mcpServers as Record<string, any>).github;
		expect(server.toolExposure).toEqual({ "*": "hidden", search: "direct", delete: "direct" });
	});

	it("represents an empty tool list as deny-all toolExposure", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: { github: { url: "https://gh" } },
		});

		const plan = await resolveProfile({
			profile: profile("review", {
				mcp_tools: { github: [] },
			} as any),
			skills: [],
			extensions: await extensionsWith(),
			mcpDiscovery,
		});

		const server = (plan.instanceMcpConfig?.mcpServers as Record<string, any>).github;
		expect(server.toolExposure).toEqual({ "*": "hidden" });
	});

	it("keeps all user-level servers when mcps is omitted and preserves server omitted from mcp_tools", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: {
				github: { url: "https://gh" },
				linear: { command: "linear", env: { API_KEY: "secret" } },
			},
		});

		const plan = await resolveProfile({
			profile: profile("review", {
				mcp_tools: {
					github: ["search"],
				},
			} as any),
			skills: [],
			extensions: await extensionsWith(),
			mcpDiscovery,
		});

		expect(plan.mcps).toBeUndefined();
		const servers = plan.instanceMcpConfig?.mcpServers as Record<string, any>;
		expect(servers.github.toolExposure).toEqual({ "*": "hidden", search: "direct" });
		expect(servers.linear).toEqual({ command: "linear", env: { API_KEY: "secret" } });
	});

	it("applies tool restrictions even when mcps is undeclared", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: { github: { url: "https://gh" } },
		});

		const plan = await resolveProfile({
			profile: profile("review", {
				mcp_tools: { github: ["search"] },
			} as any),
			skills: [],
			extensions: await extensionsWith(),
			mcpDiscovery,
		});

		expect(plan.mcps).toBeUndefined();
		const server = (plan.instanceMcpConfig?.mcpServers as Record<string, any>).github;
		expect(server.toolExposure).toEqual({ "*": "hidden", search: "direct" });
	});

	it("does not write toolExposure when mcp_tools is absent for a server", async () => {
		const mcpDiscovery = mockMcpDiscovery({
			servers: { github: { url: "https://gh" } },
		});

		const plan = await resolveProfile({
			profile: profile("review", {
				mcps: ["github"],
			} as any),
			skills: [],
			extensions: await extensionsWith(),
			mcpDiscovery,
		});

		const server = (plan.instanceMcpConfig?.mcpServers as Record<string, any>).github;
		expect(server.toolExposure).toBeUndefined();
	});
});


describe("partial skill and extension selections", () => {
	it("retains usable selections after misses and diagnoses literals and zero-match globs", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["missing", "future-*", "code-review"], extensions: ["ghost", "./relative.ts", "ghost-*", "linter"] }),
			skills: [skill("code-review"), skill("unselected")], extensions: await extensionsWith(["linter", "unselected"]),
		});
		expect(plan.skills.map((entry) => entry.name)).toEqual(["code-review"]);
		expect(plan.extensions.map((entry) => entry.id)).toEqual(["linter"]);
		expect(plan.unmatched).toEqual(["skill:future-*", "extension:ghost-*"]);
		expect(plan.diagnostics?.map((issue) => issue.reference)).toEqual(["missing", "future-*", "ghost", "./relative.ts", "ghost-*"]);
		for (const issue of plan.diagnostics ?? []) expect(issue.message).toContain('profile "review"');
	});

	it("re-resolves unchanged declarations when previously missing resources appear", async () => {
		const target = profile("review", { skills: ["future"], extensions: ["future"] });
		const before = JSON.stringify(target);
		const first = await resolveProfile({ profile: target, skills: [skill("unselected")], extensions: await extensionsWith(["unselected"]) });
		expect(first.skills).toEqual([]);
		expect(first.extensions).toEqual([]);
		const next = await resolveProfile({ profile: target, skills: [skill("future"), skill("unselected")], extensions: await extensionsWith(["future"]) });
		expect(next.skills.map((entry) => entry.name)).toEqual(["future"]);
		expect(next.extensions.map((entry) => entry.id)).toEqual(["future"]);
		expect(next.diagnostics).toBeUndefined();
		expect(JSON.stringify(target)).toBe(before);
	});

	it.each(["skill", "extension"])("still rejects overlay disabling a skipped %s literal", async (kind) => {
		await expect(resolveProfile({ profile: profile("review", { skills: ["missing"], extensions: ["missing"] }), skills: [], extensions: await extensionsWith(), overlay: kind === "skill" ? { disabledSkills: ["missing"] } : { disabledExtensions: ["missing"] } })).rejects.toThrow(/overlay disables unknown/);
	});
});


describe("partial MCP selection intent", () => {
	function discovery(): MergedMcpResult {
		return { servers: { kept: { command: "fixture", toolExposure: { original: "hidden" } }, unselected: { url: "https://unselected" }, disabled: { url: "https://disabled", enabled: false }, project: { url: "https://project" } }, sharedServers: new Set(), projectServers: new Set(["project"]), serverOwners: { kept: "user", unselected: "user", disabled: "user", project: "project" } };
	}

	it("keeps partial MCP selections restrictive and retains dormant policy keys", async () => {
		const mcpDiscovery = discovery();
		const before = JSON.stringify(mcpDiscovery.servers);
		const target = profile("review", { mcps: ["missing", "disabled", "project", "kept"], mcp_tools: { kept: ["opaque-unmatched"], missing: [], disabled: ["future"], project: [], unselected: [] } });
		const definitionBefore = JSON.stringify(target.definition);
		const plan = await resolveProfile({ profile: target, skills: [], extensions: await extensionsWith(), mcpDiscovery });
		expect(plan.mcps).toEqual(["kept"]);
		expect(plan.mcpTools).toEqual(target.definition.mcp_tools);
		expect(plan.instanceMcpConfig?.mcpServers).toEqual({ kept: { command: "fixture", toolExposure: { "*": "hidden", "opaque-unmatched": "direct" } }, unselected: { url: "https://unselected", enabled: false }, disabled: { url: "https://disabled", enabled: false } });
		expect(plan.diagnostics?.filter((issue) => issue.reference === "opaque-unmatched")).toEqual([]);
		for (const name of ["missing", "disabled", "project", "unselected"]) expect(plan.diagnostics?.some((issue) => issue.reference === name)).toBe(true);
		expect(JSON.stringify(mcpDiscovery.servers)).toBe(before);
		expect(JSON.stringify(target.definition)).toBe(definitionBefore);
	});

	it("all skipped MCP references retain empty selection rather than omission", async () => {
		const plan = await resolveProfile({ profile: profile("review", { mcps: ["missing", "disabled", "project"] }), skills: [], extensions: await extensionsWith(), mcpDiscovery: discovery() });
		expect(plan.mcps).toEqual([]);
		const servers = plan.instanceMcpConfig?.mcpServers as Record<string, Record<string, unknown>>;
		expect(Object.keys(servers).sort()).toEqual(["disabled", "kept", "unselected"]);
		for (const server of Object.values(servers)) expect(server.enabled).toBe(false);
	});

	it("policy-only dormant keys do not invent connections or narrow unmentioned servers", async () => {
		const plan = await resolveProfile({ profile: profile("review", { mcp_tools: { missing: ["future"], disabled: [], project: [] } }), skills: [], extensions: await extensionsWith(), mcpDiscovery: discovery() });
		expect(plan.mcps).toBeUndefined();
		expect(plan.mcpTools).toEqual({ missing: ["future"], disabled: [], project: [] });
		expect(plan.instanceMcpConfig?.mcpServers).toEqual({ kept: { command: "fixture", toolExposure: { original: "hidden" } }, unselected: { url: "https://unselected" }, disabled: { url: "https://disabled", enabled: false } });
	});

	it("re-evaluates dormant policies and missing selections when a server appears", async () => {
		const target = profile("review", { mcps: ["future"], mcp_tools: { future: [] } });
		const mcpDiscovery = discovery();
		expect((await resolveProfile({ profile: target, skills: [], extensions: await extensionsWith(), mcpDiscovery })).mcps).toEqual([]);
		mcpDiscovery.servers.future = { command: "fixture" };
		mcpDiscovery.serverOwners.future = "user";
		const next = await resolveProfile({ profile: target, skills: [], extensions: await extensionsWith(), mcpDiscovery });
		expect(next.mcps).toEqual(["future"]);
		expect((next.instanceMcpConfig?.mcpServers as Record<string, any>).future.toolExposure).toEqual({ "*": "hidden" });
		expect(next.diagnostics).toBeUndefined();
		expect(target.definition).toEqual({ mcps: ["future"], mcp_tools: { future: [] } });
	});
});
