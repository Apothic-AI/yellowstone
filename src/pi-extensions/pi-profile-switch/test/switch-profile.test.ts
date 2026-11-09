import { chmod, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as initialProfile from "../src/launcher/initial-profile.ts";
import { generateRuntimeDir, writeRuntimeFiles } from "../src/settings-generator.ts";
import { defaultPlan } from "../src/profile-resolver.ts";
import { switchProfile, SwitchError } from "../src/switching/switch-profile.ts";
import { addGlobalExtension, addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;
let runtimeDir: string;

/** Write-stage injection: fail the next pi-profile.json write so a switch
 *  fails after settings.json has already changed, exercising rollback. */
const fsFailure = vi.hoisted(() => ({ failNextPlanWrite: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const actualWriteFile = actual.writeFile as unknown as (
		file: string | Buffer | URL,
		data: string | Uint8Array,
		options?: unknown,
	) => Promise<void>;
	return {
		...actual,
		writeFile: async (file: string | Buffer | URL, data: string | Uint8Array, options?: unknown) => {
			if (fsFailure.failNextPlanWrite && String(file).endsWith("pi-profile.json")) {
				fsFailure.failNextPlanWrite = false;
				throw new Error("injected write failure");
			}
			return actualWriteFile(file, data, options);
		},
	};
});

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
	runtimeDir = (
		await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir })
	).runtimeDir;
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const deps = (overrides?: Partial<Parameters<typeof switchProfile>[1]>) => ({
	runtimeDir,
	realAgentDir: fixture.agentDir,
	cwd: fixture.cwd,
	getAllTools: () => ["read", "bash", "grep"].map((name) => ({ name })),
	waitForIdle: async () => {},
	reload: async () => {},
	// Tests simulate the reload having re-executed extensions (context stale).
	assertStale: () => {
		throw new Error("stale");
	},
	...overrides,
});

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

async function readPlanFile(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8"));
}

async function managedSnapshot(): Promise<unknown[]> {
	return Promise.all(["settings.json", "pi-profile.json", "mcp.json", "APPEND_SYSTEM.md", "trust.json"].map(async (name) => {
		const file = path.join(runtimeDir, name);
		const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (!info) return { name, kind: "absent" };
		if (info.isSymbolicLink()) return { name, kind: "symlink", target: await readlink(file) };
		return { name, kind: "file", mode: info.mode & 0o777, content: await readFile(file, "utf8") };
	}));
}

describe("switchProfile", () => {
	it("rewrites the runtime files for the target profile and marks the plan for persistence", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });

		const result = await switchProfile("impl", deps());

		expect(result.profile).toBe("impl");
		const plan = await readPlanFile();
		expect(plan.profile).toBe("impl");
		expect(plan.switchedFrom).toBe("default");
		expect(plan.persistSelection).toBe(true);
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")]);
		expect(settings.defaultProjectTrust).toBe("never");
	});

	it("waits for the agent to be idle before touching the runtime files", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		let releaseIdle!: () => void;
		const idleGate = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const original = await readFile(path.join(runtimeDir, "settings.json"), "utf8");

		const pending = switchProfile("impl", deps({ waitForIdle: () => idleGate }));
		await new Promise((resolve) => setTimeout(resolve, 60));
		const observed = (await readFile(path.join(runtimeDir, "settings.json"), "utf8")) === original ? "untouched" : "rewritten";
		releaseIdle();
		await pending;

		expect(observed).toBe("untouched");
	});

	it("leaves the runtime untouched when the target fails to resolve", async () => {
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		const originalPlan = await readPlanFile();

		await expect(switchProfile("ghost", deps())).rejects.toThrow(/unknown profile/);

		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect(await readPlanFile()).toEqual(originalPlan);
	});

	it("rolls back every managed file when a write fails after settings.json changed", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"], instructions: "Be terse." } });
		const originalManaged = await managedSnapshot();
		const statePath = path.join(fixture.agentDir, "pi-profile-state.json");
		const originalState = JSON.stringify({ activeProfile: "default", overlay: { disabledSkills: ["saved-entry"] } });
		await writeFile(statePath, originalState);
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		const originalPlan = await readPlanFile();
		let reloads = 0;

		fsFailure.failNextPlanWrite = true;
		await expect(
			switchProfile(
				"impl",
				deps({
					reload: async () => {
						reloads += 1;
					},
				}),
			),
		).rejects.toThrow(/restored the previous settings.*injected write failure/);

		// The write failed after settings.json was already rewritten; the
		// rollback must restore the pre-switch state of every managed file.
		expect(reloads).toBe(1); // the restore reload only
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect(await readPlanFile()).toEqual(originalPlan);
		await expect(lstat(path.join(runtimeDir, "APPEND_SYSTEM.md"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await managedSnapshot()).toEqual(originalManaged);
		expect(await readFile(statePath, "utf8")).toBe(originalState);
	});

	it("restores the snapshot and reloads again when reload fails", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		const originalManaged = await managedSnapshot();
		const statePath = path.join(fixture.agentDir, "pi-profile-state.json");
		const originalState = JSON.stringify({ activeProfile: "default", overlay: { disabledSkills: ["saved-entry"] } });
		await writeFile(statePath, originalState);
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("boom");
		};

		await expect(switchProfile("impl", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		expect(reloads).toBe(2);
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect((await readPlanFile()).profile).toBe("default");
		expect(await managedSnapshot()).toEqual(originalManaged);
		expect(await readFile(statePath, "utf8")).toBe(originalState);
	});

	it("rolls back when Pi silently skips the reload (context never goes stale)", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		const originalManaged = await managedSnapshot();
		const statePath = path.join(fixture.agentDir, "pi-profile-state.json");
		const originalState = JSON.stringify({ activeProfile: "default", overlay: { disabledSkills: ["saved-entry"] } });
		await writeFile(statePath, originalState);
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		let reloads = 0;

		await expect(
			switchProfile(
				"impl",
				deps({
					reload: async () => {
						reloads += 1;
					},
					assertStale: () => {}, // still valid: the reload never re-executed extensions
				}),
			),
		).rejects.toThrow(/did not run the reload/);

		expect(reloads).toBe(2); // the restore reload
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect((await readPlanFile()).profile).toBe("default");
		expect(await managedSnapshot()).toEqual(originalManaged);
		expect(await readFile(statePath, "utf8")).toBe(originalState);
	});

	it("restores mcp.json, APPEND_SYSTEM.md, and trust.json to the pre-switch state when the reload fails", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "linear" } } }),
		);
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ projects: {} }));
		await writeCatalog({
			impl: { skills: ["alpha-skill"], mcps: ["github"], instructions: "Be terse." },
		});
		// Re-apply the default plan so the runtime dir reflects a real default
		// launch: mcp.json snapshot, trust.json linked, no APPEND_SYSTEM.md.
		await writeRuntimeFiles(runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });
		const agentMcp = path.join(fixture.agentDir, "mcp.json");
		const agentTrust = path.join(fixture.agentDir, "trust.json");
		const originalInstanceMcp = await readFile(path.join(runtimeDir, "mcp.json"), "utf8");
		expect((await lstat(path.join(runtimeDir, "mcp.json"))).isSymbolicLink()).toBe(false);
		expect(await readlink(path.join(runtimeDir, "trust.json"))).toBe(agentTrust);
		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("boom");
		};

		await expect(switchProfile("impl", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		expect(reloads).toBe(2);
		// The switch rewrote all three (filtered mcp.json, APPEND_SYSTEM.md
		// created, trust.json removed); the rollback must leave them in the
		// pre-switch state, not the target profile's.
		const mcpStat = await lstat(path.join(runtimeDir, "mcp.json"));
		expect(mcpStat.isSymbolicLink()).toBe(false);
		expect(await readFile(path.join(runtimeDir, "mcp.json"), "utf8")).toBe(originalInstanceMcp);
		const trustStat = await lstat(path.join(runtimeDir, "trust.json"));
		expect(trustStat.isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "trust.json"))).toBe(agentTrust);
		await expect(lstat(path.join(runtimeDir, "APPEND_SYSTEM.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("restores a snapshotted regular file exactly, even after the switch replaced it", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "linear" } } }),
		);
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ projects: {} }));
		await writeCatalog({
			impl: { mcps: ["github"], instructions: "Be terse." },
		});
		// Clean switch to the named profile: mcp.json is a filtered regular
		// file, APPEND_SYSTEM.md carries the profile instructions.
		await switchProfile("impl", deps());
		const filteredMcp = await readFile(path.join(runtimeDir, "mcp.json"), "utf8");
		const realMcpBefore = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
		let reloads = 0;
		let trustLinkCreated = false;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) {
				// Observe the generator's mid-switch state before failing: the
				// trust.json link is kept in place for every profile.
				trustLinkCreated = (await lstat(path.join(runtimeDir, "trust.json"))).isSymbolicLink();
				throw new Error("boom");
			}
		};

		await expect(switchProfile("default", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		// The default profile's generator regenerated the mcp.json snapshot
		// and deleted APPEND_SYSTEM.md; rollback must replace it with the
		// snapshot's content. The user's real mcp.json must stay byte-identical.
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(realMcpBefore);
		const mcpStat = await lstat(path.join(runtimeDir, "mcp.json"));
		expect(mcpStat.isSymbolicLink()).toBe(false);
		expect(mcpStat.isFile()).toBe(true);
		expect(await readFile(path.join(runtimeDir, "mcp.json"), "utf8")).toBe(filteredMcp);
		expect(await readFile(path.join(runtimeDir, "APPEND_SYSTEM.md"), "utf8")).toBe("Be terse.");
		expect(trustLinkCreated).toBe(true);
		const trustStat = await lstat(path.join(runtimeDir, "trust.json"));
		expect(trustStat.isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "trust.json"))).toBe(path.join(fixture.agentDir, "trust.json"));
	});

	it("restores the pre-switch file mode, not just the content", async () => {
		await writeCatalog({ impl: { instructions: "Be terse." } });
		await switchProfile("impl", deps());
		const appendPath = path.join(runtimeDir, "APPEND_SYSTEM.md");
		await chmod(appendPath, 0o600);

		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("boom");
		};
		await expect(switchProfile("default", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		// The failed switch deleted APPEND_SYSTEM.md; rollback recreates it
		// with the snapshot's content AND permission bits (writeFile alone
		// would recreate it with the umask default, widening 0600 to 0644).
		expect(await readFile(appendPath, "utf8")).toBe("Be terse.");
		expect((await lstat(appendPath)).mode & 0o777).toBe(0o600);
	});

	it("reload re-resolves the current profile without a switch marker and keeps its persistence", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		await switchProfile("impl", deps());

		const result = await switchProfile(undefined, deps(), { reloadCurrent: true });

		expect(result.profile).toBe("impl");
		const plan = await readPlanFile();
		expect(plan.switchedFrom).toBeUndefined();
		expect(plan.persistSelection).toBe(true);
	});

	it("reload of a transient launch selection stays transient", async () => {
		// Launch plans have no persistSelection (the CLI selection is transient).
		expect((await readPlanFile()).persistSelection).toBeUndefined();
		await writeCatalog({});

		const result = await switchProfile(undefined, deps(), { reloadCurrent: true });

		expect(result.profile).toBe("default");
		expect((await readPlanFile()).persistSelection).toBe(false);
	});

	it("re-resolves at switch time, so catalog edits are picked up", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });
		await switchProfile("impl", deps());
		// The profile definition changes after activation; reload propagates it.
		await writeCatalog({ impl: { skills: ["beta-skill"] } });

		await switchProfile(undefined, deps(), { reloadCurrent: true });

		const runtimeDir = deps().runtimeDir;
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md"),
			`-${path.join(runtimeDir, "skills", "alpha-skill", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")}`,
		]);
	});

	it("switching and reloading rebuild subagent settings from the current native base", async () => {
		const nativePath = path.join(fixture.agentDir, "settings.json");
		const native = {
			subagents: {
				defaultModel: "base/model",
				agentOverrides: { reviewer: { model: "native/model", description: "native description", inheritedContext: true } },
			},
		};
		await writeFile(nativePath, JSON.stringify(native));
		await writeCatalog({
			review: { subagents: { agentOverrides: { reviewer: { model: "profile/model", description: "profile description" } } } },
			plain: {},
		});

		await switchProfile("review", deps());
		const overridden = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(overridden.subagents.agentOverrides.reviewer).toEqual({
			model: "profile/model", description: "profile description", inheritedContext: true,
		});

		await switchProfile("plain", deps());
		let restored = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(restored.subagents).toEqual(native.subagents);
		expect((await readPlanFile()).subagents).toBeUndefined();

		await switchProfile("review", deps());
		const editedNative = {
			subagents: {
				defaultModel: "edited/base",
				agentOverrides: { reviewer: { model: "native/edited", description: "edited native description", inheritedContext: false } },
			},
		};
		await writeFile(nativePath, JSON.stringify(editedNative));
		await writeCatalog({ review: { subagents: { agentOverrides: { reviewer: { model: "profile/model" } } } } });
		await switchProfile(undefined, deps(), { reloadCurrent: true });

		restored = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(restored.subagents).toEqual({
			defaultModel: "edited/base",
			agentOverrides: { reviewer: { model: "profile/model", description: "edited native description", inheritedContext: false } },
		});
		expect((await readPlanFile()).subagents).toEqual({ agentOverrides: { reviewer: { model: "profile/model" } } });
	});

	it("restores exact subagent settings and declaration on failed reload", async () => {
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ subagents: { defaultModel: "native", agentOverrides: { reviewer: { model: "native/model", description: "native" } } } }),
		);
		await writeCatalog({
			review: { subagents: { agentOverrides: { reviewer: { model: "profile/model", description: "profile" } } } },
			plain: {},
		});
		await switchProfile("review", deps());
		const previousSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		const previousPlan = await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8");
		let reloads = 0;

		await expect(switchProfile("plain", deps({
			reload: async () => {
				reloads += 1;
				if (reloads === 1) throw new Error("reload failed");
			},
		}))).rejects.toThrow(/restored the previous settings/);

		expect(reloads).toBe(2);
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(previousSettings);
		expect(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8")).toBe(previousPlan);
	});

	it("profile switch changes per-server MCP tool policy", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
		);
		await writeCatalog({
			broad: {},
			narrow: { mcp_tools: { github: ["search"] } },
		});

		await switchProfile("broad", deps());
		let instanceMcp = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toBeUndefined();

		await switchProfile("narrow", deps());
		const plan = await readPlanFile();
		expect(plan.profile).toBe("narrow");
		expect(plan.mcpTools).toEqual({ github: ["search"] });

		instanceMcp = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden", search: "direct" });
	});

	it("empty MCP tool list survives reload", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
		);
		await writeCatalog({
			denied: { mcp_tools: { github: [] } },
		});

		await switchProfile("denied", deps());
		let instanceMcp = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden" });

		await switchProfile(undefined, deps(), { reloadCurrent: true });
		instanceMcp = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden" });
	});

	async function writeSharedMcpConfig(servers: Record<string, unknown>): Promise<void> {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(path.join(fixture.root, ".agents", "mcp.json"), JSON.stringify({ mcpServers: servers }));
	}

	it("switching to an empty mcps selection disables discovered user-level servers", async () => {
		await writeSharedMcpConfig({ github: { url: "https://x" } });
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
		await writeCatalog({
			open: {},
			closed: { mcps: [] },
		});

		await switchProfile("open", deps());
		expect((await lstat(path.join(runtimeDir, "mcp.json"))).isSymbolicLink()).toBe(false);

		await switchProfile("closed", deps());
		const plan = await readPlanFile();
		expect(plan.mcps).toEqual([]);
		const instanceMcp = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github).toEqual({ url: "https://x", enabled: false });
	});

	it("empty mcps selection survives reload", async () => {
		await writeSharedMcpConfig({ github: { url: "https://x" } });
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
		await writeCatalog({
			closed: { mcps: [] },
		});

		await switchProfile("closed", deps());
		const before = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(before.mcpServers.github).toEqual({ url: "https://x", enabled: false });

		await switchProfile(undefined, deps(), { reloadCurrent: true });
		const after = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(after.mcpServers.github).toEqual({ url: "https://x", enabled: false });
	});

	it("switching back to omitted mcps selection restores server availability", async () => {
		const originalMcp = JSON.stringify({ mcpServers: {} });
		await writeSharedMcpConfig({ github: { url: "https://x" } });
		await writeFile(path.join(fixture.agentDir, "mcp.json"), originalMcp);
		await writeCatalog({
			open: {},
			closed: { mcps: [] },
		});

		await switchProfile("closed", deps());
		const closedMcp = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(closedMcp.mcpServers.github).toEqual({ url: "https://x", enabled: false });

		await switchProfile("open", deps());
		expect((await lstat(path.join(runtimeDir, "mcp.json"))).isSymbolicLink()).toBe(false);
		const openMcp = JSON.parse(await readFile(path.join(runtimeDir, "mcp.json"), "utf8"));
		expect(openMcp.mcpServers.github).toEqual({ url: "https://x" });
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(originalMcp);
	});

	it("failed switch restores previous MCP tool policy", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
		);
		await writeCatalog({
			initial: { mcp_tools: { github: ["search"] } },
			failing: { mcp_tools: { github: [] } },
		});

		await switchProfile("initial", deps());
		const initialMcp = await readFile(path.join(runtimeDir, "mcp.json"), "utf8");
		const initialPlan = await readPlanFile();

		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("reload failed");
		};

		await expect(switchProfile("failing", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		expect(await readFile(path.join(runtimeDir, "mcp.json"), "utf8")).toBe(initialMcp);
		expect(await readPlanFile()).toEqual(initialPlan);
	});
});

