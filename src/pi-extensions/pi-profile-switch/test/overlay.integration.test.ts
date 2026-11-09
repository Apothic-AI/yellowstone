import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncherRpc } from "./helpers/launcher-runner.ts";
import { addGlobalSkill, createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";
import type { RpcDriver } from "./helpers/rpc-driver.ts";

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

async function skillNames(rpc: RpcDriver): Promise<string[]> {
	return (await rpc.skillCommandNames()).sort();
}

async function readState(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"));
}

describe("launcher integration: runtime overlay", () => {
	it(
		"overlay narrows the runtime only: state holds the overlay, the catalog is untouched, the next launch ignores it",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);

				const narrowed = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable skill beta-skill" },
					60_000,
				);
				expect(narrowed.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill"]);

				// Overlay persisted to runtime state; the catalog file is untouched.
				expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });
				const profile = JSON.parse(
					await readFile(path.join(fixture.profileSwitchDir, "profiles", "review.json"), "utf8"),
				);
				expect(profile.skills).toEqual(["alpha-skill", "beta-skill"]);

				// overlay clear restores the declared set.
				const cleared = await rpc.send({ type: "prompt", message: "/profile overlay clear" }, 60_000);
				expect(cleared.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
				expect((await readState()).overlay).toBeUndefined();
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}

			// A fresh launch restores the profile WITHOUT the discarded overlay
			// (the launcher never reads stored overlays).
			const relaunched = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				expect(await skillNames(relaunched)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
			} finally {
				await relaunched.close();
				await relaunched.waitForExit();
			}
		},
	);

	it(
		"an overlay can disable a resolved extension",
		{ timeout: 60_000 },
		async () => {
			const extensionsDir = path.join(fixture.agentDir, "extensions");
			const extFile = path.join(extensionsDir, "my-ext.ts");
			await mkdir(extensionsDir, { recursive: true });
			await writeFile(
				extFile,
				[
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
					`export default function (pi: ExtensionAPI) {`,
					`\tpi.registerCommand("my-ext-cmd", { description: "from my-ext", handler: async () => {} });`,
					`}`,
					"",
				].join("\n"),
			);
			await writeCatalog({ review: { extensions: ["my-ext"] } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				const commands = await rpc.commandNames();
				expect(commands.some((c) => c.name === "my-ext-cmd")).toBe(true);

				const disableAttempt = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable extension my-ext" },
					60_000,
				);
				expect(disableAttempt.success).toBe(true);

				const state = (await readState()) as { overlay?: { disabledExtensions?: string[] } };
				expect(state.overlay?.disabledExtensions).toEqual(["my-ext"]);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"a switch discards the previous profile's overlay",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({
				review: { skills: ["alpha-skill", "beta-skill"] },
				impl: { skills: ["beta-skill"] },
			});

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "prompt", message: "/profile overlay disable skill beta-skill" }, 60_000);
				expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });

				const switched = await rpc.send({ type: "prompt", message: "/profile use impl" }, 60_000);
				expect(switched.success).toBe(true);

				expect(await skillNames(rpc)).toEqual(["skill:beta-skill"]);
				const state = await readState();
				expect(state.activeProfile).toBe("impl");
				expect(state.overlay).toBeUndefined();
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"a stored glob disable is re-expanded on reload and narrows a newly resolved skill",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "git-commit");
			await writeCatalog({ review: { skills: ["alpha-skill", "git-commit"] } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill", "skill:git-commit"]);

				// The glob is stored as written and narrows its current matches.
				const disabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable skill git-*" },
					60_000,
				);
				expect(disabled.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill"]);
				expect((await readState()).overlay).toEqual({ disabledSkills: ["git-*"] });

				// Mid-runtime the profile resolves a NEW skill matching the stored
				// glob; reload re-expands the pattern and narrows it too.
				await addGlobalSkill(fixture, "git-rebase");
				await writeCatalog({ review: { skills: ["alpha-skill", "git-commit", "git-rebase"] } });

				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill"]);
				expect((await readState()).overlay).toEqual({ disabledSkills: ["git-*"] });
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"empty tools denies sibling extension tools and overlays still reapply",
		{ timeout: 120_000 },
		async () => {
			const extensionsDir = path.join(fixture.agentDir, "extensions");
			await mkdir(extensionsDir, { recursive: true });
			await writeFile(
				path.join(extensionsDir, "linter.ts"),
				`export default function (pi: any) {
					pi.registerTool({
						name: "lint_check",
						label: "Lint check",
						description: "Run fixture lint",
						parameters: { type: "object", properties: {} },
						execute: async () => ({ content: [{ type: "text", text: "lint" }] }),
					});
				}
				`,
			);
			const activeToolsPath = path.join(fixture.root, "active-tools.json");
			await writeFile(
				path.join(extensionsDir, "active-tool-probe.ts"),
				`import { writeFile } from "node:fs/promises";
					export default function (pi: any) {
						pi.on("session_start", async () => {
							await writeFile(${JSON.stringify(activeToolsPath)}, JSON.stringify(pi.getActiveTools()));
						});
					}
				`,
			);
			await writeCatalog({
				empty: { extensions: ["linter", "active-tool-probe"], tools: [] },
				lint: { extensions: ["linter", "active-tool-probe"], tools: ["lint_check"] },
			});

			const readActiveTools = async (): Promise<string[]> => {
				for (let attempt = 0; attempt < 40; attempt++) {
					try {
						return JSON.parse(await readFile(activeToolsPath, "utf8"));
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 25));
					}
				}
				throw new Error("timed out waiting for active-tool probe");
			};
			const clearActiveTools = async () => rm(activeToolsPath, { force: true });

			const rpc = runLauncherRpc(fixture, ["empty", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" }).catch((error: unknown) => {
					throw new Error(`${error instanceof Error ? error.message : String(error)}\n${rpc.stderr.join("")}`);
				});
				const initialTools = await readActiveTools();
				expect(initialTools).not.toContain("lint_check");

				await clearActiveTools();
				const switched = await rpc.send({ type: "prompt", message: "/profile use lint" }, 60_000);
				expect(switched.success).toBe(true);
				const selectedTools = await readActiveTools();
				expect(selectedTools).toContain("lint_check");

				await clearActiveTools();
				const disabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable tool lint_check" },
					60_000,
				);
				expect(disabled.success).toBe(true);
				expect(await readActiveTools()).not.toContain("lint_check");

				await clearActiveTools();
				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);
				expect(await readActiveTools()).not.toContain("lint_check");

				await clearActiveTools();
				const enabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay enable tool lint_check" },
					60_000,
				);
				expect(enabled.success).toBe(true);
				expect(await readActiveTools()).toContain("lint_check");
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"overlay disable tool narrows the active tool set and enable restores it",
		{ timeout: 90_000 },
		async () => {
			await writeCatalog({ review: { tools: ["read", "bash"] } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				// The launcher creates the instance dir as pi starts — resolve it
				// after the first round trip, not at spawn time.
				await rpc.send({ type: "get_state" });
				const instance = await soleInstanceDir(fixture);
				const settings = async () => JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
				const plan = async () => JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8"));

				expect((await settings()).defaultTools).toEqual(["read", "bash"]);

				const disabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable tool bash" },
					60_000,
				);
				expect(disabled.success).toBe(true);
				expect((await readState()).overlay).toEqual({ disabledTools: ["bash"] });
				// The active tool set narrows: the boot baseline loses bash and the
				// plan carries the entry verbatim (declared refs stay untouched).
				expect((await settings()).defaultTools).toEqual(["read"]);
				expect((await plan()).disabledTools).toEqual(["bash"]);
				expect((await plan()).toolReferences).toEqual(["read", "bash"]);

				const enabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay enable tool bash" },
					60_000,
				);
				expect(enabled.success).toBe(true);
				const afterEnable = (await readState()).overlay as Record<string, unknown> | undefined;
				expect(afterEnable === undefined || Object.keys(afterEnable).length === 0).toBe(true);
				expect((await settings()).defaultTools).toEqual(["read", "bash"]);
				expect((await plan()).disabledTools).toBeUndefined();
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"overlay forms execute normally in non-TUI (rpc) mode",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				const disabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable skill beta-skill" },
					60_000,
				);
				expect(disabled.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill"]);

				// enable removes the stored entry by exact string match.
				const enabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay enable skill beta-skill" },
					60_000,
				);
				expect(enabled.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
				// The stored entry is gone: the overlay carries no disable entries
				// (an emptied overlay may persist as {}).
				const afterEnable = (await readState()).overlay as Record<string, unknown> | undefined;
				expect(afterEnable === undefined || Object.keys(afterEnable).length === 0).toBe(true);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
});

