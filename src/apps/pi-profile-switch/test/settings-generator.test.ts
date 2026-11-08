import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiscoveredExtensions } from "../src/extension-discovery.ts";
import type { ProfileDefinition } from "../src/profile-catalog.ts";
import { defaultPlan, resolveProfile } from "../src/profile-resolver.ts";
import { generateRuntimeDir, writeRuntimeFiles } from "../src/settings-generator.ts";
import { resolveModelProfileInNode } from "./helpers/model-profile-runner.ts";
import { runLauncher } from "./helpers/launcher-runner.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

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
