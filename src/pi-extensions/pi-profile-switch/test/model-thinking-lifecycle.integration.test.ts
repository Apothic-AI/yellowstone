import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncherRpc } from "./helpers/launcher-runner.ts";
import { createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";
import type { RpcDriver } from "./helpers/rpc-driver.ts";

/**
 * FT-32: the provider/model/thinking-level spec a profile declares must be the
 * level the lane actually runs at, and must survive every session-lifecycle leg
 * (fresh launch, /new, /reload, /resume, process relaunch).
 *
 * Pi ranks a *per-model startup pin* (`modelThinkingLevels[provider/modelId]`)
 * above `defaultThinkingLevel`. A profile states its level through
 * `defaultThinkingLevel`, so a pin the user set for the same model — for any
 * other lane, or for this model before the profile existed — silently won and
 * every lane of every profile came up at that pinned level.
 *
 * These tests launch the real binary through the real launcher and read the
 * effective runtime state from `get_state` (model + thinkingLevel), never the
 * footer. The fixture provider maps xhigh/max so a level above `high` is
 * representable, and its streamSimple throws before any I/O, so no request can
 * leave the machine.
 */

const PROVIDER = "thinking-lifecycle-fixture";
const PROVIDER_EXTENSION = path.resolve("test/fixtures/thinking-lifecycle-provider.ts");
const RELOAD_EXTENSION = path.resolve("test/fixtures/native-reload.ts");
const RPC_ARGS = ["--mode", "rpc", "--approve", "-e", PROVIDER_EXTENSION, "-e", RELOAD_EXTENSION];

interface ModelIdentity {
	provider: string;
	id: string;
}
interface SessionState {
	model?: ModelIdentity;
	sessionId: string;
	sessionFile?: string;
	messageCount: number;
	thinkingLevel: string;
}
interface ProviderEvent {
	kind: string;
	reason?: string;
}

/** The user's real (global) settings, which the launcher starts from. The pin
 *  for the profiles' own model is the documented user feature that used to
 *  outrank every profile; `other-model` is an unrelated pin that must survive. */
const GLOBAL_SETTINGS = {
	cacheWarming: "off",
	defaultProvider: PROVIDER,
	defaultModel: "worker-model",
	defaultThinkingLevel: "low",
	modelThinkingLevels: {
		[`${PROVIDER}/worker-model`]: "max",
		[`${PROVIDER}/other-model`]: "medium",
	},
};

let fixtures: PiFixture[];
let drivers: RpcDriver[];
let savedTrace: string | undefined;
let savedSwitchDir: string | undefined;

beforeEach(() => {
	fixtures = [];
	drivers = [];
	savedTrace = process.env.PI_PROFILE_VALIDATION_TRACE;
	savedSwitchDir = process.env.PI_PROFILE_SWITCH_DIR;
});

afterEach(async () => {
	for (const driver of drivers) {
		await driver.close();
		await driver.waitForExit();
	}
	for (const fixture of fixtures) {
		await expectNoRequests(fixture);
		await rm(fixture.root, { recursive: true, force: true });
	}
	if (savedTrace === undefined) delete process.env.PI_PROFILE_VALIDATION_TRACE;
	else process.env.PI_PROFILE_VALIDATION_TRACE = savedTrace;
	if (savedSwitchDir === undefined) delete process.env.PI_PROFILE_SWITCH_DIR;
	else process.env.PI_PROFILE_SWITCH_DIR = savedSwitchDir;
});

/** A fixture whose *global* agent dir carries conflicting state: a `max` pin for
 *  the model every profile below launches, and a saved active profile that is
 *  not the one being launched. */
async function fixture(): Promise<PiFixture> {
	const value = await createPiFixture();
	fixtures.push(value);
	await writeFile(path.join(value.agentDir, "settings.json"), JSON.stringify(GLOBAL_SETTINGS));
	// Core reads its own agent-dir settings, never this file: keeping it present
	// and contradictory is the control for the "global active profile" belief.
	await writeFile(path.join(value.agentDir, "pi-profile-state.json"), JSON.stringify({ activeProfile: "leader-like" }));
	process.env.PI_PROFILE_SWITCH_DIR = value.profileSwitchDir;
	process.env.PI_PROFILE_VALIDATION_TRACE = path.join(value.root, "provider-events.jsonl");
	return value;
}

async function profile(value: PiFixture, name: string, model: string, thinkingLevel: string): Promise<void> {
	const dir = path.join(value.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, `${name}.json`),
		JSON.stringify({
			defaultProvider: PROVIDER,
			defaultModel: model,
			defaultThinkingLevel: thinkingLevel,
			extensions: [PROVIDER_EXTENSION],
		}),
	);
}

function start(value: PiFixture, name: string): RpcDriver {
	const driver = runLauncherRpc(value, [name, "--", ...RPC_ARGS]);
	drivers.push(driver);
	return driver;
}

async function state(driver: RpcDriver): Promise<SessionState> {
	const response = await driver.send({ type: "get_state" });
	expect(response.success, driver.stderr.join("")).toBe(true);
	return response.data as unknown as SessionState;
}

async function level(driver: RpcDriver): Promise<string> {
	return (await state(driver)).thinkingLevel;
}

async function command(driver: RpcDriver, message: string): Promise<void> {
	const response = await driver.send({ type: "prompt", message }, 45_000);
	expect(response.success, driver.stderr.join("")).toBe(true);
	expect(response.data?.disposition).toBe("handled");
}

