import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncherRpc } from "./helpers/launcher-runner.ts";
import { MCP_INVOCATION_ARGS, invokeNativeTool, localMcpServer, mcpCalls } from "./helpers/mcp-invocation.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
import type { RpcDriver } from "./helpers/rpc-driver.ts";

let fixture: PiFixture;
let driver: RpcDriver;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await driver?.close();
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

/** A fixture extension that reports Pi's active tool names via
 *  `/report-tools` and registers one unrelated tool whose absence the
 *  narrowed `tools` profile must preserve. */
async function writeFixtureExtension(): Promise<void> {
	const dir = path.join(fixture.agentDir, "extensions");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "report-tools.ts"),
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("report-tools", {
		description: "report active tool names",
		handler: async () => {
			pi.sendMessage({
				customType: "pi-profile-tools-report",
				content: "tools report",
				display: true,
				details: { activeTools: pi.getActiveTools() },
			});
		},
	});
	pi.registerTool({
		name: "fixture_unrelated",
		description: "Fixture unrelated tool",
		parameters: { type: "object", properties: {} },
	});
}
`,
	);
}

async function start(profile: string): Promise<void> {
	driver = runLauncherRpc(fixture, [profile, "--", "--mode", "rpc"]);
	await driver.send({ type: "get_state" });
}

function extractActiveTools(message: unknown): string[] | undefined {
	const record = message as {
		details?: { activeTools?: string[] };
		message?: { details?: { activeTools?: string[] } };
	};
	const direct = record.details?.activeTools;
	if (Array.isArray(direct)) return direct;
	const nested = record.message?.details?.activeTools;
	if (Array.isArray(nested)) return nested;
	return undefined;
}

async function reportActiveTools(): Promise<string[]> {
	await driver.send({ type: "prompt", message: "/report-tools" }, 60_000);
	const raw = await driver.waitFor((message) => extractActiveTools(message) !== undefined, 60_000);
	const found = extractActiveTools(raw);
	if (found !== undefined) return found;
	for (const message of driver.messages) {
		const candidate = extractActiveTools(message);
		if (candidate !== undefined) return candidate;
	}
	throw new Error("no activeTools report found");
}

describe("MCP gateway entry points against a real spawned pi", () => {
	it(
		"first launch keeps codemode and tool_search active with tools: [read]",
		{ timeout: 90_000 },
		async () => {
			await writeMcpConfig({
				fixture: {
					command: "node",
					args: [path.resolve("test/fixtures/fixture-mcp-server.mjs")],
				},
			});
			await writeFixtureExtension();
			await writeCatalog({ "narrow-read": { tools: ["read"], extensions: ["report-tools"] } });

			await start("narrow-read");
			const activeTools = await reportActiveTools();

			expect(activeTools).toContain("read");
			expect(activeTools).toContain("codemode");
			expect(activeTools).toContain("tool_search");
			expect(activeTools).not.toContain("bash");
			expect(activeTools).not.toContain("fixture_unrelated");
		},
	);

	it(
		"first launch keeps codemode and tool_search active with tools: []",
		{ timeout: 90_000 },
		async () => {
			await writeMcpConfig({
				fixture: {
					command: "node",
					args: [path.resolve("test/fixtures/fixture-mcp-server.mjs")],
				},
			});
			await writeFixtureExtension();
			await writeCatalog({ "narrow-none": { tools: [], extensions: ["report-tools"] } });

			await start("narrow-none");
			const activeTools = await reportActiveTools();

			expect(activeTools).toContain("codemode");
			expect(activeTools).toContain("tool_search");
			expect(activeTools).not.toContain("read");
			expect(activeTools).not.toContain("bash");
			expect(activeTools).not.toContain("fixture_unrelated");
		},
	);

	it(
		"/profile use retains both entry points after reload",
		{ timeout: 120_000 },
		async () => {
			await writeMcpConfig({
				fixture: {
					command: "node",
					args: [path.resolve("test/fixtures/fixture-mcp-server.mjs")],
				},
			});
			await writeFixtureExtension();
			await writeCatalog({
				"narrow-none": { tools: [], extensions: ["report-tools"] },
				"narrow-read": { tools: ["read"], extensions: ["report-tools"] },
			});

			await start("narrow-none");
			await driver.send({ type: "prompt", message: "/profile use narrow-read" }, 60_000);

			const activeTools = await reportActiveTools();

			expect(activeTools).toContain("read");
			expect(activeTools).toContain("codemode");
			expect(activeTools).toContain("tool_search");
			expect(activeTools).not.toContain("bash");
			expect(activeTools).not.toContain("fixture_unrelated");
		},
	);

	it(
		"an empty effective MCP set enables neither entry point",
		{ timeout: 90_000 },
		async () => {
			await writeMcpConfig({
				fixture: {
					command: "node",
					args: [path.resolve("test/fixtures/fixture-mcp-server.mjs")],
				},
			});
			await writeFixtureExtension();
			await writeCatalog({
				"empty-mcp": { tools: ["read"], mcps: [], extensions: ["report-tools"] },
			});

			await start("empty-mcp");
			const activeTools = await reportActiveTools();

			expect(activeTools).toContain("read");
			expect(activeTools).not.toContain("codemode");
			expect(activeTools).not.toContain("tool_search");
			expect(activeTools).not.toContain("bash");
		},
	);
});


describe("partial selections preserve native gateway restrictions", () => {
	it("keeps both native gateways and allowed MCP invocation without unrelated Pi tools or unselected servers", { timeout: 90_000 }, async () => {
		const calls = path.join(fixture.root, "calls.jsonl"); const marker = path.join(fixture.root, "unselected-started");
		await writeMcpConfig({ fixture: localMcpServer(undefined, calls), unselected: localMcpServer(marker) });
		await writeFixtureExtension();
		await writeCatalog({ partial: { tools: ["read"], mcps: ["missing", "fixture"], mcp_tools: { fixture: ["search"] }, extensions: ["missing-ext", "report-tools"] } });
		const original = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
		driver = runLauncherRpc(fixture, ["partial", "--", ...MCP_INVOCATION_ARGS]);
		expect((await invokeNativeTool(driver, "codemode", { code: 'text(await tools.mcp__fixture__search({query:"gateway"}));' })).isError).toBe(false);
		expect((await invokeNativeTool(driver, "mcp__fixture__delete", { id: "forbidden" })).isError).toBe(true);
		const tools = await reportActiveTools();
		expect(tools).toContain("read"); expect(tools).toContain("codemode"); expect(tools).toContain("tool_search");
		expect(tools).not.toContain("bash"); expect(tools).not.toContain("fixture_unrelated");
		expect((await mcpCalls(calls)).map((call) => call.name)).toEqual(["search"]);
		expect((await import("node:fs")).existsSync(marker)).toBe(false);
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(original);
	});
});
