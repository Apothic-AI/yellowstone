import { existsSync } from "node:fs";
import { mkdir, lstat, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInitialProfile } from "../src/launcher/initial-profile.ts";
import { defaultPlan, type ActivationPlan } from "../src/profile-resolver.ts";
import { generateRuntimeDir, writeRuntimeFiles, type DiscoveryContext } from "../src/settings-generator.ts";
import type { SkillEntry } from "../src/skill-registry.ts";
import { addGlobalExtension, addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

function agentDirSkill(name: string): SkillEntry {
	return {
		name,
		filePath: path.join(fixture.agentDir, "skills", name, "SKILL.md"),
		source: "auto",
		scope: "user",
		origin: "top-level",
	};
}

function agentsSkill(name: string): SkillEntry {
	return {
		name,
		filePath: path.join(fixture.root, ".agents", "skills", name, "SKILL.md"),
		source: "auto",
		scope: "user",
		origin: "top-level",
		baseDir: path.join(fixture.root, ".agents"),
	};
}

function packageSkill(name: string, pkg: { source: string; root: string }): SkillEntry {
	return {
		name,
		filePath: path.join(pkg.root, "skills", name, "SKILL.md"),
		source: pkg.source,
		scope: "user",
		origin: "package",
		baseDir: pkg.root,
	};
}

function selectionPlan(overrides: Partial<ActivationPlan>): ActivationPlan {
	return {
		profile: "review",
		source: "global",
		filter: "selection",
		skills: [],
		extensions: [],
		// Typed plan fixture for the existing explicit-selection tests: both
		// kinds are declared so their allowlist encoding keeps its meaning.
		resourceSelection: { skills: true, extensions: true },
		...overrides,
	};
}

async function generatedSettings(runtimeDir: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
}

describe("generateRuntimeDir (named profile selection)", () => {
	it("allowlists selected agent dir skills as additive absolute paths", async () => {
		const plan = selectionPlan({ skills: [agentDirSkill("alpha-skill")] });
		const discovery: DiscoveryContext = {
			skills: [agentDirSkill("alpha-skill"), agentDirSkill("beta-skill")],
			packages: [],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"),
			`-${path.join(result.runtimeDir, "skills", "beta-skill", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md")}`,
		]);
	});

	it("force-excludes agent dir skills that are symlinks to outside the agent dir", async () => {
		// Pi matches `-` exclusions against the raw discovered path without
		// resolving symlinks. The exclusion must therefore name the runtime
		// mirror path, not the symlink target — otherwise it matches nothing
		// and the skill leaks into the session (the agentDir skills of a
		// dotfiles-managed skill library are symlinks in real setups).
		const libraryDir = path.join(fixture.root, "skill-library", "linked-skill");
		await mkdir(libraryDir, { recursive: true });
		await writeFile(path.join(libraryDir, "SKILL.md"), "---\nname: linked-skill\n---\n");
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });
		await symlink(libraryDir, path.join(fixture.agentDir, "skills", "linked-skill"), "dir");

		const plan = selectionPlan({ skills: [] });
		const discovery: DiscoveryContext = { skills: [agentDirSkill("linked-skill")], packages: [] };

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			`-${path.join(result.runtimeDir, "skills", "linked-skill", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "linked-skill", "SKILL.md")}`,
		]);
	});

	it("force-excludes unselected ~/.agents skills while keeping selected ones auto-discovered", async () => {
		const plan = selectionPlan({ skills: [agentsSkill("shared-skill")] });
		const discovery: DiscoveryContext = {
			skills: [agentsSkill("shared-skill"), agentsSkill("secret-skill")],
			packages: [],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			`-${path.join(fixture.root, ".agents", "skills", "secret-skill", "SKILL.md")}`,
		]);
	});

	it("carries the user's own skill exclusions into the generated settings", async () => {
		// Discovery honors these exclusions, so the skills they hide never get a
		// `-` entry of their own; dropping the user's entries would reveal them.
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({
				skills: [
					"!skills/**",
					"+skills/kept-skill",
					"/opt/shared-skills/extra/SKILL.md",
					`-${path.join(fixture.agentDir, "skills", "absolute-hidden", "SKILL.md")}`,
					"-~/.pi-test-agent-hidden/SKILL.md",
					"-skills/relative-hidden/SKILL.md",
				],
			}),
		);
		const plan = selectionPlan({ skills: [agentDirSkill("kept-skill")] });
		const discovery: DiscoveryContext = { skills: [agentDirSkill("kept-skill")], packages: [] };

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "kept-skill", "SKILL.md"),
			"!skills/**",
			"+skills/kept-skill",
			`-${path.join(result.runtimeDir, "skills", "absolute-hidden", "SKILL.md")}`,
			"-~/.pi-test-agent-hidden/SKILL.md",
			"-skills/relative-hidden/SKILL.md",
		]);
	});

	it("rewrites a ~ exclusion under the agent dir to its runtime mirror path", async () => {
		const rel = path.relative(fixture.root, path.join(fixture.agentDir, "skills", "tilde-hidden", "SKILL.md"));
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ skills: [`-~/${rel}`] }));

		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([`-${path.join(result.runtimeDir, "skills", "tilde-hidden", "SKILL.md")}`]);
	});

	it("writes selected extensions as additive entry paths", async () => {
		const plan = selectionPlan({
			extensions: [{ id: "review-guard", entry: "/opt/pi-resources/review-guard/index.ts" }],
		});

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.extensions).toEqual(["/opt/pi-resources/review-guard/index.ts"]);
	});

	it("filters configured packages down to the selected resources, object form", async () => {
		const pkg = { source: path.join(fixture.root, "my-package"), root: path.join(fixture.root, "my-package") };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: [pkg.source] }));
		const plan = selectionPlan({ skills: [packageSkill("pkg-skill", pkg)] });
		const discovery: DiscoveryContext = {
			skills: [packageSkill("pkg-skill", pkg), packageSkill("other-pkg-skill", pkg)],
			packages: [pkg],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.packages).toEqual([
			{ source: pkg.source, skills: ["skills/pkg-skill/SKILL.md"], extensions: [] },
		]);
		// Package skills must not also appear as top-level additive paths.
		expect(settings.skills ?? []).toEqual([]);
	});

	it("classifies extension entries under a package root into that package's allowlist", async () => {
		const pkg = { source: "npm:pi-tools", root: path.join(fixture.agentDir, "npm", "node_modules", "pi-tools") };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-tools"] }));
		const plan = selectionPlan({
			extensions: [{ id: "pkg-ext", entry: path.join(pkg.root, "extensions", "pkg-ext.ts") }],
		});

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.packages).toEqual([
			{ source: "npm:pi-tools", skills: [], extensions: ["extensions/pkg-ext.ts"] },
		]);
		expect(settings.extensions ?? []).toEqual([]);
	});

	it("keys a package's skill allowlist by the user's exact settings source string", async () => {
		// Pi's discovery tags package skills with the source string as written in
		// settings; the generated allowlist must key off that exact string.
		const pkg = { source: path.join(fixture.root, "obj-package"), root: path.join(fixture.root, "obj-package") };
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ packages: [{ source: pkg.source, prompts: ["keep-*"] }] }),
		);
		const plan = selectionPlan({ skills: [packageSkill("obj-skill", pkg)] });
		const discovery: DiscoveryContext = { skills: [packageSkill("obj-skill", pkg)], packages: [pkg] };

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.packages).toEqual([
			{ source: pkg.source, prompts: ["keep-*"], skills: ["skills/obj-skill/SKILL.md"], extensions: [] },
		]);
	});

	it("preserves unmanaged package keys and user settings keys", async () => {
		const pkg = { source: "npm:pi-tools", root: path.join(fixture.agentDir, "npm", "node_modules", "pi-tools") };
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({
				theme: "dark",
				packages: [{ source: "npm:pi-tools", prompts: ["review-*"], autoload: false }],
			}),
		);

		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.theme).toBe("dark");
		expect(settings.packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, prompts: ["review-*"], skills: [], extensions: [] },
		]);
	});

	it("sets defaultProjectTrust to never for non-default profiles", async () => {
		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });

		expect((await generatedSettings(result.runtimeDir)).defaultProjectTrust).toBe("never");
	});

	it("re-includes the real agent dir's unmanaged resource dirs (prompts, themes)", async () => {
		await mkdir(path.join(fixture.agentDir, "prompts"), { recursive: true });
		await mkdir(path.join(fixture.agentDir, "themes"), { recursive: true });

		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.prompts).toContain(path.join(fixture.agentDir, "prompts"));
		expect(settings.themes).toContain(path.join(fixture.agentDir, "themes"));
		expect(settings.skills ?? []).toEqual([]);
		expect(settings.extensions ?? []).toEqual([]);
	});

	it("generates default model and tools in settings.json only when declared", async () => {
		const withBoth = await generateRuntimeDir(
			selectionPlan({ tools: ["read", "grep"], model: { provider: "openai", id: "gpt-5.4", thinkingLevel: "high" } }),
			{ agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } },
		);
		const settings = JSON.parse(await readFile(path.join(withBoth.runtimeDir, "settings.json"), "utf8"));
		expect(settings.defaultTools).toEqual(["read", "grep"]);
		expect(settings.defaultProvider).toBe("openai");
		expect(settings.defaultModel).toBe("gpt-5.4");
		expect(settings.defaultThinkingLevel).toBe("high");

		const bare = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		const bareSettings = JSON.parse(await readFile(path.join(bare.runtimeDir, "settings.json"), "utf8"));
		expect(bareSettings.defaultTools).toBeUndefined();
		expect(bareSettings.defaultProvider).toBeUndefined();
		expect(bareSettings.defaultModel).toBeUndefined();
		expect(bareSettings.defaultThinkingLevel).toBeUndefined();
	});

	it("adds native MCP gateways to defaultTools when tools are declared and a user server is enabled", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" } } }),
		);

		const result = await generateRuntimeDir(selectionPlan({ tools: ["read"] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).defaultTools).toEqual(["read", "codemode", "tool_search"]);
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcpGateways).toBe(true);
	});

	it("adds gateways for an empty tools selection when a user server is enabled", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" } } }),
		);

		const result = await generateRuntimeDir(selectionPlan({ tools: [] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).defaultTools).toEqual(["codemode", "tool_search"]);
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcpGateways).toBe(true);
	});

	it("does not add gateways when no MCP server is enabled", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x", enabled: false } } }),
		);

		const result = await generateRuntimeDir(selectionPlan({ tools: ["read"] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).defaultTools).toEqual(["read"]);
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcpGateways).toBeUndefined();
	});

	it("adds gateways when only a trusted project server is enabled", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { proj: { url: "https://proj" } } }),
		);

		const result = await generateRuntimeDir(selectionPlan({ tools: ["read"] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectDir: fixture.cwd,
		});

		expect((await generatedSettings(result.runtimeDir)).defaultTools).toEqual(["read", "codemode", "tool_search"]);
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcpGateways).toBe(true);
	});

	it("does not add gateways when tools are undeclared", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" } } }),
		);

		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).defaultTools).toBeUndefined();
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcpGateways).toBeUndefined();
	});

	it("writes the launch plan file for the in-pi extension and writes APPEND_SYSTEM.md", async () => {
		const result = await generateRuntimeDir(selectionPlan({ instructions: "Be picky." }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.profile).toBe("review");
		expect(plan.instructions).toBeUndefined();
		expect(await readFile(path.join(result.runtimeDir, "APPEND_SYSTEM.md"), "utf8")).toBe("Be picky.");
	});

	it("materializes the merged snapshot into instance mcp.json when mcps is declared", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {}, missing: {} } }));

		const result = await generateRuntimeDir(selectionPlan({ mcps: ["github"] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcps).toEqual(["github"]);
		const mcpStat = await lstat(path.join(result.runtimeDir, "mcp.json"));
		expect(mcpStat.isSymbolicLink()).toBe(false);
		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({ github: {}, missing: { enabled: false } });
	});

	it("extracts MCP servers defined in ~/.agents/mcp.json and disables unallowed shared servers", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".agents", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"mcp-atlassian": { url: "http://127.0.0.1:10801/mcp", lifecycle: "keep-alive" },
					"mcp-grafana": { url: "http://127.0.0.1:10802/mcp" },
				},
			}),
		);
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "agent-only": { url: "http://x" } } }));

		const result = await generateRuntimeDir(selectionPlan({ mcps: ["mcp-atlassian"] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({
			"mcp-atlassian": { url: "http://127.0.0.1:10801/mcp", lifecycle: "keep-alive" },
			"mcp-grafana": { url: "http://127.0.0.1:10802/mcp", enabled: false },
			"agent-only": { url: "http://x", enabled: false },
		});
	});

	it("always materializes the snapshot when no mcp allowlist is declared", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));

		const result = await generateRuntimeDir(selectionPlan({ mcps: undefined }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const mcpStat = await lstat(path.join(result.runtimeDir, "mcp.json"));
		expect(mcpStat.isSymbolicLink()).toBe(false);
		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({ github: {} });
	});

	it("reports warnings when a malformed MCP source is skipped under an undeclared policy", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const malformedPath = path.join(fixture.root, ".agents", "mcp.json");
		await writeFile(malformedPath, "{ invalid");
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" } } }),
		);

		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect(result.warnings).toEqual([expect.stringContaining(`MCP config is not valid JSON: ${path.resolve(malformedPath)}`)]);
		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({ github: { url: "https://x" } });
	});

	it("skips malformed sources even under explicit MCP policy", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const file = path.join(fixture.root, ".agents", "mcp.json");
		await writeFile(file, "{ invalid");
		const result = await generateRuntimeDir(selectionPlan({ mcps: ["github"] }), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		expect(result.warnings).toContainEqual(expect.stringContaining(file));
		expect(JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8")).mcpServers).toEqual({});
	});

	it("returns an empty warnings list when every MCP source is valid", async () => {
		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect(result.warnings).toEqual([]);
	});

	it("generates an empty mcps selection that disables discovered shared user servers", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".agents", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					shared: { url: "http://shared" },
				},
			}),
		);
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));

		const result = await generateRuntimeDir(selectionPlan({ mcps: [] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({ shared: { url: "http://shared", enabled: false } });
		expect((await lstat(path.join(result.runtimeDir, "mcp.json"))).isSymbolicLink()).toBe(false);
	});

	it("does not mark project-sourced MCP servers disabled for an empty mcps selection", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { proj: { url: "https://proj" } } }),
		);

		const result = await generateRuntimeDir(selectionPlan({ mcps: [] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectDir: fixture.cwd,
		});

		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({});
	});

	it("symlinks auth state and links trust.json for named profiles", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");

		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });

		expect(await realpath(path.join(result.runtimeDir, "auth.json"))).toBe(await realpath(path.join(fixture.agentDir, "auth.json")));
		// Pi reads its project-scope decision from this path: project-level
		// resources belong to Pi's trust gate, not to the profile.
		expect(await realpath(path.join(result.runtimeDir, "trust.json"))).toBe(await realpath(path.join(fixture.agentDir, "trust.json")));
	});

	it("links trust.json even when the real agent dir has no trust store yet", async () => {
		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });

		const link = path.join(result.runtimeDir, "trust.json");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(existsSync(link)).toBe(false); // dangling on purpose: Pi writes through it
		expect(existsSync(path.join(fixture.agentDir, "trust.json"))).toBe(false);
	});
});

