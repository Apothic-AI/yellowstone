import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncherRpc } from "./helpers/launcher-runner.ts";
import { createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";
import type { RpcDriver } from "./helpers/rpc-driver.ts";

/**
 * FT-32: the provider/model/thinking-level spec a profile declares must be the
 * spec the lane actually runs, and must survive every session-lifecycle leg
 * (fresh launch, /new, /reload, /resume, process relaunch).
 *
 * Pi ranks a *per-model startup pin* (`modelThinkingLevels[provider/modelId]`)
 * above `defaultThinkingLevel`. A profile states its level through
 * `defaultThinkingLevel`, so a global pin the user set for the same model — for
 * any other lane — used to win, and every lane of every profile came up at that
 * pinned level. The reviewed policy is narrow: a profile that declares a model
 * *and* a level owns that model's startup level, so a conflicting inherited pin
 * for that one model is not carried into the generated instance settings. A pin
 * that already matches is left alone, every other model's pin is preserved, and
 * the user's own settings file is never written.
 *
 * These tests launch the real binary through the real launcher and read the
 * effective runtime state from `get_state` (provider, model, thinkingLevel,
 * session identity), never the footer. The fixture provider maps xhigh/max so a
 * level above `high` is representable, and its streamSimple throws before any
 * I/O, so no request can leave the machine.
 */

const PROVIDER = "thinking-lifecycle-fixture";
const SHARED = "shared-model";
const OTHER = "other-model";
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
	piEntry?: string;
}

/** The user's real (global) settings, which the launcher starts from. The pin
 *  for the profiles' own model is the documented user feature that used to
 *  outrank every profile; `other-model` is an unrelated pin that must survive. */
const GLOBAL_SETTINGS = {
	cacheWarming: "off",
	defaultProvider: PROVIDER,
	defaultModel: SHARED,
	defaultThinkingLevel: "low",
	modelThinkingLevels: {
		[`${PROVIDER}/${SHARED}`]: "max",
		[`${PROVIDER}/${OTHER}`]: "medium",
	},
};

/** Same model, three levels: every profile case faces a real same-model conflict
 *  except `max`, which is the matching-pin control. */
const PROFILES = [
	["leader-like", "max"],
	["worker-like", "high"],
	["ask-like", "medium"],
] as const;

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

async function profile(value: PiFixture, name: string, definition: Record<string, unknown>): Promise<void> {
	const dir = path.join(value.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ defaultProvider: PROVIDER, extensions: [PROVIDER_EXTENSION], ...definition }));
}

