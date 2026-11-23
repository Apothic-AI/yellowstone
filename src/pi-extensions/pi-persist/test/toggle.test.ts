import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import envContext, { SECTION_NAME } from "../src/index.ts";
import { clearEnvMessages } from "../src/messages.ts";
import { clearContributions } from "../src/registry.ts";
import { setPersistEnabled } from "../src/settings.ts";
import { isEnabled, readToggleState, resetEnabled, resetGlobalDefault, toggleEnabled } from "../src/toggle.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

/** Two session ids, so "this session" and "some other session" are never the same bucket. */
const SESSION = "session-a";
const OTHER = "session-b";

/**
 * A harness around the extension — one per simulated copy of the package or per `/reload`.
 *
 * The global default comes from pi's own settings file, which the caller points at a temp directory
 * through `PI_CODING_AGENT_DIR`. A test that used the operator's real file would read a real "off"
 * and fail every other test here.
 *
 * The session id is mutable (`use`), because one process runs several sessions: isolation between
 * them is a property worth testing directly rather than through two harnesses.
 */
function harness(notices: string[]) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandHandler>();
	let sessionId = SESSION;

	envContext({
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (name: string, options: { handler: CommandHandler }) => {
			commands.set(name, options.handler);
		},
		getActiveTools: () => ["read"],
		getSettings: () => ({}),
	} as unknown as ExtensionAPI);

	const ctx = {
		cwd: "/home/u/project",
		provider: "relayfast",
		mode: "tui",
		model: { provider: "relayfast" },
		isProjectTrusted: () => false,
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
		// The switch is keyed by this, so it has to be the same call pi makes.
		sessionManager: { buildContextEntries: () => [] as unknown[], getSessionId: () => sessionId },
	};
	const event: { type: string; systemPromptOptions: { sections: Record<string, string> } } = {
		type: "before_agent_start",
		systemPromptOptions: { sections: {} },
	};

	return {
		commands,
		notices,
		/** Point the extension at another session, as `/new` would. */
		use(id: string) {
			sessionId = id;
		},
		async run(args: string) {
			const handler = commands.get("pi-persist-toggle");
			if (!handler) throw new Error("the command was not registered");
			await handler(args, ctx);
		},
		async start() {
			await handlers.get("before_agent_start")!(event, ctx);
			return event.systemPromptOptions.sections[SECTION_NAME];
		},
		async providerRequest(payload: unknown) {
			await handlers.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx);
			return payload as { messages: Array<{ role: string; content: unknown }> };
		},
	};
}

describe("/pi-persist-toggle", () => {
	let agentDir: string;
	let notices: string[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-persist-toggle-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		notices = [];
		clearContributions();
		clearEnvMessages();
		// The state is shared between copies of the package, so it is reset explicitly.
		resetEnabled();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		resetEnabled();
	});

	test("is registered under the name the operator types", () => {
		const app = harness(notices);
		expect(app.commands.has("pi-persist-toggle")).toBe(true);
	});

	test("is on by default", async () => {
		const app = harness(notices);
		expect(await app.start()).toContain("<shell>");
		const payload = await app.providerRequest({ messages: [] });
		expect(payload.messages.at(-1)?.role).toBe("developer");
	});

	test("off removes the section and the trailing message", async () => {
		const app = harness(notices);
		await app.run("");

		expect(await app.start()).toBeUndefined();
		const payload = await app.providerRequest({ messages: [] });
		expect(payload.messages).toEqual([]);
	});

	test("off is reported as this session's state", async () => {
		const app = harness(notices);
		await app.run("");
		expect(notices.at(-1) ?? "").toContain("is off for this session (global: on)");
	});

	test("on restores the section and the trailing message", async () => {
		const app = harness(notices);
		await app.run("");
		await app.run("");

		expect(await app.start()).toContain("<shell>");
		const payload = await app.providerRequest({ messages: [] });
		expect(payload.messages.at(-1)?.role).toBe("developer");
	});

	test("an explicit argument sets the state instead of flipping it", async () => {
		const app = harness(notices);
		await app.run("off");
		await app.run("on");
		expect(await app.start()).toContain("<shell>");

		await app.run("on");
		expect(await app.start()).toContain("<shell>");
	});

	test("status reports the session state and the global default distinctly", async () => {
		const app = harness(notices);
		await app.run("status");
		expect(notices.at(-1) ?? "").toContain("is on (global: on)");

		await app.run("off");
		await app.run("status");
		const line = notices.at(-1) ?? "";
		expect(line).toContain("off for this session");
		expect(line).toContain("global: on");
		// Status changes nothing.
		expect(await app.start()).toBeUndefined();
	});

	test("an argument that is not understood changes nothing", async () => {
		const app = harness(notices);
		await app.run("maybe");

		expect(notices.join("\n")).toContain("usage:");
		expect(await app.start()).toContain("<shell>");
	});
});