describe("generateRuntimeDir (project scope belongs to Pi)", () => {
	const projectSettingsPath = () => path.join(fixture.cwd, ".pi", "settings.json");

	function projectSkill(name: string): SkillEntry {
		return {
			name,
			filePath: path.join(fixture.cwd, ".pi", "skills", name, "SKILL.md"),
			source: "auto",
			scope: "project",
			origin: "top-level",
		};
	}

	it("never merges the trusted project's settings into generated settings", async () => {
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ theme: "dark", retry: { enabled: true, maxRetries: 3 }, globalOnly: 1 }),
		);
		await writeFile(
			projectSettingsPath(),
			JSON.stringify({
				theme: "light",
				retry: { maxRetries: 1 },
				projectOnly: true,
				packages: ["npm:evil-package"],
				skills: ["/evil/skills"],
				extensions: ["/evil/ext.ts"],
			}),
		);

		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectDir: fixture.cwd,
		});
		const settings = await generatedSettings(result.runtimeDir);

		// Merging project settings would turn the project's packages into
		// global-scope packages (installing them into the real agent dir's npm
		// root) and would duplicate what Pi reads natively.
		expect(settings.theme).toBe("dark");
		expect(settings.retry).toEqual({ enabled: true, maxRetries: 3 });
		expect(settings.globalOnly).toBe(1);
		expect(settings.projectOnly).toBeUndefined();
		expect(settings.packages).toBeUndefined();
		expect(settings.skills).toEqual([]);
		expect(settings.extensions).toEqual([]);
		expect(settings.defaultProjectTrust).toBe("never");
	});

	it("never writes project-scope skills into generated settings", async () => {
		const plan = selectionPlan({ skills: [agentDirSkill("alpha-skill"), projectSkill("proj-skill")] });
		const discovery: DiscoveryContext = {
			skills: [agentDirSkill("alpha-skill"), projectSkill("proj-skill"), projectSkill("proj-unselected")],
			packages: [],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery, projectDir: fixture.cwd });
		const settings = await generatedSettings(result.runtimeDir);

		// Project scope is discovered by Pi itself: the profile neither adds the
		// selected project skill nor excludes the unselected one.
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")]);
	});

	it("never writes project .pi/extensions entries into generated settings", async () => {
		const projectExtension = {
			id: "proj-ext",
			entry: path.join(fixture.cwd, ".pi", "extensions", "proj-ext.ts"),
			origin: "local" as const,
		};
		const result = await generateRuntimeDir(selectionPlan({ extensions: [projectExtension] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectDir: fixture.cwd,
		});
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.extensions ?? []).toEqual([]);
	});

	it("keeps project-defined MCP servers enabled when the allowlist omits them", async () => {
		await mkdir(path.join(fixture.agentDir), { recursive: true });
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "agent-a": { url: "http://a" } } }));
		await writeFile(path.join(fixture.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "proj-p": { url: "http://p" } } }));

		const result = await generateRuntimeDir(selectionPlan({ mcps: ["agent-a"] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectDir: fixture.cwd,
		});
		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));

		expect(mcpInstance.mcpServers["agent-a"]).toEqual({ url: "http://a" });
		// Same boundary as project skills and extensions: the profile does not
		// narrow project-level servers.
		expect(mcpInstance.mcpServers["proj-p"]).toBeUndefined();
	});

	it("always materializes mcp.json as a regular file", async () => {
		await mkdir(path.join(fixture.agentDir), { recursive: true });
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: { url: "http://gh" } } }));

		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		const mcpInstancePath = path.join(result.runtimeDir, "mcp.json");
		const stat = await lstat(mcpInstancePath);
		expect(stat.isSymbolicLink()).toBe(false);
		expect(stat.isFile()).toBe(true);
	});

	it("materializes tool restriction without a server whitelist and represents empty list as deny-all", async () => {
		await mkdir(path.join(fixture.agentDir), { recursive: true });
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					github: { url: "http://gh" },
					linear: { command: "linear" },
				},
			}),
		);

		const plan = selectionPlan({
			mcpTools: { github: ["search"], linear: [] },
		});

		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const instanceMcp = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden", search: "direct" });
		expect(instanceMcp.mcpServers.linear.toolExposure).toEqual({ "*": "hidden" });
	});
});

