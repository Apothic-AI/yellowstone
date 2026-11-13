import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiscoveredExtensions } from "../src/extension-discovery.ts";
import type { ProfileDefinition } from "../src/profile-catalog.ts";
import { compositionMetadata, composeProfileDefinitions } from "../src/profile-composition.ts";
import { loadMergedMcpServers, type MergedMcpResult } from "../src/mcp-config.ts";
import { defaultPlan, resolveProfile } from "../src/profile-resolver.ts";
import { discoverSkills, type SkillEntry } from "../src/skill-registry.ts";
import { generateRuntimeDir, writeRuntimeFiles } from "../src/settings-generator.ts";
import { resolveModelProfileInNode } from "./helpers/model-profile-runner.ts";
import { runLauncher } from "./helpers/launcher-runner.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("generateRuntimeDir (default profile)", () => {
	it("preserves user settings keys and re-includes the real agent dir's resource dirs", async () => {
		const settings = { defaultModel: "claude-sonnet-4-5", theme: "dark", customKey: { nested: true } };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(settings));
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const generated = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));

		expect(generated.defaultModel).toBe("claude-sonnet-4-5");
		expect(generated.customKey).toEqual({ nested: true });
		// The discovery root moved with PI_CODING_AGENT_DIR, so the real
		// agent dir's skills dir must be re-included explicitly.
		expect(generated.skills).toContain(path.join(fixture.agentDir, "skills"));
	});

	it("preserves native settings-only extension paths and relative resource paths", async () => {
		const settingsOnly = "/opt/pi-resources/review-guard/index.ts";
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ extensions: [settingsOnly, "./extra.ts"] }),
		);
		await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const generated = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));

		// The ordinary default path stays the regression baseline: native entries
		// and their relative meaning are preserved verbatim.
		expect(generated.extensions).toEqual([settingsOnly, "./extra.ts", path.join(fixture.agentDir, "extensions")]);
	});

	it("writes an empty settings object when the user has none", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"))).toEqual({});
	});

	it("returns an empty warnings list for valid sources", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(result.warnings).toEqual([]);
	});

	it("does not set defaultProjectTrust for the default profile", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const settings = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));
		expect(settings.defaultProjectTrust).toBeUndefined();
	});

	it("symlinks trust/auth/models state back to the real agent dir", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "models.json"), "{}");

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		for (const name of ["auth.json", "trust.json", "models.json"]) {
			expect(await realpath(path.join(result.runtimeDir, name))).toBe(await realpath(path.join(fixture.agentDir, name)));
		}
	});

	it("points PI_CODING_AGENT_DIR at the runtime dir and symlinks sessions without overriding session dir", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(result.env.PI_CODING_AGENT_DIR).toBe(result.runtimeDir);
		expect(result.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
		expect(await realpath(path.join(result.runtimeDir, "sessions"))).toBe(
			await realpath(path.join(fixture.agentDir, "sessions")),
		);
	});

	it("ensures agentDir/sessions exists and is symlinked even if not initially present", async () => {
		expect(existsSync(path.join(fixture.agentDir, "sessions"))).toBe(false);
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(existsSync(path.join(fixture.agentDir, "sessions"))).toBe(true);
		expect(await realpath(path.join(result.runtimeDir, "sessions"))).toBe(
			await realpath(path.join(fixture.agentDir, "sessions")),
		);
	});

	it("creates a unique runtime dir per launch under the instances root", async () => {
		const first = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const second = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		const root = path.join(fixture.profileSwitchDir, "instances");
		for (const result of [first, second]) {
			expect(path.dirname(result.runtimeDir)).toBe(root);
			expect(path.basename(result.runtimeDir).startsWith("launch-")).toBe(true);
		}
		expect(first.runtimeDir).not.toBe(second.runtimeDir);
	});

	it("seeds the real agent dir's missions store and links it into the instance", async () => {
		expect(existsSync(path.join(fixture.agentDir, "missions"))).toBe(false);

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		expect(existsSync(path.join(fixture.agentDir, "missions"))).toBe(true);
		expect(await realpath(path.join(result.runtimeDir, "missions"))).toBe(
			await realpath(path.join(fixture.agentDir, "missions")),
		);
	});

	it("links an existing missions store without touching its content", async () => {
		const store = path.join(fixture.agentDir, "missions", "projects", "abc");
		await mkdir(store, { recursive: true });
		const record = path.join(store, "mission.json");
		await writeFile(record, "{}");

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		expect(await realpath(path.join(result.runtimeDir, "missions"))).toBe(
			await realpath(path.join(fixture.agentDir, "missions")),
		);
		expect(await readFile(record, "utf8")).toBe("{}");
	});

	it("links the runtime state files Pi creates, even before they exist", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		for (const name of ["auth.json", "models-store.json"]) {
			const linkPath = path.join(result.runtimeDir, name);
			expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
			expect(await readlink(linkPath)).toBe(path.join(fixture.agentDir, name));
			// Deliberately dangling: the content is Pi's to create, not pi-profile's.
			expect(existsSync(path.join(fixture.agentDir, name))).toBe(false);
		}
	});

	it("routes writes through the seeded links into the real agent dir", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		await writeFile(path.join(result.runtimeDir, "auth.json"), "{}");

		expect(await readFile(path.join(fixture.agentDir, "auth.json"), "utf8")).toBe("{}");
		expect((await lstat(path.join(result.runtimeDir, "auth.json"))).isSymbolicLink()).toBe(true);
	});

	it("links an existing state file to the real one", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), '{"provider":{}}');

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		const linkPath = path.join(result.runtimeDir, "auth.json");
		expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await realpath(linkPath)).toBe(await realpath(path.join(fixture.agentDir, "auth.json")));
	});

	it("keeps the seeded links when the runtime dir is rewritten in place", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		await writeRuntimeFiles(result.runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });

		for (const name of ["auth.json", "models-store.json"]) {
			expect((await lstat(path.join(result.runtimeDir, name))).isSymbolicLink()).toBe(true);
		}
	});

	it("cleans up dangling symlinks when the runtime dir is rewritten in place (switch path)", async () => {
		const tempFile = path.join(fixture.agentDir, "temp-file.txt");
		await writeFile(tempFile, "hello");

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const linkedPath = path.join(result.runtimeDir, "temp-file.txt");
		expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);

		// Delete the source and rewrite the SAME runtime dir (what an in-session
		// switch does: PI_CODING_AGENT_DIR cannot move).
		await rm(tempFile);
		await writeRuntimeFiles(result.runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });
		await expect(lstat(linkedPath)).rejects.toThrow();
	});

	it("materializes sparse native overrides and carries only the declaration in the launch plan", async () => {
		const settingsPath = path.join(fixture.agentDir, "settings.json");
		const nativeText = JSON.stringify({ subagents: { defaultModel: "base", agentOverrides: {
			reviewer: { model: "old", inheritedContext: true }, scout: { model: "scout" },
		} } });
		await writeFile(settingsPath, nativeText);
		const agentsDir = path.join(fixture.agentDir, "agents");
		await mkdir(agentsDir, { recursive: true });
		const agentFile = path.join(agentsDir, "reviewer.md");
		await writeFile(agentFile, "native agent bytes\n");
		const declaration = { agentOverrides: { reviewer: { model: "new", advertise: false } } };
		const result = await generateRuntimeDir({ ...defaultPlan(), subagents: declaration }, { agentDir: fixture.agentDir });
		const generated = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));
		const launchPlan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(generated.subagents.agentOverrides).toEqual({
			reviewer: { model: "new", inheritedContext: true, advertise: false }, scout: { model: "scout" },
		});
		expect(launchPlan.subagents).toEqual(declaration);
		expect(Object.keys(launchPlan).filter((key) => key.includes("subagent"))).toEqual(["subagents"]);
		expect(await readFile(settingsPath, "utf8")).toBe(nativeText);
		expect(await readFile(agentFile, "utf8")).toBe("native agent bytes\n");
	});

	it("prepares subagent shape failures before changing managed runtime files", async () => {
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ subagents: { agentOverrides: { reviewer: false } } }));
		const runtimeDir = path.join(fixture.root, "runtime");
		await mkdir(runtimeDir, { recursive: true });
		const sentinelSettings = "settings sentinel";
		const sentinelPlan = "plan sentinel";
		await writeFile(path.join(runtimeDir, "settings.json"), sentinelSettings);
		await writeFile(path.join(runtimeDir, "pi-profile.json"), sentinelPlan);
		await expect(writeRuntimeFiles(runtimeDir, { ...defaultPlan(), subagents: { agentOverrides: { reviewer: { model: "x" } } } }, { agentDir: fixture.agentDir }))
			.rejects.toThrow(/settings\.json.*subagents\.agentOverrides\.reviewer.*correct/);
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(sentinelSettings);
		expect(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8")).toBe(sentinelPlan);
	});
});


