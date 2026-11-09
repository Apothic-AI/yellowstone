import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncher, runLauncherRpc } from "./helpers/launcher-runner.ts";
import { MCP_INVOCATION_ARGS, invokeNativeTool, localMcpServer, mcpCalls } from "./helpers/mcp-invocation.ts";
import { createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";

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

describe("launcher integration: per-server MCP tool selection (native semantics)", () => {
	it("selector allowlist replaces exposure wholesale with direct/hidden", async () => {
		await writeMcpConfig({
			github: { url: "https://x", toolExposure: { delete: "hidden" } },
			linear: { command: "linear" },
		});
		await writeCatalog({
			review: { mcp_tools: { github: ["search", "delete"] } },
		});

		const res = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);

		const instanceDir = await soleInstanceDir(fixture);
		const instanceMcp = JSON.parse(await readFile(path.join(instanceDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toEqual({
			"*": "hidden",
			search: "direct",
			delete: "direct",
		});
		expect(instanceMcp.mcpServers.linear.toolExposure).toBeUndefined();
	}, 30_000);

	it("empty list denies all tools via hidden wildcard", async () => {
		await writeMcpConfig({ github: { url: "https://x" } });
		await writeCatalog({
			denyall: { mcp_tools: { github: [] } },
		});

		const res = await runLauncher(fixture, ["denyall", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);

		const instanceDir = await soleInstanceDir(fixture);
		const instanceMcp = JSON.parse(await readFile(path.join(instanceDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden" });
	}, 30_000);

	it("prefixed adapter-era selector is encoded as-is and matches no tool", async () => {
		await writeMcpConfig({ fixture: { command: "node", args: ["--version"] } });
		await writeCatalog({
			prefixed: { mcp_tools: { fixture: ["fixture_search"] } },
		});

		const res = await runLauncher(fixture, ["prefixed", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);

		const instanceDir = await soleInstanceDir(fixture);
		const instanceMcp = JSON.parse(await readFile(path.join(instanceDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.fixture.toolExposure).toEqual({
			"*": "hidden",
			fixture_search: "direct",
		});
	}, 30_000);

	it("does not require an adapter extension for mcp_tools", async () => {
		await writeMcpConfig({ github: { url: "https://x" } });
		await writeCatalog({
			review: { mcp_tools: { github: ["search"] } },
		});

		const res = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);

		const instanceDir = await soleInstanceDir(fixture);
		const instanceMcp = JSON.parse(await readFile(path.join(instanceDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toEqual({ "*": "hidden", search: "direct" });
	}, 30_000);

	it("unknown policy servers warn without creating connections", async () => {
		await writeMcpConfig({ github: { url: "https://x" } });
		await writeCatalog({
			review: { mcp_tools: { typo_server: ["search"] } },
		});

		const res = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);
		expect(res.stderr).toContain('unknown MCP server "typo_server"');
		expect(res.stderr).toContain("github");
		const plan = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "pi-profile.json"), "utf8"));
		expect(plan.mcpTools).toEqual({ typo_server: ["search"] });
		const snapshot = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8"));
		expect(Object.keys(snapshot.mcpServers)).toEqual(["github"]);
		expect(snapshot.mcpServers.github.toolExposure).toBeUndefined();
	}, 30_000);

	it("project-only policies warn without changing native project ownership", async () => {
		await mkdir(path.join(fixture.cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { proj_mcp: { url: "https://proj" } } }),
		);
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		await writeMcpConfig({});
		await writeCatalog({
			narrow_project: { mcp_tools: { proj_mcp: ["search"] } },
		});

		const res = await runLauncher(fixture, ["narrow_project", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);
		expect(res.stderr).toContain('cannot narrow project-level MCP server "proj_mcp"');
		expect(JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "mcp.json"), "utf8")).mcpServers).toEqual({});
		expect(JSON.parse(await readFile(path.join(fixture.cwd, ".pi", "mcp.json"), "utf8")).mcpServers.proj_mcp.toolExposure).toBeUndefined();
	}, 30_000);

	it("empty mcp_tools object is inert", async () => {
		await writeMcpConfig({ github: { url: "https://x" } });
		await writeCatalog({
			plain: { mcp_tools: {} },
		});

		const res = await runLauncher(fixture, ["plain", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);

		const instanceDir = await soleInstanceDir(fixture);
		const instanceMcp = JSON.parse(await readFile(path.join(instanceDir, "mcp.json"), "utf8"));
		expect(instanceMcp.mcpServers.github.toolExposure).toBeUndefined();
	}, 30_000);

	it("literal server keys that shadow prototypes are resolved as data", async () => {
		await writeMcpConfig({ toString: { url: "https://x" } });
		await writeCatalog({
			string_server: JSON.parse('{"mcp_tools":{"toString":["search"]}}'),
		});

		const res = await runLauncher(fixture, ["string_server", "--", "--mode", "rpc"]);
		expect(res.code).toBe(0);

		const instanceDir = await soleInstanceDir(fixture);
		const instanceMcp = JSON.parse(await readFile(path.join(instanceDir, "mcp.json"), "utf8"));
		expect(Object.keys(instanceMcp.mcpServers)).toEqual(["toString"]);
		expect(instanceMcp.mcpServers.toString.toolExposure).toEqual({ "*": "hidden", search: "direct" });
	}, 30_000);
});


describe("native MCP callable restrictions", () => {
	it.each([true, false])("surviving partial policies restrict direct and codemode calls after source skipping (server selection=%s)", { timeout: 90_000 }, async (serverSelection) => {
		const calls = path.join(fixture.root, "calls.jsonl");
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const source = path.join(fixture.root, ".agents", "mcp.json");
		const content = JSON.stringify({ mcpServers: { fixture: localMcpServer(undefined, calls) } });
		await writeFile(source, content);
		const invalid = path.join(fixture.agentDir, "mcp.json");
		await writeFile(invalid, "{ invalid");
		const project = path.join(fixture.cwd, ".pi", "mcp.json");
		await writeFile(project, '{"mcpServers":[]}');
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		await writeCatalog({ partial: { tools: ["read"], ...(serverSelection ? { mcps: ["missing", "fixture"] } : {}), mcp_tools: { fixture: ["search"], dormant: [] } } });
		const profileFile = path.join(fixture.profileSwitchDir, "profiles", "partial.json");
		const originalProfile = await readFile(profileFile, "utf8");
		const rpc = runLauncherRpc(fixture, ["partial", "--", ...MCP_INVOCATION_ARGS]);
		try {
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "direct" })).isError).toBe(false);
			expect((await invokeNativeTool(rpc, "codemode", { code: 'text(await tools.mcp__fixture__search({query:"indirect"}));' })).isError).toBe(false);
			expect((await invokeNativeTool(rpc, "mcp__fixture__delete", { id: "forbidden" })).isError).toBe(true);
			expect((await invokeNativeTool(rpc, "codemode", { code: 'text(await tools.mcp__fixture__delete({id:"forbidden"}));' })).isError).toBe(true);
			expect(await invokeNativeTool(rpc, "tool_search", { query: "mcp__fixture__delete" })).toMatchObject({ isError: false, details: { loaded: [] } });
			expect(await mcpCalls(calls)).toEqual([{ name: "search", arguments: { query: "direct" } }, { name: "search", arguments: { query: "indirect" } }]);
			expect(rpc.stderr.join("").split("\n").filter((line) => line.includes("pi-profile: warning:") && line.includes(invalid))).toHaveLength(1);
		} finally { await rpc.close(); await rpc.waitForExit(); }
		expect(await readFile(source, "utf8")).toBe(content);
		expect(await readFile(profileFile, "utf8")).toBe(originalProfile);
		expect(await readFile(invalid, "utf8")).toBe("{ invalid");
		expect(await readFile(project, "utf8")).toBe('{"mcpServers":[]}');
	});
});


describe("empty and dormant tool restrictions stay callable-safe", () => {
	it.each([{ selectors: [] }, { selectors: ["unmatched-literal"] }, { selectors: ["fixture_search"] }])("does not restore tools for policy $selectors", { timeout: 90_000 }, async ({ selectors }) => {
		const calls = path.join(fixture.root, "calls.jsonl"); const marker = path.join(fixture.root, "started");
		await writeMcpConfig({ fixture: localMcpServer(marker, calls) });
		await writeCatalog({ denied: { tools: ["read"], mcp_tools: { fixture: selectors } } });
		const rpc = runLauncherRpc(fixture, ["denied", "--", ...MCP_INVOCATION_ARGS]);
		try {
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "forbidden" })).isError).toBe(true);
			expect((await invokeNativeTool(rpc, "codemode", { code: 'text(await tools.mcp__fixture__search({query:"forbidden"}));' })).isError).toBe(true);
			const discovery = await invokeNativeTool(rpc, "tool_search", { query: "mcp__fixture__search" });
			expect(discovery).toMatchObject({ isError: false, details: { loaded: [] } });
			expect(await mcpCalls(calls)).toEqual([]);
			expect(rpc.stderr.join("")).not.toMatch(/selector.*(?:invalid|not found)|unmatched-literal.*(?:invalid|not found)/i);
		} finally { await rpc.close(); await rpc.waitForExit(); }
		expect((await import("node:fs")).existsSync(marker)).toBe(true);
	});

	it("keeps newly discovered unselected tools hidden through direct and indirect invocation", { timeout: 90_000 }, async () => {
		const calls = path.join(fixture.root, "calls.jsonl"); const dynamic = path.join(fixture.root, "dynamic.json");
		await writeMcpConfig({ fixture: localMcpServer(undefined, calls, dynamic) });
		await writeCatalog({ restricted: { mcp_tools: { fixture: ["search"] } } });
		const rpc = runLauncherRpc(fixture, ["restricted", "--", ...MCP_INVOCATION_ARGS]);
		try {
			expect((await invokeNativeTool(rpc, "mcp__fixture__search", { query: "warm" })).isError).toBe(false);
			await writeFile(dynamic, JSON.stringify(["search", "delete", "late"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }))));
			let registered = false;
			const deadline = Date.now() + 5000;
			while (!registered && Date.now() < deadline) {
				const offset = rpc.messages.length;
				await rpc.send({ type: "prompt", message: "/fixture-mcp-registry" });
				const event = await rpc.waitFor((message) => rpc.messages.indexOf(message) >= offset && JSON.stringify(message).includes('"customType":"fixture-mcp-registry"'));
				registered = JSON.stringify(event).includes('"name":"mcp__fixture__late","exposure":"hidden"');
				if (!registered) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(registered).toBe(true);
			expect((await invokeNativeTool(rpc, "mcp__fixture__late", {})).isError).toBe(true);
			expect((await invokeNativeTool(rpc, "codemode", { code: 'text(await tools.mcp__fixture__late({}));' })).isError).toBe(true);
			expect((await mcpCalls(calls)).map((call) => call.name)).toEqual(["search"]);
		} finally { await rpc.close(); await rpc.waitForExit(); }
	});
});