describe("generateRuntimeDir (default profile, unchanged)", () => {
	it("does not set defaultProjectTrust for default", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.defaultProjectTrust).toBeUndefined();
	});

	it("materializes the merged snapshot even for the default profile", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: { url: "http://gh" } } }));

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({ github: { url: "http://gh" } });
		expect((await lstat(path.join(result.runtimeDir, "mcp.json"))).isSymbolicLink()).toBe(false);
	});
});

describe("writeRuntimeFiles (in-session switch rewrite)", () => {
	it("rewrites settings and the launch plan inside an existing runtime dir", async () => {
		const first = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		await addGlobalSkill(fixture, "alpha-skill");
		const next = selectionPlan({
			profile: "impl",
			skills: [agentDirSkill("alpha-skill")],
			toolReferences: ["read", "mcp__*"],
		});
		(next as ActivationPlan).tools = ["read"];

		await writeRuntimeFiles(first.runtimeDir, next, {
			agentDir: fixture.agentDir,
			discovery: { skills: [agentDirSkill("alpha-skill")], packages: [] },
			planExtras: { switchedFrom: "review", persistSelection: true },
		});

		const settings = await generatedSettings(first.runtimeDir);
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")]);
		const plan = JSON.parse(await readFile(path.join(first.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.profile).toBe("impl");
		expect(plan.agentDir).toBe(fixture.agentDir);
		expect(plan.toolReferences).toEqual(["read", "mcp__*"]);
		expect(plan.switchedFrom).toBe("review");
		expect(plan.persistSelection).toBe(true);
	});

	it("keeps the trust.json link when switching from default to a named profile", async () => {
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");
		const first = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(existsSync(path.join(first.runtimeDir, "trust.json"))).toBe(true);

		await writeRuntimeFiles(first.runtimeDir, selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect(await realpath(path.join(first.runtimeDir, "trust.json"))).toBe(await realpath(path.join(fixture.agentDir, "trust.json")));
	});

	it("keeps a dangling trust.json symlink when switching to a named profile", async () => {
		// The real trust store may be created later (Pi writes through the link);
		// the link itself is profile-independent.
		const first = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const trustLink = path.join(first.runtimeDir, "trust.json");
		expect((await lstat(trustLink)).isSymbolicLink()).toBe(true);
		expect(existsSync(trustLink)).toBe(false); // dangling: target absent

		await writeRuntimeFiles(first.runtimeDir, selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await lstat(trustLink)).isSymbolicLink()).toBe(true);
		expect(existsSync(path.join(fixture.agentDir, "trust.json"))).toBe(false);
	});

	it("keeps the trust.json link pointing at the real store when switching to default", async () => {
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");
		const first = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		expect(existsSync(path.join(first.runtimeDir, "trust.json"))).toBe(true);

		await writeRuntimeFiles(first.runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });

		expect(await realpath(path.join(first.runtimeDir, "trust.json"))).toBe(
			await realpath(path.join(fixture.agentDir, "trust.json")),
		);
	});
});

describe("independent per-kind materialization (fix-undeclared-resource-filtering)", () => {
	async function writeUserSettings(settings: unknown): Promise<void> {
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(settings));
	}

	it("omitted skills preserve native settings and native exclusion/inclusion entries", async () => {
		await writeUserSettings({ skills: ["/opt/shared/SKILL.md", "!skills/**", "+skills/keep"] });

		const plan = selectionPlan({ resourceSelection: { skills: false, extensions: true } });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [agentDirSkill("ignored-snapshot")], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).skills).toEqual([
			"/opt/shared/SKILL.md",
			"!skills/**",
			"+skills/keep",
		]);
	});

	it("omitted extensions preserve native settings-only paths and control entries", async () => {
		await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
		await writeUserSettings({ extensions: ["/opt/pi-resources/review-guard/index.ts", "-builtin:mcp"] });

		const plan = selectionPlan({ resourceSelection: { skills: true, extensions: false } });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		// The real directory is exposed by the conditional link, not an additive
		// plain include, so only the native entries remain in the array.
		expect((await generatedSettings(result.runtimeDir)).extensions).toEqual([
			"/opt/pi-resources/review-guard/index.ts",
			"-builtin:mcp",
		]);
	});

	it("keeps non-escaping relative native extension paths for the mirrored kind", async () => {
		await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
		await writeUserSettings({ extensions: ["./extra.ts"] });

		const result = await generateRuntimeDir(selectionPlan({ resourceSelection: { skills: true, extensions: false } }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		// The instance mirrors the real extensions directory, so a relative path
		// under the agent dir keeps its native relative meaning.
		expect((await generatedSettings(result.runtimeDir)).extensions).toEqual(["./extra.ts"]);
	});

	it("appends targeted native-base exclusions for an overlay on an omitted skill kind", async () => {
		const plan = selectionPlan({
			resourceSelection: { skills: false, extensions: true },
			disabledSkills: [agentDirSkill("beta-skill"), agentsSkill("secret-skill")],
		});
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).skills).toEqual([
			`-${path.join(result.runtimeDir, "skills", "beta-skill", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md")}`,
			`-${agentsSkill("secret-skill").filePath}`,
		]);
	});

	it("appends targeted native-base exclusions for an overlay on an omitted extension kind", async () => {
		await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
		const entry = path.join(fixture.agentDir, "extensions", "beta.ts");
		const plan = selectionPlan({
			resourceSelection: { skills: true, extensions: false },
			disabledExtensions: [{ id: "beta", entry, origin: "local" }],
		});
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).extensions).toEqual([
			`-${path.join(result.runtimeDir, "extensions", "beta.ts")}`,
		]);
	});

	it("carries native built-in extension controls through a declared selection", async () => {
		await writeUserSettings({ extensions: ["-builtin:mcp", "+builtin:codemode"] });

		const plan = selectionPlan({ extensions: [{ id: "review-guard", entry: "/opt/pi-resources/review-guard/index.ts" }] });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).extensions).toEqual([
			"/opt/pi-resources/review-guard/index.ts",
			"-builtin:mcp",
			"+builtin:codemode",
		]);
	});

	it("keeps an explicitly empty native package filter empty for the undeclared kind", async () => {
		const pkg = { source: path.join(fixture.root, "pkg"), root: path.join(fixture.root, "pkg") };
		await writeUserSettings({ packages: [{ source: pkg.source, skills: [] }] });

		const plan = selectionPlan({
			resourceSelection: { skills: false, extensions: true },
			extensions: [{ id: "pkg-ext", entry: path.join(pkg.root, "extensions", "pkg-ext.ts"), origin: "package" }],
		});
		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });

		expect((await generatedSettings(result.runtimeDir)).packages).toEqual([
			{ source: pkg.source, skills: [], extensions: ["extensions/pkg-ext.ts"] },
		]);
	});

	it("narrows extensions while preserving an undeclared skill-filter meaning", async () => {
		const pkg = { source: path.join(fixture.root, "pkg"), root: path.join(fixture.root, "pkg") };
		await writeUserSettings({ packages: [{ source: pkg.source, skills: ["skills/keep"] }] });

		const plan = selectionPlan({
			resourceSelection: { skills: false, extensions: true },
			extensions: [{ id: "pkg-ext", entry: path.join(pkg.root, "extensions", "pkg-ext.ts"), origin: "package" }],
		});
		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });

		expect((await generatedSettings(result.runtimeDir)).packages).toEqual([
			{ source: pkg.source, skills: ["skills/keep"], extensions: ["extensions/pkg-ext.ts"] },
		]);
	});

	it("narrows skills while preserving an undeclared extension-filter meaning", async () => {
		const pkg = { source: path.join(fixture.root, "pkg"), root: path.join(fixture.root, "pkg") };
		await writeUserSettings({ packages: [{ source: pkg.source, extensions: ["extensions/keep.ts"] }] });

		const plan = selectionPlan({
			resourceSelection: { skills: true, extensions: false },
			skills: [packageSkill("pkg-skill", pkg)],
		});
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [packageSkill("pkg-skill", pkg)], packages: [pkg] },
		});

		expect((await generatedSettings(result.runtimeDir)).packages).toEqual([
			{ source: pkg.source, extensions: ["extensions/keep.ts"], skills: ["skills/pkg-skill/SKILL.md"] },
		]);
	});

	it("appends overlay package exclusions to an undeclared kind's native filter", async () => {
		const pkg = { source: path.join(fixture.root, "pkg"), root: path.join(fixture.root, "pkg") };
		const disabledEntry = path.join(pkg.root, "extensions", "e1.ts");
		await writeUserSettings({ packages: [{ source: pkg.source, extensions: ["extensions/keep.ts"] }] });

		const plan = selectionPlan({
			resourceSelection: { skills: false, extensions: false },
			disabledExtensions: [{ id: "pkg-ext", entry: disabledEntry, origin: "package" }],
		});
		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });

		expect((await generatedSettings(result.runtimeDir)).packages).toEqual([
			{ source: pkg.source, extensions: ["extensions/keep.ts", "-extensions/e1.ts"] },
		]);
	});

	it("keeps an undeclared kind's package entry untouched when the profile declares the other kind", async () => {
		const pkg = { source: path.join(fixture.root, "pkg"), root: path.join(fixture.root, "pkg") };
		await writeUserSettings({ packages: [{ source: pkg.source, autoload: false, prompts: ["review-*"] }] });

		const plan = selectionPlan({
			resourceSelection: { skills: false, extensions: true },
			extensions: [{ id: "pkg-ext", entry: path.join(pkg.root, "extensions", "pkg-ext.ts"), origin: "package" }],
		});
		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });

		expect((await generatedSettings(result.runtimeDir)).packages).toEqual([
			{ source: pkg.source, autoload: false, prompts: ["review-*"], extensions: ["extensions/pkg-ext.ts"] },
		]);
	});

	it("remaps absolute and ~ native skill overrides under the agent dir for an omitted kind", async () => {
		// Pi matches `!`/`+`/`-` entries lexically against the raw discovered path.
		// AgentDir skills surface only through the instance's runtime-mirror
		// symlink, so a native absolute/`~` override under the agent dir must be
		// rewritten to the mirror path or it silently matches nothing.
		await writeUserSettings({
			skills: [
				`-${path.join(fixture.agentDir, "skills", "hidden-skill", "SKILL.md")}`,
				`+${path.join(fixture.agentDir, "skills", "kept-skill", "SKILL.md")}`,
				`-~/${path.relative(fixture.root, path.join(fixture.agentDir, "skills", "tilde-hidden", "SKILL.md"))}`,
				"-skills/relative-hidden/SKILL.md",
				"-~/.agents/skills/agents-hidden/SKILL.md",
			],
		});
		const plan = selectionPlan({ resourceSelection: { skills: false, extensions: true } });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect((await generatedSettings(result.runtimeDir)).skills).toEqual([
			`-${path.join(result.runtimeDir, "skills", "hidden-skill", "SKILL.md")}`,
			`+${path.join(result.runtimeDir, "skills", "kept-skill", "SKILL.md")}`,
			// Real Pi treats a `~` override as a no-op, so it is preserved verbatim
			// rather than remapped into an effective exclusion.
			`-~/${path.relative(fixture.root, path.join(fixture.agentDir, "skills", "tilde-hidden", "SKILL.md"))}`,
			"-skills/relative-hidden/SKILL.md",
			"-~/.agents/skills/agents-hidden/SKILL.md",
		]);
	});

	it("rewrites a relative local package source to its resolved root", async () => {
		const root = path.resolve(fixture.agentDir, "..", "shared-pkg");
		await writeUserSettings({ packages: [{ source: "../shared-pkg", skills: ["skills/keep"] }] });

		const result = await generateRuntimeDir(selectionPlan({ resourceSelection: { skills: false, extensions: false } }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [{ source: "../shared-pkg", root }] },
		});

		// A user-scope relative source resolves from the agent dir; the instance
		// moves that root, so the emitted source must carry the resolved path.
		expect((await generatedSettings(result.runtimeDir)).packages).toEqual([{ source: root, skills: ["skills/keep"] }]);
	});

	it("keeps an unresolved package's native declaration for an undeclared kind", async () => {
		await writeUserSettings({ packages: [{ source: "npm:not-installed", skills: ["skills/keep"] }] });

		const result = await generateRuntimeDir(selectionPlan({ resourceSelection: { skills: false, extensions: false } }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [{ source: "npm:not-installed", root: undefined }] },
		});

		// Read-only discovery cannot resolve the root; the native declaration must
		// pass through instead of becoming an empty or discovery-derived allowlist.
		expect((await generatedSettings(result.runtimeDir)).packages).toEqual([
			{ source: "npm:not-installed", skills: ["skills/keep"] },
		]);
	});

	it("keeps native extension control patterns for the mirrored kind", async () => {
		await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
		// The canonical shape `pi config` writes: a top-level relative control.
		await writeUserSettings({
			extensions: [
				"-extensions/x.ts",
				"!extensions/legacy/**",
				"+extensions/keep.ts",
				"-builtin:mcp",
				"/opt/pi-resources/one-off.ts",
				"~/.config/pi/extra.ts",
			],
		});
		const plan = selectionPlan({ resourceSelection: { skills: true, extensions: false } });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		// Relative controls match the mirrored `rel`; `builtin:`/`~`/absolute keep
		// their native spelling.
		expect((await generatedSettings(result.runtimeDir)).extensions).toEqual([
			"-extensions/x.ts",
			"!extensions/legacy/**",
			"+extensions/keep.ts",
			"-builtin:mcp",
			"/opt/pi-resources/one-off.ts",
			"~/.config/pi/extra.ts",
		]);
	});

	it("re-anchors escaping relative skill includes and their matching overrides", async () => {
		await writeUserSettings({
			skills: [
				"../shared-skills",
				"!../shared-skills/foo/SKILL.md",
				"!skills/**",
				`!${path.join(fixture.agentDir, "skills", "**")}`,
			],
		});
		const plan = selectionPlan({ resourceSelection: { skills: false, extensions: true } });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const escaped = path.resolve(fixture.agentDir, "..", "shared-skills");
		expect((await generatedSettings(result.runtimeDir)).skills).toEqual([
			escaped,
			`!${path.join(escaped, "foo", "SKILL.md")}`,
			// Non-escaping relatives still match the instance's mirrored subtree.
			"!skills/**",
			// An absolute agentDir control still maps to the runtime mirror.
			`!${path.join(result.runtimeDir, "skills", "**")}`,
		]);
	});

	it("re-anchors escaping relative extension includes and their matching overrides", async () => {
		await writeUserSettings({ extensions: ["../shared-extension.ts", "-../shared-extension.ts"] });
		const plan = selectionPlan({ resourceSelection: { skills: true, extensions: false } });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const escaped = path.resolve(fixture.agentDir, "..", "shared-extension.ts");
		expect((await generatedSettings(result.runtimeDir)).extensions).toEqual([escaped, `-${escaped}`]);
	});
});

