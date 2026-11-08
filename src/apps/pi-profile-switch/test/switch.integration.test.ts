import { chmod, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MCP_INVOCATION_ARGS, invokeNativeTool, localMcpServer, mcpCalls } from "./helpers/mcp-invocation.ts";
import { runLauncherRpc } from "./helpers/launcher-runner.ts";
import { addGlobalExtension, addGlobalSkill, createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";
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

async function addProjectSkill(name: string): Promise<void> {
	const dir = path.join(fixture.cwd, ".pi", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: project skill ${name}\n---\n`);
}

async function trustProject(): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
}

async function writeMcpConfig(servers: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

interface RpcState {
	sessionId: string;
	sessionFile?: string;
	messageCount: number;
}

async function getState(rpc: RpcDriver): Promise<RpcState> {
	const response = await rpc.send({ type: "get_state" });
	return response.data as unknown as RpcState;
}

async function skillCommands(rpc: RpcDriver): Promise<Array<{ name: string; description?: string }>> {
	const response = await rpc.send({ type: "get_commands" });
	const commands = (response.data?.commands ?? []) as Array<{ name: string; description?: string }>;
	return commands.filter((command) => command.name.startsWith("skill:"));
}

async function managedFiles(instance: string): Promise<unknown[]> {
	return Promise.all(["settings.json", "pi-profile.json", "mcp.json", "APPEND_SYSTEM.md", "trust.json"].map(async (name) => {
		const file = path.join(instance, name);
		const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (!info) return { name, kind: "absent" };
		if (info.isSymbolicLink()) return { name, kind: "symlink", target: await readlink(file) };
		return { name, kind: "file", mode: info.mode & 0o777, content: await readFile(file, "utf8") };
	}));
}

describe("launcher integration: in-session switching", () => {
	it(
		"project-level visibility is the same before and after switching to default",
		{ timeout: 60_000 },
		async () => {
			await addProjectSkill("proj-skill");
			await addProjectSkill("proj-unselected");
			await writeCatalog({ doc: { skills: [] } });
			await trustProject();

			const rpc = runLauncherRpc(fixture, ["doc", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				expect((await skillCommands(rpc)).map((command) => command.name).sort()).toEqual([
					"skill:proj-skill",
					"skill:proj-unselected",
				]);

				const switched = await rpc.send({ type: "prompt", message: "/profile use default" }, 60_000);
				expect(switched.success).toBe(true);

				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);
				expect((await skillCommands(rpc)).map((command) => command.name).sort()).toEqual([
					"skill:profile-config",
					"skill:proj-skill",
					"skill:proj-unselected",
				]);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"/profile use switches without restarting: same session, new resources, state persisted",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({
				alpha: { skills: ["alpha-skill"] },
				beta: { skills: ["beta-skill"] },
			});

			const rpc = runLauncherRpc(fixture, ["alpha", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(["skill:alpha-skill"]);

				const switched = await rpc.send({ type: "prompt", message: "/profile use beta" }, 60_000);
				expect(switched.success).toBe(true);

				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);
				expect(after.sessionFile).toBe(before.sessionFile);
				expect(before.sessionFile).toBeDefined();
				expect(path.basename(path.dirname(before.sessionFile!))).toMatch(/^--.+--$/);
				expect(after.messageCount).toBe(before.messageCount);
				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(["skill:beta-skill"]);

				const state = JSON.parse(
					await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"),
				);
				expect(state).toEqual({ activeProfile: "beta" });
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"/profile reload picks up shared-resource edits without a restart",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ alpha: { skills: ["alpha-skill"] } });

			const rpc = runLauncherRpc(fixture, ["alpha", "--", "--mode", "rpc"]);
			try {
				expect((await skillCommands(rpc))[0]?.description).toContain("alpha-skill");

				const skillFile = path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md");
				await writeFile(
					skillFile,
					"---\nname: alpha-skill\ndescription: EDITED description\n---\nbody\n",
				);

				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);

				expect((await skillCommands(rpc))[0]?.description).toBe("EDITED description");
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"a failed switch leaves the runtime and state untouched",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ alpha: { skills: ["alpha-skill"] } });

			const rpc = runLauncherRpc(fixture, ["alpha", "--", "--mode", "rpc"]);
			try {
				const failed = await rpc.send({ type: "prompt", message: "/profile use ghost" }, 60_000);
				expect(failed.success).toBe(true);

				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(["skill:alpha-skill"]);
				const { existsSync } = await import("node:fs");
				expect(existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"profile switch changes per-server MCP tool policy",
		{ timeout: 60_000 },
		async () => {
			await writeFile(
				path.join(fixture.agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { github: { url: "https://gh" } } }),
			);
			await writeCatalog({
				broad: {},
				narrow: { mcp_tools: { github: ["search"] } },
			});

			const rpc = runLauncherRpc(fixture, ["broad", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				let instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github.toolExposure).toBeUndefined();

				const switched = await rpc.send({ type: "prompt", message: "/profile use narrow" }, 60_000);
				expect(switched.success).toBe(true);

				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);

				instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden", search: "direct" });
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"empty MCP list survives reload",
		{ timeout: 60_000 },
		async () => {
			await writeFile(
				path.join(fixture.agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { github: { url: "https://gh" } } }),
			);
			await writeCatalog({
				denied: { mcp_tools: { github: [] } },
			});

			const rpc = runLauncherRpc(fixture, ["denied", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				let instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden" });

				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);

				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);

				instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden" });
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"malformed project winner leaves the previous policy and all managed files unchanged",
		{ timeout: 60_000 },
		async () => {
			await writeFile(
				path.join(fixture.agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { github: { url: "https://gh" } } }),
			);
			await writeCatalog({
				initial: { mcp_tools: { github: ["search"] } },
				failing: { mcp_tools: { github: [] } },
			});

						await trustProject();
			const projectProfiles = path.join(fixture.cwd, ".pi", "profiles");
			await mkdir(projectProfiles, { recursive: true });
			const invalidWinner = path.join(projectProfiles, "failing.json");
			await writeFile(invalidWinner, '{"mcp_tools":{"github":"invalid-type"}}');
			const rpc = runLauncherRpc(fixture, ["initial", "--", "--mode", "rpc"]);
			try {
				await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				const before = await managedFiles(instance);
				const session = await getState(rpc);
				let instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden", search: "direct" });

				const failed = await rpc.send({ type: "prompt", message: "/profile use failing" }, 60_000);
				expect(failed.success).toBe(true);
				await rpc.waitFor((message) => JSON.stringify(message).includes(invalidWinner));
				expect(await managedFiles(instance)).toEqual(before);
				expect((await getState(rpc)).sessionId).toBe(session.sessionId);
				expect((await import("node:fs")).existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);

				instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden", search: "direct" });
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"switching to an empty mcps selection disables discovered user-level servers",
		{ timeout: 60_000 },
		async () => {
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(
				path.join(fixture.root, ".agents", "mcp.json"),
				JSON.stringify({ mcpServers: { github: { url: "https://gh" } } }),
			);
			await writeMcpConfig({});
			await writeCatalog({
				open: {},
				closed: { mcps: [] },
			});

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				expect((await lstat(path.join(instance, "mcp.json"))).isSymbolicLink()).toBe(false);

				const switched = await rpc.send({ type: "prompt", message: "/profile use closed" }, 60_000);
				expect(switched.success).toBe(true);

				const instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github).toEqual({ url: "https://gh", enabled: false });
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"empty mcps selection survives reload",
		{ timeout: 60_000 },
		async () => {
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(
				path.join(fixture.root, ".agents", "mcp.json"),
				JSON.stringify({ mcpServers: { github: { url: "https://gh" } } }),
			);
			await writeMcpConfig({});
			await writeCatalog({
				closed: { mcps: [] },
			});

			const rpc = runLauncherRpc(fixture, ["closed", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				let instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github).toEqual({ url: "https://gh", enabled: false });

				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);

				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);

				instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github).toEqual({ url: "https://gh", enabled: false });
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"switching back to omitted mcps selection restores server availability",
		{ timeout: 60_000 },
		async () => {
			const originalMcp = JSON.stringify({ mcpServers: {} });
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(
				path.join(fixture.root, ".agents", "mcp.json"),
				JSON.stringify({ mcpServers: { github: { url: "https://gh" } } }),
			);
			await writeMcpConfig({});
			await writeCatalog({
				open: {},
				closed: { mcps: [] },
			});

			const rpc = runLauncherRpc(fixture, ["closed", "--", "--mode", "rpc"]);
			try {
				await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				let instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github).toEqual({ url: "https://gh", enabled: false });

				const switched = await rpc.send({ type: "prompt", message: "/profile use open" }, 60_000);
				expect(switched.success).toBe(true);

				instanceMcp = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
				expect(instanceMcp.mcpServers.github).toEqual({ url: "https://gh" });
				expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(originalMcp);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
});

describe("in-session sparse resource selection (fix-undeclared-resource-filtering)", () => {
	async function extensionCommandNames(rpc: RpcDriver): Promise<string[]> {
		const response = await rpc.send({ type: "get_commands" });
		const commands = (response.data?.commands ?? []) as Array<{ name: string; source?: string }>;
		return commands.filter((command) => command.source === "extension").map((command) => command.name).sort();
	}

	it(
		"switching from declared kinds to a profile omitting them restores native visibility without a restart",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addGlobalExtension(fixture, "ext-a");
			await addGlobalExtension(fixture, "ext-b");
			await writeCatalog({
				declared: { skills: ["alpha-skill"], extensions: ["ext-a"] },
				open: {},
			});

			const rpc = runLauncherRpc(fixture, ["declared", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				const skillsBefore = (await skillCommands(rpc)).map((command) => command.name);
				expect(skillsBefore).toEqual(["skill:alpha-skill"]);
				expect(await extensionCommandNames(rpc)).toContain("ext-a");
				expect(await extensionCommandNames(rpc)).not.toContain("ext-b");

				const switched = await rpc.send({ type: "prompt", message: "/profile use open" }, 60_000);
				expect(switched.success).toBe(true);

				const after = await getState(rpc);
				// Session identity and message history are retained, not just the file.
				expect(after.sessionId).toBe(before.sessionId);
				expect(after.sessionFile).toBe(before.sessionFile);
				expect(after.messageCount).toBe(before.messageCount);
				const skills = (await skillCommands(rpc)).map((command) => command.name);
				expect(skills).toContain("skill:alpha-skill");
				expect(skills).toContain("skill:beta-skill");
				expect(await extensionCommandNames(rpc)).toContain("ext-b");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"reload after deleting each resource field restores that kind's native visibility",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addGlobalExtension(fixture, "ext-a");
			await addGlobalExtension(fixture, "ext-b");
			await writeCatalog({ impl: { skills: ["beta-skill"], extensions: ["ext-a"] } });

			const rpc = runLauncherRpc(fixture, ["impl", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(["skill:beta-skill"]);
				expect(await extensionCommandNames(rpc)).toContain("ext-a");
				expect(await extensionCommandNames(rpc)).not.toContain("ext-b");

				await writeCatalog({ impl: {} });
				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);

				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);
				expect(after.messageCount).toBe(before.messageCount);
				const skills = (await skillCommands(rpc)).map((command) => command.name);
				expect(skills).toContain("skill:alpha-skill");
				expect(skills).toContain("skill:beta-skill");
				expect(await extensionCommandNames(rpc)).toContain("ext-a");
				expect(await extensionCommandNames(rpc)).toContain("ext-b");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"reload reflects real user settings edits for an omitted kind",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				const skillsBefore = (await skillCommands(rpc)).map((command) => command.name);
				expect(skillsBefore).toContain("skill:alpha-skill");

				await writeFile(
					path.join(fixture.agentDir, "settings.json"),
					JSON.stringify({ skills: ["-skills/alpha-skill/SKILL.md"] }),
				);
				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);

				const skillsAfter = (await skillCommands(rpc)).map((command) => command.name);
				expect(skillsAfter).toContain("skill:beta-skill");
				expect(skillsAfter).not.toContain("skill:alpha-skill");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"an injected write failure restores the exact prior runtime content and resource visibility",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addGlobalExtension(fixture, "ext-a");
			await addGlobalExtension(fixture, "ext-b");
			await writeCatalog({
				declared: { skills: ["alpha-skill"], extensions: ["ext-a"] },
				open: {},
			});

			const rpc = runLauncherRpc(fixture, ["declared", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				const skillsBefore = (await skillCommands(rpc)).map((command) => command.name);
				const extensionsBefore = await extensionCommandNames(rpc);
				expect(skillsBefore).toEqual(["skill:alpha-skill"]);
				expect(extensionsBefore).not.toContain("ext-b");

				const instance = await soleInstanceDir(fixture);
				const settingsPath = path.join(instance, "settings.json");
				const planPath = path.join(instance, "pi-profile.json");
				const settingsBefore = await readFile(settingsPath, "utf8");
				const planBefore = await readFile(planPath, "utf8");

				// The switch writes settings.json first, then pi-profile.json. A
				// read-only plan file makes the plan write fail after settings.json
				// changed, exercising the process-level rollback boundary.
				await chmod(planPath, 0o444);
				const attempted = await rpc.send({ type: "prompt", message: "/profile use open" }, 60_000);
				expect(attempted.success).toBe(true);

				// Exact prior runtime content; the failed target is not active.
				expect(await readFile(settingsPath, "utf8")).toBe(settingsBefore);
				expect(await readFile(planPath, "utf8")).toBe(planBefore);
				expect(JSON.parse(await readFile(planPath, "utf8")).profile).toBe("declared");

				// Actual resource visibility after the real process reload: the
				// failed target's extra resources are not visible and the declared
				// restriction still applies.
				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);
				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(skillsBefore);
				expect(await extensionCommandNames(rpc)).toEqual(extensionsBefore);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"reports an actionable activation failure at the user boundary after an injected write failure",
		{ timeout: 60_000 },
		async () => {
			await addGlobalExtension(fixture, "ext-a");
			await addGlobalExtension(fixture, "ext-b");
			await writeCatalog({ declared: { extensions: ["ext-a"] }, open: {} });

			const rpc = runLauncherRpc(fixture, ["declared", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				const instance = await soleInstanceDir(fixture);
				// Make the plan write fail after settings.json changed.
				await chmod(path.join(instance, "pi-profile.json"), 0o444);

				const attempted = await rpc.send({ type: "prompt", message: "/profile use open" }, 60_000);
				expect(attempted.success).toBe(true);

				// The cause is delivered to the user (RPC notification) even though the
				// rollback reload invalidates the old command context.
				const diagnostic = await rpc.waitFor(
					(message) => JSON.stringify(message).includes("restored the previous settings"),
					20_000,
				);
				const diagnosticJson = JSON.stringify(diagnostic);
				expect(diagnosticJson).toContain("activation of profile");
				expect(diagnosticJson).toMatch(/EACCES|permission denied/);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"transitions the extension mirror in both directions with session identity retained",
		{ timeout: 60_000 },
		async () => {
			await addGlobalExtension(fixture, "ext-a");
			await addGlobalExtension(fixture, "ext-b");
			await writeCatalog({ declared: { extensions: ["ext-a"] }, open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				const link = path.join(instance, "extensions");
				expect((await lstat(link)).isSymbolicLink()).toBe(true);
				expect(await extensionCommandNames(rpc)).toContain("ext-b");

				// Omitted -> declared: the generated link is removed and only the
				// declared extension stays visible.
				const switched = await rpc.send({ type: "prompt", message: "/profile use declared" }, 60_000);
				expect(switched.success).toBe(true);
				await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await extensionCommandNames(rpc)).toContain("ext-a");
				expect(await extensionCommandNames(rpc)).not.toContain("ext-b");

				// Declared -> omitted: the link is restored and native visibility
				// returns without restarting.
				const back = await rpc.send({ type: "prompt", message: "/profile use open" }, 60_000);
				expect(back.success).toBe(true);
				expect((await lstat(link)).isSymbolicLink()).toBe(true);
				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);
				expect(after.messageCount).toBe(before.messageCount);
				expect(await extensionCommandNames(rpc)).toContain("ext-b");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"an unsafe real directory at the instance extension path blocks the transition safely",
		{ timeout: 60_000 },
		async () => {
			await addGlobalExtension(fixture, "ext-a");
			await addGlobalExtension(fixture, "ext-b");
			await writeCatalog({ declared: { extensions: ["ext-a"] }, open: {} });

			const rpc = runLauncherRpc(fixture, ["declared", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				const instance = await soleInstanceDir(fixture);
				const link = path.join(instance, "extensions");
				await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
				// Real content appears at the managed path (created by Pi or a user).
				await mkdir(link, { recursive: true });
				await writeFile(path.join(link, "real.ts"), "real bytes");

				const attempted = await rpc.send({ type: "prompt", message: "/profile use open" }, 60_000);
				expect(attempted.success).toBe(true);

				// The failure reaches the user boundary (RPC notification) before the
				// rollback reload invalidates the command context.
				const diagnostic = await rpc.waitFor(
					(message) => JSON.stringify(message).includes("will not delete or overwrite"),
					20_000,
				);
				const diagnosticJson = JSON.stringify(diagnostic);
				expect(diagnosticJson).toContain("activation of profile");
				expect(diagnosticJson).toContain("restored the previous settings");
				// Real content is never deleted; prior representation/visibility/selection intact.
				expect(await readFile(path.join(link, "real.ts"), "utf8")).toBe("real bytes");
				expect(JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8")).profile).toBe("declared");
				expect(await extensionCommandNames(rpc)).toContain("ext-a");
				expect(await extensionCommandNames(rpc)).not.toContain("ext-b");
				// The failed selection is not persisted.
				await expect(
					readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"),
				).rejects.toThrow();
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"removes the generated extension mirror when switching to the ordinary default profile",
		{ timeout: 60_000 },
		async () => {
			await addGlobalExtension(fixture, "ext-a");
			await writeCatalog({ open: {} });

			const rpc = runLauncherRpc(fixture, ["open", "--", "--mode", "rpc"]);
			try {
				const before = await getState(rpc);
				const instance = await soleInstanceDir(fixture);
				const link = path.join(instance, "extensions");
				expect((await lstat(link)).isSymbolicLink()).toBe(true);

				const switched = await rpc.send({ type: "prompt", message: "/profile use default" }, 60_000);
				expect(switched.success).toBe(true);

				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);
				expect(after.messageCount).toBe(before.messageCount);
				// The per-session generated mirror is gone and the real source is intact.
				await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await readFile(path.join(fixture.agentDir, "extensions", "ext-a.ts"), "utf8")).toContain("ext-a");
				// The default additive baseline is retained.
				const settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
				expect(settings.extensions).toContain(path.join(fixture.agentDir, "extensions"));
				expect(settings.defaultProjectTrust).toBeUndefined();
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"refuses unexpected real content at the instance extension path for a declared selection",
		{ timeout: 60_000 },
		async () => {
			await addGlobalExtension(fixture, "ext-a");
			await addGlobalExtension(fixture, "ext-b");
			await writeCatalog({ declared: { extensions: ["ext-a"] }, empty: { extensions: [] }, open: {} });

			const rpc = runLauncherRpc(fixture, ["declared", "--", "--mode", "rpc"]);
			try {
				await rpc.send({ type: "get_state" });
				const instance = await soleInstanceDir(fixture);
				const extDir = path.join(instance, "extensions");
				await expect(lstat(extDir)).rejects.toMatchObject({ code: "ENOENT" });
				await mkdir(path.join(extDir, "sneaky"), { recursive: true });
				await writeFile(path.join(extDir, "sneaky", "index.ts"), "export default 1");

				const attempted = await rpc.send({ type: "prompt", message: "/profile use empty" }, 60_000);
				expect(attempted.success).toBe(true);

				const diagnostic = await rpc.waitFor(
					(message) => JSON.stringify(message).includes("will not delete or overwrite"),
					20_000,
				);
				expect(JSON.stringify(diagnostic)).toContain("activation of profile");

				// Content is not deleted or adopted; the prior selection stays active.
				expect(await readFile(path.join(extDir, "sneaky", "index.ts"), "utf8")).toBe("export default 1");
				expect(JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8")).profile).toBe("declared");
				expect(await extensionCommandNames(rpc)).toContain("ext-a");
				expect(await extensionCommandNames(rpc)).not.toContain("ext-b");
			} finally {
				await rpc.close();
			}
		},
	);
});

describe("live partial switching and re-resolution", () => {
	it("persists a partial switch, clears its old overlay, and reloads reappearing resources without changing history, process or project trust", { timeout: 90_000 }, async () => {
		await addGlobalSkill(fixture, "selected"); await addGlobalSkill(fixture, "unselected");
		await addGlobalExtension(fixture, "selected-ext"); await addGlobalExtension(fixture, "unselected-ext");
		await addProjectSkill("project-skill"); await trustProject();
		const projectExt = path.join(fixture.cwd, ".pi", "extensions"); await mkdir(projectExt, { recursive: true });
		await writeFile(path.join(projectExt, "project-ext.ts"), 'export default function(pi) { pi.registerCommand("project-ext", { handler: async () => {} }); }');
		await writeMcpConfig({ fixture: localMcpServer() });
		await writeCatalog({ initial: { skills: ["selected", "unselected"], extensions: ["selected-ext"] }, partial: { skills: ["selected", "future-skill"], extensions: ["selected-ext", "future-ext"], mcps: ["fixture", "future-server"], mcp_tools: { "future-server": ["search"] } } });
		const profileFile = path.join(fixture.profileSwitchDir, "profiles", "partial.json"); const definition = await readFile(profileFile, "utf8");
		const trustFile = path.join(fixture.agentDir, "trust.json"); const trust = await readFile(trustFile, "utf8");
		const rpc = runLauncherRpc(fixture, ["initial", "--", ...MCP_INVOCATION_ARGS]);
		try {
			const seeded = await rpc.send({ type: "bash", command: "printf switch-history" }); expect(seeded.success).toBe(true);
			const before = await getState(rpc); const history = (await rpc.send({ type: "get_messages" })).data?.messages;
			expect((history as unknown[]).length).toBeGreaterThan(0);
			const instance = await soleInstanceDir(fixture); const pid = await readFile(path.join(instance, "pid"), "utf8");
			const trustLink = await readlink(path.join(instance, "trust.json"));
			await rpc.send({ type: "prompt", message: "/profile overlay disable skill unselected" }, 45_000);
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8")).overlay).toEqual({ disabledSkills: ["unselected"] });
			const switched = await rpc.send({ type: "prompt", message: "/profile use partial" }, 45_000); expect(switched.success).toBe(true);
			expect(await rpc.skillCommandNames()).toEqual(["skill:project-skill", "skill:selected"]);
			let names = (await rpc.commandNames()).map((entry) => entry.name);
			expect(names).toContain("project-ext"); expect(names).toContain("selected-ext"); expect(names).not.toContain("unselected-ext"); expect(names).not.toContain("future-ext");
			let plan = JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8"));
			expect(plan.profile).toBe("partial"); expect(plan.mcps).toEqual(["fixture"]);
			for (const reference of ["future-skill", "future-ext", "future-server"]) expect(plan.diagnostics.some((issue: { reference?: string }) => issue.reference === reference)).toBe(true);
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"))).toEqual({ activeProfile: "partial" });
			await addGlobalSkill(fixture, "future-skill"); await addGlobalExtension(fixture, "future-ext");
			await writeMcpConfig({ fixture: localMcpServer(), "future-server": localMcpServer() });
			const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 45_000); expect(reloaded.success).toBe(true);
			expect(await rpc.skillCommandNames()).toEqual(["skill:future-skill", "skill:project-skill", "skill:selected"]);
			names = (await rpc.commandNames()).map((entry) => entry.name); expect(names).toContain("future-ext"); expect(names).toContain("project-ext"); expect(names).not.toContain("unselected-ext");
			plan = JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8"));
			expect(plan.mcps).toEqual(["fixture", "future-server"]); expect(plan.diagnostics).toBeUndefined(); expect(plan.switchedFrom).toBeUndefined();
			const after = await getState(rpc); expect(after.sessionId).toBe(before.sessionId); expect(after.sessionFile).toBe(before.sessionFile);
			expect((await rpc.send({ type: "get_messages" })).data?.messages).toEqual(history);
			expect(await readFile(path.join(instance, "pid"), "utf8")).toBe(pid);
			expect(await readlink(path.join(instance, "trust.json"))).toBe(trustLink); expect(await readFile(trustFile, "utf8")).toBe(trust);
			expect((await invokeNativeTool(rpc, "mcp__future_server__search", { query: "reappeared" })).isError).toBe(false);
			await rpc.send({ type: "prompt", message: "/profile use default" }, 45_000);
			expect((await rpc.commandNames()).map((entry) => entry.name)).toContain("project-ext"); expect(await rpc.skillCommandNames()).toContain("skill:project-skill");
			expect((await getState(rpc)).sessionId).toBe(before.sessionId);
			expect(await readlink(path.join(instance, "trust.json"))).toBe(trustLink);
		} finally { await rpc.close(); await rpc.waitForExit(); }
		expect(await readFile(profileFile, "utf8")).toBe(definition); expect(await readFile(trustFile, "utf8")).toBe(trust);
	});

	it("keeps one-shot CLI selection transient across real reload", { timeout: 60_000 }, async () => {
		await addGlobalSkill(fixture, "selected"); await writeCatalog({ transient: { skills: ["selected"] } });
		const rpc = runLauncherRpc(fixture, ["transient", "--", "--mode", "rpc"]);
		try {
			const before = await getState(rpc);
			await rpc.send({ type: "prompt", message: "/profile reload" }, 45_000);
			const plan = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "pi-profile.json"), "utf8"));
			expect(plan.profile).toBe("transient"); expect(plan.persistSelection).toBe(false);
			expect((await getState(rpc)).sessionId).toBe(before.sessionId);
			const { existsSync } = await import("node:fs");
			expect(existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);
			expect(existsSync(path.join(fixture.profileSwitchDir, "pi-profile-state.json"))).toBe(false);
		} finally { await rpc.close(); await rpc.waitForExit(); }
	});

	it("changes actual user MCP callability for empty/reload/omitted transitions while project servers and source files stay native", { timeout: 90_000 }, async () => {
		const userCalls = path.join(fixture.root, "user-calls.jsonl"); const projectCalls = path.join(fixture.root, "project-calls.jsonl");
		await writeMcpConfig({ fixture: { ...localMcpServer(undefined, userCalls), exposure: "direct" } });
		const source = path.join(fixture.agentDir, "mcp.json"); const original = await readFile(source, "utf8");
		const project = path.join(fixture.cwd, ".pi", "mcp.json"); const projectSource = JSON.stringify({ mcpServers: { project: { ...localMcpServer(undefined, projectCalls), exposure: "direct" } } });
		await writeFile(project, projectSource); await trustProject();
		await writeCatalog({ open: { tools: ["read"] }, closed: { tools: ["read"], mcps: [] } });
		const rpc = runLauncherRpc(fixture, ["open", "--", ...MCP_INVOCATION_ARGS]);
		try {
			const before = await getState(rpc); const instance = await soleInstanceDir(fixture); const link = await readlink(path.join(instance, "trust.json"));
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "before" })).isError).toBe(false);
			const history = (await rpc.send({ type: "get_messages" })).data?.messages;
			await rpc.send({ type: "prompt", message: "/profile use closed" }, 45_000);
			expect((await rpc.send({ type: "get_messages" })).data?.messages).toEqual(history);
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "denied" })).isError).toBe(true);
			expect((await invokeNativeTool(rpc, "mcp__project__search", { query: "project" })).isError).toBe(false);
			await rpc.send({ type: "prompt", message: "/profile reload" }, 45_000);
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "still-denied" })).isError).toBe(true);
			await rpc.send({ type: "prompt", message: "/profile use open" }, 45_000);
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "reopened" })).isError).toBe(false);
			expect((await getState(rpc)).sessionId).toBe(before.sessionId); expect(await readlink(path.join(instance, "trust.json"))).toBe(link);
			expect(await mcpCalls(userCalls)).toEqual([{ name: "search", arguments: { query: "before" } }, { name: "search", arguments: { query: "reopened" } }]);
			expect((await mcpCalls(projectCalls)).map((call) => call.name)).toEqual(["search"]);
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"))).toEqual({ activeProfile: "open" });
		} finally { await rpc.close(); await rpc.waitForExit(); }
		expect(await readFile(source, "utf8")).toBe(original); expect(await readFile(project, "utf8")).toBe(projectSource);
	});
});
