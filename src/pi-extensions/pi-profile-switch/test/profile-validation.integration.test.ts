import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncher, runLauncherRpc } from "./helpers/launcher-runner.ts";
import { runNativePi, runNativePiRpc } from "./helpers/native-pi-runner.ts";
import { createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";
import type { RpcDriver } from "./helpers/rpc-driver.ts";

const PROVIDER = "profile-validation-fixture";
const UNAVAILABLE = "profile-validation-unavailable";
const PROVIDER_EXTENSION = path.resolve("test/fixtures/provider-registration.ts");
const RELOAD_EXTENSION = path.resolve("test/fixtures/native-reload.ts");
const RPC_ARGS = ["--mode", "rpc", "--no-session", "--approve", "-e", RELOAD_EXTENSION];

interface ModelIdentity { provider: string; id: string }
interface SessionState { model?: ModelIdentity; sessionId: string; messageCount: number; thinkingLevel: string }
interface ProviderEvent { kind: string; pid: number; reason?: string; model?: ModelIdentity; sessionId?: string }

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
	for (const driver of drivers) { await driver.close(); await driver.waitForExit(); }
	for (const fixture of fixtures) { await noRequests(fixture); await rm(fixture.root, { recursive: true, force: true }); }
	if (savedTrace === undefined) delete process.env.PI_PROFILE_VALIDATION_TRACE;
	else process.env.PI_PROFILE_VALIDATION_TRACE = savedTrace;
	if (savedSwitchDir === undefined) delete process.env.PI_PROFILE_SWITCH_DIR;
	else process.env.PI_PROFILE_SWITCH_DIR = savedSwitchDir;
});

