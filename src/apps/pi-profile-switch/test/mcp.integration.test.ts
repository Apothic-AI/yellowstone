import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncher, runLauncherRpc } from "./helpers/launcher-runner.ts";
import { runNativePi } from "./helpers/native-pi-runner.ts";
import { MCP_INVOCATION_ARGS, invokeNativeTool, localMcpServer } from "./helpers/mcp-invocation.ts";
import { createPiFixture, launchInstanceDirs, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";

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

async function writeMcpConfig(servers: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

describe("launcher integration: native MCP snapshot semantics", () => {
	it(
		"a missing-only MCP selection starts with warnings and disables discovered user servers",
		{ timeout: 30_000 },
		async () => {
			await writeMcpConfig({ github: { url: "https://x" } });
			await writeCatalog({ review: { mcps: ["typo-server"] } });

			const failure = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);
			expect(failure.code).toBe(0);
			const snapshot = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8"));
			expect(snapshot.mcpServers.github.enabled).toBe(false);
			expect(failure.stderr).toContain('unknown MCP server: "typo-server" (usable candidates: github)');
		},
	);

	it(
		"materializes the instance mcp.json as a generated snapshot, never a symlink",
		{ timeout: 45_000 },
		async () => {
			const globalConfig = { github: { url: "https://x" }, linear: { command: "mcp-linear" } };
			await writeMcpConfig(globalConfig);
			await writeCatalog({ review: { mcps: ["github"] } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			const stat = await (await import("node:fs/promises")).lstat(instanceMcpPath);
			expect(stat.isSymbolicLink()).toBe(false);
			expect(JSON.parse(await readFile(instanceMcpPath, "utf8"))).toEqual({
				mcpServers: {
					github: { url: "https://x" },
					linear: { command: "mcp-linear", enabled: false },
				},
			});

			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8"))).toEqual({
				mcpServers: globalConfig,
			});
			expect(existsSync(path.join(fixture.cwd, ".pi", "mcp.json"))).toBe(false);
		},
	);

	it(
		"materializes the merged snapshot when no mcp allowlist is declared",
		{ timeout: 45_000 },
		async () => {
			const globalConfig = { github: { url: "https://x" } };
			await writeMcpConfig(globalConfig);
			await writeCatalog({ plain: {} });

			const rpc = runLauncherRpc(fixture, ["plain", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			const stat = await (await import("node:fs/promises")).lstat(instanceMcpPath);
			expect(stat.isSymbolicLink()).toBe(false);
			expect(JSON.parse(await readFile(instanceMcpPath, "utf8"))).toEqual({
				mcpServers: globalConfig,
			});
		},
	);

	it("passes selected unsupported transport to Pi with native diagnostics and exit parity", { timeout: 45_000 }, async () => {
		const servers = { github: { type: "sse", url: "http://127.0.0.1:9/sse" } };
		await writeMcpConfig(servers); await writeCatalog({ review: { mcps: ["github"] } });
		const native = await runNativePi(fixture, ["--mode", "rpc"]);
		const actual = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);
		expect(actual.code).toBe(native.code);
		expect(native.signal).toBeNull();
		const nativeOutput = native.stdout + native.stderr;
		const actualOutput = actual.stdout + actual.stderr;
		expect(nativeOutput).toContain("legacy SSE transport is not supported");
		expect(actualOutput).toContain("legacy SSE transport is not supported");
		expect(actual.stderr).not.toMatch(/pi-profile:.*legacy SSE/);
		expect(JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8")).mcpServers).toEqual(servers);
	});

	it(
		"passes an unselected SSE server through and lets Pi report its own config error",
		{ timeout: 45_000 },
		async () => {
			await writeMcpConfig({ github: { type: "sse", url: "http://localhost:3000/sse" } });
			await writeCatalog({ plain: {} });

			const rpc = runLauncherRpc(fixture, ["plain", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			expect(JSON.parse(await readFile(instanceMcpPath, "utf8"))).toEqual({
				mcpServers: {
					github: { type: "sse", url: "http://localhost:3000/sse" },
				},
			});
		},
	);

	it(
		"materializes tool restriction without a server whitelist and keeps original files byte-identical",
		{ timeout: 45_000 },
		async () => {
			const globalConfig = { github: { url: "https://x" }, linear: { command: "mcp-linear" } };
			await writeMcpConfig(globalConfig);
			await writeCatalog({ review: { mcp_tools: { github: ["search"] } } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			expect(JSON.parse(await readFile(instanceMcpPath, "utf8"))).toEqual({
				mcpServers: {
					github: { url: "https://x", toolExposure: { "*": "hidden", search: "direct" } },
					linear: { command: "mcp-linear" },
				},
			});

			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8"))).toEqual({
				mcpServers: globalConfig,
			});
		},
	);

	it(
		"empty mcp_tools list denies all tools via toolExposure",
		{ timeout: 45_000 },
		async () => {
			const globalConfig = { github: { url: "https://x" } };
			await writeMcpConfig(globalConfig);
			await writeCatalog({ review: { mcp_tools: { github: [] } } });

			const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			expect(JSON.parse(await readFile(instanceMcpPath, "utf8"))).toEqual({
				mcpServers: {
					github: { url: "https://x", toolExposure: { "*": "hidden" } },
				},
			});
		},
	);

	it(
		"empty mcps selection disables discovered shared user servers and leaves source files unchanged",
		{ timeout: 45_000 },
		async () => {
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			const sharedConfig = { shared: { url: "https://shared" } };
			await writeFile(
				path.join(fixture.root, ".agents", "mcp.json"),
				JSON.stringify({ mcpServers: sharedConfig }),
			);
			const agentConfig = { agentonly: { url: "https://agent" } };
			await writeMcpConfig(agentConfig);
			const originalMcp = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
			await writeCatalog({ denyall: { mcps: [] } });

			const rpc = runLauncherRpc(fixture, ["denyall", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			const instanceMcp = JSON.parse(await readFile(instanceMcpPath, "utf8"));
			expect(instanceMcp.mcpServers).toEqual({
				shared: { url: "https://shared", enabled: false },
				agentonly: { url: "https://agent", enabled: false },
			});

			expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(originalMcp);
			expect(JSON.parse(await readFile(path.join(fixture.root, ".agents", "mcp.json"), "utf8"))).toEqual({
				mcpServers: sharedConfig,
			});
		},
	);

	it(
		"project-sourced MCP server is not disabled by an empty mcps selection",
		{ timeout: 45_000 },
		async () => {
			await writeMcpConfig({});
			await mkdir(path.join(fixture.cwd, ".pi"), { recursive: true });
			await writeFile(
				path.join(fixture.cwd, ".pi", "mcp.json"),
				JSON.stringify({ mcpServers: { proj: { url: "https://proj" } } }),
			);
			await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
			await writeCatalog({ denyall: { mcps: [] } });

			const rpc = runLauncherRpc(fixture, ["denyall", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			const instanceMcp = JSON.parse(await readFile(instanceMcpPath, "utf8"));
			expect(instanceMcp.mcpServers).toEqual({});
		},
	);

	it(
		"empty mcps selection with no discovered servers generates an empty instance mcp.json",
		{ timeout: 45_000 },
		async () => {
			await writeMcpConfig({});
			await writeCatalog({ empty: { mcps: [] } });

			const rpc = runLauncherRpc(fixture, ["empty", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			expect(JSON.parse(await readFile(instanceMcpPath, "utf8"))).toEqual({ mcpServers: {} });
		},
	);

	it(
		"mcps: [] disables discovered stdio servers without connecting them or warning about missing transports",
		{ timeout: 45_000 },
		async () => {
			const marker = path.join(fixture.root, "mcp-server-started.marker");
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(
				path.join(fixture.root, ".agents", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						shared: {
							command: "node",
							args: [path.resolve("test/fixtures/fixture-mcp-server.mjs")],
							env: { FIXTURE_MCP_START_MARKER: marker },
						},
					},
				}),
			);
			await writeMcpConfig({});
			await writeCatalog({ denyall: { mcps: [] } });

			const result = await runLauncher(fixture, ["denyall", "--", "--mode", "rpc"]);

			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain('needs either "command"');
			// The disabled stdio server must never be spawned.
			expect(existsSync(marker)).toBe(false);
			const instanceMcp = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8"));
			expect(instanceMcp.mcpServers).toEqual({
				shared: {
					command: "node",
					args: [path.resolve("test/fixtures/fixture-mcp-server.mjs")],
					env: { FIXTURE_MCP_START_MARKER: marker },
					enabled: false,
				},
			});
		},
	);

	it(
		"merged user-level sources override earlier ones per server name",
		{ timeout: 45_000 },
		async () => {
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(
				path.join(fixture.root, ".agents", "mcp.json"),
				JSON.stringify({ mcpServers: { shared: { url: "https://agents" } } }),
			);
			await writeMcpConfig({ shared: { url: "https://agentdir" } });
			await writeCatalog({ plain: {} });

			const rpc = runLauncherRpc(fixture, ["plain", "--", "--mode", "rpc"]);
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			const instanceMcpPath = path.join(await soleInstanceDir(fixture), "mcp.json");
			expect(JSON.parse(await readFile(instanceMcpPath, "utf8"))).toEqual({
				mcpServers: {
					shared: { url: "https://agentdir" },
				},
			});
		},
	);

	it(
		"an explicit MCP policy survives malformed sources without discarding restrictions",
		{ timeout: 30_000 },
		async () => {
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(path.join(fixture.root, ".agents", "mcp.json"), "{ invalid");
			await writeMcpConfig({ github: { url: "https://x" } });
			await writeCatalog({ review: { mcps: ["github"] } });

			const failure = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);

			expect(failure.code).toBe(0);
			const snapshot = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8"));
			expect(Object.keys(snapshot.mcpServers)).toEqual(["github"]);
			expect(failure.stderr).toContain(path.join(fixture.root, ".agents", "mcp.json"));
			expect(failure.stderr).toContain("not valid JSON");
		},
	);

	it(
		"no MCP policy diagnoses a malformed source and still starts Pi with valid sources",
		{ timeout: 45_000 },
		async () => {
			await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
			await writeFile(path.join(fixture.root, ".agents", "mcp.json"), "{ invalid");
			await writeMcpConfig({ github: { url: "https://x" } });
			await writeCatalog({ plain: {} });

			const result = await runLauncher(fixture, ["plain", "--", "--mode", "rpc"]);

			expect(result.code).toBe(0);
			expect(result.stderr).toContain(path.join(fixture.root, ".agents", "mcp.json"));
			const instanceMcp = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8"));
			expect(instanceMcp.mcpServers).toEqual({ github: { url: "https://x" } });
		},
	);
});


describe("native MCP missing and disabled selections", () => {
	it.each([{ definition: { mcps: [] }, disabled: true }, { definition: { mcp_tools: {} }, disabled: false }, { definition: {}, disabled: false }])("keeps explicit-empty/empty-policy/omitted intent with malformed sources: %j", { timeout: 45_000 }, async ({ definition, disabled }) => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const invalid = path.join(fixture.root, ".agents", "mcp.json"); await writeFile(invalid, "{ bad");
		const marker = path.join(fixture.root, "started"); const server = localMcpServer(marker);
		await writeMcpConfig({ fixture: server }); await writeCatalog({ focused: definition });
		const before = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
		const result = await runLauncher(fixture, ["focused", "--", "--mode", "rpc"]);
		expect(result.code).toBe(0);
		expect(result.stderr.split("\n").filter((line) => line.includes("pi-profile: warning:") && line.includes(invalid))).toHaveLength(1);
		const snapshot = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8"));
		expect(snapshot.mcpServers.fixture).toEqual(disabled ? { ...server, enabled: false } : server);
		if (disabled) expect(existsSync(marker)).toBe(false);
		expect(await readFile(invalid, "utf8")).toBe("{ bad");
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(before);
	});
	it.each([false, true])("does not connect unselected or source-disabled servers (missing-only=%s)", { timeout: 90_000 }, async (missingOnly) => {
		const disabled = path.join(fixture.root, "disabled-started"); const unselected = path.join(fixture.root, "unselected-started");
		await writeMcpConfig({ disabled: { ...localMcpServer(disabled), enabled: false }, unselected: localMcpServer(unselected), fixture: localMcpServer() });
		await writeCatalog({ focused: { mcps: ["missing", "disabled", ...(missingOnly ? [] : ["fixture"])], mcp_tools: { disabled: [], fixture: ["search"] } } });
		const before = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
		const rpc = runLauncherRpc(fixture, ["focused", "--", ...MCP_INVOCATION_ARGS]);
		try {
			const allowed = await invokeNativeTool(rpc, "mcp__fixture__search", { query: "selected" });
			expect(allowed.isError).toBe(missingOnly);
			expect((await invokeNativeTool(rpc, "codemode", { code: 'text(await tools.mcp__disabled__search({query:"forbidden"}));' })).isError).toBe(true);
			expect(rpc.stderr.join("")).toContain("enable it there or remove");
		} finally { await rpc.close(); await rpc.waitForExit(); }
		expect(existsSync(disabled)).toBe(false); expect(existsSync(unselected)).toBe(false);
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(before);
	});
	it("leaves trusted project servers callable despite an empty user selection and a dormant project policy", { timeout: 90_000 }, async () => {
		await writeMcpConfig({ fixture: localMcpServer() });
		const project = path.join(fixture.cwd, ".pi", "mcp.json"); const content = JSON.stringify({ mcpServers: { project: localMcpServer() } });
		await writeFile(project, content); await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		await writeCatalog({ focused: { mcps: [], mcp_tools: { project: [] }, tools: ["read"] } });
		const rpc = runLauncherRpc(fixture, ["focused", "--", ...MCP_INVOCATION_ARGS]);
		try {
			expect((await invokeNativeTool(rpc, "codemode", { code: 'text(await tools.mcp__project__search({query:"native-project"}));' })).isError).toBe(false);
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "forbidden" })).isError).toBe(true);
			expect(rpc.stderr.join("")).toContain("cannot narrow project-level");
		} finally { await rpc.close(); await rpc.waitForExit(); }
		expect(await readFile(project, "utf8")).toBe(content);
	});
});