describe("native model declaration inputs", () => {
	const native = { defaultProvider: "native-provider", defaultModel: "native-model", defaultThinkingLevel: "low", theme: "dark" };

	async function materialize(definition: ProfileDefinition): Promise<Record<string, unknown>> {
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(native));
		const plan = definition.defaultProvider !== undefined && definition.defaultModel !== undefined && definition.defaultThinkingLevel !== undefined
			? await resolveModelProfileInNode(definition)
			: await resolveProfile({ profile: { name: "review", source: "global", definition }, skills: [], extensions: new DiscoveredExtensions([], [], []) });
		const { runtimeDir } = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, homeDir: fixture.root, discovery: { skills: [], packages: [] } });
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8")).toBe(JSON.stringify(native));
		expect(settings.theme).toBe("dark");
		return settings;
	}

	it("hands complete model declarations to Pi without registry/auth preflight", async () => {
		const settings = await materialize({ defaultProvider: "extension-provider", defaultModel: "local-model", defaultThinkingLevel: "high" });
		expect(settings.defaultProvider).toBe("extension-provider");
		expect(settings.defaultModel).toBe("local-model");
		expect(settings.defaultThinkingLevel).toBe("high");
	});

	it.each([undefined, "extreme"])("preserves native thinking when the complete model contributes no supported thinking (%s)", async (thinking) => {
		const settings = await materialize({ defaultProvider: "extension-provider", defaultModel: "local-model", ...(thinking !== undefined ? { defaultThinkingLevel: thinking } : {}) });
		expect(settings.defaultProvider).toBe("extension-provider");
		expect(settings.defaultModel).toBe("local-model");
		expect(settings.defaultThinkingLevel).toBe(native.defaultThinkingLevel);
	});

	it.each([{}, { defaultThinkingLevel: "extreme" }, { defaultProvider: "profile-provider", defaultThinkingLevel: "extreme" }, { defaultModel: "profile-model", defaultThinkingLevel: "extreme" }])("keeps undeclared and incomplete native model inputs unchanged %j", async (definition) => {
		const settings = await materialize(definition);
		for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const) expect(settings[key]).toBe(native[key]);
	});

	it("does not delete native thinking even for an already-resolved plan without thinking", async () => {
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(native));
		const plan = { ...defaultPlan(), profile: "review", source: "global" as const, filter: "selection" as const, model: { provider: "extension-provider", id: "local-model" } };
		const { runtimeDir } = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, homeDir: fixture.root, discovery: { skills: [], packages: [] } });
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.defaultThinkingLevel).toBe(native.defaultThinkingLevel);
	});

	// A per-model startup pin outranks defaultThinkingLevel in Pi, and the copy the
	// generator starts from carries the user's pins into every instance. A pin for
	// the model a profile declares would therefore beat the profile's own level on
	// every session start, so it is not inherited for that model alone.
	describe("inherited per-model startup pins", () => {
		const pinned = {
			...native,
			modelThinkingLevels: {
				"extension-provider/local-model": "max",
				"extension-provider/other-model": "medium",
			},
		};

		async function withPins(definition: ProfileDefinition): Promise<Record<string, unknown>> {
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(pinned));
			const plan = await resolveModelProfileInNode(definition);
			const { runtimeDir } = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, homeDir: fixture.root, discovery: { skills: [], packages: [] } });
			const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
			// The user's real settings file is never rewritten.
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8"))).toEqual(pinned);
			return settings;
		}

		it("drops the pin for the profile's own model when it disagrees with the declared level", async () => {
			const settings = await withPins({ defaultProvider: "extension-provider", defaultModel: "local-model", defaultThinkingLevel: "high" });
			expect(settings.defaultThinkingLevel).toBe("high");
			const pins = settings.modelThinkingLevels as Record<string, string>;
			expect(pins["extension-provider/local-model"]).toBeUndefined();
			expect(pins["extension-provider/other-model"]).toBe("medium");
		});

		it("leaves every pin alone when the plan declares no thinking level", async () => {
			const settings = await withPins({ defaultProvider: "extension-provider", defaultModel: "local-model" });
			expect(settings.modelThinkingLevels).toEqual(pinned.modelThinkingLevels);
			expect(settings.defaultThinkingLevel).toBe(native.defaultThinkingLevel);
		});

		it("leaves a matching pin and other models' pins in place", async () => {
			const settings = await withPins({ defaultProvider: "extension-provider", defaultModel: "local-model", defaultThinkingLevel: "max" });
			expect(settings.modelThinkingLevels).toEqual(pinned.modelThinkingLevels);
		});
	});
});


