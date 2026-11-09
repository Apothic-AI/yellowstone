import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as jsonFile from "../src/json-file.ts";
import { ProfileCatalog } from "../src/profile-catalog.ts";
import { UnknownProfileError, resolveInitialProfile } from "../src/launcher/initial-profile.ts";
import { addGlobalExtension, addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const context = () => ({ agentDir: fixture.agentDir, cwd: fixture.cwd });

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

async function writeMcpConfig(servers: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

describe("resolveInitialProfile", () => {
	it("returns the unfiltered default plan when no name and no saved state exist", async () => {
		const { plan } = await resolveInitialProfile(undefined, context());

		expect(plan.profile).toBe("default");
		expect(plan.filter).toBe("none");
	});

	it("resolves a positional named profile against the global catalog", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });

		const { plan } = await resolveInitialProfile("review", context());

		expect(plan.profile).toBe("review");
		expect(plan.filter).toBe("selection");
		expect(plan.skills.map((skill) => skill.name)).toEqual(["alpha-skill"]);
	});

	it("restores the saved active profile when no positional name is given", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });
		await writeFile(
			path.join(fixture.agentDir, "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "review" }),
		);

		const { plan } = await resolveInitialProfile(undefined, context());

		expect(plan.profile).toBe("review");
	});

	it("a positional name wins over the saved active profile", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] }, implement: { skills: ["beta-skill"] } });
		await writeFile(
			path.join(fixture.agentDir, "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "implement" }),
		);

		const { plan } = await resolveInitialProfile("review", context());

		expect(plan.profile).toBe("review");
	});

	it("warns and falls back to default when the saved active profile no longer exists", async () => {
		await writeFile(
			path.join(fixture.agentDir, "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "ghost" }),
		);

		const { plan, warnings } = await resolveInitialProfile(undefined, context());

		expect(plan.profile).toBe("default");
		expect(warnings.some((warning) => warning.includes("ghost"))).toBe(true);
	});

	it("rejects an unknown positional profile before any spawn", async () => {
		await expect(resolveInitialProfile("review", context())).rejects.toThrow(/unknown profile: review/);
	});

	it("does not write runtime state for the initial selection", async () => {
		await writeCatalog({ review: { skills: [] } });

		await resolveInitialProfile("review", context());

		await expect(readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8")).rejects.toThrow();
	});

	it("warns and retains usable references when a profile names a missing skill", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalExtension(fixture, "linter");
		await writeCatalog({ review: { skills: ["missing", "future-*", "alpha-skill"], extensions: ["ghost", "ghost-*", "linter"] } });
		const file = path.join(fixture.profileSwitchDir, "profiles", "review.json");
		const before = await readFile(file, "utf8");
		const { plan, warnings } = await resolveInitialProfile("review", context());
		expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
		expect(plan.extensions.map((entry) => entry.id)).toEqual(["linter"]);
		expect(warnings.filter((warning) => warning.includes('"missing"'))).toHaveLength(1);
		expect(warnings.filter((warning) => warning.includes('"ghost"'))).toHaveLength(1);
		expect(warnings.filter((warning) => warning.includes("future-*"))).toHaveLength(1);
		expect(warnings.filter((warning) => warning.includes("ghost-*"))).toHaveLength(1);
		await addGlobalSkill(fixture, "missing");
		await addGlobalExtension(fixture, "ghost");
		const next = await resolveInitialProfile("review", context());
		expect(next.plan.skills.map((entry) => entry.name)).toEqual(["missing", "alpha-skill"]);
		expect(next.plan.extensions.map((entry) => entry.id)).toEqual(["ghost", "linter"]);
		expect(await readFile(file, "utf8")).toBe(before);
	});

	describe("selected definition isolation", () => {
		it.each(["default", undefined])("bypasses catalog loading for normal default selection %s", async (name) => {
			await writeCatalog({ default: [], invalid: { skills: 1 } });
			await writeFile(path.join(fixture.profileSwitchDir, "profiles", "corrupt.json"), "{ bad");
			const load = vi.spyOn(ProfileCatalog, "load");
			const read = vi.spyOn(jsonFile, "readJsonFile");
			const { plan } = await resolveInitialProfile(name, context());
			expect(plan.filter).toBe("none");
			expect(load).not.toHaveBeenCalled();
			expect(read.mock.calls.map(([file]) => file).filter((file) => file.includes(`${path.sep}profiles${path.sep}`))).toEqual([]);
		});

		it("does not enumerate a catalog path on normal default activation", async () => {
			await mkdir(fixture.profileSwitchDir, { recursive: true });
			await writeFile(path.join(fixture.profileSwitchDir, "profiles"), "not a directory");
			expect((await resolveInitialProfile("default", context())).plan.filter).toBe("none");
		});

		it("resolves a valid named profile without reading unrelated invalid definitions", async () => {
			await writeCatalog({ review: { skills: [] }, invalid: { skills: 1 } });
			await writeFile(path.join(fixture.profileSwitchDir, "profiles", "corrupt.json"), "{ bad");
			const read = vi.spyOn(jsonFile, "readJsonFile");
			expect((await resolveInitialProfile("review", context())).plan.profile).toBe("review");
			expect(read.mock.calls.map(([file]) => file).filter((file) => file.includes(`${path.sep}profiles${path.sep}`))).toEqual([path.join(fixture.profileSwitchDir, "profiles", "review.json")]);
		});

		it("rejects a saved existing malformed profile instead of falling back", async () => {
			await writeCatalog({ review: { skills: 1 } });
			await writeFile(path.join(fixture.agentDir, "pi-profile-state.json"), JSON.stringify({ activeProfile: "review" }));
			await expect(resolveInitialProfile(undefined, context())).rejects.toThrow(path.join(fixture.profileSwitchDir, "profiles", "review.json"));
		});

		it("rejects an invalid trusted-project winner without reading its valid global counterpart", async () => {
			await writeCatalog({ review: {} });
			const dir = path.join(fixture.cwd, ".pi", "profiles");
			await mkdir(dir, { recursive: true });
			const winner = path.join(dir, "review.json");
			await writeFile(winner, "{ bad");
			const read = vi.spyOn(jsonFile, "readJsonFile");
			await expect(resolveInitialProfile("review", { ...context(), trustOverride: true })).rejects.toThrow(winner);
			expect(read.mock.calls.map(([file]) => file)).not.toContain(path.join(fixture.profileSwitchDir, "profiles", "review.json"));
		});

		it("collects unknown-field warnings without forwarding those keys to the plan", async () => {
			await writeCatalog({ review: { skills: [], defaultTools: ["write"], defaultProjectTrust: "always" } });
			const { plan, warnings } = await resolveInitialProfile("review", context());
			expect(warnings).toContainEqual(expect.stringContaining('unknown field "defaultTools" ignored'));
			expect(warnings).toContainEqual(expect.stringContaining('unknown field "defaultProjectTrust" ignored'));
			expect(Object.hasOwn(plan, "defaultTools")).toBe(false);
			expect(Object.hasOwn(plan, "defaultProjectTrust")).toBe(false);
			expect(plan.tools).toBeUndefined();
			expect(plan.model).toBeUndefined();
		});
	});

	describe("project trust gating", () => {
		async function writeProjectCatalog(profiles: Record<string, unknown>): Promise<void> {
			const dir = path.join(fixture.cwd, ".pi", "profiles");
			await mkdir(dir, { recursive: true });
			for (const [name, definition] of Object.entries(profiles)) {
				await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
			}
		}

		async function addProjectSkill(name: string): Promise<void> {
			const dir = path.join(fixture.cwd, ".pi", "skills", name);
			await mkdir(dir, { recursive: true });
			await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: p\n---\n`);
		}

		async function trustProject(): Promise<void> {
			await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		}

		it("an untrusted project's catalog is never read", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });

			await expect(resolveInitialProfile("impl", context())).rejects.toThrow(/unknown profile/);
		});

		it("a trusted project's profiles resolve and select project skills", async () => {
			await addProjectSkill("proj-skill");
			await writeProjectCatalog({ impl: { skills: ["proj-skill"] } });
			await trustProject();

			const { plan } = await resolveInitialProfile("impl", context());

			expect(plan.source).toBe("project");
			expect(plan.skills.map((skill) => skill.name)).toEqual(["proj-skill"]);
		});

		it("--approve grants one-run trust so project profiles resolve", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });

			const { plan } = await resolveInitialProfile("impl", { ...context(), trustOverride: true });

			expect(plan.profile).toBe("impl");
		});

		it("--no-approve distrusts even a stored trust entry", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });
			await trustProject();

			await expect(resolveInitialProfile("impl", { ...context(), trustOverride: false })).rejects.toThrow(
				/unknown profile/,
			);
		});

		it("restores the project state file's active profile when trusted", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });
			await trustProject();
			await writeFile(
				path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
				JSON.stringify({ activeProfile: "impl" }),
			);

			const { plan } = await resolveInitialProfile(undefined, context());

			expect(plan.profile).toBe("impl");
		});

		it("ignores the project state file when untrusted", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });
			await writeFile(
				path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
				JSON.stringify({ activeProfile: "impl" }),
			);

			const { plan } = await resolveInitialProfile(undefined, context());

			expect(plan.profile).toBe("default");
		});
	});

	describe("default-profile overlays use the shared native bases", () => {
		it("a skill-only overlay on default narrows only skills and keeps both kinds undeclared", async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addGlobalExtension(fixture, "linter");

			const { plan } = await resolveInitialProfile("default", context(), {
				overlay: { disabledSkills: ["beta-skill"] },
			});

			expect(plan.profile).toBe("default");
			expect(plan.resourceSelection).toEqual({ skills: false, extensions: false });
			expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
			expect((plan.disabledSkills ?? []).map((entry) => entry.name)).toEqual(["beta-skill"]);
			expect(plan.disabledExtensions).toBeUndefined();
			expect(plan.extensions.map((entry) => entry.id)).toContain("linter");
		});

		it("an extension-only overlay on default narrows only extensions", async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalExtension(fixture, "linter");
			await addGlobalExtension(fixture, "helper");

			const { plan } = await resolveInitialProfile("default", context(), {
				overlay: { disabledExtensions: ["helper"] },
			});

			expect(plan.resourceSelection).toEqual({ skills: false, extensions: false });
			expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
			expect((plan.disabledExtensions ?? []).map((entry) => entry.id)).toEqual(["helper"]);
			expect(plan.disabledSkills).toBeUndefined();
		});

		it("a tool-only overlay on default declares neither resource kind", async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalExtension(fixture, "linter");

			const { plan } = await resolveInitialProfile("default", context(), {
				overlay: { disabledTools: ["bash"] },
				liveToolNames: ["read", "bash", "grep"],
			});

			expect(plan.resourceSelection).toEqual({ skills: false, extensions: false });
			expect(plan.disabledSkills).toBeUndefined();
			expect(plan.disabledExtensions).toBeUndefined();
			expect(plan.skills.map((entry) => entry.name)).toEqual(["alpha-skill"]);
			expect(plan.extensions.map((entry) => entry.id)).toContain("linter");
		});

		it("keeps rejecting an MCP disable on default", async () => {
			await expect(
				resolveInitialProfile("default", context(), { overlay: { disabledMcps: ["github"] } }),
			).rejects.toThrow(/no MCP allowlist to narrow/);
		});
	});

	describe("mcp declarations", () => {
		it("expands the profile's mcp references against the merged user-level snapshot", async () => {
			await writeMcpConfig({ github: {}, linear: {} });
			await writeCatalog({ review: { mcps: ["github"] } });

			const { plan } = await resolveInitialProfile("review", context());

			expect(plan.mcps).toEqual(["github"]);
		});

		it("warns and retains empty MCP selection for an unknown server", async () => {
			await writeMcpConfig({ github: {} });
			await writeCatalog({ review: { mcps: ["typo-server"] } });

			const { plan, warnings } = await resolveInitialProfile("review", context());
			expect(plan.mcps).toEqual([]);
			expect(warnings.join("\n")).toMatch(/unknown MCP server: "typo-server"/);
			expect(plan.instanceMcpConfig?.mcpServers).toEqual({ github: { enabled: false } });
		});

		it("does not require an adapter extension for nonempty mcps", async () => {
			await writeMcpConfig({ github: {} });
			await writeCatalog({ review: { mcps: ["github"] } });

			const { plan } = await resolveInitialProfile("review", context());

			expect(plan.mcps).toEqual(["github"]);
		});

		it("diagnoses malformed configuration under explicit empty MCP selection", async () => {
			await writeFile(path.join(fixture.agentDir, "mcp.json"), "{ not valid json");
			await writeCatalog({ inert: { mcps: [] } });

			const { plan, warnings } = await resolveInitialProfile("inert", context());
			expect(plan.mcps).toEqual([]);
			expect(warnings.join("\n")).toContain("MCP config is not valid JSON");
		});

		it("requests MCP discovery for empty mcps and marks discovered servers enabled: false", async () => {
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(
				path.join(fixture.root, ".agents", "mcp.json"),
				JSON.stringify({ mcpServers: { github: { url: "https://gh" } } }),
			);
			await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
			await writeCatalog({ denyall: { mcps: [] } });

			const { plan } = await resolveInitialProfile("denyall", context());

			expect(plan.mcps).toEqual([]);
			expect(plan.instanceMcpConfig?.mcpServers).toEqual({ github: { url: "https://gh", enabled: false } });
		});

		it("does not mark project-sourced MCP servers disabled for an empty mcps selection", async () => {
			await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
			await writeFile(path.join(fixture.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { proj: { url: "https://proj" } } }));
			await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
			await writeCatalog({ denyall: { mcps: [] } });

			const { plan } = await resolveInitialProfile("denyall", context());

			expect(plan.mcps).toEqual([]);
			expect(plan.instanceMcpConfig?.mcpServers).toEqual({});
		});

		it("delegates selected SSE transport usability to Pi", async () => {
			await writeMcpConfig({ github: { type: "sse", url: "http://localhost:3000/sse" } });
			await writeCatalog({ review: { mcps: ["github"] } });

			const { plan, warnings } = await resolveInitialProfile("review", context());
			expect(plan.mcps).toEqual(["github"]);
			expect(plan.instanceMcpConfig?.mcpServers).toEqual({ github: { type: "sse", url: "http://localhost:3000/sse" } });
			expect(warnings).toEqual([]);
		});

		it("passes an unselected SSE server through without failing activation", async () => {
			await writeMcpConfig({ github: { type: "sse", url: "http://localhost:3000/sse" } });
			await writeCatalog({ review: {} });

			const { plan } = await resolveInitialProfile("review", context());

			expect(plan.mcps).toBeUndefined();
		});
	});
});


describe("diagnostic MCP discovery during initial resolution", () => {
	it.each([{}, { mcp_tools: {} }, { mcps: [] }, { mcps: ["kept", "missing"] }, { mcp_tools: { kept: [] } }])("skips malformed user sources and retains declared policy %j", async (definition) => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const valid = path.join(fixture.root, ".agents", "mcp.json");
		await writeFile(valid, JSON.stringify({ mcpServers: { kept: { command: "fixture" }, unselected: { command: "other" } } }));
		const invalid = path.join(fixture.agentDir, "mcp.json");
		await writeFile(invalid, "{ broken");
		await writeCatalog({ review: definition });
		const { plan, warnings } = await resolveInitialProfile("review", context());
		expect(warnings.filter((warning) => warning.includes(invalid))).toHaveLength(1);
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ kind: "mcp-source", filePath: invalid, message: expect.stringContaining("source skipped") }));
		if ("mcps" in definition) expect(plan.mcps).toEqual(definition.mcps?.length ? ["kept"] : []);
		else expect(plan.mcps).toBeUndefined();
		if ("mcp_tools" in definition && Object.keys(definition.mcp_tools ?? {}).length > 0) expect(plan.mcpTools).toEqual(definition.mcp_tools);
		expect(await readFile(invalid, "utf8")).toBe("{ broken");
	});

	it.each([{}, { mcps: ["kept"] }, { mcp_tools: { kept: [] } }])("diagnoses malformed trusted-project classification without controlling that file %j", async (definition) => {
		await writeMcpConfig({ kept: { command: "fixture" } });
		const file = path.join(fixture.cwd, ".pi", "mcp.json");
		await writeFile(file, '{"mcpServers":[]}');
		await writeCatalog({ review: definition });
		const { plan, warnings } = await resolveInitialProfile("review", { ...context(), trustOverride: true });
		expect(warnings.join("\n")).toContain(file);
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ filePath: file }));
		expect(await readFile(file, "utf8")).toBe('{"mcpServers":[]}');
	});

	it("does not read untrusted project MCP classification", async () => {
		await writeCatalog({ review: { mcps: [] } });
		const file = path.join(fixture.cwd, ".pi", "mcp.json");
		await writeFile(file, "{ malformed");
		const read = vi.spyOn(jsonFile, "readJsonFile");
		const { warnings } = await resolveInitialProfile("review", { ...context(), trustOverride: false });
		expect(read.mock.calls.map(([source]) => source)).not.toContain(file);
		expect(warnings.join("\n")).not.toContain(file);
	});

	it("retains source-disabled servers without enabling them", async () => {
		await writeMcpConfig({ disabled: { command: "fixture", enabled: false } });
		await writeCatalog({ review: { mcps: ["disabled"], mcp_tools: { disabled: [] } } });
		const { plan, warnings } = await resolveInitialProfile("review", context());
		expect(plan.mcps).toEqual([]);
		expect(plan.mcpTools).toEqual({ disabled: [] });
		expect(plan.instanceMcpConfig?.mcpServers).toEqual({ disabled: { command: "fixture", enabled: false } });
		expect(warnings.join("\n")).toContain("enable it");
	});
});