describe("sparse resource selection across activation (fix-undeclared-resource-filtering)", () => {
	it("switching to a profile omitting a kind removes the previous restriction for that kind", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await addGlobalExtension(fixture, "ext-a");
		await addGlobalExtension(fixture, "ext-b");
		await writeCatalog({
			declared: { skills: ["alpha-skill"], extensions: ["ext-a"] },
			open: {},
		});

		await switchProfile("declared", deps());
		let settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"),
			`-${path.join(runtimeDir, "skills", "beta-skill", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md")}`,
		]);
		expect(settings.extensions).toEqual([path.join(fixture.agentDir, "extensions", "ext-a.ts")]);

		await switchProfile("open", deps());
		settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		// Both restrictions are gone: skills and extensions return to native
		// visibility (no selection keys); the omitted extension kind is exposed
		// through the conditional managed link to the real discovery directory.
		expect(settings.skills).toBeUndefined();
		expect(settings.extensions).toBeUndefined();
		expect((await lstat(path.join(runtimeDir, "extensions"))).isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "extensions"))).toBe(path.join(fixture.agentDir, "extensions"));
		const plan = await readPlanFile();
		const resolved = plan.resolved as { skills: Array<{ name: string }> };
		expect(resolved.skills.map((skill) => skill.name).sort()).toEqual(["alpha-skill", "beta-skill"]);
	});

	it("reloading after deleting a resource field restores native visibility for that kind only", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ impl: { skills: ["beta-skill"] } });
		await switchProfile("impl", deps());
		let settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md"),
			`-${path.join(runtimeDir, "skills", "alpha-skill", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")}`,
		]);

		await writeCatalog({ impl: {} });
		await switchProfile(undefined, deps(), { reloadCurrent: true });
		settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toBeUndefined();
	});

	it("reloading an omitted kind reflects edits to the current real user settings", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ open: {} });
		await switchProfile("open", deps());

		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ skills: ["-skills/alpha-skill/SKILL.md"] }),
		);
		await switchProfile(undefined, deps(), { reloadCurrent: true });

		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual(["-skills/alpha-skill/SKILL.md"]);
	});

	it("a failed transition restores the exact prior runtime content and resource policy", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({
			declared: { skills: ["alpha-skill"] },
			open: {},
		});
		await switchProfile("declared", deps());
		const previousSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		const previousPlan = await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8");

		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("reload failed");
		};
		await expect(switchProfile("open", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		expect(reloads).toBe(2);
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(previousSettings);
		expect(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8")).toBe(previousPlan);
	});

	it("restores the extension-link representation in both transition directions on failure", async () => {
		await addGlobalExtension(fixture, "ext-a");
		await writeCatalog({ declared: { extensions: ["ext-a"] }, open: {} });

		// Declared -> omitted failure: prior absence is restored.
		await switchProfile("declared", deps());
		await expect(lstat(path.join(runtimeDir, "extensions"))).rejects.toMatchObject({ code: "ENOENT" });

		let reloads = 0;
		const failFirstReload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("reload failed");
		};
		await expect(switchProfile("open", deps({ reload: failFirstReload }))).rejects.toThrow(
			/restored the previous settings/,
		);
		await expect(lstat(path.join(runtimeDir, "extensions"))).rejects.toMatchObject({ code: "ENOENT" });

		// Omitted -> declared failure: the prior link is restored.
		await switchProfile("open", deps());
		expect(await readlink(path.join(runtimeDir, "extensions"))).toBe(path.join(fixture.agentDir, "extensions"));

		reloads = 0;
		await expect(switchProfile("declared", deps({ reload: failFirstReload }))).rejects.toThrow(
			/restored the previous settings/,
		);
		expect((await lstat(path.join(runtimeDir, "extensions"))).isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "extensions"))).toBe(path.join(fixture.agentDir, "extensions"));
		// The real extension source is never touched by the rollback.
		expect(await readFile(path.join(fixture.agentDir, "extensions", "ext-a.ts"), "utf8")).toContain("ext-a");
	});

	it("fails actionably without deleting real content at the instance extension path", async () => {
		await addGlobalExtension(fixture, "ext-a");
		await writeCatalog({ open: {} });
		// A real directory occupies the managed path instead of the generated link.
		await mkdir(path.join(runtimeDir, "extensions"), { recursive: true });
		await writeFile(path.join(runtimeDir, "extensions", "real.ts"), "real bytes");

		await expect(switchProfile("open", deps())).rejects.toThrow(
			/real directory.*will not delete or overwrite/,
		);

		// The content is never deleted or replaced by the generated link.
		expect((await lstat(path.join(runtimeDir, "extensions"))).isDirectory()).toBe(true);
		expect(await readFile(path.join(runtimeDir, "extensions", "real.ts"), "utf8")).toBe("real bytes");
	});

	it("transitions the extension-link representation on reload after adding or deleting the field", async () => {
		await addGlobalExtension(fixture, "ext-a");
		await writeCatalog({ open: {} });

		await switchProfile("open", deps());
		expect((await lstat(path.join(runtimeDir, "extensions"))).isSymbolicLink()).toBe(true);

		await writeCatalog({ open: { extensions: ["ext-a"] } });
		await switchProfile(undefined, deps(), { reloadCurrent: true });
		await expect(lstat(path.join(runtimeDir, "extensions"))).rejects.toMatchObject({ code: "ENOENT" });

		await writeCatalog({ open: {} });
		await switchProfile(undefined, deps(), { reloadCurrent: true });
		expect((await lstat(path.join(runtimeDir, "extensions"))).isSymbolicLink()).toBe(true);
	});
});