async function fixture(): Promise<PiFixture> {
	const value = await createPiFixture();
	fixtures.push(value);
	await writeFile(path.join(value.agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
	return value;
}

function environment(value: PiFixture): void {
	process.env.PI_PROFILE_SWITCH_DIR = value.profileSwitchDir;
	process.env.PI_PROFILE_VALIDATION_TRACE = path.join(value.root, "provider-events.jsonl");
}

function declaration(id: string, provider = PROVIDER) {
	return { defaultProvider: provider, defaultModel: id, defaultThinkingLevel: "high", extensions: [PROVIDER_EXTENSION] };
}

async function profile(value: PiFixture, name: string, definition: object): Promise<void> {
	const dir = path.join(value.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
}

async function nativeSettings(value: PiFixture, definition: object): Promise<void> {
	await writeFile(path.join(value.agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", ...definition }));
}

function start(value: PiFixture, kind: "profile" | "native", name = "focused", args = RPC_ARGS): RpcDriver {
	environment(value);
	const driver = kind === "profile" ? runLauncherRpc(value, [name, "--", ...args]) : runNativePiRpc(value, args);
	drivers.push(driver);
	return driver;
}

async function state(driver: RpcDriver): Promise<SessionState> {
	const response = await driver.send({ type: "get_state" });
	expect(response.success, driver.stderr.join("")).toBe(true);
	return response.data as unknown as SessionState;
}

function identity(value: SessionState): ModelIdentity | undefined {
	return value.model && { provider: value.model.provider, id: value.model.id };
}

async function events(value: PiFixture): Promise<ProviderEvent[]> {
	const file = path.join(value.root, "provider-events.jsonl");
	if (!existsSync(file)) return [];
	return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function noRequests(value: PiFixture, driver?: RpcDriver): Promise<void> {
	expect((await events(value)).filter((event) => event.kind === "request" || event.kind === "provider-request")).toEqual([]);
	if (driver) {
		expect(driver.messages.some((message) => (message as { type?: string }).type === "agent_start")).toBe(false);
		const stats = await driver.send({ type: "get_session_stats" });
		expect(stats.success).toBe(true);
		expect(stats.data?.tokens).toMatchObject({ input: 0, output: 0 });
	}
}

function noPreflightWarning(driver: RpcDriver): void {
	expect(driver.stderr.join("")).not.toMatch(/pi-profile:.*(?:model.*(?:not found|missing|validat)|credentials|unknown provider)/i);
}

async function command(driver: RpcDriver, message: string): Promise<void> {
	const response = await driver.send({ type: "prompt", message }, 45_000);
	expect(response.success, driver.stderr.join("")).toBe(true);
	expect(response.data?.disposition).toBe("handled");
}

async function bootstrap(value: PiFixture): Promise<object> {
	await writeFile(path.join(value.agentDir, "models.json"), JSON.stringify({ providers: {
		"profile-validation-bootstrap": { api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "test-only-not-a-credential", models: [{ id: "bootstrap", reasoning: true }] },
	} }));
	return { defaultProvider: "profile-validation-bootstrap", defaultModel: "bootstrap", extensions: [] };
}

describe("native provider lifecycle through profiles", () => {
	it("selects an extension-registered startup provider after loading, without launcher execution or preflight warnings", { timeout: 60_000 }, async () => {
		const wrapped = await fixture(); const native = await fixture();
		await profile(wrapped, "focused", declaration("startup"));
		await nativeSettings(native, declaration("startup"));
		expect(existsSync(path.join(wrapped.agentDir, "models.json"))).toBe(false);
		expect(existsSync(path.join(wrapped.agentDir, "auth.json"))).toBe(false);
		const wrappedDriver = start(wrapped, "profile"); const nativeDriver = start(native, "native");
		const actual = await state(wrappedDriver); const control = await state(nativeDriver);
		expect(identity(actual)).toEqual({ provider: PROVIDER, id: "startup" });
		expect(identity(actual)).toEqual(identity(control));
		expect(actual.thinkingLevel).toBe(control.thinkingLevel);
		const trace = await events(wrapped);
		expect(trace.find((event) => event.kind === "session_start")?.model).toEqual(identity(actual));
		const instance = await soleInstanceDir(wrapped);
		const childPid = Number(await readFile(path.join(instance, "pid"), "utf8"));
		expect([...new Set(trace.map((event) => event.pid))]).toEqual([childPid]);
		noPreflightWarning(wrappedDriver);
		await noRequests(wrapped, wrappedDriver); await noRequests(native, nativeDriver);
	});

	it.each([
		{ name: "CLI overrides a valid profile", profileId: "startup", provider: PROVIDER, projectId: undefined, cliId: "cli", expected: "cli" },
		{ name: "CLI overrides an unavailable profile", profileId: "missing", provider: UNAVAILABLE, projectId: undefined, cliId: "cli", expected: "cli" },
		{ name: "trusted project settings override the profile", profileId: "startup", provider: PROVIDER, projectId: "project", cliId: undefined, expected: "project" },
		{ name: "CLI overrides project settings too", profileId: "startup", provider: PROVIDER, projectId: "project", cliId: "cli", expected: "cli" },
	])("preserves native precedence: $name", { timeout: 60_000 }, async ({ profileId, provider, projectId, cliId, expected }) => {
		const wrapped = await fixture(); const native = await fixture();
		const definition = declaration(profileId, provider);
		await profile(wrapped, "focused", definition); await nativeSettings(native, definition);
		if (projectId !== undefined) for (const value of [wrapped, native]) {
			await writeFile(path.join(value.cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: projectId }));
		}
		const args = [...RPC_ARGS, ...(cliId ? ["--model", `${PROVIDER}/${cliId}`] : [])];
		const wrappedDriver = start(wrapped, "profile", "focused", args); const nativeDriver = start(native, "native", "focused", args);
		const actual = await state(wrappedDriver); const control = await state(nativeDriver);
		expect(identity(actual)).toEqual({ provider: PROVIDER, id: expected });
		expect(identity(actual)).toEqual(identity(control));
		noPreflightWarning(wrappedDriver);
		await noRequests(wrapped, wrappedDriver); await noRequests(native, nativeDriver);
	});

	it("leaves unavailable declared defaults to the same native fallback rather than inventing validation", { timeout: 60_000 }, async () => {
		const wrapped = await fixture(); const native = await fixture();
		const definition = declaration("missing", UNAVAILABLE);
		await profile(wrapped, "focused", definition); await nativeSettings(native, definition);
		const wrappedDriver = start(wrapped, "profile"); const nativeDriver = start(native, "native");
		const actual = await state(wrappedDriver); const control = await state(nativeDriver);
		expect(identity(actual)).toEqual(identity(control));
		expect(actual.thinkingLevel).toBe(control.thinkingLevel);
		expect(identity(actual)).not.toEqual({ provider: UNAVAILABLE, id: "missing" });
		const instance = await soleInstanceDir(wrapped);
		const handedOff = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
		expect(handedOff.defaultProvider).toBe(UNAVAILABLE);
		expect(handedOff.defaultModel).toBe("missing");
		noPreflightWarning(wrappedDriver);
		await noRequests(wrapped, wrappedDriver); await noRequests(native, nativeDriver);
	});

	it("preserves native unavailable CLI diagnostics and exit behavior after extensions load", { timeout: 60_000 }, async () => {
		const wrapped = await fixture(); const native = await fixture();
		await profile(wrapped, "focused", declaration("startup")); await nativeSettings(native, declaration("startup"));
		const args = [...RPC_ARGS, "--provider", UNAVAILABLE, "--model", "missing"];
		environment(native); const control = await runNativePi(native, args);
		environment(wrapped); const actual = await runLauncher(wrapped, ["focused", "--", ...args]);
		expect(control.signal).toBeNull();
		expect(actual.code).toBe(control.code);
		expect(control.stderr).toContain(`Unknown provider "${UNAVAILABLE}"`);
		expect(actual.stderr).toContain(control.stderr.trim());
		expect(actual.stderr).not.toMatch(/pi-profile:.*(?:model|provider|credentials)/i);
		expect((await events(wrapped)).some((event) => event.kind === "factory")).toBe(true);
		await noRequests(wrapped); await noRequests(native);
	});

	it.each([false, true])("matches native use/reload retention when provider first loads on switch=%s", { timeout: 90_000 }, async (firstLoad) => {
		const wrapped = await fixture(); const native = await fixture();
		const initial = firstLoad ? await bootstrap(wrapped) : declaration("startup");
		if (firstLoad) await bootstrap(native);
		await profile(wrapped, "initial", initial); await nativeSettings(native, initial);
		await profile(wrapped, "target", declaration("reload"));
		const wrappedDriver = start(wrapped, "profile", "initial"); const nativeDriver = start(native, "native");
		// RPC bash adds real history without starting a model turn.
		for (const driver of [wrappedDriver, nativeDriver]) {
			const history = await driver.send({ type: "bash", command: "printf profile-validation-history" });
			expect(history.success).toBe(true);
		}
		const before = await state(wrappedDriver); const nativeBefore = await state(nativeDriver);
		const messagesBefore = (await wrappedDriver.send({ type: "get_messages" })).data?.messages;
		const nativeMessagesBefore = (await nativeDriver.send({ type: "get_messages" })).data?.messages;
		expect((messagesBefore as unknown[]).length).toBeGreaterThan(0);
		expect(identity(before)).toEqual(identity(nativeBefore));
		if (firstLoad) expect((await events(wrapped)).some((event) => event.kind === "factory")).toBe(false);
		await nativeSettings(native, declaration("reload"));
		await command(nativeDriver, "/fixture-native-reload");
		await command(wrappedDriver, "/profile use target");
		const afterUse = await state(wrappedDriver); const nativeAfter = await state(nativeDriver);
		expect(identity(afterUse)).toEqual(identity(nativeAfter));
		expect(identity(afterUse)).toEqual(identity(before));
		expect(afterUse.thinkingLevel).toBe(nativeAfter.thinkingLevel);
		expect(afterUse.thinkingLevel).toBe(before.thinkingLevel);
		expect(afterUse.sessionId).toBe(before.sessionId);
		expect(nativeAfter.sessionId).toBe(nativeBefore.sessionId);
		expect((await wrappedDriver.send({ type: "get_messages" })).data?.messages).toEqual(messagesBefore);
		expect((await nativeDriver.send({ type: "get_messages" })).data?.messages).toEqual(nativeMessagesBefore);
		const available = await wrappedDriver.send({ type: "get_available_models" });
		expect((available.data?.models as ModelIdentity[]).some((model) => model.provider === PROVIDER && model.id === "reload")).toBe(true);
		const instance = await soleInstanceDir(wrapped);
		expect(JSON.parse(await readFile(path.join(instance, "pi-profile.json"), "utf8")).profile).toBe("target");
		const targetSettings = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
		expect(targetSettings.defaultProvider).toBe(PROVIDER);
		expect(targetSettings.defaultModel).toBe("reload");
		await command(nativeDriver, "/fixture-native-reload");
		await command(wrappedDriver, "/profile reload");
		const afterReload = await state(wrappedDriver); const nativeReload = await state(nativeDriver);
		expect(identity(afterReload)).toEqual(identity(nativeReload));
		expect(identity(afterReload)).toEqual(identity(before));
		expect(afterReload.thinkingLevel).toBe(nativeReload.thinkingLevel);
		expect(afterReload.thinkingLevel).toBe(before.thinkingLevel);
		expect(afterReload.sessionId).toBe(before.sessionId);
		expect((await wrappedDriver.send({ type: "get_messages" })).data?.messages).toEqual(messagesBefore);
		expect((await nativeDriver.send({ type: "get_messages" })).data?.messages).toEqual(nativeMessagesBefore);
		for (const value of [wrapped, native]) {
			const trace = await events(value);
			expect(trace.filter((event) => event.kind === "session_start" && event.reason === "reload")).toHaveLength(2);
			expect(trace.filter((event) => event.kind === "factory")).toHaveLength(firstLoad ? 2 : 3);
		}
		noPreflightWarning(wrappedDriver);
		await noRequests(wrapped, wrappedDriver); await noRequests(native, nativeDriver);
	});
});


describe("selected definition and unexpected IO startup boundaries", () => {
	it.each(["{ invalid", "[]", '{"skills":1}'])("rejects the selected definition before native creation: %s", { timeout: 45_000 }, async (content) => {
		const wrapped = await fixture();
		await profile(wrapped, "broken", {});
		const file = path.join(wrapped.profileSwitchDir, "profiles", "broken.json");
		await writeFile(file, content); environment(wrapped);
		const result = await runLauncher(wrapped, ["broken", "--", ...RPC_ARGS, "-e", PROVIDER_EXTENSION]);
		expect(result.code).toBe(2); expect(result.stderr).toContain(file);
		expect(await events(wrapped)).toEqual([]);
		expect(existsSync(path.join(wrapped.profileSwitchDir, "instances"))).toBe(false);
	});
	it("rejects explicitly absent names rather than substituting a profile", { timeout: 45_000 }, async () => {
		const wrapped = await fixture(); environment(wrapped);
		const result = await runLauncher(wrapped, ["absent", "--", ...RPC_ARGS, "-e", PROVIDER_EXTENSION]);
		expect(result.code).toBe(2); expect(result.stderr).toContain("unknown profile: absent");
		expect(await events(wrapped)).toEqual([]);
	});
	it("keeps genuine filesystem failure fatal rather than a skipped-content warning", { timeout: 45_000 }, async () => {
		const wrapped = await fixture(); await profile(wrapped, "focused", declaration("startup"));
		await mkdir(path.join(wrapped.agentDir, "mcp.json")); environment(wrapped);
		const result = await runLauncher(wrapped, ["focused", "--", ...RPC_ARGS]);
		expect(result.code).toBe(1); expect(result.stderr).toContain("EISDIR");
		expect(result.stderr).not.toContain("source skipped");
		expect(await events(wrapped)).toEqual([]);
	});
});