describe("launcher activation diagnostic deduplication", () => {
	it("prints resolution/generation warnings once on stderr and stores them for status", { timeout: 45_000 }, async () => {
		const dir = path.join(fixture.profileSwitchDir, "profiles");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "review.json"), '{"skills":["missing"],"mcps":[],"unknownField":"ignored"}');
		const malformed = path.join(fixture.agentDir, "mcp.json");
		await writeFile(malformed, "{ bad");
		const output = await runLauncher(fixture, ["review", "--", "--version"]);
		expect(output.code).toBe(0);
		const warnings = output.stderr.split("\n").filter((line) => line.startsWith("pi-profile: warning:"));
		expect(warnings.filter((line) => line.includes(malformed))).toHaveLength(1);
		expect(warnings.filter((line) => line.includes('unknown skill "missing"'))).toHaveLength(1);
		expect(warnings.filter((line) => line.includes('unknown field "unknownField"'))).toHaveLength(1);
		expect(output.stdout).not.toContain("warning");
	});
});

/**
 * FT54 S2 §3.3 — provenance reaches the plan file by pass-through only.
 *
 * The recorded pre-change file below was produced by this same write path at
 * the accepted S1 tip before any S2 edit
 * (`2ae6f74e1fefbe76dd16708df4b1e98ebbda312d`), with the fixture dirs
 * normalized to placeholders. It is compared byte-for-byte.
 */