describe("activation failure reporting (fix-undeclared-resource-filtering)", () => {
	it("delivers the actionable cause before the rollback reload and survives a throwing reporter", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		const events: string[] = [];
		const reload = async () => {
			events.push("reload");
		};
		const reportFailure = (message: string) => {
			events.push(`report:${message}`);
			throw new Error("reporter exploded");
		};

		fsFailure.failNextPlanWrite = true;
		await expect(switchProfile("impl", deps({ reload, reportFailure }))).rejects.toThrow(
			/restored the previous settings/,
		);

		const reported = events.filter((event) => event.startsWith("report:"));
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain('activation of profile "impl" failed');
		expect(reported[0]).toContain("injected write failure");
		// Reported before the rollback reload, which still ran despite the throw,
		// and the reporter failure did not block restoration.
		expect(events.indexOf(reported[0]!)).toBeLessThan(events.indexOf("reload"));
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
	});

	it("reports the unsafe extension-path refusal cause with its path and fix", async () => {
		await addGlobalExtension(fixture, "ext-a");
		await writeCatalog({ open: {} });
		await mkdir(path.join(runtimeDir, "extensions"), { recursive: true });
		await writeFile(path.join(runtimeDir, "extensions", "real.ts"), "real bytes");
		const reported: string[] = [];

		await expect(
			switchProfile("open", deps({ reportFailure: (message) => reported.push(message) })),
		).rejects.toThrow(/real directory.*will not delete or overwrite/);

		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain(path.join(runtimeDir, "extensions"));
		expect(reported[0]).toContain("will not delete or overwrite");
	});
});

