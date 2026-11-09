import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { existsSync } from "node:fs";
import { localMcpServer } from "./helpers/mcp-invocation.ts";
import type { StatusReport } from "../src/switching/status.ts";
import { soleInstanceDir } from "./helpers/pi-fixture.ts";
import { runLauncherRpc } from "./helpers/launcher-runner.ts";
import type { RpcDriver } from "./helpers/rpc-driver.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let driver: RpcDriver;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "review");
	await addGlobalSkill(fixture, "impl");
	const globalProfilesDir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(globalProfilesDir, { recursive: true });
	await writeFile(path.join(globalProfilesDir, "review.json"), JSON.stringify({ skills: ["review"] }));
	await writeFile(path.join(globalProfilesDir, "impl.json"), JSON.stringify({ skills: ["impl"] }));
	await writeFile(path.join(globalProfilesDir, "shared.json"), JSON.stringify({}));

	const projectProfilesDir = path.join(fixture.cwd, ".pi", "profiles");
	await mkdir(projectProfilesDir, { recursive: true });
	await writeFile(path.join(projectProfilesDir, "shared.json"), JSON.stringify({ label: "project shared" }));
	// An enabled server and a snapshot-disabled server are both discovered; without
	// an explicit mcps whitelist, status must not present the disabled server as enabled.
	await writeFile(
		path.join(fixture.agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { github: {}, linear: { enabled: false } } }),
	);
});

afterEach(async () => {
	await driver?.close();
	await rm(fixture.root, { recursive: true, force: true });
});

async function start(profile = "review"): Promise<void> {
	// Pre-seed trust so the project catalog participates.
	await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
	driver = runLauncherRpc(fixture, [profile, "--", "--mode", "rpc"]);
	await driver.send({ type: "get_state" });
}

async function command(text: string, timeoutMs = 60_000): Promise<void> {
	await driver.send({ type: "prompt", message: `/${text}` }, timeoutMs);
}

async function messageContaining(fragment: string): Promise<unknown> {
	return driver.waitFor((message) => JSON.stringify(message).includes(fragment));
}

describe("observability surface against a real spawned pi", () => {
	it("bare /profile degrades to the list with sources, project shadowing, and the structured payload", async () => {
		await start();

		await command("profile");

		await messageContaining("shared [project] (shadows global)");
		const seen = driver.messages.map((message) => JSON.stringify(message)).join("\n");
		expect(seen).toContain("default [builtin]");
		expect(seen).toContain("review [global]");
		expect(seen).toContain("shared [project] (shadows global) — project shared");
		// RPC-consumable structured form: the degraded list carries the same
		// {kind, profiles} payload the removed `list` subcommand emitted.
		const structured = driver.messages.find(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				JSON.stringify(message).includes('"kind":"list"') &&
				JSON.stringify(message).includes('"name":"review","source":"global"'),
		);
		expect(structured).toBeDefined();
	}, 90_000);

	it("/profile status shows resolved paths, mcp tri-state, and the switch delta", async () => {
		await start();

		await command("profile status");
		await messageContaining("mcp: enabled=[github]");
		let seen = driver.messages.map((message) => JSON.stringify(message)).join("\n");
		expect(seen).toContain(`review → ${path.join(fixture.agentDir, "skills", "review", "SKILL.md")}`);
		expect(seen).toContain("enabled=[github]");
		expect(seen).toContain("disabled=[linear]");
		expect(seen).toContain("github: unrestricted");
		expect(seen).not.toContain("linear: unrestricted");

		// RPC-consumable structured form (ticket 11): the custom message
		// carries the report object in details.
		const structured = driver.messages.find(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				JSON.stringify(message).includes('"kind":"status"') &&
				JSON.stringify(message).includes('"profile":"review"'),
		);
		expect(structured).toBeDefined();

		// Switch (the prompt response returns after the handler's reload
		// settles), then status reflects the delta against the previous plan.
		await command("profile use impl");
		expect(await driver.skillCommandNames()).toEqual(["skill:impl"]);

		await command("profile status");
		await messageContaining("delta: +[skill:impl] -[skill:review]");
	}, 90_000);

	it("/profile status stays available when a user-level MCP source is malformed under no policy", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: {} } }),
		);
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		const malformedPath = path.join(fixture.root, ".agents", "mcp.json");
		await writeFile(malformedPath, "{ invalid");
		await start("shared");

		await command("profile status");
		await messageContaining("mcp: enabled=[github]");

		const seen = driver.messages.map((message) => JSON.stringify(message)).join("\n");
		expect(seen).toContain(malformedPath);
		expect(seen).not.toContain('"success":false');
	}, 90_000);

	it("/profile status keeps project-owned servers enabled with an empty mcps selection", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: {} } }),
		);
		await mkdir(path.join(fixture.cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { proj: {} } }),
		);
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));

		const globalProfilesDir = path.join(fixture.profileSwitchDir, "profiles");
		await mkdir(globalProfilesDir, { recursive: true });
		await writeFile(path.join(globalProfilesDir, "closed.json"), JSON.stringify({ mcps: [] }));

		driver = runLauncherRpc(fixture, ["closed", "--", "--mode", "rpc"]);
		await driver.send({ type: "get_state" });

		await command("profile status");
		await messageContaining("mcp: enabled=[proj]");
		const seen = driver.messages.map((message) => JSON.stringify(message)).join("\n");
		expect(seen).toContain("disabled=[github]");
		expect(seen).not.toContain("disabled=[proj]");
	}, 90_000);
});


