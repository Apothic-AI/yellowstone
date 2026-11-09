import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launcherEnv, runLauncherRpc } from "./helpers/launcher-runner.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";

/**
 * Real-Pi coverage for the sparse skill/extension selection contract. Loaded
 * resources are compared against a NATIVE Pi process (the pi binary launched
 * without the launcher or the pi-profile extension), never against the
 * pi-profile `default` profile and never against resolver-derived expectations.
 */

let fixture: PiFixture;

/** The real pi binary, launched directly as the native baseline. */
const NATIVE_PI = path.resolve("node_modules/.bin/pi");

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

async function writeUserSettings(settings: unknown): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(settings));
}

async function addGlobalSkill(name: string): Promise<string> {
	const dir = path.join(fixture.agentDir, "skills", name);
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	await writeFile(file, `---\nname: ${name}\ndescription: ${name}\n---\n`);
	return file;
}

async function addAgentsSkill(name: string): Promise<void> {
	const dir = path.join(fixture.root, ".agents", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

async function addProjectSkill(name: string): Promise<void> {
	const dir = path.join(fixture.cwd, ".pi", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

/** An extension that registers a same-named command observed through RPC. */
async function addExtensionFile(name: string): Promise<string> {
	const dir = path.join(fixture.agentDir, "extensions");
	await mkdir(dir, { recursive: true });
	return writeExtensionFile(path.join(dir, `${name}.ts`), name);
}

async function writeExtensionFile(file: string, name: string): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(
		file,
		[
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.registerCommand(${JSON.stringify(name)}, { description: "fixture ${name}", handler: async () => {} });`,
			`}`,
			"",
		].join("\n"),
	);
	return file;
}

async function addProjectExtension(name: string): Promise<string> {
	return writeExtensionFile(path.join(fixture.cwd, ".pi", "extensions", `${name}.ts`), name);
}

/** Reports every registered tool name (including built-ins) so a native
 *  built-in control's effect is observable. */
async function addToolReporter(name: string): Promise<string> {
	const dir = path.join(fixture.agentDir, "extensions");
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.ts`);
	await writeFile(
		file,
		[
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.registerCommand(${JSON.stringify(name)}, {`,
			`\t\tdescription: "report registered tools",`,
			`\t\thandler: async () => {`,
			`\t\t\tpi.sendMessage({`,
			`\t\t\t\tcustomType: "fixture-tool-report",`,
			`\t\t\t\tcontent: "tools",`,
			`\t\t\t\tdisplay: true,`,
			`\t\t\t\tdetails: { tools: pi.getAllTools().map((tool) => tool.name) },`,
			`\t\t\t});`,
			`\t\t},`,
			`\t});`,
			`}`,
			"",
		].join("\n"),
	);
	return file;
}

/** A local package exposing one extension command and one skill. */
async function createLocalPackage(name: string): Promise<string> {
	const root = path.join(fixture.root, name);
	await mkdir(path.join(root, "skills", `${name}-skill`), { recursive: true });
	await mkdir(path.join(root, "extensions"), { recursive: true });
	await writeFile(path.join(root, "skills", `${name}-skill`, "SKILL.md"), `---\nname: ${name}-skill\ndescription: ${name}-skill\n---\n`);
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["./extensions"], skills: ["./skills"] } }),
	);
	await writeFile(
		path.join(root, "extensions", "pkg-ext.ts"),
		[
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.registerCommand("pkg-ext", { description: "package extension", handler: async () => {} });`,
			`}`,
			"",
		].join("\n"),
	);
	return root;
}

interface Observation {
	skills: string[];
	commands: string[];
}

function extractTools(message: unknown): string[] | undefined {
	const record = message as {
		details?: { tools?: string[] };
		message?: { details?: { tools?: string[] } };
	};
	if (Array.isArray(record.details?.tools)) return record.details.tools;
	if (Array.isArray(record.message?.details?.tools)) return record.message?.details?.tools;
	return undefined;
}

async function observeWith(
	rpc: RpcDriver,
	toolCommand?: string,
): Promise<Observation & { tools?: string[] }> {
	try {
		await rpc.send({ type: "get_state" });
		const skills = await rpc.skillCommandNames();
		const commands = (await rpc.commandNames()).map((command) => command.name);
		let tools: string[] | undefined;
		if (toolCommand !== undefined) {
			await rpc.send({ type: "prompt", message: `/${toolCommand}` }, 60_000);
			const raw = await rpc.waitFor((message) => extractTools(message) !== undefined, 60_000);
			tools = extractTools(raw);
		}
		return { skills, commands, ...(tools !== undefined ? { tools } : {}) };
	} finally {
		await rpc.close();
	}
}

function observe(args: string[], toolCommand?: string): Promise<Observation & { tools?: string[] }> {
	return observeWith(runLauncherRpc(fixture, args, launcherEnv(fixture)), toolCommand);
}

/** The native baseline: the pi binary with the real agent dir and no launcher. */
function observeNative(toolCommand?: string): Promise<Observation & { tools?: string[] }> {
	return observeWith(
		new RpcDriver("node", [NATIVE_PI, "--mode", "rpc"], { cwd: fixture.cwd, env: launcherEnv(fixture) }),
		toolCommand,
	);
}

function fixtureCommands(observation: Observation, names: string[]): string[] {
	return names.filter((name) => observation.commands.includes(name)).sort();
}

describe("sparse resource selection against a real spawned pi", () => {
	it(
		"omitted skills preserve every natively visible skill",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addGlobalSkill("beta-skill");
			await addAgentsSkill("shared-skill");
			await addExtensionFile("selected-ext");
			await writeCatalog({ review: { extensions: ["selected-ext"] } });

			// Launch first so the launcher's starter-asset distribution is present
			// for the native baseline too.
			const review = await observe(["review", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(review.skills).toEqual(native.skills);
			expect(native.skills).toEqual(
				expect.arrayContaining(["skill:alpha-skill", "skill:beta-skill", "skill:shared-skill"]),
			);
			expect(fixtureCommands(review, ["selected-ext"])).toEqual(["selected-ext"]);
		},
	);

	it(
		"omitted extensions preserve extension visibility observed natively",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addExtensionFile("ext-a");
			await addExtensionFile("ext-b");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });

			const review = await observe(["review", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(fixtureCommands(review, ["ext-a", "ext-b"])).toEqual(fixtureCommands(native, ["ext-a", "ext-b"]));
			expect(review.skills).toEqual(["skill:alpha-skill"]);
		},
	);

	it(
		"explicit empty selections remain restrictive for each kind",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addAgentsSkill("shared-skill");
			await addExtensionFile("ext-a");
			await writeCatalog({ bare: { skills: [], extensions: [] } });

			const bare = await observe(["bare", "--", "--mode", "rpc"]);

			expect(bare.skills).toEqual([]);
			expect(fixtureCommands(bare, ["ext-a"])).toEqual([]);
		},
	);

	it(
		"a skill-only selection leaves extensions at native visibility",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addGlobalSkill("beta-skill");
			await addExtensionFile("ext-a");
			await addExtensionFile("ext-b");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });

			const review = await observe(["review", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(review.skills).toEqual(["skill:alpha-skill"]);
			expect(fixtureCommands(review, ["ext-a", "ext-b"])).toEqual(fixtureCommands(native, ["ext-a", "ext-b"]));
		},
	);

	it(
		"an extension-only selection leaves skills at native visibility",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addGlobalSkill("beta-skill");
			await addExtensionFile("ext-a");
			await addExtensionFile("ext-b");
			await writeCatalog({ review: { extensions: ["ext-a"] } });

			const review = await observe(["review", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(review.skills).toEqual(native.skills);
			expect(fixtureCommands(review, ["ext-a", "ext-b"])).toEqual(["ext-a"]);
		},
	);

	it(
		"relative native exclusions and inclusion exceptions match a native session",
		{ timeout: 120_000 },
		async () => {
			await addGlobalSkill("kept-skill");
			await addGlobalSkill("hidden-skill");
			await writeUserSettings({ skills: ["!skills/**", "+skills/kept-skill/SKILL.md"] });
			await addExtensionFile("ext-a");
			await writeCatalog({ omitted: { extensions: ["ext-a"] }, globbed: { skills: ["*"], extensions: ["ext-a"] } });

			const omitted = await observe(["omitted", "--", "--mode", "rpc"]);
			const globbed = await observe(["globbed", "--", "--mode", "rpc"]);
			const native = await observeNative();

			// The native `!skills/**` exclusion hides the agentDir skills; the native
			// `+skills/kept-skill/SKILL.md` force-inclusion keeps the kept skill.
			expect(native.skills).toEqual(["skill:kept-skill"]);
			expect(omitted.skills).toEqual(native.skills);
			expect(globbed.skills).toEqual(native.skills);
		},
	);

	it(
		"absolute and ~ native skill overrides stay effective for an omitted kind",
		{ timeout: 120_000 },
		async () => {
			const hiddenPath = await addGlobalSkill("hidden-skill");
			const keptPath = await addGlobalSkill("kept-skill");
			// An absolute `-` under the agent dir: the native session matches it
			// lexically against the real discovered path.
			await writeUserSettings({ skills: [`-${hiddenPath}`] });
			await writeCatalog({ omitted: {} });

			const omitted = await observe(["omitted", "--", "--mode", "rpc"]);
			const native = await observeNative();
			expect(native.skills).not.toContain("skill:hidden-skill");
			expect(omitted.skills).toEqual(native.skills);

			// An absolute `+` force-inclusion beneath a broad `!` pattern.
			await writeUserSettings({ skills: ["!skills/**", `+${keptPath}`] });
			const omittedForceInclude = await observe(["omitted", "--", "--mode", "rpc"]);
			const nativeForceInclude = await observeNative();
			expect(nativeForceInclude.skills).toEqual(["skill:kept-skill"]);
			expect(omittedForceInclude.skills).toEqual(nativeForceInclude.skills);

			// Real pi treats `~` overrides as no-ops; the omitted branch preserves
			// that native meaning, so the excluded skill stays visible in both.
			const tilde = `-~/${path.relative(fixture.root, hiddenPath)}`;
			await writeUserSettings({ skills: [tilde] });
			const omittedTilde = await observe(["omitted", "--", "--mode", "rpc"]);
			const nativeTilde = await observeNative();
			expect(nativeTilde.skills).toContain("skill:hidden-skill");
			expect(omittedTilde.skills).toEqual(nativeTilde.skills);
		},
	);

	it(
		"a settings-only extension path survives an omitted extension field",
		{ timeout: 90_000 },
		async () => {
			const settingsOnly = await writeExtensionFile(path.join(fixture.root, "generated", "one-off.ts"), "one-off");
			await writeUserSettings({ extensions: [settingsOnly] });
			await addGlobalSkill("alpha-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });

			const review = await observe(["review", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(fixtureCommands(native, ["one-off"])).toEqual(["one-off"]);
			expect(fixtureCommands(review, ["one-off"])).toEqual(["one-off"]);
		},
	);

	it(
		"a native built-in control stays effective under an omitted and a declared extension field",
		{ timeout: 120_000 },
		async () => {
			await addToolReporter("report-tools");
			await writeUserSettings({ extensions: ["-builtin:codemode"] });
			await writeCatalog({ omitted: {}, declared: { extensions: ["report-tools"] } });

			const native = await observeNative("report-tools");
			const omitted = await observe(["omitted", "--", "--mode", "rpc"], "report-tools");
			const declared = await observe(["declared", "--", "--mode", "rpc"], "report-tools");

			expect(native.tools).not.toContain("codemode");
			expect(omitted.tools).not.toContain("codemode");
			expect(declared.tools).not.toContain("codemode");
		},
	);

	it(
		"a broad native built-in exclusion with an inclusion exception matches a native session",
		{ timeout: 120_000 },
		async () => {
			await addToolReporter("report-tools");
			await writeUserSettings({ extensions: ["!builtin:*", "+builtin:codemode"] });
			await writeCatalog({ omitted: {}, declared: { extensions: ["report-tools"] } });

			const baseline = async (): Promise<string[]> => {
				const observation = await observeNative("report-tools");
				return (observation.tools ?? []).filter((name) => name.startsWith("builtin") || ["codemode", "mcp", "llama"].includes(name)).sort();
			};
			const native = await baseline();
			const omitted = await observe(["omitted", "--", "--mode", "rpc"], "report-tools");
			const declared = await observe(["declared", "--", "--mode", "rpc"], "report-tools");

			// Every built-in except the force-included codemode is disabled natively.
			expect(native).toContain("codemode");
			expect(native.filter((name) => name !== "codemode")).not.toContain("mcp");
			for (const observation of [omitted, declared]) {
				const names = observation.tools ?? [];
				expect(names).toContain("codemode");
				expect(names).not.toContain("mcp");
				expect(names).not.toContain("llama");
			}
		},
	);

	it(
		"a native package filter and a relative local source match a native session",
		{ timeout: 120_000 },
		async () => {
			const pkgRoot = await createLocalPackage("shared-pkg");
			// Relative to the agent dir, escaping it (the sibling `shared-pkg`).
			const relativeSource = `../${path.basename(pkgRoot)}`;
			await writeUserSettings({ packages: [{ source: relativeSource, skills: ["skills/shared-pkg-skill"] }] });
			await addGlobalSkill("alpha-skill");
			await writeCatalog({ omitted: {} });

			const omitted = await observe(["omitted", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(fixtureCommands(native, ["pkg-ext"])).toEqual(["pkg-ext"]);
			expect(fixtureCommands(omitted, ["pkg-ext"])).toEqual(["pkg-ext"]);
			expect(native.skills).toContain("skill:shared-pkg-skill");
			expect(omitted.skills).toEqual(native.skills);
		},
	);

	it(
		"symlinked skills stay at native visibility for an omitted kind",
		{ timeout: 90_000 },
		async () => {
			// A dotfiles-style skill library symlinked into the agentDir.
			const libraryDir = path.join(fixture.root, "skill-library", "linked-skill");
			await mkdir(libraryDir, { recursive: true });
			await writeFile(path.join(libraryDir, "SKILL.md"), "---\nname: linked-skill\ndescription: linked-skill\n---\n");
			await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });
			await symlink(libraryDir, path.join(fixture.agentDir, "skills", "linked-skill"), "dir");
			await addGlobalSkill("alpha-skill");
			await writeCatalog({ omitted: {} });

			const omitted = await observe(["omitted", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(native.skills).toContain("skill:linked-skill");
			expect(omitted.skills).toEqual(native.skills);
		},
	);

	it(
		"project resources follow the trust boundary for an omitted and an empty selection",
		{ timeout: 120_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addProjectSkill("proj-skill");
			await addProjectExtension("proj-ext");
			await writeCatalog({ omitted: {}, empty: { skills: [] } });

			const untrustedOmitted = await observe(["omitted", "--", "--mode", "rpc"]);
			expect(untrustedOmitted.skills).not.toContain("skill:proj-skill");
			expect(fixtureCommands(untrustedOmitted, ["proj-ext"])).toEqual([]);

			const untrustedEmpty = await observe(["empty", "--", "--mode", "rpc"]);
			expect(untrustedEmpty.skills).not.toContain("skill:proj-skill");

			await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
			const trustedOmitted = await observe(["omitted", "--", "--mode", "rpc"]);
			expect(trustedOmitted.skills).toContain("skill:proj-skill");
			expect(fixtureCommands(trustedOmitted, ["proj-ext"])).toEqual(["proj-ext"]);

			const trustedEmpty = await observe(["empty", "--", "--mode", "rpc"]);
			expect(trustedEmpty.skills).toContain("skill:proj-skill");
			expect(trustedEmpty.skills).not.toContain("skill:alpha-skill");
		},
	);

	it(
		"the distributed profile-config skill follows the ordinary skill-selection contract",
		{ timeout: 120_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await writeCatalog({
				omitted: {},
				empty: { skills: [] },
				unselected: { skills: ["alpha-skill"] },
			});

			const omitted = await observe(["omitted", "--", "--mode", "rpc"]);
			expect(omitted.skills).toContain("skill:profile-config");

			const empty = await observe(["empty", "--", "--mode", "rpc"]);
			expect(empty.skills).not.toContain("skill:profile-config");

			const unselected = await observe(["unselected", "--", "--mode", "rpc"]);
			expect(unselected.skills).not.toContain("skill:profile-config");
			expect(unselected.skills).toEqual(["skill:alpha-skill"]);
		},
	);

	it(
		"a native exclusion hides the distributed profile-config skill",
		{ timeout: 90_000 },
		async () => {
			await writeUserSettings({ skills: ["-skills/profile-config/SKILL.md"] });
			await writeCatalog({ omitted: {} });

			const omitted = await observe(["omitted", "--", "--mode", "rpc"]);
			expect(omitted.skills).not.toContain("skill:profile-config");
		},
	);

	it(
		"a declared selection excludes a skill the native settings only add",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addGlobalSkill("beta-skill");
			await writeUserSettings({ skills: ["/opt/pi-resources/extra/SKILL.md"] });
			await writeCatalog({ review: { skills: ["alpha-skill"] } });

			const review = await observe(["review", "--", "--mode", "rpc"]);
			expect(review.skills).toEqual(["skill:alpha-skill"]);
		},
	);

	it(
		"real user settings and catalogs stay byte-identical around omitted/empty/mixed launches",
		{ timeout: 120_000 },
		async () => {
			await addGlobalSkill("alpha-skill");
			await addExtensionFile("ext-a");
			await writeUserSettings({ skills: ["!skills/**", "+skills/alpha-skill/SKILL.md"], extensions: ["-builtin:codemode"] });
			await writeCatalog({
				omitted: {},
				empty: { skills: [], extensions: [] },
				mixed: { skills: ["alpha-skill"] },
			});
			const settingsPath = path.join(fixture.agentDir, "settings.json");
			const catalogPath = path.join(fixture.profileSwitchDir, "profiles", "mixed.json");
			const settingsBefore = await readFile(settingsPath, "utf8");
			const catalogBefore = await readFile(catalogPath, "utf8");

			await observe(["omitted", "--", "--mode", "rpc"]);
			await observe(["empty", "--", "--mode", "rpc"]);
			await observe(["mixed", "--", "--mode", "rpc"]);

			expect(await readFile(settingsPath, "utf8")).toBe(settingsBefore);
			expect(await readFile(catalogPath, "utf8")).toBe(catalogBefore);
		},
	);

	it(
		"relative native extension controls match a native session",
		{ timeout: 120_000 },
		async () => {
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "x.ts"), "x");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "legacy", "old.ts"), "legacy-old");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "keep.ts"), "keep");
			// The canonical shape `pi config` writes for a top-level extension toggle.
			await writeUserSettings({ extensions: ["-extensions/x.ts", "!extensions/legacy/**"] });
			await writeCatalog({ open: {} });

			const omitted = await observe(["open", "--", "--mode", "rpc"]);
			const native = await observeNative();
			const fixtureNames = ["x", "legacy-old", "keep"];

			expect(fixtureCommands(native, fixtureNames)).toEqual(["keep"]);
			expect(fixtureCommands(omitted, fixtureNames)).toEqual(fixtureCommands(native, fixtureNames));
		},
	);

	it(
		"escaping relative includes and absolute ! skill patterns match a native session",
		{ timeout: 120_000 },
		async () => {
			// Skills and an extension that live outside the agent dir, reached by a
			// relative entry that escapes it, plus a matching relative override.
			const sharedSkills = path.join(fixture.root, "shared-skills");
			await mkdir(path.join(sharedSkills, "pkg-skill"), { recursive: true });
			await writeFile(path.join(sharedSkills, "pkg-skill", "SKILL.md"), "---\nname: pkg-skill\ndescription: pkg\n---\n");
			await mkdir(path.join(sharedSkills, "hidden-skill"), { recursive: true });
			await writeFile(path.join(sharedSkills, "hidden-skill", "SKILL.md"), "---\nname: hidden-skill\ndescription: hidden\n---\n");
			await writeExtensionFile(path.join(fixture.root, "shared-extension.ts"), "shared-ext");

			const keptPath = await addGlobalSkill("kept-skill");
			await addGlobalSkill("other-skill");
			await writeUserSettings({
				skills: [
					"../shared-skills",
					"!../shared-skills/hidden-skill/SKILL.md",
					`!${path.join(fixture.agentDir, "skills", "**")}`,
					`+${keptPath}`,
				],
				extensions: ["../shared-extension.ts"],
			});
			await writeCatalog({ open: {} });

			const omitted = await observe(["open", "--", "--mode", "rpc"]);
			const native = await observeNative();

			expect(native.skills).toEqual(["skill:kept-skill", "skill:pkg-skill"]);
			expect(omitted.skills).toEqual(native.skills);
			expect(fixtureCommands(native, ["shared-ext"])).toEqual(["shared-ext"]);
			expect(fixtureCommands(omitted, ["shared-ext"])).toEqual(["shared-ext"]);
		},
	);

	it(
		"marker-less extension glob includes match a native session",
		{ timeout: 120_000 },
		async () => {
			// N4-A1: `"*"` is a marker-less include filter; native applies it only to
			// plain settings entries (none here) and auto-discovers every extension.
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "alpha.ts"), "alpha");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "beta.ts"), "beta");
			await writeUserSettings({ extensions: ["*"] });
			await writeCatalog({ open: {} });

			const omitted = await observe(["open", "--", "--mode", "rpc"]);
			const native = await observeNative();
			const names = ["alpha", "beta"];
			expect(fixtureCommands(native, names)).toEqual(["alpha", "beta"]);
			expect(fixtureCommands(omitted, names)).toEqual(fixtureCommands(native, names));
		},
	);

	it(
		"basename extension exclusion matches a native session",
		{ timeout: 120_000 },
		async () => {
			// N4-A2: `!legacy-*` excludes by basename natively.
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "legacy-old.ts"), "legacy-old");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "keep.ts"), "keep");
			await writeUserSettings({ extensions: ["!legacy-*"] });
			await writeCatalog({ open: {} });

			const omitted = await observe(["open", "--", "--mode", "rpc"]);
			const native = await observeNative();
			const names = ["legacy-old", "keep"];
			expect(fixtureCommands(native, names)).toEqual(["keep"]);
			expect(fixtureCommands(omitted, names)).toEqual(fixtureCommands(native, names));
		},
	);

	it(
		"marker-less path glob without native plain includes matches a native session",
		{ timeout: 120_000 },
		async () => {
			// N4-B: a path-style marker-less glob is inert natively (no plain entries).
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "pkg-a.ts"), "pkg-a");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "alpha.ts"), "alpha");
			await writeUserSettings({ extensions: ["extensions/pkg-*"] });
			await writeCatalog({ open: {} });

			const omitted = await observe(["open", "--", "--mode", "rpc"]);
			const native = await observeNative();
			const names = ["pkg-a", "alpha"];
			expect(fixtureCommands(native, names)).toEqual(["alpha", "pkg-a"]);
			expect(fixtureCommands(omitted, names)).toEqual(fixtureCommands(native, names));
		},
	);

	it(
		"marker-less path glob filtering native plain includes matches a native session",
		{ timeout: 120_000 },
		async () => {
			// N4-B variant: the same glob filters the user's real plain includes but
			// must not filter the auto-discovered extensions (pkg-b, legacy).
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "pkg-a.ts"), "pkg-a");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "pkg-b.ts"), "pkg-b");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "alpha.ts"), "alpha");
			await writeExtensionFile(path.join(fixture.agentDir, "extensions", "other.ts"), "other");
			await writeUserSettings({
				extensions: ["extensions/pkg-*", "./extensions/pkg-a.ts", "./extensions/alpha.ts"],
			});
			await writeCatalog({ open: {} });

			const omitted = await observe(["open", "--", "--mode", "rpc"]);
			const native = await observeNative();
			const names = ["pkg-a", "pkg-b", "alpha", "other"];
			expect(fixtureCommands(native, names)).toEqual(["other", "pkg-a", "pkg-b"]);
			expect(fixtureCommands(omitted, names)).toEqual(fixtureCommands(native, names));
		},
	);
});