const RECORDED_PRE_CHANGE_PLAN_FILE = `{
  "profile": "capture",
  "source": "global",
  "agentDir": "<agentDir>",
  "tools": [
    "read",
    "lint-fix"
  ],
  "toolReferences": [
    "read",
    "lint-fix"
  ],
  "resolved": {
    "skills": [
      {
        "name": "alpha",
        "filePath": "/agent/skills/alpha/SKILL.md"
      }
    ],
    "extensions": []
  }
}
`;

describe("composed plan provenance pass-through (FT54 S2 §3.3)", () => {
	const fixedSkill = (name: string): SkillEntry => ({
		name,
		filePath: `/agent/skills/${name}/SKILL.md`,
		source: "auto",
		scope: "user",
		origin: "top-level",
	});

	it("carries composition, per-kind intent, and the provenance maps for a composed plan", async () => {
		const paths = { globalPath: "/global/leader.json", projectPath: "/project/.pi/profiles/leader.json" };
		const composed = composeProfileDefinitions(
			{ skills: ["alpha"], tools: ["read"] },
			{ promptStrategy: "append", skills: ["beta"], tools: ["lint-fix"] },
			paths,
		);
		const plan = await resolveProfile({
			profile: {
				name: "composed",
				source: "project",
				definition: composed.definition,
				composition: compositionMetadata(composed, paths),
			},
			skills: [fixedSkill("alpha"), fixedSkill("beta"), fixedSkill("gamma")],
			extensions: new DiscoveredExtensions([], [], []),
			referenceContributors: composed.referenceContributors,
		});

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir });
		const written = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));

		expect(written.composition).toMatchObject({
			strategy: "append",
			branch: "composed",
			globalPath: paths.globalPath,
			projectPath: paths.projectPath,
		});
		expect(written.resourceSelection).toEqual({ skills: true, extensions: false });
		expect(written.origins).toEqual({ skills: { alpha: "global", beta: "project" } });
		expect(written.toolOrigins).toEqual({ read: { contributors: "global", state: "resolved", at: "boot" } });
		expect(written.pendingToolReferences).toEqual([
			{ reference: "lint-fix", contributors: "project", resolvesAt: "session-start" },
		]);
		// No extension was declared and none was selected: no provenance field.
		expect(written.extensionOrigins).toBeUndefined();
	});

	it("leaves an uncomposed plan file byte-identical to the recorded pre-change output", async () => {
		const plan = await resolveProfile({
			profile: { name: "capture", source: "global", definition: { skills: ["alpha"], tools: ["read", "lint-fix"] } },
			skills: [fixedSkill("alpha"), fixedSkill("beta")],
			extensions: new DiscoveredExtensions([], [], []),
		});
		// No contributor input: the trace is inactive and no field is added.
		expect(plan.origins).toBeUndefined();

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir });
		const text = await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8");
		const normalized = text
			.replaceAll(result.runtimeDir, "<runtimeDir>")
			.replaceAll(fixture.agentDir, "<agentDir>");
		expect(normalized).toBe(RECORDED_PRE_CHANGE_PLAN_FILE);
	});
});