function start(value: PiFixture, name: string, extra: string[] = []): RpcDriver {
	const driver = runLauncherRpc(value, [name, "--", ...RPC_ARGS, ...extra]);
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

function identity(value: SessionState): string {
	return value.model ? `${value.model.provider}/${value.model.id}` : "(none)";
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

/** A session file recording a resolved spec, exactly as a real session records
 *  its own start-up state. No provider interaction is involved. */
async function seedSession(value: PiFixture, spec: { model: string; thinkingLevel: string }, stamp: string, id: string): Promise<string> {
	// Pi slugs a session directory as `--<cwd without its leading slash, / → ->--`.
	const slug = value.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const sessionDir = path.join(value.agentDir, "sessions", `--${slug}--`);
	await mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${stamp}_${id}.jsonl`);
	const entries = [
		{ type: "session", version: 3, id, timestamp: stamp, cwd: value.cwd },
		{ type: "model_change", id: "m1", parentId: null, timestamp: stamp, provider: PROVIDER, modelId: spec.model },
		{ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: stamp, thinkingLevel: spec.thinkingLevel },
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
				model: spec.model,
				usage: { input: 0, output: 0 },
				stopReason: "stop",
				timestamp: stamp,
			},
		},
	];
	await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("a declared profile spec governs startup for its own model", () => {
	it.each(PROFILES)(
		"%s profile on the shared model: declared level wins over a conflicting global same-model pin on every leg",
		{ timeout: 120_000 },
		async (name, spec) => {
			const value = await fixture();
			await profile(value, name, { defaultModel: SHARED, defaultThinkingLevel: spec });
			const driver = start(value, name);

			// Fresh launch: actual runtime provider, model and level.
			const fresh = await state(driver);
			expect(identity(fresh)).toBe(`${PROVIDER}/${SHARED}`);
			expect(fresh.thinkingLevel).toBe(spec);

			// /new is a fresh session: new identity, same declared spec.
			expect((await driver.send({ type: "new_session" })).success).toBe(true);
			const afterNew = await state(driver);
			expect(afterNew.sessionId).not.toBe(fresh.sessionId);
			expect(identity(afterNew)).toBe(`${PROVIDER}/${SHARED}`);
			expect(afterNew.thinkingLevel).toBe(spec);

			// /reload keeps the same session and the same selection.
			await command(driver, "/fixture-native-reload");
			const afterReload = await state(driver);
			expect(afterReload.sessionId).toBe(afterNew.sessionId);
			expect(identity(afterReload)).toBe(`${PROVIDER}/${SHARED}`);
			expect(afterReload.thinkingLevel).toBe(spec);

			// Generated instance settings: the conflicting pin is *absent* (not
			// rewritten), the matching pin is kept, the unrelated pin survives.
			const instance = await soleInstanceDir(value);
			const settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
			expect(settings.defaultProvider).toBe(PROVIDER);
			expect(settings.defaultModel).toBe(SHARED);
			expect(settings.defaultThinkingLevel).toBe(spec);
			const ownPin = settings.modelThinkingLevels?.[`${PROVIDER}/${SHARED}`];
			if (spec === "max") expect(ownPin).toBe("max");
			else expect(ownPin).toBeUndefined();
			expect(settings.modelThinkingLevels?.[`${PROVIDER}/${OTHER}`]).toBe("medium");

			await expectNoRequests(value);
		},
	);

	it("inherits unchanged when the profile declares a model but no level", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "model-only", { defaultModel: SHARED });
		const driver = start(value, "model-only");

		// No declared level: nothing is suppressed, so the user's pin applies
		// exactly as it does without profiles.
		expect(await level(driver)).toBe("max");
		const instance = await soleInstanceDir(value);
		const settings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
		expect(settings.defaultThinkingLevel).toBe(GLOBAL_SETTINGS.defaultThinkingLevel);
		expect(settings.modelThinkingLevels?.[`${PROVIDER}/${SHARED}`]).toBe("max");
		await expectNoRequests(value);
	});

	it("runs the runtime the launcher resolves from PATH, and names it in the trace", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", { defaultModel: SHARED, defaultThinkingLevel: "high" });
		const driver = start(value, "worker-like");
		expect(await level(driver)).toBe("high");

		// The child recorded the entry it actually executed. Resolve that entry the way
		// the OS does (the CLI entry may be a shim), find the package that owns it, and
		// compare its version with what `pi --version` reports here. This proves the
		// executed file, not prose: a scratch HOME or a changed PATH cannot silently
		// substitute the pinned dev dependency for the deployed runtime.
		const moduleEvent = (await events(value)).find((event) => event.kind === "module");
		expect(typeof moduleEvent?.piEntry).toBe("string");
		const entry = realpathSync(moduleEvent!.piEntry!);
		expect(existsSync(entry)).toBe(true);

		let owner: { version: string; name?: string } | undefined;
		for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
			const candidate = path.join(dir, "package.json");
			if (existsSync(candidate)) {
				owner = JSON.parse(readFileSync(candidate, "utf8")) as { version: string; name?: string };
				break;
			}
		}
		expect(owner?.version).toBeDefined();
		const reported = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
		expect(owner!.version).toBe(reported);
		await expectNoRequests(value);
	});

	it("keeps the generated own-model pin suppressed for the instance lifetime", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", { defaultModel: SHARED, defaultThinkingLevel: "high" });
		const driver = start(value, "worker-like");
		expect(await level(driver)).toBe("high");

		// Switch to another model and back. The global pin for the shared model was
		// dropped from this instance, so returning to it re-applies the profile's
		// declared default, not the user's global pin. Recording the actual
		// semantics: suppression lasts for the instance lifetime.
		expect((await driver.send({ type: "set_model", provider: PROVIDER, modelId: OTHER })).success).toBe(true);
		expect(identity(await state(driver))).toBe(`${PROVIDER}/${OTHER}`);
		expect((await driver.send({ type: "set_model", provider: PROVIDER, modelId: SHARED })).success).toBe(true);
		const back = await state(driver);
		expect(identity(back)).toBe(`${PROVIDER}/${SHARED}`);
		expect(back.thinkingLevel).toBe("high");
		await expectNoRequests(value);
	});

	it("keeps a user's in-session provider/model/thinking choice across a reload", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", { defaultModel: SHARED, defaultThinkingLevel: "high" });
		const driver = start(value, "worker-like");
		expect(await level(driver)).toBe("high");

		const switched = await driver.send({ type: "set_model", provider: PROVIDER, modelId: OTHER });
		expect(switched.success, driver.stderr.join("")).toBe(true);
		const set = await driver.send({ type: "set_thinking_level", level: "low" });
		expect(set.success).toBe(true);
		const chosen = await state(driver);
		expect(identity(chosen)).toBe(`${PROVIDER}/${OTHER}`);
		expect(chosen.thinkingLevel).toBe("low");

		// A reload is a settings/resources reload: it must not reset the session's
		// own provider/model/thinking selection.
		await command(driver, "/fixture-native-reload");
		const afterReload = await state(driver);
		expect(afterReload.sessionId).toBe(chosen.sessionId);
		expect(identity(afterReload)).toBe(`${PROVIDER}/${OTHER}`);
		expect(afterReload.thinkingLevel).toBe("low");
		await expectNoRequests(value);
	});
});

describe("recorded session state across /resume and process relaunch", () => {
	it("restores the exact session and its recorded model/thinking, including a choice that differs from the profile", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", { defaultModel: SHARED, defaultThinkingLevel: "high" });

		// A session recorded at the profile's own spec.
		const highSession = await seedSession(value, { model: SHARED, thinkingLevel: "high" }, "2026-02-01T00:00:00.000Z", "11111111-2222-3333-4444-555555555555");
		const first = runLauncherRpc(value, ["worker-like", "--", ...RPC_ARGS, "--session", highSession]);
		drivers.push(first);
		const restoredOwn = await state(first);
		expect(restoredOwn.sessionId).toBe("11111111-2222-3333-4444-555555555555");
		expect(identity(restoredOwn)).toBe(`${PROVIDER}/${SHARED}`);
		expect(restoredOwn.thinkingLevel).toBe("high");

		// A session whose recorded choice differs from the profile's spec: resume
		// restores the session, it does not re-apply the profile.
		const otherSession = await seedSession(value, { model: OTHER, thinkingLevel: "low" }, "2026-03-01T00:00:00.000Z", "99999999-8888-7777-6666-555555555555");
		const second = runLauncherRpc(value, ["worker-like", "--", ...RPC_ARGS, "--session", otherSession]);
		drivers.push(second);
		const restoredOther = await state(second);
		expect(restoredOther.sessionId).toBe("99999999-8888-7777-6666-555555555555");
		expect(identity(restoredOther)).toBe(`${PROVIDER}/${OTHER}`);
		expect(restoredOther.thinkingLevel).toBe("low");
		await expectNoRequests(value);
	});

	it("keeps the recorded session and spec across a process relaunch that continues it", { timeout: 120_000 }, async () => {
		const value = await fixture();
		await profile(value, "worker-like", { defaultModel: SHARED, defaultThinkingLevel: "high" });
		const seeded = await seedSession(value, { model: OTHER, thinkingLevel: "medium" }, "2026-04-01T00:00:00.000Z", "12121212-3434-5656-7878-909090909090");

		const driver = runLauncherRpc(value, ["worker-like", "--", ...RPC_ARGS, "--continue"]);
		drivers.push(driver);
		const relaunched = await state(driver);
		expect(relaunched.sessionId).toBe("12121212-3434-5656-7878-909090909090");
		expect(identity(relaunched)).toBe(`${PROVIDER}/${OTHER}`);
		expect(relaunched.thinkingLevel).toBe("medium");
		expect(path.basename(seeded)).toContain("12121212");
		await expectNoRequests(value);
	});
});
