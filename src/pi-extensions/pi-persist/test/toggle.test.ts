import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import envContext, { SECTION_NAME } from "../src/index.ts";
import { clearEnvMessages } from "../src/messages.ts";
import { clearContributions } from "../src/registry.ts";
import { resetEnabled } from "../src/toggle.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

/**
 * A harness around the extension.
 *
 * The switch lives in pi's own settings file, which the caller points at a temp directory through
 * `PI_CODING_AGENT_DIR`. A test that used the operator's real file would read a real "off" and
 * fail every other test here.
 */
function harness(notices: string[]) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandHandler>();
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
		sessionManager: { buildContextEntries: () => [] as unknown[] },
	};
	const event: { type: string; systemPromptOptions: { sections: Record<string, string> } } = {
		type: "before_agent_start",
		systemPromptOptions: { sections: {} },
	};

	return {
		commands,
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
		// The live state is shared between copies of the package, so it is reset explicitly.
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

	test("off is reported", async () => {
		const app = harness(notices);
		await app.run("");
		expect(notices.join("\n")).toContain("is off");
	});

	test("on restores the section and the trailing message", async () => {
		const app = harness(notices);
		await app.run("");
		await app.run("");

		expect(await app.start()).toContain("<shell>");
		const payload = await app.providerRequest({ messages: [] });
		expect(payload.messages.at(-1)?.role).toBe("developer");
	});

	test("writes the switch into pi's settings file", async () => {
		const app = harness(notices);
		await app.run("");

		const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(written.piPersist).toEqual({ enabled: false });
	});

	test("the written switch survives a reload", async () => {
		const first = harness(notices);
		await first.run("");

		// A reload re-runs the factory, which forgets the live state and reads the file again.
		const second = harness(notices);
		expect(await second.start()).toBeUndefined();
	});

	test("an explicit argument sets the state instead of flipping it", async () => {
		const app = harness(notices);
		await app.run("off");
		await app.run("on");
		expect(await app.start()).toContain("<shell>");

		await app.run("on");
		expect(await app.start()).toContain("<shell>");
	});

	test("status reports the state without changing it", async () => {
		const app = harness(notices);
		await app.run("status");
		expect(notices.join("\n")).toContain("is on");
		expect(await app.start()).toContain("<shell>");
	});

	test("an argument that is not understood changes nothing", async () => {
		const app = harness(notices);
		await app.run("maybe");

		expect(notices.join("\n")).toContain("usage:");
		expect(await app.start()).toContain("<shell>");
	});

	test("a settings file that cannot be written leaves the switch on for this session only", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		const app = harness(notices);
		await app.run("");

		// The switch still takes effect — the operator asked for it now.
		expect(await app.start()).toBeUndefined();
		expect(notices.join("\n")).toContain("for this session only");
	});
});