describe("conditional extension mirror (fix-undeclared-resource-filtering)", () => {
	function omittedExtensionsPlan(): ActivationPlan {
		return selectionPlan({ resourceSelection: { skills: true, extensions: false } });
	}

	it("links the instance extensions path to the real one for an omitted selection, dangling allowed", async () => {
		const result = await generateRuntimeDir(omittedExtensionsPlan(), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const link = path.join(result.runtimeDir, "extensions");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readlink(link)).toBe(path.join(fixture.agentDir, "extensions"));
		// The target is not created or populated.
		expect(existsSync(path.join(fixture.agentDir, "extensions"))).toBe(false);
	});

	it("links an existing real extensions directory without touching its contents", async () => {
		await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
		await writeFile(path.join(fixture.agentDir, "extensions", "a.ts"), "export default 1");

		const result = await generateRuntimeDir(omittedExtensionsPlan(), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect(await readlink(path.join(result.runtimeDir, "extensions"))).toBe(
			path.join(fixture.agentDir, "extensions"),
		);
		expect(await readFile(path.join(fixture.agentDir, "extensions", "a.ts"), "utf8")).toBe("export default 1");
	});

	it("has no generated link for a declared extension selection", async () => {
		const plan = selectionPlan({ extensions: [{ id: "e", entry: "/opt/x/index.ts" }] });
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		await expect(lstat(path.join(result.runtimeDir, "extensions"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes a stale generated link when an in-place rewrite declares extensions", async () => {
		const first = await generateRuntimeDir(omittedExtensionsPlan(), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		expect((await lstat(path.join(first.runtimeDir, "extensions"))).isSymbolicLink()).toBe(true);

		await writeRuntimeFiles(
			first.runtimeDir,
			selectionPlan({ extensions: [{ id: "e", entry: "/opt/x/index.ts" }] }),
			{ agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } },
		);

		await expect(lstat(path.join(first.runtimeDir, "extensions"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses real content at the instance extensions path before any managed write", async () => {
		const runtimeDir = path.join(fixture.root, "runtime");
		await mkdir(path.join(runtimeDir, "extensions"), { recursive: true });
		await writeFile(path.join(runtimeDir, "extensions", "real.ts"), "real");
		const sentinelSettings = "settings sentinel";
		const sentinelPlan = "plan sentinel";
		await writeFile(path.join(runtimeDir, "settings.json"), sentinelSettings);
		await writeFile(path.join(runtimeDir, "pi-profile.json"), sentinelPlan);

		await expect(
			writeRuntimeFiles(runtimeDir, omittedExtensionsPlan(), {
				agentDir: fixture.agentDir,
				discovery: { skills: [], packages: [] },
			}),
		).rejects.toThrow(/real directory.*will not delete or overwrite/);

		// Refusal happens before managed writes and never touches the real content.
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(sentinelSettings);
		expect(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8")).toBe(sentinelPlan);
		expect(await readFile(path.join(runtimeDir, "extensions", "real.ts"), "utf8")).toBe("real");
	});
});

describe("native plain-include overlay exclusion (fix-undeclared-resource-filtering)", () => {
	it("excludes a disabled skill through both its real and mirrored lexical routes", async () => {
		const vendorSkill: SkillEntry = {
			name: "vendor-x",
			filePath: path.join(fixture.agentDir, "vendor", "x", "SKILL.md"),
			source: "local",
			scope: "user",
			origin: "top-level",
		};
		// The native plain include loads the file at its real absolute path.
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ skills: [vendorSkill.filePath] }),
		);
		const plan = selectionPlan({
			resourceSelection: { skills: false, extensions: true },
			disabledSkills: [vendorSkill],
		});
		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const skills = (await generatedSettings(result.runtimeDir)).skills as string[];
		expect(skills).toContain(vendorSkill.filePath); // the native include stays
		expect(skills).toContain(`-${vendorSkill.filePath}`); // real lexical route
		expect(skills).toContain(`-${path.join(result.runtimeDir, "vendor", "x", "SKILL.md")}`); // mirror route
	});
});

describe("declared-selection extension-path refusal (fix-undeclared-resource-filtering)", () => {
	it.each([
		["empty", { extensions: [] }],
		["nonempty", { extensions: [{ id: "declared", entry: "/opt/pi-resources/declared/index.ts" }] }],
	] as Array<[string, Partial<ActivationPlan>]>, )("refuses real content at the instance extension path for a declared %s selection", async (_label, definition) => {
		const runtimeDir = path.join(fixture.root, `runtime-${_label}`);
		await mkdir(path.join(runtimeDir, "extensions", "sneaky"), { recursive: true });
		await writeFile(path.join(runtimeDir, "extensions", "sneaky", "index.ts"), "export default 1");
		const sentinelSettings = "settings sentinel";
		await writeFile(path.join(runtimeDir, "settings.json"), sentinelSettings);

		await expect(
			writeRuntimeFiles(runtimeDir, selectionPlan(definition), {
				agentDir: fixture.agentDir,
				discovery: { skills: [], packages: [] },
			}),
		).rejects.toThrow(/real directory.*will not delete or overwrite/);

		// Refusal happens before managed writes and never deletes or adopts content.
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(sentinelSettings);
		expect(await readFile(path.join(runtimeDir, "extensions", "sneaky", "index.ts"), "utf8")).toBe("export default 1");
	});
});

describe("restrictive partial runtime materialization", () => {
	it("keeps all-missing resource selections empty and user resources excluded", async () => {
		await addGlobalSkill(fixture, "unselected");
		await addGlobalExtension(fixture, "unselected");
		await writeFile(path.join(fixture.agentDir, "mcp.json"), '{"mcpServers":{"unselected":{"command":"fixture"}}}');
		const dir = path.join(fixture.profileSwitchDir, "profiles");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, "review.json");
		const content = '{"skills":["missing"],"extensions":["missing"],"mcps":["missing"],"unknownField":"ignored"}';
		await writeFile(file, content);
		const resolved = await resolveInitialProfile("review", { agentDir: fixture.agentDir, cwd: fixture.cwd });
		const result = await generateRuntimeDir(resolved.plan, { agentDir: fixture.agentDir, discovery: resolved.discovery, projectDir: resolved.projectDir });
		const settings = await generatedSettings(result.runtimeDir);
		expect(settings.extensions).toEqual([]);
		expect(settings.skills).toEqual([
			`-${path.join(result.runtimeDir, "skills", "unselected", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "unselected", "SKILL.md")}`,
		]);
		expect(JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8")).mcpServers).toEqual({ unselected: { command: "fixture", enabled: false } });
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcps).toEqual([]);
		for (const kind of ["skill", "extension", "mcp", "catalog"]) expect(plan.diagnostics.some((issue: { kind: string }) => issue.kind === kind)).toBe(true);
		expect(plan.resolved).toEqual({ skills: [], extensions: [] });
		expect(settings.unknownField).toBeUndefined();
		expect(await readFile(file, "utf8")).toBe(content);
	});

	it("preserves partial MCP restrictions, dormant keys, and source/project boundaries with a bad later source", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const valid = path.join(fixture.root, ".agents", "mcp.json");
		const content = '{"mcpServers":{"kept":{"command":"fixture"},"disabled":{"command":"disabled","enabled":false},"unselected":{"command":"other"}}}';
		await writeFile(valid, content);
		const invalid = path.join(fixture.agentDir, "mcp.json");
		await writeFile(invalid, "{ bad");
		const project = path.join(fixture.cwd, ".pi", "mcp.json");
		await writeFile(project, '{"mcpServers":{"project":{"command":"project"}}}');
		const result = await generateRuntimeDir(selectionPlan({ mcps: ["kept"], mcpTools: { kept: ["opaque"], missing: [], disabled: [], project: [], unselected: [] } }), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] }, projectDir: fixture.cwd });
		const servers = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8")).mcpServers;
		expect(servers).toEqual({ kept: { command: "fixture", toolExposure: { "*": "hidden", opaque: "direct" } }, disabled: { command: "disabled", enabled: false }, unselected: { command: "other", enabled: false } });
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(Object.keys(plan.mcpTools).sort()).toEqual(["disabled", "kept", "missing", "project", "unselected"]);
		expect(plan.diagnostics.some((issue: { filePath?: string }) => issue.filePath === invalid)).toBe(true);
		for (const name of ["missing", "disabled", "project", "unselected"]) expect(plan.diagnostics.some((issue: { reference?: string }) => issue.reference === name)).toBe(true);
		expect(await readFile(valid, "utf8")).toBe(content);
		expect(await readFile(invalid, "utf8")).toBe("{ bad");
		expect(await readFile(project, "utf8")).toBe('{"mcpServers":{"project":{"command":"project"}}}');
	});

	it("persists diagnostics once and uses the final source snapshot without discarding other warnings", async () => {
		const issue = { kind: "skill", code: "unknown-reference", reference: "missing", message: 'profile "review": missing skill; not loaded' };
		const result = await generateRuntimeDir(selectionPlan({ diagnostics: [issue, { ...issue }], unmatched: ["overlay skill:zero-*"] }), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.diagnostics.filter((entry: { reference?: string }) => entry.reference === "missing")).toEqual([issue]);
		expect(result.warnings.filter((warning) => warning === issue.message)).toHaveLength(1);
		expect(result.warnings.some((warning) => warning.includes("overlay skill:zero-*"))).toBe(true);
	});

	it("uses final MCP source/policy diagnostics rather than stale earlier content errors", async () => {
		const file = path.join(fixture.agentDir, "mcp.json");
		await writeFile(file, '{"mcpServers":{"kept":{"command":"fixture","enabled":false}}}');
		const stale = { kind: "mcp-source", code: "invalid-source", filePath: file, message: "stale content error" };
		const result = await generateRuntimeDir(selectionPlan({ mcps: ["kept"], mcpTools: { kept: [] }, diagnostics: [stale] }), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		expect(result.warnings).not.toContain("stale content error");
		expect(result.warnings.some((message) => message.includes("remains disabled"))).toBe(true);
		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.diagnostics.some((issue: { kind: string }) => issue.kind === "mcp-source")).toBe(false);
		expect(JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8")).mcpServers.kept).toEqual({ command: "fixture", enabled: false });
	});

	it("propagates genuine MCP IO errors before rewriting managed files", async () => {
		const first = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		const before = await readFile(path.join(first.runtimeDir, "settings.json"), "utf8");
		await mkdir(path.join(fixture.agentDir, "mcp.json"));
		await expect(writeRuntimeFiles(first.runtimeDir, selectionPlan({ mcps: [] }), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } })).rejects.toMatchObject({ code: "EISDIR" });
		expect(await readFile(path.join(first.runtimeDir, "settings.json"), "utf8")).toBe(before);
	});
});