describe("generated extension mirror on the ordinary default profile (fix-undeclared-resource-filtering)", () => {
	it("removes the generated mirror when switching from an omitted selection to default", async () => {
		await addGlobalExtension(fixture, "ext-a");
		await writeCatalog({ open: {} });

		await switchProfile("open", deps());
		const link = path.join(runtimeDir, "extensions");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);

		await switchProfile("default", deps());

		// The per-session generated mirror is gone; the real source is untouched.
		await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(path.join(fixture.agentDir, "extensions", "ext-a.ts"), "utf8")).toContain("ext-a");

		// The default additive baseline is retained (filter:none representation).
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.extensions).toContain(path.join(fixture.agentDir, "extensions"));
		expect(settings.defaultProjectTrust).toBeUndefined();
	});

	it("leaves foreign real content at the instance extension path untouched for default", async () => {
		await writeCatalog({ open: {}, plain: {} });
		// A foreign real directory Pi or a user created at the managed path.
		await mkdir(path.join(runtimeDir, "extensions", "foreign"), { recursive: true });
		await writeFile(path.join(runtimeDir, "extensions", "foreign", "keep.ts"), "keep");

		await switchProfile("default", deps());

		expect((await lstat(path.join(runtimeDir, "extensions"))).isDirectory()).toBe(true);
		expect(await readFile(path.join(runtimeDir, "extensions", "foreign", "keep.ts"), "utf8")).toBe("keep");
	});
});

