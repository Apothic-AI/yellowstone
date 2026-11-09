import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMergedMcpServers, McpConfigError } from "../src/mcp-config.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

describe("loadMergedMcpServers", () => {
	it("returns no names when no config exists", async () => {
		expect(Object.keys((await loadMergedMcpServers(fixture.agentDir)).servers)).toEqual([]);
	});

	it("reads server names from the global agentDir mcp.json", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "mcp-linear" } } }),
		);

		expect(Object.keys((await loadMergedMcpServers(fixture.agentDir)).servers).sort()).toEqual([
			"github",
			"linear",
		]);
	});

	it("ignores non-server keys and never exposes connection config", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x", headers: { auth: "secret" } } }, settings: {} }),
		);

		expect(Object.keys((await loadMergedMcpServers(fixture.agentDir)).servers)).toEqual(["github"]);
	});

	it("merges the trusted project's .pi/mcp.json names only (not project-root .mcp.json)", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { "proj-server": {}, github: {} } }),
		);
		await writeFile(
			path.join(fixture.cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { "proj-shared": {} } }),
		);

		const result = await loadMergedMcpServers(fixture.agentDir, fixture.cwd);
		expect(Object.keys(result.servers).sort()).toEqual(["github", "proj-server"]);
		expect([...result.projectServers].sort()).toEqual(["github", "proj-server"]);
	});

	it("discovers servers from ~/.config/mcp/mcp.json, ~/.agents/mcp.json, and nested", async () => {
		await mkdir(path.join(fixture.root, ".config", "mcp"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".config", "mcp", "mcp.json"),
			JSON.stringify({ mcpServers: { "generic-global": { url: "https://x" } } }),
		);
		await mkdir(path.join(fixture.root, ".agents", "mcp"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".agents", "mcp.json"),
			JSON.stringify({ mcpServers: { "agents-global": { url: "https://y" } } }),
		);
		await writeFile(
			path.join(fixture.root, ".agents", "mcp", "mcp.json"),
			JSON.stringify({ mcpServers: { "agents-nested": { url: "https://z" } } }),
		);

		expect(Object.keys((await loadMergedMcpServers(fixture.agentDir)).servers).sort()).toEqual([
			"agents-global",
			"agents-nested",
			"generic-global",
		]);
	});

	it("fails loudly on a malformed ~/.agents/mcp.json config", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(path.join(fixture.root, ".agents", "mcp.json"), "{ invalid json");

		await expect(loadMergedMcpServers(fixture.agentDir)).rejects.toThrow(McpConfigError);
	});

	it("merges server definitions across sources with correct precedence", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".agents", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"shared-a": { url: "https://a-agents", key: "from-agents" },
					"shared-b": { url: "https://b" },
				},
			}),
		);
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"shared-a": { url: "https://a-agentdir" },
					"local-c": { command: "c" },
				},
				settings: { custom: true },
			}),
		);

		const result = await loadMergedMcpServers(fixture.agentDir);
		expect(result.servers["shared-a"]).toEqual({ url: "https://a-agentdir" });
		expect(result.servers["shared-b"]).toEqual({ url: "https://b" });
		expect(result.servers["local-c"]).toEqual({ command: "c" });
		expect(result.sharedServers.has("shared-a")).toBe(true);
		expect(result.sharedServers.has("shared-b")).toBe(true);
		expect(result.sharedServers.has("local-c")).toBe(false);
		// baseConfig is the merged user-level config object.
		expect((result.baseConfig?.mcpServers as Record<string, unknown>)?.["shared-a"]).toEqual({
			url: "https://a-agentdir",
		});
		expect(result.baseConfig?.settings).toEqual({ custom: true });
	});

	it("a later URL does not inherit an earlier authorization header", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".agents", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"github-api": { url: "https://old", headers: { Authorization: "Bearer secret" } },
				},
			}),
		);
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"github-api": { url: "https://new" },
				},
			}),
		);

		const result = await loadMergedMcpServers(fixture.agentDir);

		expect(result.servers["github-api"]).toEqual({ url: "https://new" });
	});

	it("baseConfig merges user-level sources with later top-level keys overriding earlier ones", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".agents", "mcp.json"),
			JSON.stringify({ settings: { fromAgents: true }, extra: "agents" }),
		);
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ settings: { fromAgentDir: true }, extra: "agentdir" }),
		);

		const result = await loadMergedMcpServers(fixture.agentDir);
		expect(result.baseConfig).toEqual({
			settings: { fromAgentDir: true },
			extra: "agentdir",
		});
	});

	it("matches toString and excludes unrepresentable __proto__ keys", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			'{"mcpServers":{"toString":{"url":"https://x"},"__proto__":{"url":"https://proto"}}}',
		);

		const result = await loadMergedMcpServers(fixture.agentDir);

		expect(Object.keys(result.servers)).toEqual(["toString"]);
		expect(Object.hasOwn(result.servers, "toString")).toBe(true);
		expect(result.servers.toString).toEqual({ url: "https://x" });
		expect(result.serverOwners.toString).toBe("user");
		expect(Object.hasOwn(result.servers, "__proto__")).toBe(false);
		expect(Object.hasOwn(result.serverOwners, "__proto__")).toBe(false);
	});

	it("marks servers defined by the trusted project as project servers and records serverOwners", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { "agent-a": {}, "shadowed-b": { url: "http://user" } } }),
		);
		await mkdir(path.join(fixture.cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { "proj-owned": {}, "shadowed-b": { url: "http://proj" } } }),
		);

		const result = await loadMergedMcpServers(fixture.agentDir, fixture.cwd);

		expect([...result.projectServers].sort()).toEqual(["proj-owned", "shadowed-b"]);
		expect(result.projectServers.has("agent-a")).toBe(false);
		expect(result.serverOwners).toEqual({
			"agent-a": "user",
			"shadowed-b": "project",
			"proj-owned": "project",
		});
	});

	it("does not read an untrusted project's .pi/mcp.json", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
		await mkdir(path.join(fixture.cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { "proj-owned": {} } }),
		);

		const result = await loadMergedMcpServers(fixture.agentDir);
		expect(Object.hasOwn(result.servers, "proj-owned")).toBe(false);
	});

	it("fails loudly on a malformed config instead of reading it as empty", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: ["not-an-object"] }));

		await expect(loadMergedMcpServers(fixture.agentDir)).rejects.toThrow(McpConfigError);
	});

	it("diagnostic mode skips a malformed source and keeps valid sources", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const malformedPath = path.join(fixture.root, ".agents", "mcp.json");
		await writeFile(malformedPath, "{ invalid");
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" } } }),
		);

		const result = await loadMergedMcpServers(fixture.agentDir, undefined, { invalidSource: "diagnose" });

		expect(Object.keys(result.servers)).toEqual(["github"]);
		expect(result.diagnostics).toEqual([`MCP config is not valid JSON: ${path.resolve(malformedPath)}`]);
	});

	it("diagnostic mode skips a non-object envelope without merging it", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify(["not", "an", "object"]));

		const result = await loadMergedMcpServers(fixture.agentDir, undefined, { invalidSource: "diagnose" });

		expect(Object.keys(result.servers)).toEqual([]);
		expect(result.baseConfig).toBeUndefined();
		expect(result.diagnostics?.[0]).toContain("must be a JSON object");
	});

	it("diagnostic mode skips a malformed mcpServers envelope without merging its other keys", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: ["not-an-object"], settings: { leaked: true } }),
		);

		const result = await loadMergedMcpServers(fixture.agentDir, undefined, { invalidSource: "diagnose" });

		expect(Object.keys(result.servers)).toEqual([]);
		expect(result.baseConfig).toBeUndefined();
		expect(result.diagnostics?.[0]).toContain('"mcpServers" must be a JSON object');
	});

	it("diagnostic mode diagnoses a malformed trusted project source without blocking", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" } } }),
		);
		await mkdir(path.join(fixture.cwd, ".pi"), { recursive: true });
		const projectPath = path.join(fixture.cwd, ".pi", "mcp.json");
		await writeFile(projectPath, "{ invalid");

		const result = await loadMergedMcpServers(fixture.agentDir, fixture.cwd, { invalidSource: "diagnose" });

		expect(Object.keys(result.servers)).toEqual(["github"]);
		expect(result.diagnostics).toEqual([`MCP config is not valid JSON: ${path.resolve(projectPath)}`]);
	});
});


describe("MCP source error boundaries", () => {
	it("skips a malformed later source without erasing an earlier complete definition", async () => {
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(path.join(fixture.root, ".agents", "mcp.json"), JSON.stringify({ mcpServers: { kept: { command: "fixture", enabled: false, toolExposure: { "*": "hidden" } } } }));
		await writeFile(path.join(fixture.agentDir, "mcp.json"), '{"mcpServers":[]}');
		const result = await loadMergedMcpServers(fixture.agentDir, undefined, { invalidSource: "diagnose" });
		expect(result.servers.kept).toEqual({ command: "fixture", enabled: false, toolExposure: { "*": "hidden" } });
		expect(result.diagnostics).toHaveLength(1);
	});

	it.each(["throw", "diagnose"] as const)("propagates unexpected read failures in %s mode", async (invalidSource) => {
		await mkdir(path.join(fixture.agentDir, "mcp.json"));
		await expect(loadMergedMcpServers(fixture.agentDir, undefined, { invalidSource })).rejects.toMatchObject({ code: "EISDIR" });
	});
});
