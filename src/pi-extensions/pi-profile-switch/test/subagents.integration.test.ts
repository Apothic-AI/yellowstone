import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncher, runLauncherRpc } from "./helpers/launcher-runner.ts";
import { createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";
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

function extractStatusReport(message: unknown): Record<string, unknown> | undefined {
	const record = message as { details?: { kind?: string; report?: Record<string, unknown> }; message?: { details?: { kind?: string; report?: Record<string, unknown> } } };
	const direct = record.details;
	if (direct?.kind === "status" && direct.report !== undefined) return direct.report;
	const nested = record.message?.details;
	if (nested?.kind === "status" && nested.report !== undefined) return nested.report;
	return undefined;
}

describe("launcher integration: optional subagent settings", () => {
	it("launches with omitted and empty declarations when pi-subagents is absent", { timeout: 45_000 }, async () => {
		const nativeSettings = JSON.stringify({ subagents: { unsupportedNativeField: { arbitrary: true } } });
		const projectSettings = path.join(fixture.cwd, ".pi", "settings.json");
		await mkdir(path.dirname(projectSettings), { recursive: true });
		const projectSettingsText = JSON.stringify({ subagents: { defaultModel: "project/model", agentOverrides: { reviewer: { model: "project/reviewer" } } } });
		await writeFile(projectSettings, projectSettingsText);
		await writeFile(path.join(fixture.agentDir, "settings.json"), nativeSettings);
		await writeCatalog({ omitted: {}, empty: { subagents: { agentOverrides: { reviewer: {} } } } });

		for (const profile of ["omitted", "empty"]) {
			const result = await runLauncher(fixture, [profile, "--", "--mode", "rpc"]);
			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("pi-subagents registration could not be confirmed");
			const instance = await soleInstanceDir(fixture);
			const settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
			expect(settings.subagents).toEqual(JSON.parse(nativeSettings).subagents);
			const plan = JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8"));
			expect(plan.subagents).toBeUndefined();
			expect(await readFile(projectSettings, "utf8")).toBe(projectSettingsText);
		}
	});

	it("does not require or load the optional extension for a declared override", { timeout: 45_000 }, async () => {
		await writeCatalog({ review: { subagents: { defaultModel: "local/test-model" } } });

		const result = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain('profile "review"');
		expect(result.stderr).toContain("/subagents-models");
		const instance = await soleInstanceDir(fixture);
		const settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
		expect(settings.subagents.defaultModel).toBe("local/test-model");
		const plan = JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8"));
		expect(plan.subagents).toEqual({ defaultModel: "local/test-model" });
		expect(plan.resolved.extensions).toEqual([]);
	});

	it("does not add user extensions or tools back when subagent declarations coexist with empty selectors", { timeout: 45_000 }, async () => {
		const extensionDir = path.join(fixture.agentDir, "extensions");
		await mkdir(extensionDir, { recursive: true });
		const marker = path.join(fixture.root, "extension-loaded");
		await writeFile(path.join(extensionDir, "probe.ts"), `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }\n`);
		await writeCatalog({ review: { extensions: [], tools: [], subagents: { defaultModel: "local/model" } } });

		const rpc = runLauncherRpc(fixture, ["review", "--", "--mode", "rpc"]);
		try {
			const commands = await rpc.commandNames();
			expect(commands.map((command) => command.name)).not.toContain("probe");
			expect(await readFile(path.join((await soleInstanceDir(fixture)), "pi-profile.json"), "utf8")).toContain('"extensions": []');
			const { existsSync } = await import("node:fs");
			expect(existsSync(marker)).toBe(false);
		} finally {
			await rpc.close();
		}
	});

	it("warns for a missing explicit extension without widening its declared selection", { timeout: 30_000 }, async () => {
		const marker = path.join(fixture.root, "unselected-extension-loaded");
		const extensions = path.join(fixture.agentDir, "extensions");
		await mkdir(extensions, { recursive: true });
		await writeFile(path.join(extensions, "unselected.ts"), `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }\n`);
		await writeCatalog({ review: { extensions: ["pi-subagents"] } });

		const result = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain('unknown extension: "pi-subagents"');
		const instance = await soleInstanceDir(fixture);
		const plan = JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8"));
		expect(plan.resolved.extensions).toEqual([]);
		expect(plan.diagnostics).toContainEqual(expect.objectContaining({ kind: "extension", reference: "pi-subagents" }));
		const { existsSync } = await import("node:fs");
		expect(existsSync(marker)).toBe(false);
	});

	it("switches, reloads deleted overrides and native edits without changing the session", { timeout: 90_000 }, async () => {
		const baseSettings = {
			subagents: { defaultModel: "base/model", agentOverrides: { reviewer: { model: "native/model", description: "Native", inheritedContext: true } } },
		};
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(baseSettings));
		await writeCatalog({
			alpha: { subagents: { agentOverrides: { reviewer: { model: "profile/alpha", description: "Alpha" } } } },
			beta: { subagents: { agentOverrides: { reviewer: { model: "profile/beta", description: "Beta" } } } },
			plain: {},
		});
		const rpc: RpcDriver = runLauncherRpc(fixture, ["alpha", "--", "--mode", "rpc"]);
		try {
			const before = await rpc.send({ type: "get_state" });
			const initialState = before.data as { sessionId?: string; sessionFile?: string; messageCount?: number };
			const instance = await soleInstanceDir(fixture);
			const switched = await rpc.send({ type: "prompt", message: "/profile use beta" }, 60_000);
			expect(switched.success).toBe(true);
			let settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
			expect(settings.subagents.agentOverrides.reviewer).toEqual({ model: "profile/beta", description: "Beta", inheritedContext: true });

			await writeCatalog({ beta: { subagents: { agentOverrides: { reviewer: { model: "profile/beta" } } } }, plain: {} });
			await writeFile(
				path.join(fixture.agentDir, "settings.json"),
				JSON.stringify({ subagents: { defaultModel: "edited/base", agentOverrides: { reviewer: { model: "native/edited", description: "Edited native", inheritedContext: false } } } }),
			);
			const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
			expect(reloaded.success).toBe(true);
			settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
			expect(settings.subagents).toEqual({
				defaultModel: "edited/base",
				agentOverrides: { reviewer: { model: "profile/beta", description: "Edited native", inheritedContext: false } },
			});

			await rpc.send({ type: "prompt", message: "/profile status" }, 60_000);
			const rawStatus = await rpc.waitFor((message) => extractStatusReport(message) !== undefined, 60_000);
			const report = extractStatusReport(rawStatus);
			expect(report?.profile).toBe("beta");
			expect(report?.subagents).toEqual({
				declared: { agentOverrides: { reviewer: { model: "profile/beta" } } },
				extension: "unconfirmed",
			});

			const plainSwitch = await rpc.send({ type: "prompt", message: "/profile use plain" }, 60_000);
			expect(plainSwitch.success).toBe(true);
			settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
			expect(settings.subagents).toEqual({
				defaultModel: "edited/base",
				agentOverrides: { reviewer: { model: "native/edited", description: "Edited native", inheritedContext: false } },
			});
			const after = await rpc.send({ type: "get_state" });
			const finalState = after.data as { sessionId?: string; sessionFile?: string; messageCount?: number };
			expect(finalState.sessionId).toBe(initialState.sessionId);
			expect(finalState.sessionFile).toBe(initialState.sessionFile);
			expect(finalState.messageCount).toBeGreaterThan(initialState.messageCount ?? 0);
		} finally {
			await rpc.close();
		}
	});
});