describe("tolerant switch resolution with strict fatal boundaries", () => {
	it.each(["{ invalid", "[]", '{"skills":1}', '{"mcp_tools":{"github":"search"}}'])("does not write or reload for malformed selected definitions: %s", async (content) => {
		await writeCatalog({ broken: {} });
		await writeFile(path.join(fixture.profileSwitchDir, "profiles", "broken.json"), content);
		const before = await managedSnapshot(); const reload = vi.fn(async () => {});
		await expect(switchProfile("broken", deps({ reload }))).rejects.toThrow(/broken.json/);
		expect(reload).not.toHaveBeenCalled();
		expect(await managedSnapshot()).toEqual(before);
	});
	it("switches partially, retains original references, and resolves new resources on reload", async () => {
		await addGlobalSkill(fixture, "selected"); await addGlobalExtension(fixture, "selected-ext");
		await writeFile(path.join(fixture.agentDir, "mcp.json"), '{"mcpServers":{"fixture":{"command":"fixture"}}}');
		await writeCatalog({ partial: { skills: ["selected", "future"], extensions: ["selected-ext", "future-ext"], mcps: ["fixture", "future-server"], mcp_tools: { "future-server": ["search"] } } });
		const file = path.join(fixture.profileSwitchDir, "profiles", "partial.json"); const original = await readFile(file, "utf8");
		const result = await switchProfile("partial", deps(), { clearOverlay: true });
		expect(result.warnings.some((message) => message.includes('unknown skill "future"'))).toBe(true);
		expect(result.warnings.some((message) => message.includes('unknown extension: "future-ext"'))).toBe(true);
		let plan = await readPlanFile();
		expect(plan.mcps).toEqual(["fixture"]); expect(plan.mcpTools).toEqual({ "future-server": ["search"] });
		await addGlobalSkill(fixture, "future"); await addGlobalExtension(fixture, "future-ext");
		await writeFile(path.join(fixture.agentDir, "mcp.json"), '{"mcpServers":{"fixture":{"command":"fixture"},"future-server":{"command":"future"}}}');
		const next = await switchProfile(undefined, deps(), { reloadCurrent: true });
		expect(next.warnings).toEqual([]);
		plan = await readPlanFile(); expect(plan.mcps).toEqual(["fixture", "future-server"]);
		expect((plan.resolved as { skills: Array<{ name: string }> }).skills.map((entry) => entry.name)).toEqual(["selected", "future"]);
		expect((plan.resolved as { extensions: Array<{ id: string }> }).extensions.map((entry) => entry.id)).toEqual(["selected-ext", "future-ext"]);
		expect(plan.switchedFrom).toBeUndefined(); expect(plan.persistSelection).toBe(true);
		expect(await readFile(file, "utf8")).toBe(original);
	});
	it("still rejects overlay disabling a skipped literal without changing the active files", async () => {
		await writeCatalog({ partial: { skills: ["missing"] } });
		const before = await managedSnapshot();
		await expect(switchProfile("partial", deps(), { overlay: { disabledSkills: ["missing"] } })).rejects.toThrow(/overlay disables unknown skill/);
		expect(await managedSnapshot()).toEqual(before);
	});
});