describe("composed generator preservation and the 13-skill baseline (FT54 S3 §6)", () => {
	/** The operator's stated baseline: thirteen skills. The number is encoded in
	 *  this fixture, not read from any live state; confirming it against a live
	 *  profile is a later SI-authorised canary, and the number is neither
	 *  deleted nor redefined here. */
	const BASELINE_SKILL_COUNT = 13;
	const baselineSkills = Array.from(
		{ length: BASELINE_SKILL_COUNT },
		(_, index) => `baseline-skill-${String(index + 1).padStart(2, "0")}`,
	);

	async function discoverFixtureSkills(): Promise<SkillEntry[]> {
		return await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: true });
	}

	it("a project half that adds one skill leaves the global tools allowlist verbatim", async () => {
		for (const name of baselineSkills) await addGlobalSkill(fixture, name);
		await addGlobalSkill(fixture, "added-skill");
		const discovered = await discoverFixtureSkills();

		const globalPlan = await resolveProfile({
			profile: {
				name: "leader",
				source: "global",
				definition: { skills: baselineSkills, tools: ["read", "grep"] },
			},
			skills: discovered,
			extensions: new DiscoveredExtensions([], [], []),
		});
		const paths = { globalPath: "/global/leader.json", projectPath: "/project/.pi/profiles/leader.json" };
		const composed = composeProfileDefinitions(
			{ skills: baselineSkills, tools: ["read", "grep"] },
			{ promptStrategy: "append", skills: ["added-skill"] },
			paths,
		);
		const composedPlan = await resolveProfile({
			profile: {
				name: "leader",
				source: "project",
				definition: composed.definition,
				composition: compositionMetadata(composed, paths),
			},
			skills: discovered,
			extensions: new DiscoveredExtensions([], [], []),
			referenceContributors: composed.referenceContributors,
		});

		// The global tools allowlist is verbatim: the project half declared no
		// tools, so it cannot narrow them.
		expect(composedPlan.tools).toEqual(globalPlan.tools);
		// Every global skill is still selected, and the added one is selected
		// exactly once.
		expect(composedPlan.skills.filter((skill) => baselineSkills.includes(skill.name))).toHaveLength(
			BASELINE_SKILL_COUNT,
		);
		expect(composedPlan.skills.filter((skill) => skill.name === "added-skill")).toHaveLength(1);
		// The dynamic assertion: the selection is exactly the discovered
		// eligible skills the composed profile names.
		const named = new Set([...baselineSkills, "added-skill"]);
		expect(composedPlan.skills.map((skill) => skill.name).sort()).toEqual(
			discovered.filter((skill) => named.has(skill.name)).map((skill) => skill.name).sort(),
		);

		const result = await generateRuntimeDir(composedPlan, {
			agentDir: fixture.agentDir,
			discovery: { skills: discovered, packages: [] },
		});
		const settings = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));
		const entries = ((settings.skills ?? []) as unknown[]).map((entry) => String(entry));
		// The added skill is in the generated allowlist exactly once.
		expect(entries.filter((entry) => entry.includes("added-skill"))).toHaveLength(1);
	});

	it("a declared empty base is widened by the project half", async () => {
		await addGlobalSkill(fixture, "widened-skill");
		const discovered = await discoverFixtureSkills();
		const paths = { globalPath: "/global/leader.json", projectPath: "/project/.pi/profiles/leader.json" };
		const composed = composeProfileDefinitions(
			{ skills: [] },
			{ promptStrategy: "append", skills: ["widened-skill"] },
			paths,
		);
		const plan = await resolveProfile({
			profile: {
				name: "leader",
				source: "project",
				definition: composed.definition,
				composition: compositionMetadata(composed, paths),
			},
			skills: discovered,
			extensions: new DiscoveredExtensions([], [], []),
			referenceContributors: composed.referenceContributors,
		});
		// An empty list is a declared selection of nothing, so the project half
		// widens it instead of failing to apply.
		expect(composed.unapplied).toEqual([]);
		expect(plan.resourceSelection.skills).toBe(true);
		expect(plan.skills.map((skill) => skill.name)).toEqual(["widened-skill"]);
	});

	it("an empty project list contributes nothing", async () => {
		await addGlobalSkill(fixture, "base-skill");
		const discovered = await discoverFixtureSkills();
		const paths = { globalPath: "/global/leader.json", projectPath: "/project/.pi/profiles/leader.json" };
		const composed = composeProfileDefinitions(
			{ skills: ["base-skill"] },
			{ promptStrategy: "append", skills: [] },
			paths,
		);
		const plan = await resolveProfile({
			profile: {
				name: "leader",
				source: "project",
				definition: composed.definition,
				composition: compositionMetadata(composed, paths),
			},
			skills: discovered,
			extensions: new DiscoveredExtensions([], [], []),
			referenceContributors: composed.referenceContributors,
		});
		expect(composed.unapplied).toEqual([]);
		expect(plan.skills.map((skill) => skill.name)).toEqual(["base-skill"]);
	});

	it("an omitted mcp_tools in the global half is not narrowed by a project entry", async () => {
		const paths = { globalPath: "/global/leader.json", projectPath: "/project/.pi/profiles/leader.json" };
		const composed = composeProfileDefinitions(
			{ skills: [], mcp_tools: { known: ["tool-a"] } },
			{ promptStrategy: "append", mcp_tools: { unknown: ["tool-b"] } },
			paths,
		);
		// The global half's per-server policy is unchanged ...
		expect(composed.definition.mcp_tools).toEqual({ known: ["tool-a"] });
		// ... and the project entry is reported, never applied.
		expect(composed.unapplied).toEqual([{ kind: "mcp_tools", reference: "unknown", scope: "project" }]);
		expect(composed.diagnostics.map((entry) => entry.code)).toContain("append-cannot-narrow");

		// The real merged MCP discovery: the fixture's own mcp.json is the
		// source of both servers.
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					known: { command: "known" },
					unknown: { command: "unknown" },
				},
			}),
		);
		const mcpDiscovery: MergedMcpResult = await loadMergedMcpServers(fixture.agentDir, fixture.cwd, {
			invalidSource: "diagnose",
		});
		const plan = await resolveProfile({
			profile: {
				name: "leader",
				source: "project",
				definition: composed.definition,
				composition: compositionMetadata(composed, paths),
			},
			skills: [],
			extensions: new DiscoveredExtensions([], [], []),
			discoveredMcpServers: Object.keys(mcpDiscovery.servers).sort(),
			mcpDiscovery,
			referenceContributors: composed.referenceContributors,
		});
		expect(plan.mcpTools).toEqual({ known: ["tool-a"] });

		const result = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		const instance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		// The instance keeps the base policy only. The project entry introduced a
		// restriction the base does not have, so it was never applied: that
		// server keeps its native exposure.
		expect(instance.mcpServers.known.toolExposure).toEqual({ "*": "hidden", "tool-a": "direct" });
		expect(instance.mcpServers.unknown.toolExposure).toBeUndefined();
	});
});