describe("tolerant observability in native Pi", () => {
	it("lists unavailable/catalog filename diagnostics but status ignores other malformed profiles", { timeout: 90_000 }, async () => {
		const dir = path.join(fixture.profileSwitchDir, "profiles");
		await writeFile(path.join(dir, "broken.json"), "{ bad");
		await writeFile(path.join(dir, "default.json"), "{ bad");
		await writeFile(path.join(dir, "bad name.json"), "{ bad");
		await writeFile(path.join(dir, "shared.json"), "{ corrupt shadowed");
		await start();
		await command("profile");
		await messageContaining('"available":false');
		const list = driver.messages.find((message) => JSON.stringify(message).includes('"kind":"list"'));
		expect(JSON.stringify(list)).toContain("broken.json");
		expect(JSON.stringify(list)).toContain("bad name.json");
		expect(JSON.stringify(list)).toContain('"shadowsGlobal":true');
		await command("profile status");
		await messageContaining('"kind":"status"');
	});
	it("exposes active skipped-reference and dormant-policy diagnostics without enabled claims or duplicate startup warnings", { timeout: 90_000 }, async () => {
		const file = path.join(fixture.profileSwitchDir, "profiles", "partial.json");
		await writeFile(file, '{"skills":["review","missing"],"mcps":["absent"],"mcp_tools":{"absent":["opaque"],"linear":[]},"unknownField":true}');
		await start("partial");
		expect(driver.stderr.join("").split("\n").filter((line) => line.includes('pi-profile: warning:') && line.includes('unknown skill "missing"'))).toHaveLength(1);
		await command("profile status");
		await messageContaining('"kind":"status"');
		const status = driver.messages.find((message) => JSON.stringify(message).includes('"kind":"status"'));
		const seen = JSON.stringify(status);
		expect(seen).toContain("missing");
		expect(seen).toContain("unknownField");
		expect(seen).toContain("absent: declared policy [opaque] (missing; not applied)");
		expect(seen).not.toContain("linear: no enabled MCP tools");
		expect(await driver.skillCommandNames()).toEqual(["skill:review"]);
		expect(await readFile(file, "utf8")).toBe('{"skills":["review","missing"],"mcps":["absent"],"mcp_tools":{"absent":["opaque"],"linear":[]},"unknownField":true}');
	});
});


describe("dormant policy status uses activation knowledge", () => {
	it.each([false, true])("does not activate missing/source-disabled policy in status before reload (source-disabled=%s)", { timeout: 60_000 }, async (sourceDisabled) => {
		const marker = path.join(fixture.root, "late-started");
		const late = localMcpServer(marker);
		const source = path.join(fixture.agentDir, "mcp.json");
		await writeFile(source, JSON.stringify({ mcpServers: { native: localMcpServer(), ...(sourceDisabled ? { late: { ...late, enabled: false } } : {}) } }));
		await writeFile(path.join(fixture.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project: localMcpServer() } }));
		await writeFile(path.join(fixture.profileSwitchDir, "profiles", "policy.json"), '{"mcp_tools":{"late":["search"]}}');
		await start("policy");
		const instance = await soleInstanceDir(fixture);
		const status = async (): Promise<{ content: string; report: StatusReport }> => {
			const offset = driver.messages.length;
			await command("profile status");
			const event = await driver.waitFor((message) => driver.messages.indexOf(message) >= offset && JSON.stringify(message).includes('"kind":"status"')) as { message: { content: string; details: { report: StatusReport } } };
			return { content: event.message.content, report: event.message.details.report };
		};
		const initial = await status();
		expect(initial.report.mcp.enabled).not.toContain("late");
		await writeFile(source, JSON.stringify({ mcpServers: { native: localMcpServer(), late } }));
		const beforeReload = await status();
		expect(beforeReload.report.mcp.enabled).toEqual(["native", "project"]);
		expect(beforeReload.report.mcpTools).toContainEqual({ server: "late", policy: "restricted", tools: ["search"], state: sourceDisabled ? "disabled" : "missing" });
		expect(beforeReload.content).toContain("not applied");
		expect(existsSync(marker)).toBe(false);
		await command("profile reload");
		const afterReload = await status();
		expect(afterReload.report.mcp.enabled).toEqual(["late", "native", "project"]);
		expect(afterReload.report.mcpTools).toContainEqual({ server: "late", policy: "restricted", tools: ["search"] });
		expect(afterReload.report.diagnostics?.some((issue) => issue.kind === "mcp-tools" && issue.reference === "late") ?? false).toBe(false);
		const snapshot = JSON.parse(await readFile(path.join(instance, "mcp.json"), "utf8"));
		expect(snapshot.mcpServers.late.toolExposure).toEqual({ "*": "hidden", search: "direct" });
		const deadline = Date.now() + 5000;
		while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(existsSync(marker)).toBe(true);
	});
});