describe("in-session native resource bases for overlays (fix-undeclared-resource-filtering)", () => {
	async function extensionNames(rpc: RpcDriver): Promise<string[]> {
		const commands = await rpc.commandNames();
		return commands.filter((command) => command.source === "extension").map((command) => command.name).sort();
	}

	/** A loose agentDir extension registering one observable command. */
	async function addExtension(name: string): Promise<string> {
		const dir = path.join(fixture.agentDir, "extensions");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, `${name}.ts`);
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

	/** Skill command names excluding the distributed profile-config skill, so
	 *  native-base comparisons isolate the fixture skills. */
	async function nativeSkillNames(rpc: RpcDriver): Promise<string[]> {
		return (await skillNames(rpc)).filter((name) => name !== "skill:profile-config");
	}

	it(
		"a named profile's native-base overlay narrows an omitted skill kind only",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addExtension("ext-a");
			await writeCatalog({ open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
				expect(await extensionNames(rpc)).toContain("ext-a");

				const narrowed = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable skill beta-skill" },
					60_000,
				);
				expect(narrowed.success).toBe(true);
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill"]);
				// The unrelated extension kind keeps native visibility.
				expect(await extensionNames(rpc)).toContain("ext-a");
				expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });

				const enabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay enable skill beta-skill" },
					60_000,
				);
				expect(enabled.success).toBe(true);
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
				expect(await extensionNames(rpc)).toContain("ext-a");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"the default profile narrows each resource kind from its native base independently",
		{ timeout: 120_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addExtension("ext-a");
			await addExtension("ext-b");

			const rpc = runLauncherRpc(fixture, ["--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				const fixtureExtensions = (names: string[]) => names.filter((name) => name === "ext-a" || name === "ext-b");
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
				expect(fixtureExtensions(await extensionNames(rpc))).toEqual(["ext-a", "ext-b"]);

				// Skill-only narrowing leaves the extension kind untouched.
				await rpc.send({ type: "prompt", message: "/profile overlay disable skill beta-skill" }, 60_000);
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill"]);
				expect(fixtureExtensions(await extensionNames(rpc))).toEqual(["ext-a", "ext-b"]);

				// Extension-only narrowing leaves the skill kind's current state.
				await rpc.send({ type: "prompt", message: "/profile overlay disable extension ext-a" }, 60_000);
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill"]);
				expect(fixtureExtensions(await extensionNames(rpc))).toEqual(["ext-b"]);
				expect((await readState()).overlay).toEqual({
					disabledSkills: ["beta-skill"],
					disabledExtensions: ["ext-a"],
				});

				// clear restores native visibility for both kinds.
				await rpc.send({ type: "prompt", message: "/profile overlay clear" }, 60_000);
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
				expect(fixtureExtensions(await extensionNames(rpc))).toEqual(["ext-a", "ext-b"]);
				expect((await readState()).overlay).toBeUndefined();
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"a tool-only overlay on the default profile leaves skills and extensions untouched",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addExtension("ext-a");
			await writeCatalog({ review: { tools: ["read", "bash"] } });

			const rpc = runLauncherRpc(fixture, ["--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				const skillsBefore = await nativeSkillNames(rpc);
				const extensionsBefore = await extensionNames(rpc);
				expect(skillsBefore).toEqual(["skill:alpha-skill"]);

				const disabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable tool bash" },
					60_000,
				);
				expect(disabled.success).toBe(true);

				// Unrelated resource kinds retain exactly their prior visibility.
				expect(await nativeSkillNames(rpc)).toEqual(skillsBefore);
				expect(await extensionNames(rpc)).toEqual(extensionsBefore);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"a native-base overlay glob is re-expanded for an omitted kind after a new resource appears",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "git-commit");
			await writeCatalog({ open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill", "skill:git-commit"]);

				const disabled = await rpc.send(
					{ type: "prompt", message: "/profile overlay disable skill git-*" },
					60_000,
				);
				expect(disabled.success).toBe(true);
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill"]);

				await addGlobalSkill(fixture, "git-rebase");
				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);

				// The stored glob matches the newly discovered skill; the
				// nonmatching native resource stays visible.
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill"]);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"a native-base skill overlay leaves settings-only extension paths visible",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			const settingsOnly = path.join(fixture.root, "outside", "one-off.ts");
			await mkdir(path.dirname(settingsOnly), { recursive: true });
			await writeFile(
				settingsOnly,
				[
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
					`export default function (pi: ExtensionAPI) {`,
					`\tpi.registerCommand("one-off", { description: "settings-only", handler: async () => {} });`,
					`}`,
					"",
				].join("\n"),
			);
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ extensions: [settingsOnly] }));
			await writeCatalog({ open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				expect(await extensionNames(rpc)).toContain("one-off");

				await rpc.send({ type: "prompt", message: "/profile overlay disable skill beta-skill" }, 60_000);
				expect(await nativeSkillNames(rpc)).toEqual(["skill:alpha-skill"]);
				// The settings-only extension is outside the overlay vocabulary and
				// must not be converted into an allowlist or dropped.
				expect(await extensionNames(rpc)).toContain("one-off");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"a native-base extension overlay preserves native package filters and settings-only paths",
		{ timeout: 120_000 },
		async () => {
			// A configured local package with a nonempty native extension filter, plus
			// a settings-only extension outside the overlay vocabulary and a loose
			// agentDir extension the overlay can actually name.
			const pkgRoot = path.join(fixture.root, "pkg");
			await mkdir(path.join(pkgRoot, "extensions"), { recursive: true });
			await writeFile(
				path.join(pkgRoot, "package.json"),
				JSON.stringify({ name: "pkg", version: "1.0.0", pi: { extensions: ["./extensions"] } }),
			);
			await writeFile(
				path.join(pkgRoot, "extensions", "pkg-ext.ts"),
				[
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
					`export default function (pi: ExtensionAPI) {`,
					`\tpi.registerCommand("pkg-ext", { description: "package extension", handler: async () => {} });`,
					`}`,
					"",
				].join("\n"),
			);
			const settingsOnly = path.join(fixture.root, "outside", "one-off.ts");
			await mkdir(path.dirname(settingsOnly), { recursive: true });
			await writeFile(
				settingsOnly,
				[
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
					`export default function (pi: ExtensionAPI) {`,
					`\tpi.registerCommand("one-off", { description: "settings-only", handler: async () => {} });`,
					`}`,
					"",
				].join("\n"),
			);
			await addExtension("loose");
			await writeFile(
				path.join(fixture.agentDir, "settings.json"),
				JSON.stringify({
					packages: [{ source: pkgRoot, extensions: ["extensions/pkg-ext.ts"] }],
					extensions: [settingsOnly],
				}),
			);
			await writeCatalog({ open: {} });

			// A named profile omitting both kinds.
			const named = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				await named.send({ type: "get_state" });
				const before = await extensionNames(named);
				expect(before).toContain("pkg-ext");
				expect(before).toContain("one-off");
				expect(before).toContain("loose");

				await named.send({ type: "prompt", message: "/profile overlay disable extension loose" }, 60_000);
				const after = await extensionNames(named);
				expect(after).not.toContain("loose");
				// Narrowing the omitted kind must not convert the package to a wildcard
				// or an empty allowlist, nor drop the settings-only path.
				expect(after).toContain("pkg-ext");
				expect(after).toContain("one-off");

				const instance = await soleInstanceDir(fixture);
				const settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
				expect(settings.packages[0].extensions).toEqual(["extensions/pkg-ext.ts"]);
				expect(settings.extensions).toContain(settingsOnly);
			} finally {
				await named.close();
			}

			// The default profile narrows the same omitted kind from its native base.
			const def = runLauncherRpc(fixture, ["--", "--mode", "rpc"]);
			try {
				await def.send({ type: "get_state" });
				expect(await extensionNames(def)).toContain("pkg-ext");

				await def.send({ type: "prompt", message: "/profile overlay disable extension loose" }, 60_000);
				const after = await extensionNames(def);
				expect(after).not.toContain("loose");
				expect(after).toContain("pkg-ext");
				expect(after).toContain("one-off");
			} finally {
				await def.close();
			}
		},
	);

	it(
		"native basename and marker-less extension patterns stay effective under a native-base overlay",
		{ timeout: 90_000 },
		async () => {
			await addExtension("keep");
			await addExtension("alpha");
			await addExtension("legacy-old");
			// `!legacy-*` excludes by basename; the marker-less `extensions/*`
			// glob is inert for native automatic discovery and must stay inert.
			await writeFile(
				path.join(fixture.agentDir, "settings.json"),
				JSON.stringify({ extensions: ["!legacy-*", "extensions/*"] }),
			);
			await writeCatalog({ open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				const before = await extensionNames(rpc);
				expect(before).toContain("keep");
				expect(before).toContain("alpha");
				expect(before).not.toContain("legacy-old");

				// The overlay adds only the concrete targeted disable; the native
				// basename exclusion and marker-less inertness survive.
				await rpc.send({ type: "prompt", message: "/profile overlay disable extension keep" }, 60_000);
				const after = await extensionNames(rpc);
				expect(after).not.toContain("keep");
				expect(after).toContain("alpha");
				expect(after).not.toContain("legacy-old");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"overlay disables a skill loaded through a native plain include inside the agent dir",
		{ timeout: 90_000 },
		async () => {
			const vendorSkill = path.join(fixture.agentDir, "vendor", "x", "SKILL.md");
			await mkdir(path.dirname(vendorSkill), { recursive: true });
			await writeFile(vendorSkill, "---\nname: vendor-x\ndescription: vendor skill\n---\n");
			await addGlobalSkill(fixture, "unrelated-skill");
			await writeFile(
				path.join(fixture.agentDir, "settings.json"),
				JSON.stringify({ skills: [vendorSkill] }),
			);
			await writeCatalog({ open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				// The native direct include makes the skill visible under the omitted profile.
				expect(await skillNames(rpc)).toContain("skill:vendor-x");
				expect(await skillNames(rpc)).toContain("skill:unrelated-skill");

				await rpc.send({ type: "prompt", message: "/profile overlay disable skill vendor-x" }, 60_000);
				expect(await skillNames(rpc)).not.toContain("skill:vendor-x");
				expect(await skillNames(rpc)).toContain("skill:unrelated-skill");

				await rpc.send({ type: "prompt", message: "/profile overlay enable skill vendor-x" }, 60_000);
				expect(await skillNames(rpc)).toContain("skill:vendor-x");
			} finally {
				await rpc.close();
			}
		},
	);
});