async function events(value: PiFixture): Promise<ProviderEvent[]> {
	const file = path.join(value.root, "provider-events.jsonl");
	if (!existsSync(file)) return [];
	return (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProviderEvent);
}

async function expectNoRequests(value: PiFixture): Promise<void> {
	expect((await events(value)).filter((event) => event.kind === "request" || event.kind === "provider-request")).toEqual([]);
}

/** A session file recording a resolved level, exactly as a real session records
 *  its own start-up state. No provider interaction is involved. */
async function seedSession(value: PiFixture, thinkingLevel: string, stamp: string): Promise<string> {
	// Pi slugs a session directory as `--<cwd without its leading slash, / → ->--`.
	const slug = value.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const sessionDir = path.join(value.agentDir, "sessions", `--${slug}--`);
	await mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${stamp}_11111111-2222-3333-4444-555555555555.jsonl`);
	const entries = [
		{ type: "session", version: 3, id: "11111111-2222-3333-4444-555555555555", timestamp: stamp, cwd: value.cwd },
		{ type: "model_change", id: "m1", parentId: null, timestamp: stamp, provider: PROVIDER, modelId: "worker-model" },
		{ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: stamp, thinkingLevel },
		{
			type: "message",
			id: "u1",
			parentId: "t1",
			timestamp: stamp,
			message: { role: "user", content: [{ type: "text", text: "fixture turn", timestamp: stamp }], timestamp: stamp },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "fixture answer" }],
				provider: PROVIDER,
				model: "worker-model",
				usage: { input: 0, output: 0 },
				stopReason: "stop",
				timestamp: stamp,
			},
		},
	];
	await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("the launched profile's thinking level is the level the lane runs at", () => {
	const PROFILES = [
		["leader-like", "leader-model", "max"],
		["worker-like", "worker-model", "high"],
		["ask-like", "ask-model", "medium"],
	] as const;

	it.each(PROFILES)(
		"honours the %s profile's declared level on every leg, despite a conflicting global pin and saved active profile",
		{ timeout: 120_000 },
		async (name, model, spec) => {
			const value = await fixture();
			await profile(value, name, model, spec);
			const driver = start(value, name);

			// Fresh launch: the profile's spec, not the global pin for this model.
			const fresh = await state(driver);
			expect(fresh.model && `${fresh.model.provider}/${fresh.model.id}`).toBe(`${PROVIDER}/${model}`);
			expect(fresh.thinkingLevel).toBe(spec);

			// /new is a fresh session and must resolve the same spec.
			expect((await driver.send({ type: "new_session" })).success).toBe(true);
			expect(await level(driver)).toBe(spec);

			// /reload re-reads settings but must not move the selection.
			await command(driver, "/fixture-native-reload");
			expect(await level(driver)).toBe(spec);

			// The generated instance settings state the spec for the profile's own
			// model, and leave the user's unrelated per-model pin untouched.
			const instance = await soleInstanceDir(value);
			const settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
			// The profile's own model must not carry a pin that disagrees with the spec;
			// the effective startup level is therefore the declared one (asserted above).
			expect(settings.modelThinkingLevels?.[`${PROVIDER}/${model}`] ?? settings.defaultThinkingLevel).toBe(spec);
			expect(settings.defaultThinkingLevel).toBe(spec);
			expect(settings.modelThinkingLevels[`${PROVIDER}/other-model`]).toBe("medium");
			expect(settings.defaultProvider).toBe(PROVIDER);
			expect(settings.defaultModel).toBe(model);

			await expectNoRequests(value);
		},
	);

	it("keeps a user's in-session thinking choice within that session", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", "worker-model", "high");
		const driver = start(value, "worker-like");
		expect(await level(driver)).toBe("high");

		const set = await driver.send({ type: "set_thinking_level", level: "low" });
		expect(set.success).toBe(true);
		expect(await level(driver)).toBe("low");

		// A reload is a settings/resources reload, not a reset of the selection.
		await command(driver, "/fixture-native-reload");
		expect(await level(driver)).toBe("low");
		await expectNoRequests(value);
	});
});

describe("recorded session state across /resume and process relaunch", () => {
	it("restores the level recorded in the session, in both directions", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", "worker-model", "high");

		// A session that recorded the spec's level resumes at that level.
		const highSession = await seedSession(value, "high", "2026-02-01T00:00:00.000Z");
		const first = runLauncherRpc(value, ["worker-like", "--", ...RPC_ARGS, "--session", highSession]);
		drivers.push(first);
		expect(await level(first)).toBe("high");

		// A session that recorded a level the settings disagree with still wins:
		// resume restores session state, it does not re-derive it.
		const maxSession = await seedSession(value, "max", "2026-03-01T00:00:00.000Z");
		const second = runLauncherRpc(value, ["worker-like", "--", ...RPC_ARGS, "--session", maxSession]);
		drivers.push(second);
		expect(await level(second)).toBe("max");
		await expectNoRequests(value);
	});

	it("keeps the recorded level across a process relaunch that continues the session", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", "worker-model", "high");
		await seedSession(value, "medium", "2026-04-01T00:00:00.000Z");

		const driver = runLauncherRpc(value, ["worker-like", "--", ...RPC_ARGS, "--continue"]);
		drivers.push(driver);
		expect(await level(driver)).toBe("medium");
		await expectNoRequests(value);
	});
});
