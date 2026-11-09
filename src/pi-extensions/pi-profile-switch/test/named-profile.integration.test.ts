import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncher, runLauncherRpc } from "./helpers/launcher-runner.ts";
import { runNativePi } from "./helpers/native-pi-runner.ts";
import { addGlobalSkill, createPiFixture, listFiles, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

/** An extension entry file that registers a same-named command and leaves a
 *  top-level side-effect marker if its code ever executes. */
async function addExtensionEntry(name: string): Promise<string> {
	const dir = path.join(fixture.agentDir, "extensions");
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.ts`);
	await writeFile(
		file,
		[
			`import { writeFileSync } from "node:fs";`,
			`writeFileSync(${JSON.stringify(path.join(fixture.root, `EXECUTED-${name}`))}, "ran");`,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.registerCommand("${name}", { description: "${name} command", handler: async () => {} });`,
			`}`,
			"",
		].join("\n"),
	);
	return file;
}

async function addAgentsSkill(name: string): Promise<void> {
	const dir = path.join(fixture.root, ".agents", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: agents skill ${name}\n---\n`);
}

describe("launcher integration: named global profiles", () => {
	it(
		"pi-profile <name> exposes only the profile's resolved skills and extensions",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addAgentsSkill("shared-skill");
			await addAgentsSkill("secret-skill");
			const selectedEntry = await addExtensionEntry("selected-ext");
			const unselectedEntry = await addExtensionEntry("unselected-ext");
			const unregisteredEntry = await addExtensionEntry("unregistered-ext");
			await writeCatalog({
				review: { skills: ["alpha-skill", "shared-skill"], extensions: ["selected-ext"] },
			});
			void unregisteredEntry;

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				const commands = await rpc.commandNames();
				const names = commands.map((command) => command.name);
				// Selected skills are visible; unselected ones are not.
				expect(names).toContain("skill:alpha-skill");
				expect(names).toContain("skill:shared-skill");
				expect(names).not.toContain("skill:beta-skill");
				expect(names).not.toContain("skill:secret-skill");
				// Selected extension code runs; unselected/unregistered does not.
				expect(commands.some((command) => command.name === "selected-ext" && command.source === "extension")).toBe(true);
				expect(names).not.toContain("unselected-ext");
				expect(names).not.toContain("unregistered-ext");
			} catch(e) { console.error("STDERR:", rpc.stderr); throw e; } finally {
				await rpc.close();
			}

			const { existsSync } = await import("node:fs");
			expect(existsSync(path.join(fixture.root, "EXECUTED-unselected-ext"))).toBe(false);
			expect(existsSync(path.join(fixture.root, "EXECUTED-unregistered-ext"))).toBe(false);
		},
	);

	it(
		"keeps skills hidden by the user's own settings exclusions hidden",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "kept-skill");
			await addGlobalSkill(fixture, "hidden-skill");
			await addAgentsSkill("hidden-agents-skill");
			await writeFile(
				path.join(fixture.agentDir, "settings.json"),
				JSON.stringify({ skills: ["!skills/**", "+skills/kept-skill/SKILL.md"] }),
			);
			await writeCatalog({ review: { skills: ["*"] } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				const names = await rpc.skillCommandNames();
				expect(names).toContain("skill:kept-skill");
				expect(names).not.toContain("skill:hidden-skill");
				expect(names).not.toContain("skill:hidden-agents-skill");
			} catch(e) { console.error("STDERR:", rpc.stderr); throw e; } finally {
				await rpc.close();
			}
		},
	);

	it(
		"restores the saved active profile when no positional name is given",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });
			await writeFile(
				path.join(fixture.agentDir, "pi-profile-state.json"),
				JSON.stringify({ activeProfile: "review" }),
			);

			const rpc = runLauncherRpc(fixture, ["--", "--mode", "rpc"]);
			try {
				const names = await rpc.skillCommandNames();
				expect(names).toContain("skill:alpha-skill");
				expect(names).not.toContain("skill:beta-skill");
			} catch(e) { console.error("STDERR:", rpc.stderr); throw e; } finally {
				await rpc.close();
			}
		},
	);

	it(
		"re-expands skill globs on every start",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "research-web");
			await writeCatalog({ research: { skills: ["research-*"] } });

			const first = runLauncherRpc(fixture, ["research", "--", "--mode", "rpc"]);
			try {
				expect(await first.skillCommandNames()).toEqual(["skill:research-web"]);
			} catch(e) { console.error("STDERR:", first.stderr); throw e; } finally {
				await first.close();
			}

			// A new matching skill appears after the first launch resolved the glob.
			await addGlobalSkill(fixture, "research-docs");
			const second = runLauncherRpc(fixture, ["research", "--", "--mode", "rpc"]);
			try {
				expect(await second.skillCommandNames()).toEqual(["skill:research-docs", "skill:research-web"]);
			} catch(e) { console.error("STDERR:", second.stderr); throw e; } finally {
				await second.close();
			}
		},
	);

	it(
		"applies the declared model and thinking level via generated settings",
		{ timeout: 45_000 },
		async () => {
			await writeFile(
				path.join(fixture.agentDir, "models.json"),
				JSON.stringify({
					providers: {
						testprov: {
							baseUrl: "http://localhost:9/v1",
							api: "openai-completions",
							apiKey: "static-key",
							models: [{ id: "test-model", reasoning: true }],
						},
					},
				}),
			);
			await writeCatalog({ focused: { defaultProvider: "testprov", defaultModel: "test-model", defaultThinkingLevel: "high" } });

			const rpc = runLauncherRpc(fixture, ["focused", "--", "--mode", "rpc"]);
			try {
				const state = await rpc.send({ type: "get_state" });
				const model = state.data?.model as { provider: string; id: string } | undefined;
				expect(model?.provider).toBe("testprov");
				expect(model?.id).toBe("test-model");
				expect(state.data?.thinkingLevel).toBe("high");
			} catch(e) { console.error("STDERR:", rpc.stderr); throw e; } finally {
				await rpc.close();
			}
		},
	);

	it(
		"appends declared instructions to the system prompt before the first agent turn",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeFile(
				path.join(fixture.agentDir, "models.json"),
				JSON.stringify({
					providers: {
						testprov: {
							baseUrl: "http://localhost:9/v1",
							api: "openai-completions",
							apiKey: "static-key",
							models: [{ id: "test-model" }],
						},
					},
				}),
			);
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
			await writeCatalog({
				review: { skills: ["alpha-skill"], instructions: "PROFILE INSTRUCTIONS MARKER" },
			});
			// Probe extension loaded after pi-profile captures the chained system prompt.
			const captureFile = path.join(fixture.root, "captured-prompt.txt");
			const probe = path.join(fixture.root, "probe.ts");
			await writeFile(
				probe,
				[
					`import { writeFileSync } from "node:fs";`,
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
					`export default function (pi: ExtensionAPI) {`,
					`\tpi.on("before_agent_start", (event) => {`,
					`\t\twriteFileSync(${JSON.stringify(captureFile)}, event.systemPrompt);`,
					`\t});`,
					`}`,
					"",
				].join("\n"),
			);

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc", "-e", probe]);
			try {
				// The prompt fails fast (unreachable fixture provider, retries off),
				// but before_agent_start has already fired by then.
				await rpc.send({ type: "prompt", message: "hello" }, 15_000).catch(() => undefined);
				await new Promise((resolve) => setTimeout(resolve, 2_000));
			} catch(e) { console.error("STDERR:", rpc.stderr); throw e; } finally {
				await rpc.close();
			}

			const prompt = await readFile(captureFile, "utf8");
			expect(prompt).toContain("PROFILE INSTRUCTIONS MARKER");
			// The model only sees the selected skill in the system prompt…
			expect(prompt).toContain("alpha-skill");
			expect(prompt).not.toContain("beta-skill");
		},
	);

	it("delegates an unauthenticated declaration to equivalent native Pi behavior", { timeout: 45_000 }, async () => {
		const declaration = { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" };
		await writeCatalog({ broken: declaration });
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(declaration));
		const native = await runNativePi(fixture, ["--mode", "rpc"]);
		await writeFile(path.join(fixture.agentDir, "settings.json"), "{}");
		const actual = await runLauncher(fixture, ["broken", "--", "--mode", "rpc"]);
		expect(actual.code).toBe(native.code);
		expect(native.signal).toBeNull();
		expect(actual.stderr).not.toMatch(/pi-profile:.*(?:credentials|model.*validat)/i);
	});

	it(
		"warns and starts with an empty effective unknown-extension selection",
		{ timeout: 30_000 },
		async () => {
			await writeCatalog({ review: { extensions: ["nonexistent-ext"] } });

			const failure = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);

			expect(failure.code).toBe(0);
			expect(failure.stderr).toContain('unknown extension: "nonexistent-ext"');
		},
	);

	it(
		"writes no runtime state and leaves user files untouched for positional launches",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });
			const userSettings = { customKey: "keep-me" };
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(userSettings));
			const agentDirBefore = await listFiles(fixture.agentDir);

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				await rpc.commandNames();
			} catch(e) { console.error("STDERR:", rpc.stderr); throw e; } finally {
				await rpc.close();
			}

			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8"))).toEqual(userSettings);
			const agentDirAfter = await listFiles(fixture.agentDir);
			const created = agentDirAfter.filter((file) => !agentDirBefore.includes(file));
			for (const file of created) {
				const relative = path.relative(fixture.agentDir, file);
				// Only Pi's own session storage, the state paths pi-profile seeds
				// (so Pi writes them into the real agent dir rather than the instance),
				// and the profile-config skill the launcher distributes on startup
				// (spec: Distributing the profile-config skill).
				expect(
					["sessions", "missions", "auth.json", "models-store.json", `skills${path.sep}profile-config`].some(
						(seed) => relative === seed || relative.startsWith(`${seed}${path.sep}`),
					),
				).toBe(true);
			}
			const files = await listFiles(fixture.root);
			expect(files.filter((file) => file.endsWith("pi-profile-state.json"))).toEqual([]);
		},
	);
});


describe("real restrictive partial resource discovery", () => {
	it.each([false, true])("keeps missing-only/partial user selections restrictive (partial=%s), preserves project resources and source files", { timeout: 90_000 }, async (partial) => {
		await addGlobalSkill(fixture, "selected-skill"); await addGlobalSkill(fixture, "unselected-skill");
		await addAgentsSkill("unselected-home");
		await addExtensionEntry("selected-ext"); await addExtensionEntry("unselected-ext");
		const pkg = path.join(fixture.root, "resource-package");
		await mkdir(path.join(pkg, "skills", "package-skill"), { recursive: true });
		await writeFile(path.join(pkg, "skills", "package-skill", "SKILL.md"), "---\nname: package-skill\ndescription: package skill\n---\n");
		await writeFile(path.join(pkg, "index.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path.join(fixture.root, "EXECUTED-package-ext"))}, "ran"); export default function(pi) { pi.registerCommand("package-ext", { handler: async () => {} }); }`);
		await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "resource-package", version: "1.0.0", pi: { extensions: ["./index.ts"], skills: ["./skills"] } }));
		const settingsFile = path.join(fixture.agentDir, "settings.json");
		const settings = JSON.stringify({ packages: [pkg], customKey: "unchanged" });
		await writeFile(settingsFile, settings);
		const projectSkill = path.join(fixture.cwd, ".pi", "skills", "project-skill");
		await mkdir(projectSkill, { recursive: true });
		await writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: project-skill\ndescription: project skill\n---\n");
		await mkdir(path.join(fixture.cwd, ".pi", "extensions"), { recursive: true });
		await writeFile(path.join(fixture.cwd, ".pi", "extensions", "project-ext.ts"), 'export default function(pi) { pi.registerCommand("project-ext", { handler: async () => {} }); }');
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		await writeCatalog({ partial: { skills: ["missing-skill", ...(partial ? ["selected-skill"] : [])], extensions: ["missing-ext", ...(partial ? ["selected-ext"] : [])] }, invalid: { skills: 1 } });
		const dir = path.join(fixture.profileSwitchDir, "profiles");
		await writeFile(path.join(dir, "corrupt.json"), "{ bad"); await writeFile(path.join(dir, "default.json"), "{ bad");
		const profileFile = path.join(dir, "partial.json"); const original = await readFile(profileFile, "utf8");
		const output = await runLauncher(fixture, ["partial", "--", "--mode", "rpc"]);
		expect(output.code).toBe(0);
		for (const line of output.stdout.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
		expect(output.stdout).not.toMatch(/unknown skill|unknown extension|pi-profile: warning/);
		for (const reference of ["missing-skill", "missing-ext"]) expect(output.stderr.split("\n").filter((line) => line.includes("pi-profile: warning:") && line.includes(`"${reference}"`))).toHaveLength(1);
		const rpc = runLauncherRpc(fixture, ["partial", "--", "--mode", "rpc"]);
		try {
			const names = (await rpc.commandNames()).map((entry) => entry.name);
			expect(names).toContain("skill:project-skill"); expect(names).toContain("project-ext");
			for (const name of ["skill:unselected-skill", "skill:unselected-home", "skill:package-skill", "package-ext", "unselected-ext"]) expect(names).not.toContain(name);
			if (partial) { expect(names).toContain("skill:selected-skill"); expect(names).toContain("selected-ext"); }
			else { expect(names).not.toContain("skill:selected-skill"); expect(names).not.toContain("selected-ext"); }
		} finally { await rpc.close(); await rpc.waitForExit(); }
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(fixture.root, "EXECUTED-unselected-ext"))).toBe(false);
		expect(existsSync(path.join(fixture.root, "EXECUTED-package-ext"))).toBe(false);
		expect(existsSync(path.join(fixture.root, "EXECUTED-selected-ext"))).toBe(partial);
		expect(await readFile(profileFile, "utf8")).toBe(original);
		expect(await readFile(settingsFile, "utf8")).toBe(settings);
		expect(await readFile(path.join(dir, "corrupt.json"), "utf8")).toBe("{ bad");
	});
});