describe("/pi-persist-toggle does not write the global settings", () => {
	let agentDir: string;
	let notices: string[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-persist-toggle-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		notices = [];
		clearContributions();
		clearEnvMessages();
		resetEnabled();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		resetEnabled();
	});

	test("toggling does not create pi's settings file", async () => {
		const app = harness(notices);
		await app.run("off");
		await app.run("on");
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	test("toggling leaves an existing settings file byte-identical", async () => {
		const path = join(agentDir, "settings.json");
		const original = JSON.stringify({ theme: "neon-noir", piPersist: { enabled: true, future: 1 } }, null, 2);
		writeFileSync(path, original);

		const app = harness(notices);
		await app.run("off");
		expect(await app.start()).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	test("the operator's own writer still sets the global default", async () => {
		await setPersistEnabled(false, agentDir);
		resetGlobalDefault();
		expect(isEnabled(SESSION)).toBe(false);

		await setPersistEnabled(true, agentDir);
		resetGlobalDefault();
		expect(isEnabled(SESSION)).toBe(true);
	});
});

describe("/pi-persist-toggle session lifetime", () => {
	let agentDir: string;
	let notices: string[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-persist-toggle-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		notices = [];
		clearContributions();
		clearEnvMessages();
		resetEnabled();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		resetEnabled();
	});

	test("a second copy of the package in one process agrees", async () => {
		const first = harness(notices);
		const second = harness([]);
		await first.run("off");

		// Two copies (an npm cache and a local path) must not disagree: one off and one on would
		// inject half of what the operator asked for.
		expect(await second.start()).toBeUndefined();

		await second.run("on");
		expect(await first.start()).toContain("<shell>");
	});

	test("one session turning off leaves another session on", async () => {
		const app = harness(notices);
		app.use(SESSION);
		await app.run("off");
		expect(await app.start()).toBeUndefined();

		app.use(OTHER);
		expect(await app.start()).toContain("<shell>");
		expect(isEnabled(OTHER)).toBe(true);
		expect(isEnabled(SESSION)).toBe(false);
	});

	test("keeps the state through a reload", async () => {
		const before = harness(notices);
		await before.run("off");

		// A reload re-runs the factory in the same process, for the same session id.
		const after = harness(notices);
		expect(await after.start()).toBeUndefined();
		expect(readToggleState(SESSION)).toEqual({ enabled: false, globalEnabled: true });
	});

	test("resets to the global default at a restart", async () => {
		const before = harness(notices);
		await before.run("off");

		// A restart is a new process: nothing on `globalThis` survives it.
		resetEnabled();
		const after = harness(notices);
		expect(await after.start()).toContain("<shell>");
		expect(readToggleState(SESSION)).toEqual({ enabled: true, globalEnabled: true });
	});
});

describe("/pi-persist-toggle attenuation", () => {
	let agentDir: string;
	let notices: string[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-persist-toggle-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		notices = [];
		clearContributions();
		clearEnvMessages();
		// The operator turned it off for the whole machine, by hand or with the CLI.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ piPersist: { enabled: false } }, null, 2));
		resetEnabled();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		resetEnabled();
	});

	test("a session may turn itself off while the global default is on", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ piPersist: { enabled: true } }));
		resetGlobalDefault();

		expect(toggleEnabled({ sessionId: SESSION, target: false })).toMatchObject({
			enabled: false,
			globalEnabled: true,
			changed: true,
		});
		expect(readToggleState(SESSION)).toEqual({ enabled: false, globalEnabled: true });
	});

	test("a session may not turn itself on while the global default is off", async () => {
		const app = harness(notices);
		await app.run("on");

		expect(notices.at(-1) ?? "").toContain("cannot turn on");
		expect(await app.start()).toBeUndefined();
		expect(readToggleState(SESSION)).toEqual({ enabled: false, globalEnabled: false });
	});

	test("a bare toggle from a global off stays off", async () => {
		const app = harness(notices);
		await app.run("");

		expect(notices.at(-1) ?? "").toContain("cannot turn on");
		expect(await app.start()).toBeUndefined();
	});

	test("status says disabled globally instead of off for this session", async () => {
		const app = harness(notices);
		await app.run("status");

		const line = notices.at(-1) ?? "";
		expect(line).toContain("global settings");
		expect(line).not.toContain("for this session");
	});

	test("a refused request does not touch the settings file", async () => {
		const path = join(agentDir, "settings.json");
		const original = readFileSync(path, "utf8");
		const app = harness(notices);
		await app.run("on");
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	test("a restart with a global off starts off", async () => {
		resetEnabled();
		expect(readToggleState(SESSION)).toEqual({ enabled: false, globalEnabled: false });
	});
});

describe("toggleEnabled", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-persist-toggle-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		resetEnabled();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		resetEnabled();
	});

	test("turns only the named session off", () => {
		expect(toggleEnabled({ sessionId: SESSION, target: false })).toEqual({
			enabled: false,
			globalEnabled: true,
			changed: true,
		});
		expect(isEnabled(SESSION)).toBe(false);
		expect(isEnabled(OTHER)).toBe(true);
		// A session that never toggled is not recorded anywhere; it just follows the default.
		expect(toggleEnabled({ sessionId: OTHER, target: false }).changed).toBe(true);
	});

	test("setting the state it already has changes nothing", () => {
		toggleEnabled({ sessionId: SESSION, target: false });
		expect(toggleEnabled({ sessionId: SESSION, target: false })).toEqual({
			enabled: false,
			globalEnabled: true,
			changed: false,
		});
	});

	test("turning back on clears the session mark", () => {
		toggleEnabled({ sessionId: SESSION, target: false });
		toggleEnabled({ sessionId: SESSION, target: true });
		expect(readToggleState(SESSION)).toEqual({ enabled: true, globalEnabled: true });
		// Cleared, not merely masked: a bare toggle from here turns the session off again.
		expect(toggleEnabled({ sessionId: SESSION }).changed).toBe(true);
		expect(isEnabled(SESSION)).toBe(false);
	});

	test("a session with no id is its own bucket", () => {
		toggleEnabled({ target: false });
		expect(isEnabled()).toBe(false);
		expect(isEnabled(SESSION)).toBe(true);
	});

	test("a session that never toggled follows the global default from the file", () => {
		expect(isEnabled(OTHER)).toBe(true);
		resetEnabled();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ piPersist: { enabled: false } }));
		expect(isEnabled(OTHER)).toBe(false);
	});
});