describe("final-stage diagnostic ownership during switching", () => {
	it.each([false, true])("returns refreshed diagnostics without stale candidate messages (cleared=%s), preserving plain warnings", async (cleared) => {
		await writeCatalog({ policy: { mcp_tools: { late: ["search"] } } });
		await writeFile(path.join(fixture.agentDir, "mcp.json"), '{"mcpServers":{"alpha":{"command":"alpha"}}}');
		const resolve = initialProfile.resolveInitialProfile;
		vi.spyOn(initialProfile, "resolveInitialProfile").mockImplementation(async (...args) => {
			const result = await resolve(...args);
			expect(result.warnings.some((message) => message.includes("candidates: alpha"))).toBe(true);
			await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: cleared ? { late: { command: "late" } } : { beta: { command: "beta" } } }));
			return { ...result, warnings: [...result.warnings, "plain discovery warning"] };
		});
		const result = await switchProfile("policy", deps());
		expect(result.warnings).toContain("plain discovery warning");
		expect(result.warnings.some((message) => message.includes("candidates: alpha"))).toBe(false);
		const issues = result.warnings.filter((message) => message.includes('unknown MCP server "late"'));
		expect(issues).toHaveLength(cleared ? 0 : 1);
		if (!cleared) expect(issues[0]).toContain("candidates: beta");
	});
});

it("retains plain warnings from resolution plans without diagnostic metadata", async () => {
	vi.spyOn(initialProfile, "resolveInitialProfile").mockResolvedValue({ plan: { profile: "legacy", source: "global", filter: "selection", skills: [], extensions: [], resourceSelection: { skills: true, extensions: true } }, projectTrusted: true, warnings: ["legacy plain warning"] });
	const result = await switchProfile("legacy", deps());
	expect(result.warnings).toEqual(["legacy plain warning"]);
	expect((await readPlanFile()).diagnostics).toBeUndefined();
});
